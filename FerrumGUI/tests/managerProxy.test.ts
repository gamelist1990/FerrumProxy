import { describe, expect, test } from 'bun:test';
import { managerForwardHeaders, validManagerPath } from '../src/managerProxy';

describe('manager proxy authorization', () => {
  test('forwards a delegated credential unchanged, even with an admin GUI session', () => {
    expect(managerForwardHeaders('Bearer delegated', true, 'admin')?.Authorization).toBe('Bearer delegated');
    expect(managerForwardHeaders('Bearer delegated', false, 'admin')?.Authorization).toBe('Bearer delegated');
  });
  test('requires an authenticated session to inject the admin credential', () => {
    expect(managerForwardHeaders(undefined, false, 'admin')).toBeUndefined();
    expect(managerForwardHeaders(undefined, true, 'admin')?.Authorization).toBe('Bearer admin');
    expect(managerForwardHeaders('Bearer ', true, 'admin')).toBeUndefined();
    expect(managerForwardHeaders('Basic bad', true, 'admin')).toBeUndefined();
  });
  test('preserves conditional certificate requests and rejects path traversal', () => {
    expect(managerForwardHeaders('Bearer scoped', false, 'admin', '"revision"')?.['If-None-Match']).toBe('"revision"');
    expect(validManagerPath('api/v1/certificates/geyser')).toBe(true);
    for (const path of ['api/v1/../../private', 'api/v1/%2e%2e/private', 'api/v1/x?token=secret', 'api/v1/%', 'http://other']) {
      expect(validManagerPath(path)).toBe(false);
    }
  });
});
