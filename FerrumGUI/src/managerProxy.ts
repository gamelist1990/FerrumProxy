/** Preserve the caller's credential so a delegated token never becomes an admin token. */
export function managerForwardHeaders(
  authorization: string | undefined,
  hasGuiSession: boolean,
  managerToken: string,
  ifNoneMatch?: string,
): Record<string, string> | undefined {
  const callerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (authorization !== undefined && !callerToken) return undefined;
  if (!callerToken && !hasGuiSession) return undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${callerToken || managerToken}` };
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  return headers;
}

export function validManagerPath(value: string): boolean {
  if (!value.startsWith('api/v1/')) return false;
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9_/-]+$/.test(decoded)
      && !decoded.split('/').some(part => !part || part === '.' || part === '..');
  } catch { return false; }
}
