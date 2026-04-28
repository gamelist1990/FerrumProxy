type ProtocolMode = 'tcp' | 'udp' | 'both';

interface ClientCliOptions {
  relay?: string;
  token?: string;
  protocol: ProtocolMode;
  tcpPort?: number;
  udpPort?: number;
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
  if (!options.relay) {
    throw new Error('--relay <ip:port> is required');
  }
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
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function printHelp(): void {
  console.log(`FerrumProxy Client

Usage:
  bun run src/clientCli.ts --relay <ip:port> --protocol <tcp|udp|both> [options]

Options:
  --relay <ip:port>     FerrumProxy relay control endpoint
  --token <token>       Relay authentication token
  --protocol <mode>     tcp, udp, or both
  --tcp-port <port>     Local TCP service port
  --udp-port <port>     Local UDP service port
  --haproxy             Ask the relay/client tunnel to use HAProxy PROXY protocol
`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  validate(options);
  console.log('FerrumProxy Client configuration accepted.');
  console.log(JSON.stringify(options, null, 2));
  console.log('Tunnel transport implementation will connect this client to the configured relay.');
} catch (error) {
  console.error((error as Error).message);
  printHelp();
  process.exit(1);
}
