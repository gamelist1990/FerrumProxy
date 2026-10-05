import type { ListenerConfig } from '../../api';

export type RoutePreset = 'custom' | 'java' | 'nethernet';

// Only defaults for a NEW route. Existing routes are never rewritten by a preset.
export function createListenerRoute(preset: RoutePreset, host: string): ListenerConfig {
  const tcp = preset === 'java' ? 25565 : preset === 'nethernet' ? 19132 : undefined;
  const udp = preset === 'nethernet' ? 19132 : undefined;
  const target = { host, tcp: preset === 'java' ? 5000 : tcp, udp };
  return {
    bind: '0.0.0.0', tcp, udp, target, targets: [target],
    haproxy: preset !== 'custom',
    bedrockTransport: preset === 'nethernet' ? 'nethernet' : 'raknet',
    rewriteBedrockPongPorts: preset !== 'nethernet',
    https: { enabled: false, autoDetect: true }, httpMappings: [],
  };
}

export function listenerPortsConflict(a: ListenerConfig, b: ListenerConfig): boolean {
  const bindA = a.bind || '0.0.0.0';
  const bindB = b.bind || '0.0.0.0';
  // Conservative for IPv6 dual-stack wildcard sockets as well.
  const overlaps = bindA === bindB || [bindA, bindB].some(bind => bind === '0.0.0.0' || bind === '::');
  return overlaps && (['tcp', 'udp'] as const).some(protocol =>
    a[protocol] !== undefined && a[protocol] === b[protocol]);
}
