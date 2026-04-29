import { EventEmitter } from 'events';
import net, { Server as TcpServer, Socket } from 'net';
import dgram, { Socket as UdpSocket } from 'dgram';
import { randomUUID } from 'crypto';

type Protocol = 'tcp' | 'udp';

export interface SharedServiceLimits {
  maxTcpConnections: number;
  maxUdpPeers: number;
  maxBytesPerSecond: number;
  idleTimeoutSeconds: number;
  udpSessionTimeoutSeconds: number;
}

export interface SharedServiceStartRequest {
  name?: string;
  publicHost?: string;
  bindHost?: string;
  haproxy?: boolean;
  tcp?: {
    enabled: boolean;
    localHost?: string;
    localPort?: number;
    publicPort?: number;
  };
  udp?: {
    enabled: boolean;
    localHost?: string;
    localPort?: number;
    publicPort?: number;
  };
  limits?: Partial<SharedServiceLimits>;
}

export interface SharedServiceLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  protocol?: Protocol;
  message: string;
  remoteAddress?: string;
}

export interface SharedServiceStatus {
  id: string;
  name: string;
  running: boolean;
  publicHost: string;
  haproxy: boolean;
  tcp?: {
    enabled: boolean;
    publicPort: number;
    localHost: string;
    localPort: number;
  };
  udp?: {
    enabled: boolean;
    publicPort: number;
    localHost: string;
    localPort: number;
  };
  limits: SharedServiceLimits;
  stats: {
    activeTcpConnections: number;
    activeUdpPeers: number;
    totalTcpConnections: number;
    totalUdpPeers: number;
    bytesIn: number;
    bytesOut: number;
    droppedDatagrams: number;
    startedAt: string;
  };
  logs: SharedServiceLogEntry[];
}

interface UdpPeer {
  remoteHost: string;
  remotePort: number;
  localSocket: UdpSocket;
  lastActivity: number;
  proxyHeaderSent: boolean;
}

const DEFAULT_LIMITS: SharedServiceLimits = {
  maxTcpConnections: 32,
  maxUdpPeers: 64,
  maxBytesPerSecond: 10 * 1024 * 1024,
  idleTimeoutSeconds: 120,
  udpSessionTimeoutSeconds: 60,
};

const LOG_LIMIT = 300;
const PROXY_V2_SIGNATURE = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary');
const PROXY_V2_COMMAND = 0x21;
const PROXY_V2_INET_STREAM = 0x11;
const PROXY_V2_INET_DGRAM = 0x12;
const PROXY_V2_INET6_STREAM = 0x21;
const PROXY_V2_INET6_DGRAM = 0x22;

export class SharedServiceManager extends EventEmitter {
  private status?: SharedServiceStatus;
  private tcpServer?: TcpServer;
  private udpServer?: UdpSocket;
  private tcpConnections = new Set<Socket>();
  private udpPeers = new Map<string, UdpPeer>();
  private cleanupTimer?: NodeJS.Timeout;
  private bandwidthWindowStartedAt = Date.now();
  private bandwidthWindowBytes = 0;

  getStatus(): SharedServiceStatus | null {
    return this.status || null;
  }

