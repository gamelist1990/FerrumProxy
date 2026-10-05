import { describe, expect, test } from 'bun:test';
import { parseNetherEvents, groupNetherEvents } from '../src/utils/nethernetAnalysis';
import type { LogEntry } from '../src/api';
const log = (event: string, details: Record<string, unknown>, client = '106.72.244.2:44192'): LogEntry => ({timestamp:'2026-10-06T00:00:00Z',type:'stdout',message:`INFO ferrum_proxy::nethernet: NETHER_DIAG ${JSON.stringify({version:1,event,client,backend:'100.83.127.8:19132',details})}`});
describe('NetherNet diagnostic analysis',()=>{
  test('groups TCP and UDP ports by IP without inferring a fallback or login success',()=>{
    const events=parseNetherEvents([
      log('tcp_start',{},'106.72.244.2:1234'),
      log('signaling_response',{status:200,rewritten:true},'106.72.244.2:1234'),
      log('udp_packet',{kind:'raknet_open_request_1',direction:'client_to_backend'}),
    ]);
    const groups=groupNetherEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toEqual(['raknet','rewritten','no_reply']);
  });
  test('IPv6 endpoints and observed replies are handled',()=>{
    const client='[240b:10::1]:1234';
    const group=groupNetherEvents(parseNetherEvents([
      log('udp_packet',{kind:'stun_binding_request',direction:'client_to_backend'},client),
      log('udp_packet',{kind:'stun_binding_response',direction:'backend_to_client'},client),
      log('udp_packet',{kind:'dtls',direction:'backend_to_client'},client),
    ]))[0];
    expect(group.ip).toBe('240b:10::1');
    expect(group.findings).toEqual(['dtls','stun_reply']);
  });
  test('drops malformed events and exports only allowlisted metadata',()=>{
    const events=parseNetherEvents([
      {timestamp:'now',type:'stdout',message:'NETHER_DIAG broken'},
      log('not_a_known_event',{}),
      log('signaling_response',{status:200,authorization:'SECRET',sdp:{identity:'SECRET',identityPresent:true,fingerprint:'SECRET',fingerprintCount:1,candidates:[{ip:'100.83.127.8',port:19132,kind:'host',transport:'UDP',token:'SECRET'}]}}),
    ]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(events[0].details.sdp).toMatchObject({identityPresent:true,fingerprintCount:1});
  });
});
