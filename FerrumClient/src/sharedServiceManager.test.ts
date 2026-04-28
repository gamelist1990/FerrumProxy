import { afterEach, expect, test } from 'bun:test';
import net from 'net';
import dgram from 'dgram';
import { SharedServiceManager } from './sharedServiceManager';

const managers: SharedServiceManager[] = [];
const proxyV2Signature = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary');

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.stop()));
  managers.length = 0;
});

async function startTcpEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind TCP echo server');
  }

  return {
    port: address.port,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startUdpEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (payload, remote) => {
    socket.send(payload, remote.port, remote.address);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });

  return {
    port: socket.address().port,
    stop: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}

test('shared service forwards TCP traffic and records stats', async () => {
  const echo = await startTcpEchoServer();
  const manager = new SharedServiceManager();
  managers.push(manager);

  const status = await manager.start({
    publicHost: '127.0.0.1',
    bindHost: '127.0.0.1',
    tcp: { enabled: true, localPort: echo.port },
    limits: { idleTimeoutSeconds: 5 },
  });

  expect(status.tcp?.publicPort).toBeGreaterThan(0);

  const response = await new Promise<Buffer>((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port: status.tcp!.publicPort });
    client.once('error', reject);
    client.once('data', (chunk) => {
      client.end();
      resolve(chunk);
    });
    client.write(Buffer.from('hello tcp'));
  });

  expect(response.toString()).toBe('hello tcp');
  expect(manager.getStatus()?.stats.totalTcpConnections).toBe(1);
  expect(manager.getStatus()?.stats.bytesIn).toBeGreaterThan(0);
  await echo.stop();
});

test('shared service forwards UDP traffic and tracks peer sessions', async () => {
  const echo = await startUdpEchoServer();
  const manager = new SharedServiceManager();
  managers.push(manager);

  const status = await manager.start({
    publicHost: '127.0.0.1',
    bindHost: '127.0.0.1',
    udp: { enabled: true, localPort: echo.port },
    limits: { udpSessionTimeoutSeconds: 5 },
  });

  expect(status.udp?.publicPort).toBeGreaterThan(0);

  const client = dgram.createSocket('udp4');
  const response = await new Promise<Buffer>((resolve, reject) => {
    client.once('error', reject);
    client.once('message', (payload) => {
      client.close();
      resolve(payload);
    });
    client.send(Buffer.from('hello udp'), status.udp!.publicPort, '127.0.0.1');
  });

  expect(response.toString()).toBe('hello udp');
  expect(manager.getStatus()?.stats.totalUdpPeers).toBe(1);
  expect(manager.getStatus()?.stats.bytesIn).toBeGreaterThan(0);
  await echo.stop();
});

test('shared service can prepend HAProxy PROXY v2 headers for TCP', async () => {
  const received = new Promise<Buffer>((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        socket.end();
        server.close();
        resolve(chunk);
      });
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('failed to bind TCP server');
      }

      const manager = new SharedServiceManager();
      managers.push(manager);
      const status = await manager.start({
        publicHost: '127.0.0.1',
        bindHost: '127.0.0.1',
        haproxy: true,
        tcp: { enabled: true, localPort: address.port },
      });

      const client = net.createConnection({ host: '127.0.0.1', port: status.tcp!.publicPort });
      client.write(Buffer.from('payload'));
      client.end();
    });
  });

  const data = await received;
  expect(data.subarray(0, proxyV2Signature.length).equals(proxyV2Signature)).toBe(true);
  expect(data.includes(Buffer.from('payload'))).toBe(true);
});

test('shared service rejects invalid protocol configuration', async () => {
  const manager = new SharedServiceManager();
  managers.push(manager);

  await expect(manager.start({ tcp: { enabled: false }, udp: { enabled: false } })).rejects.toThrow(
    'Enable TCP, UDP, or both'
  );
});
