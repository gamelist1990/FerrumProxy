import { EventEmitter } from 'events';
import net, { Socket } from 'net';
import dgram, { Socket as UdpSocket } from 'dgram';

type ProtocolMode = 'tcp' | 'udp' | 'both';

export interface RelayShareClientOptions {
  relayAddress: string;
  token?: string;
  protocol: ProtocolMode;
  localHost: string;
  tcpLocalPort?: number;
  udpLocalPort?: number;
}

export interface RelayPublicEndpoint {
  protocol: string;
  host: string;
  port: number;
  display: string;
}

export interface RelayShareStatus {
  relayAddress: string;
  endpoint: RelayPublicEndpoint | null;
  tcpTunnels: number;
  udpTunnel: boolean;
  bytesIn: number;
  bytesOut: number;
}

interface UdpPeer {
  socket: UdpSocket;
  target: { host: string; port: number };
}

const TCP_TUNNEL_POOL_SIZE = 8;
const TCP_RECONNECT_DELAY_MS = 250;
const UDP_RECONNECT_DELAY_MS = 500;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15000;
const TCP_TUNNEL_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const TCP_ACTIVE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RELAY_HEARTBEAT_INTERVAL_MS = 15000;
const RELAY_HEARTBEAT_TIMEOUT_MS = 5000;

export class RelayShareClient extends EventEmitter {
  private stopped = false;
  private sockets = new Set<Socket>();
  private udpSockets = new Set<UdpSocket>();
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnecting?: Promise<void>;
  private generation = 0;
  private status: RelayShareStatus;

  constructor(private readonly options: RelayShareClientOptions) {
    super();
    this.status = {
      relayAddress: options.relayAddress,
      endpoint: null,
      tcpTunnels: 0,
      udpTunnel: false,
      bytesIn: 0,
      bytesOut: 0,
    };
  }

  getStatus(): RelayShareStatus {
    return { ...this.status, endpoint: this.status.endpoint ? { ...this.status.endpoint } : null };
  }

  async start(): Promise<RelayPublicEndpoint> {
    this.validate();
    const endpoint = await this.allocateRelayEndpoint();
    this.startTunnelLoops(endpoint.port);
    this.startHeartbeat();
    return endpoint;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const endpoint = this.status.endpoint;
    if (endpoint) {
      try {
        await this.sendRelayCommand(`RELEASE ${endpoint.port}\n`, 3000);
      } catch {
        // Best effort cleanup; sockets below are still closed locally.
      }
    }

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    for (const socket of this.udpSockets) {
      socket.close();
    }
    this.udpSockets.clear();

    this.status.tcpTunnels = 0;
    this.status.udpTunnel = false;
    this.emitStatus();
  }

  private async allocateRelayEndpoint(): Promise<RelayPublicEndpoint> {
    const target = this.buildRelayTarget();
    const response = await this.sendRelayCommand(`CONNECT ${target}\n`, 0);
    const { host, port } = parseConnectResponse(response);
    const protocol = this.options.protocol === 'both' ? 'tcp/udp' : this.options.protocol;
    const endpoint = {
      protocol,
      host,
      port,
      display: `${protocol}: ${host}:${port}`,
    };

    this.status.endpoint = endpoint;
    this.emitStatus();
    return endpoint;
  }

  private buildRelayTarget(): string {
    const portForAllocation =
      this.options.protocol === 'udp' ? this.options.udpLocalPort : this.options.tcpLocalPort;
    if (!portForAllocation) {
      throw new Error('local port is required');
    }

    return this.options.token?.trim()
      ? `${this.options.token.trim()}:${this.options.localHost}:${portForAllocation}`
      : `${this.options.localHost}:${portForAllocation}`;
  }

