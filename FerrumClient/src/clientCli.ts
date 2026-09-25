import { RelayShareClient, RelayShareStatus } from './relayShareClient';

export type ProtocolMode = 'tcp' | 'udp' | 'both';

export interface ClientCliOptions {
  relay: string;
  token?: string;
  protocol: ProtocolMode;
  tcpPort: number;
  udpPort: number;
  localHost: string;
  haproxy: boolean;
  showStatus: boolean;
  help: boolean;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ClientCliOptions {
  const options: ClientCliOptions = {
    relay: env.FERRUMPROXY_RELAY?.trim() || '127.0.0.1:7000',
    token: env.FERRUMPROXY_TOKEN?.trim() || undefined,
    protocol: 'tcp',
    tcpPort: 25565,
    udpPort: 25565,
    localHost: '127.0.0.1',
    haproxy: false,
    showStatus: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (option: string): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${option} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--relay':
        options.relay = next(arg);
        break;
      case '--token':
        options.token = next(arg);
        break;
      case '--protocol':
        options.protocol = next(arg) as ProtocolMode;
        break;
      case '--tcp-port':
        options.tcpPort = parsePort(next(arg), arg);
        break;
      case '--udp-port':
        options.udpPort = parsePort(next(arg), arg);
        break;
      case '--local-host':
        options.localHost = next(arg);
        break;
      case '--haproxy':
        options.haproxy = true;
        break;
      case '--no-status':
        options.showStatus = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function validateOptions(options: ClientCliOptions): void {
  if (!['tcp', 'udp', 'both'].includes(options.protocol)) {
    throw new Error('--protocol must be tcp, udp, or both');
  }
  if (!options.relay.trim()) {
    throw new Error('--relay <host:port> must not be empty');
  }
  if (!options.localHost.trim()) {
    throw new Error('--local-host <host> must not be empty');
  }
  if ((options.protocol === 'tcp' || options.protocol === 'both') && !isPort(options.tcpPort)) {
    throw new Error('--tcp-port must be between 1 and 65535');
  }
  if ((options.protocol === 'udp' || options.protocol === 'both') && !isPort(options.udpPort)) {
    throw new Error('--udp-port must be between 1 and 65535');
  }
}

function parsePort(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} must be an integer between 1 and 65535`);
  }
  const port = Number(value);
  if (!isPort(port)) {
    throw new Error(`${option} must be between 1 and 65535`);
  }
  return port;
}

function isPort(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function printHelp(): void {
  console.log(`FerrumProxy Client CLI

Usage:
  ferrumproxy-client-cli [options]
  bun run cli -- [options]

Options:
  --relay <host:port>   FerrumProxy relay control endpoint
                        (default: FERRUMPROXY_RELAY or 127.0.0.1:7000)
  --token <token>       Relay authentication token
                        (default: FERRUMPROXY_TOKEN when set)
  --protocol <mode>     tcp, udp, or both (default: tcp)
  --local-host <host>   Local service host (default: 127.0.0.1)
  --tcp-port <port>     Local TCP service port (default: 25565)
  --udp-port <port>     Local UDP service port (default: 25565)
  --haproxy             Use HAProxy PROXY protocol v2
  --no-status           Disable the live terminal status line
  -h, --help            Show this help
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  validateOptions(options);

  console.log('FerrumProxy Client CLI starting...');
  console.log(`  Relay: ${options.relay}`);
  console.log(`  Protocol: ${options.protocol}`);
  console.log(`  Local: ${options.localHost}`);
  if (options.protocol === 'tcp' || options.protocol === 'both') {
    console.log(`  TCP Port: ${options.tcpPort}`);
  }
  if (options.protocol === 'udp' || options.protocol === 'both') {
    console.log(`  UDP Port: ${options.udpPort}`);
  }
  if (options.haproxy) {
    console.log('  HAProxy: enabled');
  }

  const client = new RelayShareClient({
    relayAddress: options.relay,
    token: options.token,
    protocol: options.protocol,
    localHost: options.localHost,
    tcpLocalPort: options.tcpPort,
    udpLocalPort: options.udpPort,
    haproxy: options.haproxy,
  });

  const liveStatus = options.showStatus && !!process.stdout.isTTY;
  client.on('status', (status: RelayShareStatus) => {
    if (!liveStatus) {
      return;
    }
    process.stdout.write(
      `\r  TCP tunnels: ${status.tcpTunnels} | ` +
        `UDP tunnel: ${status.udpTunnel ? 'ready' : 'down'} | ` +
        `In: ${formatBytes(status.bytesIn)} Out: ${formatBytes(status.bytesOut)}  `
    );
  });
  client.on('log', (message) => {
    if (liveStatus) {
      process.stdout.write('\n');
    }
    console.log(message);
  });

  let started = false;
  try {
    const endpoint = await client.start();
    started = true;
    if (liveStatus) {
      process.stdout.write('\n');
    }
    console.log('Shared service started successfully!');
    console.log(`  Public URL: ${endpoint.display}`);
    console.log('Press Ctrl+C to stop.');

    await waitForShutdownSignal(async () => {
      console.log('\nShutting down...');
      await client.stop();
      console.log('Stopped.');
    });
  } catch (error) {
    if (started) {
      await client.stop().catch(() => undefined);
    }
    throw error;
  }
}

async function waitForShutdownSignal(shutdown: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const handleSignal = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void shutdown()
        .catch((error) => {
          console.error(`Shutdown failed: ${(error as Error).message}`);
          process.exitCode = 1;
        })
        .finally(resolve);
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FerrumProxy Client CLI failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