  async start(request: SharedServiceStartRequest): Promise<SharedServiceStatus> {
    if (this.status?.running) {
      throw new Error('Shared service is already running');
    }

    const tcpEnabled = !!request.tcp?.enabled;
    const udpEnabled = !!request.udp?.enabled;
    if (!tcpEnabled && !udpEnabled) {
      throw new Error('Enable TCP, UDP, or both');
    }

    const limits = this.normalizeLimits(request.limits);
    const publicHost = request.publicHost?.trim() || '127.0.0.1';
    const bindHost = request.bindHost?.trim() || '0.0.0.0';
    const startedAt = new Date().toISOString();

    this.status = {
      id: randomUUID(),
      name: request.name?.trim() || 'Shared Service',
      running: true,
      publicHost,
      haproxy: !!request.haproxy,
      limits,
      stats: {
        activeTcpConnections: 0,
        activeUdpPeers: 0,
        totalTcpConnections: 0,
        totalUdpPeers: 0,
        bytesIn: 0,
        bytesOut: 0,
        droppedDatagrams: 0,
        startedAt,
      },
      logs: [],
    };

    try {
      if (tcpEnabled) {
        const localHost = request.tcp?.localHost?.trim() || '127.0.0.1';
        const localPort = this.requirePort(request.tcp?.localPort, 'TCP local port');
        const publicPort = await this.startTcp(bindHost, request.tcp?.publicPort || 0, localHost, localPort);
        this.status.tcp = { enabled: true, publicPort, localHost, localPort };
      }

      if (udpEnabled) {
        const localHost = request.udp?.localHost?.trim() || '127.0.0.1';
        const localPort = this.requirePort(request.udp?.localPort, 'UDP local port');
        const publicPort = await this.startUdp(bindHost, request.udp?.publicPort || 0, localHost, localPort);
        this.status.udp = { enabled: true, publicPort, localHost, localPort };
      }
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.cleanupTimer = setInterval(() => this.cleanupIdleUdpPeers(), 1000);
    this.log('info', 'share.started', `Shared service started`, undefined);
    this.emitChange();
    return this.cloneStatus();
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const socket of this.tcpConnections) {
      socket.destroy();
    }
    this.tcpConnections.clear();

    for (const peer of this.udpPeers.values()) {
      peer.localSocket.close();
    }
    this.udpPeers.clear();

    if (this.tcpServer) {
      await new Promise<void>((resolve) => this.tcpServer?.close(() => resolve()));
      this.tcpServer = undefined;
    }

    if (this.udpServer) {
      await new Promise<void>((resolve) => this.udpServer?.close(() => resolve()));
      this.udpServer = undefined;
    }

    if (this.status) {
      this.status.running = false;
      this.status.stats.activeTcpConnections = 0;
      this.status.stats.activeUdpPeers = 0;
      this.log('info', 'share.stopped', 'Shared service stopped', undefined);
      this.emitChange();
      this.status = undefined;
    }
  }

  private async startTcp(
    bindHost: string,
    publicPort: number,
    localHost: string,
    localPort: number
  ): Promise<number> {
    const server = net.createServer((remote) => this.handleTcp(remote, localHost, localPort));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(publicPort, bindHost, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.tcpServer = server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve TCP public port');
    }
    return address.port;
  }

  private handleTcp(remote: Socket, localHost: string, localPort: number): void {
    if (!this.status) {
      remote.destroy();
      return;
    }
    remote.setNoDelay(true);

    const remoteAddress = `${remote.remoteAddress || 'unknown'}:${remote.remotePort || 0}`;
    if (this.tcpConnections.size >= this.status.limits.maxTcpConnections) {
      this.log('warn', 'share.limit_reached', 'TCP connection limit reached', 'tcp', remoteAddress);
      remote.destroy();
      return;
    }

    const local = net.createConnection({ host: localHost, port: localPort });
    local.setNoDelay(true);
    if (this.status.haproxy) {
      local.write(
        buildProxyV2Header(
          remote.remoteAddress || '127.0.0.1',
          remote.remotePort || 0,
          remote.localAddress || localHost,
          remote.localPort || localPort,
          false
        )
      );
    }
    this.tcpConnections.add(remote);
    this.status.stats.activeTcpConnections = this.tcpConnections.size;
    this.status.stats.totalTcpConnections += 1;
    this.log('info', 'tcp.accepted', `TCP connection accepted`, 'tcp', remoteAddress);
    this.emitChange();

    const idleMs = this.status.limits.idleTimeoutSeconds * 1000;
    remote.setTimeout(idleMs);
    local.setTimeout(idleMs);
    let closed = false;

    const close = (reason: string) => {
      if (closed) {
        return;
      }
      closed = true;
      remote.destroy();
      local.destroy();
      this.tcpConnections.delete(remote);
      if (this.status) {
        this.status.stats.activeTcpConnections = this.tcpConnections.size;
        this.log('info', 'tcp.closed', `TCP connection closed: ${reason}`, 'tcp', remoteAddress);
        this.emitChange();
      }
    };

    remote.on('data', (chunk) => {
      if (!this.consumeBandwidth(chunk.length)) {
        close('bandwidth limit');
        return;
      }
      this.addBytesIn(chunk.length);
    });
    local.on('data', (chunk) => {
      if (!this.consumeBandwidth(chunk.length)) {
        close('bandwidth limit');
        return;
      }
      this.addBytesOut(chunk.length);
    });

    remote.pipe(local);
    local.pipe(remote);
    remote.on('timeout', () => close('idle timeout'));
    local.on('timeout', () => close('idle timeout'));
    remote.on('error', () => close('remote error'));
    local.on('error', () => close('local error'));
    remote.on('close', () => close('remote close'));
    local.on('close', () => close('local close'));
  }

  private async startUdp(
    bindHost: string,
    publicPort: number,
    localHost: string,
    localPort: number
  ): Promise<number> {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (payload, remote) => {
      this.handleUdp(payload, remote.address, remote.port, localHost, localPort);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(publicPort, bindHost, () => {
        socket.off('error', reject);
        resolve();
      });
    });

