import { describe, expect, test } from 'bun:test';
import { aggregateConnectionIps } from '../src/ipAnalytics';

describe('connection IP analytics', () => {
  test('shows connections without login notifications', () => {
    const entries = aggregateConnectionIps([], [{ ip: '203.0.113.1', connections: 3, lastSeen: 10 }]);
    expect(entries.get('203.0.113.1')?.connections).toBe(3);
    expect(entries.get('203.0.113.1')?.players.size).toBe(0);
  });

  test('merges protocols and player names without counting logins twice', () => {
    const entries = aggregateConnectionIps([
      { username: 'Alex', ips: [{ ip: '203.0.113.1', connections: 2, lastSeen: 5 }] },
      { username: 'Steve', ips: [{ ip: '203.0.113.1', connections: 1, lastSeen: 8 }] },
    ], [
      { ip: '203.0.113.1', connections: 4, lastSeen: 10 },
      { ip: '203.0.113.1', connections: 2, lastSeen: 12 },
    ]);
    expect(entries.get('203.0.113.1')?.connections).toBe(6);
    expect(entries.get('203.0.113.1')?.players.size).toBe(2);
    expect(entries.get('203.0.113.1')?.lastSeen).toBe(12);
  });

  test('keeps legacy records when no connection totals exist', () => {
    const entries = aggregateConnectionIps([
      { username: 'Alex', ips: [{ ip: '203.0.113.1', lastSeen: 5 }] },
      { username: 'Steve', ips: [{ ip: '203.0.113.1', connections: 2 }] },
    ], []);
    expect(entries.get('203.0.113.1')?.connections).toBe(3);
  });
});
