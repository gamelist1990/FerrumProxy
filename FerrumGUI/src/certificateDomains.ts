import { X509Certificate } from 'node:crypto';
/** Existing cert files do not imply that every requested SAN is covered. */
export function certificateCoversDomains(pem: string, domains: string[]): boolean {
  try {
    const cert = new X509Certificate(pem);
    const now = Date.now();
    return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now && domains.length > 0 && domains.every(domain => !!cert.checkHost(domain, { subject: 'never' }));
  } catch { return false; }
}
