import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { fetchIpBlockStatus } from '../../api';
import type { IpBlockConfig, IpBlockStatus } from '../../api';
import { t } from '../../lang';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import './IpBlockSettings.css';

// Keep these defaults aligned with Rust's IpBlockConfig::default().
export const DEFAULT_IP_BLOCK: IpBlockConfig = {
  enabled: false, blockVpn: false, blockDatacenter: false,
  vpnFeedUrl: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt',
  datacenterFeedUrl: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt',
  feedRefreshIntervalSeconds: 86400, blockedIps: [], blockedCidrs: [],
};

export function IpBlockSettingsPanel({ instanceId, config, onChange }: {
  instanceId: string; config?: IpBlockConfig; onChange: (config: IpBlockConfig) => void;
}) {
  const cfg = { ...DEFAULT_IP_BLOCK, ...config };
  const ips = cfg.blockedIps ?? [];
  const cidrs = cfg.blockedCidrs ?? [];
  const [stats, setStats] = useState<IpBlockStatus['feedStats']>();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStats(undefined);
    setLoading(true);
    fetchIpBlockStatus(instanceId, AbortSignal.any([controller.signal, AbortSignal.timeout(16000)]))
      .then(status => { if (!controller.signal.aborted) setStats(status.feedStats); })
      .catch(() => { if (!controller.signal.aborted) setStats(undefined); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [instanceId, refresh]);

  const patch = <K extends keyof IpBlockConfig>(field: K, value: IpBlockConfig[K]) => onChange({ ...cfg, [field]: value });

  return <Card title={t('ipBlockSettings')}>
    <div className="ip-block-settings">
      <Switch label={t('ipBlockEnabled')} checked={!!cfg.enabled} onChange={value => patch('enabled', value)} />
      <p className="text-sm text-muted">{t('ipBlockHint')}</p>
      <div className="ui-grid">
        <Switch label={t('ipBlockVpn')} checked={!!cfg.blockVpn} onChange={value => patch('blockVpn', value)} />
        <Switch label={t('ipBlockDatacenter')} checked={!!cfg.blockDatacenter} onChange={value => patch('blockDatacenter', value)} />
      </div>

      <section className="ip-block-list" aria-labelledby="ip-block-ips-title">
        <div className="ip-block-heading"><h4 id="ip-block-ips-title">{t('ipBlockAddresses')} <small>({ips.length})</small></h4>
          <Button type="button" icon={<Plus size={16} aria-hidden="true" />} onClick={() => patch('blockedIps', [...ips, { ip: '' }])}>{t('ipBlockAddAddress')}</Button>
        </div>
        {!ips.length && <p className="text-sm text-muted">{t('ipBlockNoAddresses')}</p>}
        {ips.map((entry, index) => <div className="ip-block-row" key={index}>
          <Input label={`${t('ipBlockAddress')} ${index + 1}`} value={entry.ip} placeholder="203.0.113.42 / 2001:db8::1" spellCheck={false}
            onChange={event => patch('blockedIps', ips.map((item, i) => i === index ? { ...item, ip: event.target.value } : item))} />
          <Input label={t('ipBlockReason')} aria-label={`${t('ipBlockReason')} ${index + 1}`} value={entry.reason ?? ''}
            onChange={event => patch('blockedIps', ips.map((item, i) => i === index ? { ...item, reason: event.target.value } : item))} />
          <Button type="button" variant="danger" aria-label={`${t('ipBlockRemoveAddress')} ${index + 1}`} icon={<Trash2 size={16} aria-hidden="true" />}
            onClick={() => patch('blockedIps', ips.filter((_, i) => i !== index))}>{t('ipBlockRemove')}</Button>
        </div>)}
      </section>

      <section className="ip-block-list" aria-labelledby="ip-block-cidrs-title">
        <div className="ip-block-heading"><h4 id="ip-block-cidrs-title">{t('ipBlockNetworks')} <small>({cidrs.length})</small></h4>
          <Button type="button" icon={<Plus size={16} aria-hidden="true" />} onClick={() => patch('blockedCidrs', [...cidrs, ''])}>{t('ipBlockAddNetwork')}</Button>
        </div>
        {!cidrs.length && <p className="text-sm text-muted">{t('ipBlockNoNetworks')}</p>}
        {cidrs.map((cidr, index) => <div className="ip-block-row ip-block-cidr" key={index}>
          <Input label={`CIDR ${index + 1}`} value={cidr} placeholder="203.0.113.0/24 / 2001:db8::/32" spellCheck={false}
            onChange={event => patch('blockedCidrs', cidrs.map((item, i) => i === index ? event.target.value : item))} />
          <Button type="button" variant="danger" aria-label={`${t('ipBlockRemoveNetwork')} ${index + 1}`} icon={<Trash2 size={16} aria-hidden="true" />}
            onClick={() => patch('blockedCidrs', cidrs.filter((_, i) => i !== index))}>{t('ipBlockRemove')}</Button>
        </div>)}
      </section>

      <details className="ip-block-feeds"><summary>{t('ipBlockFeedSettings')}</summary>
        <div className="ui-grid">
          <Input label={t('ipBlockVpnFeed')} type="url" value={cfg.vpnFeedUrl ?? ''} onChange={event => patch('vpnFeedUrl', event.target.value)} />
          <Input label={t('ipBlockDatacenterFeed')} type="url" value={cfg.datacenterFeedUrl ?? ''} onChange={event => patch('datacenterFeedUrl', event.target.value)} />
          <Input label={t('ipBlockFeedInterval')} type="number" min={0} step={1} value={cfg.feedRefreshIntervalSeconds ?? ''}
            onChange={event => patch('feedRefreshIntervalSeconds', event.target.value === '' ? undefined : Number(event.target.value))} />
        </div>
        <p className="text-sm text-muted">{t('ipBlockFeedHint')}</p>
      </details>

      <section className="ip-block-runtime" aria-labelledby="ip-block-runtime-title">
        <div className="ip-block-heading"><h4 id="ip-block-runtime-title">{t('ipBlockFeedStatus')}</h4>
          <Button type="button" variant="ghost" disabled={loading} icon={<RefreshCw size={16} aria-hidden="true" />} onClick={() => setRefresh(value => value + 1)}>{t('ipBlockRefreshStatus')}</Button>
        </div>
        <div aria-live="polite">{loading ? <p className="text-sm text-muted">{t('ipBlockLoading')}</p> : stats ?
          <dl className="ip-block-stats"><div><dt>{t('ipBlockVpn')}</dt><dd>{stats.vpnCidrs.toLocaleString()} CIDR</dd></div>
            <div><dt>{t('ipBlockDatacenter')}</dt><dd>{stats.datacenterCidrs.toLocaleString()} CIDR</dd></div>
            <div><dt>{t('ipBlockLastFetch')}</dt><dd>{stats.lastUpdatedSecondsAgo === null ? t('ipBlockNotFetched') : `${stats.lastUpdatedSecondsAgo.toLocaleString()} ${t('ipBlockSecondsAgo')}`}</dd></div></dl>
          : <p className="text-sm text-muted">{t('ipBlockStatusUnavailable')}</p>}
        </div>
      </section>
      <p className="text-sm text-muted">{t('configRestartHint')}</p>
    </div>
  </Card>;
}
