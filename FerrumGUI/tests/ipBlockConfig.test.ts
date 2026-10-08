import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../src/configManager';
import { validateIpBlockConfig, type IpBlockConfig } from '../src/ipBlockConfig';

describe('IP Block configuration', () => {
  test('preserves protection rules, reasons and custom feed settings through YAML save/reload', async () => {
    const config = {
      ipBlock: {
        enabled: true, blockVpn: true, blockDatacenter: true,
        vpnFeedUrl: ' https://example.com/vpn.txt ', datacenterFeedUrl: 'https://example.com/dc.txt',
        feedRefreshIntervalSeconds: 0,
        blockedIps: [{ ip: ' 203.0.113.42 ', reason: ' abuse ' }, { ip: '2001:db8::1' }],
        blockedCidrs: [' 203.0.113.0/24 ', '2001:db8::/32'],
      }, listeners: [{ tcp: 25565, target: { host: 'localhost', tcp: 25566 } }],
    };
    const manager = new ConfigManager();
    expect((await manager.validate(config)).errors).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'ferrum-ip-block-'));
    const file = join(dir, 'config.yml');
    try {
      await manager.write(file, config);
      const restored = await manager.read(file);
      expect(restored.ipBlock).toEqual({
        ...config.ipBlock, vpnFeedUrl: 'https://example.com/vpn.txt',
        blockedIps: [{ ip: '203.0.113.42', reason: 'abuse' }, { ip: '2001:db8::1' }],
        blockedCidrs: ['203.0.113.0/24', '2001:db8::/32'],
      });
      expect(restored.listeners).toEqual(config.listeners);
      expect((await readFile(file, 'utf8')).includes('feedRefreshIntervalSeconds: 0')).toBe(true);
      expect(config.ipBlock.blockedIps[0].ip).toBe(' 203.0.113.42 ');
    } finally {
      await unlink(file).catch(() => {});
      await rmdir(dir);
    }
  });

  test('accepts missing/disabled defaults and boundary IPv4/IPv6 networks', async () => {
    expect((await new ConfigManager().validate({})).valid).toBe(true);
    expect(validateIpBlockConfig({ enabled: false, blockedCidrs: ['0.0.0.0/0', '203.0.113.42/32', '::/0', '2001:db8::1/128'] })).toEqual([]);
  });

  test.each([
    { blockedIps: [{ ip: 'not-an-ip' }] }, { blockedIps: [{ ip: '' }] },
    { blockedIps: [{ ip: 'fe80::1%eth0' }] },
    { blockedCidrs: ['203.0.113.0/33'] }, { blockedCidrs: ['2001:db8::/129'] },
    { blockedCidrs: ['203.0.113.0/-1'] }, { blockedCidrs: ['::/1.5'] },
    { blockedCidrs: ['203.0.113.0/'] }, { blockedCidrs: ['203.0.113.0'] },
    { vpnFeedUrl: 'file:///secret.txt' }, { datacenterFeedUrl: '' },
    { feedRefreshIntervalSeconds: -1 }, { feedRefreshIntervalSeconds: 1.5 },
    { enabled: 'yes' }, { blockedIps: '203.0.113.42' }, { blockedIps: [null] },
    { blockedCidrs: [null] }, { blockedCidrs: {} }, { blockedIps: [{ ip: '203.0.113.42', reason: 7 }] },
    null, [],
  ])('rejects invalid rules before they can replace a working proxy configuration: %j', async value => {
    const result = await new ConfigManager().validate({ ipBlock: value as IpBlockConfig });
    expect(result.valid).toBe(false);
    expect(result.errors.every(error => error.startsWith('ipBlock'))).toBe(true);
  });
});
