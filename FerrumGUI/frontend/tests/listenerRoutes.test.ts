import { describe, expect, test } from 'bun:test';
import { createListenerRoute, listenerPortsConflict } from '../src/components/config/listenerRoutes';
import { ConfigManager } from '../../src/configManager';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('multiple public routes to one server', () => {
  test('GUI backend validates and saves all routes and HTTP branches without dropping them', async () => {
    const manager = new ConfigManager();
    const web = createListenerRoute('custom', '100.83.127.8');
    web.tcp = 8080;
    web.targets = [{ host: '100.83.127.8', tcp: 8123 }];
    web.target = web.targets[0];
    web.httpMappings = [{ path: '/map', targets: [{ host: '100.83.127.8', tcp: 8124 }] }];
    const config = { listeners: [createListenerRoute('java', '100.83.127.8'), createListenerRoute('nethernet', '100.83.127.8'), web] };
    config.listeners[1].nethernetAdvertiseHost = '132.145.118.98';
    config.listeners[1].nethernetAdvertisePort = 19132;
    expect((await manager.validate(config)).errors).toEqual([]);
    const folder = await mkdtemp(join(tmpdir(), 'ferrum-ui-routes-'));
    const file = join(folder, 'routes.yml');
    try {
      await manager.write(file, config);
      expect((await readFile(file, 'utf8')).includes('bedrockTransport: nethernet')).toBe(true);
      const restored = await manager.read(file);
      expect(restored.listeners).toHaveLength(3);
      expect(restored.listeners![1].nethernetAdvertiseHost).toBe('132.145.118.98');
      expect(restored.listeners![1].nethernetAdvertisePort).toBe(19132);
      expect(restored.listeners![2].tcp).toBe(8080);
      expect(restored.listeners![2].targets![0].tcp).toBe(8123);
      expect(restored.listeners![2].httpMappings![0].targets![0].tcp).toBe(8124);
    } finally {
      await unlink(file).catch(() => {});
      await rmdir(folder);
    }
  });
  test('NetherNet advertisement rejects DNS names, missing IP and invalid ports', async () => {
    const manager = new ConfigManager();
    const listener = createListenerRoute('nethernet', '100.83.127.8');
    listener.nethernetAdvertiseHost = 'play.pexserver.com';
    expect((await manager.validate({ listeners: [listener] })).errors.length).toBeGreaterThan(0);
    listener.nethernetAdvertiseHost = '132.145.118.98';
    listener.nethernetAdvertisePort = 0;
    expect((await manager.validate({ listeners: [listener] })).errors.length).toBeGreaterThan(0);
    listener.nethernetAdvertiseHost = undefined;
    listener.nethernetAdvertisePort = 19132;
    expect((await manager.validate({ listeners: [listener] })).errors.length).toBeGreaterThan(0);
  });
  test('Java and NetherNet retain separate public and destination ports after JSON serialization', () => {
    const routes = JSON.parse(JSON.stringify([
      createListenerRoute('java', '100.83.127.8'),
      createListenerRoute('nethernet', '100.83.127.8'),
    ]));
    expect(routes[0].tcp).toBe(25565);
    expect(routes[0].udp).toBeUndefined();
    expect(routes[0].targets[0]).toEqual({ host: '100.83.127.8', tcp: 5000 });
    expect(routes[1].targets[0]).toEqual({ host: '100.83.127.8', tcp: 19132, udp: 19132 });
    expect(routes[1].bedrockTransport).toBe('nethernet');
    expect(routes[1].haproxy).toBe(true);
    expect(listenerPortsConflict(routes[0], routes[1])).toBe(false);
  });

  test('overlapping wildcard binds conflict only for the same protocol', () => {
    expect(listenerPortsConflict({ tcp: 19132 }, { bind: '127.0.0.1', tcp: 19132 })).toBe(true);
    expect(listenerPortsConflict({ bind: '::', udp: 19132 }, { udp: 19132 })).toBe(true);
    expect(listenerPortsConflict({ tcp: 19132 }, { udp: 19132 })).toBe(false);
    expect(listenerPortsConflict({ bind: '127.0.0.1', tcp: 19132 }, { bind: '100.83.127.8', tcp: 19132 })).toBe(false);
  });

  test('custom routes start without duplicate public ports and have independent targets', () => {
    const a = createListenerRoute('custom', '100.83.127.8');
    const b = createListenerRoute('custom', '100.83.127.8');
    expect(listenerPortsConflict(a, b)).toBe(false);
    a.targets![0].tcp = 8123;
    expect(b.targets![0].tcp).toBeUndefined();
    a.tcp = 80;
    expect(JSON.parse(JSON.stringify(a)).targets[0].tcp).toBe(8123);
  });
});