  private startTunnelLoops(publicPort: number): void {
    const generation = ++this.generation;

    if (this.options.protocol === 'tcp' || this.options.protocol === 'both') {
      for (let index = 0; index < TCP_TUNNEL_POOL_SIZE; index += 1) {
        void this.runTcpTunnelLoop(publicPort, generation);
      }
    }

    if (this.options.protocol === 'udp' || this.options.protocol === 'both') {
      void this.runUdpTunnelLoop(publicPort, generation);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      void this.checkRelayHeartbeat();
    }, RELAY_HEARTBEAT_INTERVAL_MS);
  }

  private async checkRelayHeartbeat(): Promise<void> {
    if (this.stopped || this.reconnecting) {
      return;
    }

    try {
      const response = await this.sendRelayCommand('PING\n', RELAY_HEARTBEAT_TIMEOUT_MS);
      if (response.trim() !== 'PONG') {
        throw new Error(`unexpected heartbeat response: ${response.trim() || 'empty'}`);
      }
    } catch (error) {
      this.emit('log', `Relay heartbeat failed; refreshing allocation: ${(error as Error).message}`);
      this.reconnecting = this.refreshRelayAllocation();
      try {
        await this.reconnecting;
      } finally {
        this.reconnecting = undefined;
      }
    }
  }

  private async refreshRelayAllocation(): Promise<void> {
    const previousEndpoint = this.status.endpoint;
    this.generation += 1;

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    this.status.tcpTunnels = 0;
    this.status.udpTunnel = false;
    this.emitStatus();

    if (previousEndpoint) {
      try {
        await this.sendRelayCommand(`RELEASE ${previousEndpoint.port}\n`, 3000);
      } catch {
        // The relay may already be gone; CONNECT below recreates the allocation.
      }
    }

    const endpoint = await this.allocateRelayEndpoint();
    this.startTunnelLoops(endpoint.port);
  }

  private validate(): void {
    if (!this.options.relayAddress.trim()) {
      throw new Error('relay address is required');
    }
    if (!['tcp', 'udp', 'both'].includes(this.options.protocol)) {
      throw new Error('protocol must be tcp, udp, or both');
    }
    if ((this.options.protocol === 'tcp' || this.options.protocol === 'both') && !isPort(this.options.tcpLocalPort)) {
      throw new Error('TCP local port is required');
    }
    if ((this.options.protocol === 'udp' || this.options.protocol === 'both') && !isPort(this.options.udpLocalPort)) {
      throw new Error('UDP local port is required');
    }
  }

  private async runTcpTunnelLoop(publicPort: number, generation: number): Promise<void> {
    while (!this.stopped && generation === this.generation) {
      try {
        await this.openTcpTunnel(publicPort);
      } catch (error) {
        if (!this.stopped && generation === this.generation) {
          this.emit('log', `TCP tunnel reconnecting: ${(error as Error).message}`);
          await sleep(TCP_RECONNECT_DELAY_MS);
        }
      }
    }
  }

  private async openTcpTunnel(publicPort: number): Promise<void> {
    const tunnel = await connectTcp(this.options.relayAddress, 5000);
    this.trackSocket(tunnel);
    await writeAll(tunnel, `TUNNEL ${publicPort}\n`);
    const start = await readExact(tunnel, 6, TCP_TUNNEL_WAIT_TIMEOUT_MS);
    if (start.toString() !== 'START\n') {
      tunnel.destroy();
      throw new Error('relay rejected TCP tunnel');
    }

    const local = await connectTcp(`${this.options.localHost}:${this.options.tcpLocalPort}`, 5000);
    this.trackSocket(local);
    this.status.tcpTunnels += 1;
    this.emitStatus();

    await pipeBidirectional(
      tunnel,
      local,
      (bytes) => {
        this.status.bytesIn += bytes;
        this.emitStatus();
      },
      (bytes) => {
        this.status.bytesOut += bytes;
        this.emitStatus();
      },
      TCP_ACTIVE_IDLE_TIMEOUT_MS
    );

    this.untrackSocket(tunnel);
    this.untrackSocket(local);
    this.status.tcpTunnels = Math.max(0, this.status.tcpTunnels - 1);
    this.emitStatus();
  }

  private async runUdpTunnelLoop(publicPort: number, generation: number): Promise<void> {
    while (!this.stopped && generation === this.generation) {
      try {
        await this.openUdpTunnel(publicPort);
      } catch (error) {
        if (!this.stopped && generation === this.generation) {
          this.emit('log', `UDP tunnel reconnecting: ${(error as Error).message}`);
          await sleep(UDP_RECONNECT_DELAY_MS);
        }
      }
    }
  }

  private async openUdpTunnel(publicPort: number): Promise<void> {
    const tunnel = await connectTcp(this.options.relayAddress, 5000);
    this.trackSocket(tunnel);
    await writeAll(tunnel, `UDP_TUNNEL ${publicPort}\n`);
    const ready = await readExact(tunnel, 6);
    if (ready.toString() !== 'READY\n') {
      tunnel.destroy();
      throw new Error('relay rejected UDP tunnel');
    }

    this.status.udpTunnel = true;
    this.emitStatus();
    const peers = new Map<string, UdpPeer>();

    try {
      while (!this.stopped) {
        const frame = await readUdpFrame(tunnel);
        this.status.bytesIn += frame.payload.length;
        this.emitStatus();
        const peerKey = frame.remote.toString();
        let peer = peers.get(peerKey);
        if (!peer) {
          peer = await this.createUdpPeer(tunnel, frame.remote);
          peers.set(peerKey, peer);
        }
        peer.socket.send(frame.payload, peer.target.port, peer.target.host);
      }
    } finally {
      for (const peer of peers.values()) {
        this.untrackUdpSocket(peer.socket);
        peer.socket.close();
      }
      this.untrackSocket(tunnel);
      this.status.udpTunnel = false;
      this.emitStatus();
    }
  }

  private async createUdpPeer(tunnel: Socket, remote: string): Promise<UdpPeer> {
    const socket = dgram.createSocket('udp4');
    const target = {
      host: this.options.localHost,
      port: this.options.udpLocalPort!,
    };
    this.trackUdpSocket(socket);

    socket.on('message', (payload) => {
      if (this.stopped || tunnel.destroyed) {
        return;
      }
      const frame = encodeUdpFrame(remote, payload);
      tunnel.write(frame);
      this.status.bytesOut += payload.length;
      this.emitStatus();
    });

    socket.on('error', (error) => {
      this.emit('log', `UDP local socket error for ${remote}: ${error.message}`);
    });

    await new Promise<void>((resolve) => socket.bind(0, '0.0.0.0', resolve));
    return { socket, target };
  }

  private async sendRelayCommand(command: string, readTimeoutMs: number): Promise<string> {
    const socket = await connectTcp(this.options.relayAddress, 5000);
    this.trackSocket(socket);
    try {
      await writeAll(socket, command);
      return await readUntilCloseOrLine(socket, readTimeoutMs);
    } finally {
      this.untrackSocket(socket);
      socket.destroy();
    }
  }

  private trackSocket(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private untrackSocket(socket: Socket): void {
    this.sockets.delete(socket);
  }

  private trackUdpSocket(socket: UdpSocket): void {
    this.udpSockets.add(socket);
    socket.once('close', () => this.udpSockets.delete(socket));
  }

  private untrackUdpSocket(socket: UdpSocket): void {
    this.udpSockets.delete(socket);
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}

function isPort(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parseConnectResponse(response: string): { host: string; port: number } {
  const trimmed = response.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3 || parts[0] !== 'OK') {
    throw new Error(trimmed || 'relay returned an empty response');
  }
  const fallbackPort = Number(parts[1]);
  const endpoint = parts[2];
  const separator = endpoint.lastIndexOf(':');
  if (!Number.isInteger(fallbackPort) || fallbackPort < 1 || fallbackPort > 65535 || separator < 1) {
    throw new Error(`relay returned invalid endpoint: ${trimmed}`);
  }
  const port = Number(endpoint.slice(separator + 1));
  return {
    host: endpoint.slice(0, separator),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallbackPort,
  };
}

function connectTcp(address: string, timeoutMs: number): Promise<Socket> {
  const separator = address.lastIndexOf(':');
  if (separator < 1) {
    return Promise.reject(new Error(`invalid address: ${address}`));
  }
  const host = address.slice(0, separator);
  const port = Number(address.slice(separator + 1));
  if (!isPort(port)) {
    return Promise.reject(new Error(`invalid port in address: ${address}`));
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${address} did not respond`));
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function writeAll(socket: Socket, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function readExact(socket: Socket, length: number, timeoutMs = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            socket.destroy();
            reject(new Error('socket read timed out'));
          }, timeoutMs)
        : undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        cleanup();
        const extra = buffer.subarray(length);
        if (extra.length > 0) {
          socket.unshift(extra);
        }
        resolve(buffer.subarray(0, length));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function readUntilCloseOrLine(socket: Socket, readTimeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    const timer =
      readTimeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            resolve(output.toString());
          }, readTimeoutMs)
        : undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('end', onClose);
    };
    const onData = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.includes(0x0a)) {
        cleanup();
        resolve(output.toString());
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve(output.toString());
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onClose);
  });
}

function pipeBidirectional(
  left: Socket,
  right: Socket,
  leftToRightBytes: (bytes: number) => void,
  rightToLeftBytes: (bytes: number) => void,
  idleTimeoutMs = 0
): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs > 0) {
        idleTimer = setTimeout(close, idleTimeoutMs);
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      left.destroy();
      right.destroy();
      resolve();
    };
    left.on('data', (chunk) => {
      resetIdleTimer();
      leftToRightBytes(chunk.length);
    });
    right.on('data', (chunk) => {
      resetIdleTimer();
      rightToLeftBytes(chunk.length);
    });
    resetIdleTimer();
    left.pipe(right);
    right.pipe(left);
    left.once('close', close);
    right.once('close', close);
    left.once('error', close);
    right.once('error', close);
  });
}

async function readUdpFrame(socket: Socket): Promise<{ remote: string; payload: Buffer }> {
  const addrLength = (await readExact(socket, 2)).readUInt16BE(0);
  const remote = (await readExact(socket, addrLength)).toString();
  const payloadLength = (await readExact(socket, 4)).readUInt32BE(0);
  const payload = await readExact(socket, payloadLength);
  return { remote, payload };
}

function encodeUdpFrame(remote: string, payload: Buffer): Buffer {
  const remoteBytes = Buffer.from(remote);
  const frame = Buffer.alloc(2 + remoteBytes.length + 4 + payload.length);
  frame.writeUInt16BE(remoteBytes.length, 0);
  remoteBytes.copy(frame, 2);
  frame.writeUInt32BE(payload.length, 2 + remoteBytes.length);
  payload.copy(frame, 2 + remoteBytes.length + 4);
  return frame;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
