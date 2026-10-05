import type { LogEntry } from '../api';
export interface Candidate { ip: string; port: number; kind: string; transport: string }
export interface SdpSummary { candidates: Candidate[]; identityPresent: boolean; fingerprintCount: number; bytes: number }
export interface NetherEvent { timestamp: string; event: string; client: string; backend: string; details: Record<string, unknown> }
const events = new Set(['tcp_start', 'tcp_end', 'signaling_request', 'signaling_response', 'inspection_skipped', 'udp_packet', 'udp_idle', 'rewrite_error']);
const kinds = new Set(['raknet_ping','raknet_open_request_1','stun_binding_request','stun_binding_response','stun_binding_error','stun','dtls','unknown_udp']);
function endpoint(value: unknown): value is string { return typeof value === 'string' && value.length < 100 && /^[\da-fA-F.:\[\]]+$/.test(value); }
function summary(value: unknown): SdpSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const candidates = Array.isArray(v.candidates) ? v.candidates.slice(0,32).flatMap(c => {
    if (!c || typeof c !== 'object') return [];
    if (!endpoint(c.ip) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !['host','srflx','prflx','relay','unknown'].includes(c.kind)) return [];
    return [{ip:c.ip,port:c.port,kind:c.kind,transport:c.transport === 'UDP' ? 'UDP' : 'other'}];
  }) : [];
  return {candidates, identityPresent:v.identityPresent === true, fingerprintCount:typeof v.fingerprintCount === 'number' ? v.fingerprintCount : 0,bytes:typeof v.bytes === 'number' ? v.bytes : 0};
}
export function parseNetherEvents(logs: LogEntry[]): NetherEvent[] {
  return logs.flatMap(log => {
    const message = log.message.replace(/\x1b\[[0-9;]*m/g,'');
    const index = message.indexOf('NETHER_DIAG ');
    if (index < 0) return [];
    try {
      const value = JSON.parse(message.slice(index+'NETHER_DIAG '.length));
      if (value.version !== 1 || !events.has(value.event) || !endpoint(value.client) || !endpoint(value.backend)) return [];
      const input = value.details ?? {};
      const details: Record<string,unknown> = {};
      for (const key of ['status','bytes','sentPackets','receivedPackets','idleMs']) {
        if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) details[key] = input[key];
      }
      for (const key of ['rewritten','success','encoded','onlineAuth','selfSignedAuth']) { if (typeof input[key] === 'boolean') details[key] = input[key]; }
      for (const key of ['sdp','before','after']) { const s = summary(input[key]); if (s) details[key] = s; }
      if (['GET','POST','other'].includes(input.method)) details.method = input.method;
      if (['/v1/join','/v1/join/{networkId}','other'].includes(input.path)) details.path = input.path;
      if (kinds.has(input.kind)) details.kind = input.kind;
      if (['client_to_backend','backend_to_client','request','response'].includes(input.direction)) details.direction = input.direction;
      if (endpoint(input.advertise)) details.advertise = input.advertise;
      if (endpoint(input.upstream)) details.upstream = input.upstream;
      if (typeof input.reason === 'string' && /^[a-z_]{1,40}$/.test(input.reason)) details.reason = input.reason;
      return [{timestamp:log.timestamp,event:value.event,client:value.client,backend:value.backend,details}];
    } catch { return []; }
  });
}
export function clientIP(endpoint: string) { return endpoint.startsWith('[') ? endpoint.slice(1,endpoint.indexOf(']')) : endpoint.slice(0,endpoint.lastIndexOf(':')); }
export interface NetherGroup { ip: string; events: NetherEvent[]; findings: string[] }
export function groupNetherEvents(events: NetherEvent[]): NetherGroup[] {
  const groups = new Map<string,NetherEvent[]>();
  for (const event of events) {const ip = clientIP(event.client);groups.set(ip,[...(groups.get(ip) ?? []),event]);}
  return [...groups].map(([ip, events]) => {
    const findings: string[] = [];
    if (events.some(e=>e.event === 'rewrite_error')) findings.push('rewrite_error');
    if (events.some(e=>e.details.kind === 'raknet_open_request_1' && e.details.direction === 'client_to_backend')) findings.push('raknet');
    if (events.some(e=>e.event === 'signaling_response' && Number(e.details.status)>=400)) findings.push('http_error');
    if (events.some(e=>e.event === 'signaling_response' && e.details.rewritten === true)) findings.push('rewritten');
    if (events.some(e=>e.details.kind === 'dtls')) findings.push('dtls');
    if (events.some(e=>e.details.kind === 'stun_binding_response')) findings.push('stun_reply');
    const hasSent = events.some(e=>e.details.direction === 'client_to_backend');
    const hasReply = events.some(e=>e.details.direction === 'backend_to_client');
    if (hasSent && !hasReply) findings.push('no_reply');
    if (events.some(e=>e.event === 'tcp_end' && e.details.success === false)) findings.push('tcp_error');
    if (events.some(e=>e.event === 'inspection_skipped')) findings.push('inspection_skipped');
    return {ip,events,findings};
  }).reverse();
}

