import { SharedServiceManager, SharedServiceStartRequest } from './sharedServiceManager';

type ProtocolMode = 'tcp' | 'udp' | 'both';

interface ClientCliOptions {
  relay?: string;
  token?: string;
  protocol: ProtocolMode;
  tcpPort?: number;
  udpPort?: number;
  publicHost?: string;
  bindHost?: string;
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
      case '--public-host':
        options.publicHost = next();
        break;
      case '--bind-host':
        options.bindHost = next();
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
  --tcp-port <port>     Local TCP service port
  --udp-port <port>     Local UDP service port
  --public-host <host>  Public host to advertise (default: 127.0.0.1)
  --bind-host <host>    Bind host for listeners (default: 0.0.0.0)
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

  const manager = new SharedServiceManager();

  const request: SharedServiceStartRequest = {
    name: 'CLI Shared Service',
    publicHost: options.publicHost || '127.0.0.1',
    bindHost: options.bindHost || '0.0.0.0',
    haproxy: options.haproxy,
  };

  if (options.protocol === 'tcp' || options.protocol === 'both') {
    request.tcp = {
      enabled: true,
      localPort: options.tcpPort,
    };
  }

  if (options.protocol === 'udp' || options.protocol === 'both') {
    request.udp = {
      enabled: true,
      localPort: options.udpPort,
    };
  }

  manager.on('change', (status) => {
    const stats = status.stats;
    process.stdout.write(
      `\r  TCP: ${stats.activeTcpConnections} active / ${stats.totalTcpConnections} total | ` +
      `UDP: ${stats.activeUdpPeers} active / ${stats.totalUdpPeers} total | ` +
      `In: ${formatBytes(stats.bytesIn)} Out: ${formatBytes(stats.bytesOut)}  `
    );
  });

  try {
    const status = await manager.start(request);
    console.log(`\nShared service started successfully!`);
    console.log(`  ID: ${status.id}`);
    if (status.tcp) {
      console.log(`  TCP public port: ${status.tcp.publicPort} -> ${status.tcp.localHost}:${status.tcp.localPort}`);
    }
    if (status.udp) {
      console.log(`  UDP public port: ${status.udp.publicPort} -> ${status.udp.localHost}:${status.udp.localPort}`);
    }
    console.log(`\nPress Ctrl+C to stop.\n`);
  } catch (error) {
    console.error(`Failed to start shared service: ${(error as Error).message}`);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\nShutting down...');
    await manager.stop();
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
