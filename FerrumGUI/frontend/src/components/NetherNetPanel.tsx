import { useMemo, useState } from 'react';
import { Download, Network, Search } from 'lucide-react';
import type { LogEntry } from '../api';
import { parseNetherEvents, groupNetherEvents, type SdpSummary } from '../utils/nethernetAnalysis';
import { t } from '../lang';
import './NetherNetPanel.css';
const findingKeys: Record<string,Parameters<typeof t>[0]> = {rewrite_error:'netherFindingRewriteError',raknet:'netherFindingRaknet',http_error:'netherFindingHttp',rewritten:'netherFindingRewrite',dtls:'netherFindingDtls',stun_reply:'netherFindingStun',no_reply:'netherFindingNoReply',tcp_error:'netherFindingTcp',inspection_skipped:'netherFindingSkipped'};
const eventKeys: Record<string,Parameters<typeof t>[0]> = {rewrite_error:'netherFindingRewriteError',tcp_start:'netherTcpStart',tcp_end:'netherTcpEnd',signaling_request:'netherRequest',signaling_response:'netherResponse',inspection_skipped:'netherSkipped',udp_packet:'netherUdp',udp_idle:'netherIdle'};
function Candidates({value,label}:{value:unknown;label:string}) {
  if (!value) return null;
  const s = value as SdpSummary;
  return <div className="nether-candidates"><strong>{label}</strong>
    <span>{t('netherIdentity')}: {s.identityPresent ? '✓' : '—'} · {t('netherFingerprints')}: {s.fingerprintCount}</span>
    {s.candidates.length ? <ul>{s.candidates.map((c,i)=><li key={i}><code>{c.ip.includes(':') ? `[${c.ip}]` : c.ip}:{c.port}</code> · {c.transport} · {c.kind}</li>)}</ul> : <p>{t('netherNoCandidates')}</p>}
  </div>;
}
export function NetherNetPanel({logs, enabled, instanceName}:{logs:LogEntry[];enabled:boolean;instanceName:string}) {
  const [query,setQuery] = useState('');
  const events = useMemo(()=>parseNetherEvents(logs),[logs]);
  const groups = useMemo(()=>groupNetherEvents(events),[events]);
  const filtered = groups.filter(g=>g.ip.includes(query.trim()));
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),events},null,2)],{type:'application/json'}));
    const link = document.createElement('a');link.href=url;link.download=`${instanceName}-nethernet.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <section className="surface-card nether-panel">
    <div className="section-head"><h3 className="icon-label"><Network size={18} aria-hidden="true"/>NetherNet</h3>
      <button className="btn tertiary" type="button" onClick={exportJson} disabled={!events.length}><Download size={16} aria-hidden="true"/>{t('netherExport')}</button></div>
    <p className="text-secondary">{t('netherAnalysisHint')}</p>
    {!enabled && <p className="feedback-banner">{t('netherEnableHint')}</p>}
    <label className="nether-search"><Search size={16} aria-hidden="true"/><input aria-label={t('netherSearch')} placeholder={t('netherSearch')} value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <p className="text-secondary">{groups.length} IP · {events.length} {t('netherEvents')}</p>
    {!filtered.length && <div className="panel-empty"><Network size={30} aria-hidden="true"/><p>{events.length ? t('noMatchingLogs') : t('netherEmpty')}</p></div>}
    {filtered.map(group=><article className="nether-peer" key={group.ip}><div className="section-head"><h4>{group.ip}</h4><span>{group.events.length} {t('netherEvents')}</span></div>
      <div className="nether-findings">{group.findings.map(f=><span key={f} className={`nether-finding ${['raknet','http_error','tcp_error','rewrite_error'].includes(f)?'attention':''}`}>{t(findingKeys[f])}</span>)}</div>
      <details><summary>{t('netherTimeline')}</summary><ol className="nether-timeline">{group.events.map((event,i)=><li key={`${event.timestamp}-${i}`}>
        <div className="nether-event-head"><time>{new Date(event.timestamp).toLocaleTimeString()}</time><strong>{t(eventKeys[event.event])}</strong>
          <span>{String(event.details.method ?? event.details.kind ?? event.details.status ?? '')}</span></div>
        <p className="text-secondary"><code>{event.client}</code> → <code>{event.backend}</code></p>
        {typeof event.details.upstream === 'string' && <p>{t('netherUpstream')}: <code>{String(event.details.upstream)}</code></p>}
        {typeof event.details.direction === 'string' && <p>{t('netherDirection')}: {event.details.direction === 'backend_to_client' ? t('netherReply') : event.details.direction === 'client_to_backend' ? t('netherSend') : String(event.details.direction)}</p>}
        {typeof event.details.bytes === 'number' && <p>{event.details.bytes} B</p>}
        {event.event === 'tcp_start' && <p>{t('netherAdvertiseState')}: {event.details.advertise ? String(event.details.advertise) : t('netherObserveOnly')}</p>}
        {event.details.encoded === true && <p>{t('netherEncoded')}</p>}
        {event.event === 'udp_idle' && <p>{t('netherPackets')}: {String(event.details.sentPackets)} → / {String(event.details.receivedPackets)} ← · {String(event.details.idleMs)} ms</p>}
        {typeof event.details.reason === 'string' && <p>{t('netherSkipped')}: {event.details.reason}</p>}
        <Candidates value={event.details.sdp} label={event.event === 'signaling_request' ? t('netherOffer') : t('netherAnswer')}/>
        <Candidates value={event.details.before} label={t('netherBefore')}/><Candidates value={event.details.after} label={t('netherAfter')}/>
      </li>)}</ol></details>
    </article>)}
  </section>;
}


