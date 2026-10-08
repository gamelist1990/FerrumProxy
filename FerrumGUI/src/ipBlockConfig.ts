import { isIP } from 'node:net';

export interface IpBlockConfig {
  enabled?: boolean;
  blockVpn?: boolean;
  blockDatacenter?: boolean;
  vpnFeedUrl?: string;
  datacenterFeedUrl?: string;
  feedRefreshIntervalSeconds?: number;
  blockedIps?: Array<{ ip: string; reason?: string | null }>;
  blockedCidrs?: string[];
}

export function validateIpBlockConfig(config: IpBlockConfig): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['ipBlock must be an object'];
  }
  for (const key of ['enabled', 'blockVpn', 'blockDatacenter'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') errors.push(`ipBlock.${key} must be boolean`);
  }
  for (const key of ['vpnFeedUrl', 'datacenterFeedUrl'] as const) {
    if (config[key] === undefined) continue;
    try {
      if (typeof config[key] !== 'string') throw new Error();
      const url = new URL(config[key]);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    } catch { errors.push(`ipBlock.${key} must be an HTTP or HTTPS URL`); }
  }
  if (config.feedRefreshIntervalSeconds !== undefined &&
    (!Number.isSafeInteger(config.feedRefreshIntervalSeconds) || config.feedRefreshIntervalSeconds < 0)) {
    errors.push('ipBlock.feedRefreshIntervalSeconds must be a non-negative integer (0 = startup only)');
  }
  if (config.blockedIps !== undefined) {
    if (!Array.isArray(config.blockedIps)) errors.push('ipBlock.blockedIps must be an array');
    else config.blockedIps.forEach((entry, index) => {
      if (!entry || typeof entry.ip !== 'string' || entry.ip.includes('%') || !isIP(entry.ip.trim())) {
        errors.push(`ipBlock.blockedIps[${index}].ip must be an IPv4 or IPv6 address`);
      }
      if (entry?.reason !== undefined && entry.reason !== null && typeof entry.reason !== 'string') {
        errors.push(`ipBlock.blockedIps[${index}].reason must be a string`);
      }
    });
  }
  if (config.blockedCidrs !== undefined) {
    if (!Array.isArray(config.blockedCidrs)) errors.push('ipBlock.blockedCidrs must be an array');
    else config.blockedCidrs.forEach((cidr, index) => {
      const parts = typeof cidr === 'string' ? cidr.trim().split('/') : [];
      const version = parts.length === 2 && !parts[0].includes('%') ? isIP(parts[0].trim()) : 0;
      if (!version || !/^\d+$/.test(parts[1]?.trim() || '') || Number(parts[1]) > (version === 4 ? 32 : 128)) {
        errors.push(`ipBlock.blockedCidrs[${index}] must be a valid IPv4 or IPv6 CIDR`);
      }
    });
  }
  return errors;
}