    this.udpServer = socket;
    const address = socket.address();
    return address.port;
  }

  private handleUdp(payload: Buffer, remoteHost: string, remotePort: number, localHost: string, localPort: number): void {
    if (!this.status || !this.udpServer) {
      return;
    }

    const peerId = `${remoteHost}:${remotePort}`;
    let peer = this.udpPeers.get(peerId);
    if (!peer) {
      if (this.udpPeers.size >= this.status.limits.maxUdpPeers) {
        this.status.stats.droppedDatagrams += 1;
        this.log('warn', 'share.limit_reached', 'UDP peer limit reached', 'udp', peerId);
        this.emitChange();
        return;
      }

      const localSocket = dgram.createSocket('udp4');
      peer = {
        remoteHost,
        remotePort,
        localSocket,
        lastActivity: Date.now(),
        proxyHeaderSent: false,
      };
      localSocket.on('message', (response) => {
        if (!this.udpServer || !this.consumeBandwidth(response.length)) {
          this.addDroppedDatagram(peerId);
          return;
        }
        this.udpServer.send(response, remotePort, remoteHost);
        this.addBytesOut(response.length);
      });
      localSocket.on('error', () => this.removeUdpPeer(peerId, 'local error'));
      this.udpPeers.set(peerId, peer);
      this.status.stats.activeUdpPeers = this.udpPeers.size;
      this.status.stats.totalUdpPeers += 1;
      this.log('info', 'udp.peer_created', 'UDP peer created', 'udp', peerId);
      this.emitChange();
    }

    peer.lastActivity = Date.now();
    if (!this.consumeBandwidth(payload.length)) {
      this.addDroppedDatagram(peerId);
      return;
    }
    const sendProxyHeader = this.status.haproxy && !peer.proxyHeaderSent;
    peer.proxyHeaderSent = peer.proxyHeaderSent || sendProxyHeader;
    const outbound = sendProxyHeader
      ? Buffer.concat([
          buildProxyV2Header(remoteHost, remotePort, localHost, localPort, true),
          payload,
        ])
      : payload;
    peer.localSocket.send(outbound, localPort, localHost);
    this.addBytesIn(payload.length);
  }

  private cleanupIdleUdpPeers(): void {
    if (!this.status) {
      return;
    }
    const timeoutMs = this.status.limits.udpSessionTimeoutSeconds * 1000;
    const now = Date.now();
    for (const [peerId, peer] of this.udpPeers) {
      if (now - peer.lastActivity >= timeoutMs) {
        this.removeUdpPeer(peerId, 'idle timeout');
      }
    }
  }

  private removeUdpPeer(peerId: string, reason: string): void {
    const peer = this.udpPeers.get(peerId);
    if (!peer) {
      return;
    }
    peer.localSocket.close();
    this.udpPeers.delete(peerId);
    if (this.status) {
      this.status.stats.activeUdpPeers = this.udpPeers.size;
      this.log('info', 'udp.peer_expired', `UDP peer removed: ${reason}`, 'udp', peerId);
      this.emitChange();
    }
  }

  private consumeBandwidth(bytes: number): boolean {
    if (!this.status) {
      return false;
    }
    const now = Date.now();
    if (now - this.bandwidthWindowStartedAt >= 1000) {
      this.bandwidthWindowStartedAt = now;
      this.bandwidthWindowBytes = 0;
    }
    this.bandwidthWindowBytes += bytes;
    if (this.bandwidthWindowBytes > this.status.limits.maxBytesPerSecond) {
      this.log('warn', 'bandwidth.throttled', 'Bandwidth limit exceeded', undefined);
      return false;
    }
    return true;
  }

  private addBytesIn(bytes: number): void {
    if (this.status) {
      this.status.stats.bytesIn += bytes;
    }
  }

  private addBytesOut(bytes: number): void {
    if (this.status) {
      this.status.stats.bytesOut += bytes;
    }
  }

  private addDroppedDatagram(peerId: string): void {
    if (this.status) {
      this.status.stats.droppedDatagrams += 1;
      this.log('warn', 'udp.datagram_dropped', 'UDP datagram dropped', 'udp', peerId);
      this.emitChange();
    }
  }

  private normalizeLimits(limits?: Partial<SharedServiceLimits>): SharedServiceLimits {
    return {
      maxTcpConnections: this.positiveInt(limits?.maxTcpConnections, DEFAULT_LIMITS.maxTcpConnections),
      maxUdpPeers: this.positiveInt(limits?.maxUdpPeers, DEFAULT_LIMITS.maxUdpPeers),
      maxBytesPerSecond: this.positiveInt(limits?.maxBytesPerSecond, DEFAULT_LIMITS.maxBytesPerSecond),
      idleTimeoutSeconds: this.positiveInt(limits?.idleTimeoutSeconds, DEFAULT_LIMITS.idleTimeoutSeconds),
      udpSessionTimeoutSeconds: this.positiveInt(limits?.udpSessionTimeoutSeconds, DEFAULT_LIMITS.udpSessionTimeoutSeconds),
    };
  }

  private positiveInt(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private requirePort(value: number | undefined, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${label} must be a valid port`);
    }
    return value;
  }

  private log(
    level: SharedServiceLogEntry['level'],
    event: string,
    message: string,
    protocol?: Protocol,
    remoteAddress?: string
  ): void {
    if (!this.status) {
      return;
    }
    this.status.logs.push({
      timestamp: new Date().toISOString(),
      level,
      event,
      protocol,
      message,
      remoteAddress,
    });
    if (this.status.logs.length > LOG_LIMIT) {
      this.status.logs.splice(0, this.status.logs.length - LOG_LIMIT);
    }
  }

  private emitChange(): void {
    if (this.status) {
      this.emit('change', this.cloneStatus());
    }
  }

  private cloneStatus(): SharedServiceStatus {
    if (!this.status) {
      throw new Error('Shared service is not running');
    }
    return JSON.parse(JSON.stringify(this.status));
  }
}

function buildProxyV2Header(
  sourceAddress: string,
  sourcePort: number,
  destinationAddress: string,
  destinationPort: number,
  datagram: boolean
): Buffer {
  const source = normalizeIpAddress(sourceAddress);
  const destination = normalizeIpAddress(destinationAddress);
  const sourceBytes = ipToBytes(source);
  const destinationBytes = ipToBytes(destination);
  const sameFamily = sourceBytes.length === destinationBytes.length;
  const useIpv4 = sameFamily && sourceBytes.length === 4;
  const headerLength = useIpv4 ? 12 : 36;
  const header = Buffer.alloc(16 + headerLength);

  PROXY_V2_SIGNATURE.copy(header, 0);
  header[12] = PROXY_V2_COMMAND;
  header[13] = useIpv4
    ? datagram
      ? PROXY_V2_INET_DGRAM
      : PROXY_V2_INET_STREAM
    : datagram
      ? PROXY_V2_INET6_DGRAM
      : PROXY_V2_INET6_STREAM;
  header.writeUInt16BE(headerLength, 14);

  if (useIpv4) {
    sourceBytes.copy(header, 16);
    destinationBytes.copy(header, 20);
    header.writeUInt16BE(clampPort(sourcePort), 24);
    header.writeUInt16BE(clampPort(destinationPort), 26);
  } else {
    const mappedSource = sourceBytes.length === 16 ? sourceBytes : ipv4ToMappedIpv6(sourceBytes);
    const mappedDestination = destinationBytes.length === 16 ? destinationBytes : ipv4ToMappedIpv6(destinationBytes);
    mappedSource.copy(header, 16);
    mappedDestination.copy(header, 32);
    header.writeUInt16BE(clampPort(sourcePort), 48);
    header.writeUInt16BE(clampPort(destinationPort), 50);
  }

  return header;
}

function normalizeIpAddress(address: string): string {
  const trimmed = address.replace(/^::ffff:/, '').trim();
  if (net.isIP(trimmed)) {
    return trimmed;
  }
  return '127.0.0.1';
}

function ipToBytes(address: string): Buffer {
  if (net.isIPv4(address)) {
    return Buffer.from(address.split('.').map((part) => Number(part)));
  }

  const expanded = expandIpv6(address);
  const bytes = Buffer.alloc(16);
  expanded.forEach((part, index) => bytes.writeUInt16BE(parseInt(part, 16) || 0, index * 2));
  return bytes;
}

function expandIpv6(address: string): string[] {
  const [left, right = ''] = address.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const fill = new Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill('0');
  return [...leftParts, ...fill, ...rightParts].map((part) => part.padStart(4, '0'));
}

function ipv4ToMappedIpv6(bytes: Buffer): Buffer {
  const mapped = Buffer.alloc(16);
  mapped[10] = 0xff;
  mapped[11] = 0xff;
  bytes.copy(mapped, 12);
  return mapped;
}

function clampPort(port: number): number {
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}
