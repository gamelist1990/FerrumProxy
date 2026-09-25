import { describe, expect, test } from 'bun:test';
import { parseArgs, validateOptions } from './clientCli';
import { buildTunnelRegistrationCommand } from './relayShareClient';

describe('FerrumProxy Client CLI', () => {
  test('uses compatible defaults', () => {
    const options = parseArgs([], {});
    expect(options.relay).toBe('127.0.0.1:7000');
    expect(options.protocol).toBe('tcp');
    expect(options.tcpPort).toBe(25565);
    expect(options.udpPort).toBe(25565);
    expect(options.localHost).toBe('127.0.0.1');
    expect(options.haproxy).toBe(false);
    expect(() => validateOptions(options)).not.toThrow();
  });

  test('parses sharing options', () => {
    const options = parseArgs(
      [
        '--relay', 'relay.example.com:7000',
        '--protocol', 'both',
        '--local-host', '192.168.1.10',
        '--tcp-port', '25566',
        '--udp-port', '19132',
        '--haproxy',
        '--no-status',
      ],
      {}
    );
    expect(options.relay).toBe('relay.example.com:7000');
    expect(options.protocol).toBe('both');
    expect(options.localHost).toBe('192.168.1.10');
    expect(options.tcpPort).toBe(25566);
    expect(options.udpPort).toBe(19132);
    expect(options.haproxy).toBe(true);
    expect(options.showStatus).toBe(false);
    expect(() => validateOptions(options)).not.toThrow();
  });

  test('rejects invalid arguments and ports', () => {
    expect(() => parseArgs(['--unknown'], {})).toThrow('Unknown option');
    expect(() => parseArgs(['--relay'], {})).toThrow('requires a value');
    expect(() => parseArgs(['--tcp-port', '0'], {})).toThrow('between 1 and 65535');
    const options = parseArgs(['--protocol', 'invalid'], {});
    expect(() => validateOptions(options)).toThrow('--protocol must be tcp, udp, or both');
  });

  test('builds HAProxy registration commands', () => {
    expect(buildTunnelRegistrationCommand('tcp', 40000, false)).toBe('TUNNEL 40000\n');
    expect(buildTunnelRegistrationCommand('tcp', 40000, true)).toBe('TUNNEL 40000 HAPROXY\n');
    expect(buildTunnelRegistrationCommand('udp', 40000, true)).toBe('UDP_TUNNEL 40000 HAPROXY\n');
  });
});
