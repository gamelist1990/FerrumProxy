import { RelayShareClient, RelayShareStatus } from './relayShareClient';

type ProtocolMode = 'tcp' | 'udp' | 'both';

interface ClientCliOptions {
  relay?: string;
  token?: string;
  protocol: ProtocolMode;
  tcpPort?: number;
  udpPort?: number;
  localHost?: string;
  haproxy: boolean;
}

function parseArgs(argv: string[]): ClientCliOptions {
  const options: ClientCliOptions = {
    protocol: 'tcp',
    haproxy: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    switch (arg) {
      case '--relay':
        options.relay = next();
        break;
      case '--token':
        options.token = next();
        break;
      case '--protocol':
        options.protocol = next() as ProtocolMode;
        break;
      case '--tcp-port':
        options.tcpPort = Number(next());
        break;
      case '--udp-port':
        options.udpPort = Number(next());
        break;
      case '--local-host':
        options.localHost = next();
        break;
      case '--haproxy':
        options.haproxy = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function validate(options: ClientCliOptions): void {
  if (!['tcp', 'udp', 'both'].includes(options.protocol)) {
    throw new Error('--protocol must be tcp, udp, or both');
  }
  if (!options.relay?.trim()) {
    throw new Error('--relay <ip:port> is required');
  }
  if ((options.protocol === 'tcp' || options.protocol === 'both') && !isPort(options.tcpPort)) {
    throw new Error('--tcp-port <port> is required for TCP sharing');
  }
  if ((options.protocol === 'udp' || options.protocol === 'both') && !isPort(options.udpPort)) {
    throw new Error('--udp-port <port> is required for UDP sharing');
  }
}

function isPort(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function printHelp(): void {
  console.log(`FerrumProxy Client

Usage:
  bun run src/clientCli.ts --protocol <tcp|udp|both> [options]

Options:
  --relay <ip:port>     FerrumProxy relay control endpoint (optional)
  --token <token>       Relay authentication token (optional)
  --protocol <mode>     tcp, udp, or both (default: tcp)
  --local-host <host>   Local service host (default: 127.0.0.1)
  --tcp-port <port>     Local TCP service port
  --udp-port <port>     Local UDP service port
  --haproxy             Use HAProxy PROXY protocol v2
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  validate(options);

  console.log('FerrumProxy Client starting...');
  console.log(`  Protocol: ${options.protocol}`);
  if (options.tcpPort) console.log(`  TCP Port: ${options.tcpPort}`);
  if (options.udpPort) console.log(`  UDP Port: ${options.udpPort}`);
  if (options.haproxy) console.log(`  HAProxy: enabled`);

  const client = new RelayShareClient({
    relayAddress: options.relay!,
    token: options.token,
    protocol: options.protocol,
    localHost: options.localHost || '127.0.0.1',
    tcpLocalPort: options.tcpPort,
    udpLocalPort: options.udpPort,
  });

  client.on('status', (status: RelayShareStatus) => {
    process.stdout.write(
      `\r  TCP tunnels: ${status.tcpTunnels} | ` +
      `UDP tunnel: ${status.udpTunnel ? 'ready' : 'down'} | ` +
      `In: ${formatBytes(status.bytesIn)} Out: ${formatBytes(status.bytesOut)}  `
    );
  });
  client.on('log', (message) => {
    process.stdout.write(`\n${message}\n`);
  });

  try {
    const endpoint = await client.start();
    console.log(`\nShared service started successfully!`);
    console.log(`  Public URL: ${endpoint.display}`);
    console.log(`  Relay: ${options.relay}`);
    console.log(`  Local: ${options.localHost || '127.0.0.1'}`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  } catch (error) {
    console.error(`Failed to start shared service: ${(error as Error).message}`);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.stop();
    console.log('Stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

main().catch((error) => {
  console.error(error.message);
  printHelp();
  process.exit(1);
});
