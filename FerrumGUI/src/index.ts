import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { createServer as createNetServer } from 'net';
import path from 'path';
import fs from 'fs/promises';
import os from 'node:os';
import { randomBytes, randomUUID } from 'crypto';
import chalk from 'chalk';
import { ServiceManager, FerrumProxyInstance, FerrumProxyPlatform } from './services.js';
import { ProcessManager } from './processManager.js';
import { ConfigManager, FerrumProxyConfig } from './configManager.js';
import { AuthManager } from './authManager.js';
import {
  getLatestRelease,
  getReleaseByVersion,
  getAllReleases,
  isGitHubRateLimited,
  downloadBinary,
  setExecutablePermissions,
  getPlatformAssetName,
  resolveAssetForPlatform,
} from './downloader.js';
import {
  cleanupOldBinary,
  fetchLatestGuiRelease,
  getCurrentGuiVersion,
  isSelfUpdateSupported,
  performGuiSelfUpdate,
  compareVersions,
} from './selfUpdate.js';



const PORT = process.env.PORT || 3000;
const cliArgs = new Set(Bun.argv.slice(2));
const PRIVATE_MODE =
  cliArgs.has('--private') ||
  cliArgs.has('--localhost') ||
  (process.env.FERRUMPROXYGUI_PRIVATE || '').toLowerCase() === 'true';
const BIND_HOST = PRIVATE_MODE
  ? '127.0.0.1'
  : process.env.HOST || process.env.FERRUMPROXYGUI_HOST || '0.0.0.0';
const embeddedFiles = Array.isArray(Bun.embeddedFiles) ? Bun.embeddedFiles : [];
const isCompiled = embeddedFiles.length > 0;
const mainDir = path.dirname(Bun.main);
const mainDirName = path.basename(mainDir).toLowerCase();
const appRoot = isCompiled
  ? process.cwd()
  : mainDirName === 'src' || mainDirName === 'dist'
  ? path.dirname(mainDir)
  : mainDir;

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send([
      'User-agent: *',
      'Disallow: /',
      '',
    ].join('\n'));
});

const tlsCertPath = process.env.FERRUMPROXYGUI_TLS_CERT || process.env.HTTPS_CERT_PATH;
const tlsKeyPath = process.env.FERRUMPROXYGUI_TLS_KEY || process.env.HTTPS_KEY_PATH;
const useHttps = !!tlsCertPath && !!tlsKeyPath;
const server = useHttps
  ? createHttpsServer({
      cert: await fs.readFile(tlsCertPath),
      key: await fs.readFile(tlsKeyPath),
    }, app)
  : createHttpServer(app);
const wss = new WebSocketServer({ server });

const serviceManager = new ServiceManager(path.join(appRoot, 'services.json'));
const processManager = new ProcessManager();
const configManager = new ConfigManager();
const authManager = new AuthManager(serviceManager);
const MANAGER_PORT_START = readPositiveIntegerEnv('FERRUMPROXYGUI_MANAGER_PORT_START', 37000);
const MANAGER_PORT_END = readPositiveIntegerEnv('FERRUMPROXYGUI_MANAGER_PORT_END', 37999);

function isRequestHttps(req: express.Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function isManagerProxyPath(pathname: string): boolean {
  return /^\/api\/instances\/[^/]+\/manager\//.test(pathname);
}

function getManagerApiArgs(instance: FerrumProxyInstance): string[] {
  if (!instance.managerPort || !instance.managerToken) {
    return [];
  }
  return [
    '--manager-port',
    String(instance.managerPort),
    '--manager-token',
    instance.managerToken,
  ];
}

function parseBindPort(bind: string | undefined): number | undefined {
  if (!bind) {
    return undefined;
  }

  const match = bind.match(/:(\d+)$/);
  if (!match) {
    return undefined;
  }

  const port = Number.parseInt(match[1], 10);
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function parseHostPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
  const hostPort = withoutScheme.split('/')[0] || withoutScheme;
  const index = hostPort.lastIndexOf(':');
  if (index <= 0 || index === hostPort.length - 1) {
    return null;
  }
  const host = hostPort.slice(0, index).trim().replace(/^\[|\]$/g, '');
  const port = Number.parseInt(hostPort.slice(index + 1), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host: host.toLowerCase(), port };
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

type ManagerPerformanceSnapshot = {
  total_active_sessions?: number;
  tcp?: { active_sessions?: number };
  udp?: { active_sessions?: number };
};

type HostLoadSnapshot = {
  loadRate: number;
  loadPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  cpuCores: number;
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  uptimeSeconds: number;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}

async function collectHostLoad(): Promise<HostLoadSnapshot> {
  const first = readCpuTimes();
  await delay(800);
  const second = readCpuTimes();
  const idleDelta = Math.max(0, second.idle - first.idle);
  const totalDelta = Math.max(1, second.total - first.total);
  const cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));

  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const memoryPercent =
    memoryTotal > 0 ? Math.max(0, Math.min(100, (memoryUsed / memoryTotal) * 100)) : 0;
  const [load1, load5, load15] = os.loadavg();
  const cpuCores = os.cpus().length;

  const blendedPercent = Math.max(0, Math.min(100, cpuPercent * 0.75 + memoryPercent * 0.25));
  return {
    loadRate: blendedPercent / 100,
    loadPercent: Math.round(blendedPercent * 10) / 10,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryPercent: Math.round(memoryPercent * 10) / 10,
    cpuCores,
    loadAverage1m: Math.round(load1 * 100) / 100,
    loadAverage5m: Math.round(load5 * 100) / 100,
    loadAverage15m: Math.round(load15 * 100) / 100,
    memoryTotalBytes: memoryTotal,
    memoryUsedBytes: memoryUsed,
    memoryFreeBytes: memoryFree,
    uptimeSeconds: Math.max(0, Math.floor(os.uptime())),
  };
}

function relayMatchesConfig(relayAddress: string, config: FerrumProxyConfig): boolean {
  const relay = parseHostPort(relayAddress);
  if (!relay) {
    return false;
  }

  const shared = config.sharedService;
  if (!shared?.enabled) {
    return false;
  }

  const publicPort = parseBindPort(shared.publicBind);
  if (publicPort && relay.port !== publicPort) {
    return false;
  }

  const configuredHost = normalizeHostCandidate(shared.publicHost).toLowerCase();
  if (!configuredHost || isLocalHost(configuredHost)) {
    return true;
  }

  return configuredHost === relay.host;
}

function normalizeHostCandidate(value: string | undefined): string {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return '';
  }

  try {
    return new URL(trimmed).hostname;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').split('/')[0] || trimmed;
  }
}

function isLocalHost(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function getIpInfoTarget(req: express.Request, publicHost?: string): string | null {
  const host = normalizeHostCandidate(publicHost);
  if (host && !isLocalHost(host)) {
    return host;
  }

  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = (raw || req.socket.remoteAddress || '').split(',')[0]?.trim() || '';
  const normalized = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (!normalized || isLocalHost(normalized)) {
    return null;
  }
  return normalized;
}

function parseIpInfoLoc(loc?: string): { latitude?: number; longitude?: number } {
  if (!loc) {
    return {};
  }
  const [latRaw, lngRaw] = loc.split(',').map((value) => value.trim());
  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {};
  }
  return { latitude, longitude };
}

async function resolveLocationFromIpInfo(
  target: string | null
): Promise<
  | {
      region?: string;
      countryCode?: string;
      latitude?: number;
      longitude?: number;
    }
  | null
> {
  if (!IPINFO_ENABLED) {
    return null;
  }

  const baseUrl = IPINFO_BASE_URL.replace(/\/+$/, '');
  const path = target ? `/${encodeURIComponent(target)}/json` : '/json';
  const url = new URL(`${baseUrl}${path}`);
  if (IPINFO_TOKEN) {
    url.searchParams.set('token', IPINFO_TOKEN);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IPINFO_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const data = (await response.json().catch(() => null)) as
      | {
          region?: string;
          country?: string;
          loc?: string;
        }
      | null;
    if (!data) {
      return null;
    }

    const region = typeof data.region === 'string' ? data.region.trim() : '';
    const countryCode = typeof data.country === 'string' ? data.country.trim().toUpperCase() : '';
    const { latitude, longitude } = parseIpInfoLoc(typeof data.loc === 'string' ? data.loc : undefined);

    if (!region && !countryCode && latitude == null && longitude == null) {
      return null;
    }

    return {
      region: region || undefined,
      countryCode: countryCode || undefined,
      latitude,
      longitude,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function generateManagerToken(): string {
  return randomBytes(32).toString('base64url');
}

async function canBindLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createNetServer();
    testServer.once('error', () => resolve(false));
    testServer.once('listening', () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port, '127.0.0.1');
  });
}

async function allocateManagerPort(instanceId: string): Promise<number> {
  const usedPorts = new Set(
    serviceManager
      .getAll()
      .filter((instance) => instance.id !== instanceId && typeof instance.managerPort === 'number')
      .map((instance) => instance.managerPort as number)
  );
  const start = Math.min(MANAGER_PORT_START, MANAGER_PORT_END);
  const end = Math.max(MANAGER_PORT_START, MANAGER_PORT_END);

  for (let port = start; port <= end; port += 1) {
    if (usedPorts.has(port)) {
      continue;
    }
    if (await canBindLocalPort(port)) {
      return port;
    }
  }

  throw new Error(`No available Manager API port in range ${start}-${end}`);
}

async function ensureManagerApi(instance: FerrumProxyInstance): Promise<FerrumProxyInstance> {
  if (instance.managerToken && instance.managerPort) {
    return instance;
  }

  const updates: Partial<FerrumProxyInstance> = {};
  if (!instance.managerToken) {
    updates.managerToken = generateManagerToken();
  }
  if (!instance.managerPort) {
    updates.managerPort = await allocateManagerPort(instance.id);
  }

  await serviceManager.update(instance.id, updates);
  const updated = serviceManager.getById(instance.id);
  const next = updated ?? { ...instance, ...updates };
  broadcast({ type: 'instanceUpdated', instanceId: instance.id, updates });
  broadcast({ type: 'instances', data: serviceManager.getAll() });
  return next;
}

function createDefaultConfig(): FerrumProxyConfig {
  return {
    endpoint: 6000,
    useRestApi: true,
    savePlayerIP: true,
    debug: false,
    listeners: [
      {
        bind: '0.0.0.0',
        tcp: 25565,
        udp: 25565,
        haproxy: false,
        https: {
          enabled: false,
          autoDetect: true,
          letsEncryptDomain: 'example.com',
          certPath: './certs/fullchain.pem',
          keyPath: './certs/privkey.pem',
        },
        webhook: '',
        rewriteBedrockPongPorts: true,
        targets: [
          {
            host: '127.0.0.1',
            tcp: 19132,
            udp: 19132,
          },
        ],
      },
    ],
  };
}

type SecurityScope = 'web' | 'api' | 'auth' | 'websocket';

type SecurityState = {
  tokens: number;
  lastRefillAt: number;
  violations: number;
  blockedUntil?: number;
};

const HTTP_RATE_LIMIT_PER_MINUTE = readPositiveIntegerEnv('FERRUMPROXYGUI_RATE_LIMIT_PER_MINUTE', 240);
const HTTP_RATE_LIMIT_BURST = readPositiveIntegerEnv('FERRUMPROXYGUI_RATE_LIMIT_BURST', 80);
const AUTH_RATE_LIMIT_PER_MINUTE = readPositiveIntegerEnv('FERRUMPROXYGUI_AUTH_RATE_LIMIT_PER_MINUTE', 30);
const AUTH_RATE_LIMIT_BURST = readPositiveIntegerEnv('FERRUMPROXYGUI_AUTH_RATE_LIMIT_BURST', 10);
const WEBSOCKET_RATE_LIMIT_PER_MINUTE = readPositiveIntegerEnv('FERRUMPROXYGUI_WEBSOCKET_RATE_LIMIT_PER_MINUTE', 30);
const WEBSOCKET_RATE_LIMIT_BURST = readPositiveIntegerEnv('FERRUMPROXYGUI_WEBSOCKET_RATE_LIMIT_BURST', 12);
const RATE_LIMIT_BLOCK_AFTER = readPositiveIntegerEnv('FERRUMPROXYGUI_RATE_LIMIT_BLOCK_AFTER', 6);
const RATE_LIMIT_BLOCK_MS = readPositiveIntegerEnv('FERRUMPROXYGUI_RATE_LIMIT_BLOCK_MS', 10 * 60 * 1000);
const IPINFO_TOKEN = process.env.FERRUMPROXYGUI_IPINFO_TOKEN || process.env.IPINFO_TOKEN || '';
const IPINFO_BASE_URL = process.env.FERRUMPROXYGUI_IPINFO_BASE_URL || 'https://ipinfo.io';
const IPINFO_TIMEOUT_MS = readPositiveIntegerEnv('FERRUMPROXYGUI_IPINFO_TIMEOUT_MS', 2500);
const IPINFO_ENABLED = (process.env.FERRUMPROXYGUI_IPINFO_ENABLED || 'true').toLowerCase() !== 'false';

const DEFAULT_BLOCKED_USER_AGENT_FRAGMENTS = [
  'curl/',
  'wget/',
  'python-requests',
  'python-httpx',
  'aiohttp',
  'httpx/',
  'go-http-client',
  'java/',
  'libwww-perl',
  'masscan',
  'nmap',
  'nikto',
  'sqlmap',
  'nessus',
  'acunetix',
  'zgrab',
  'w3af',
  'scrapy',
];

const EXTRA_BLOCKED_USER_AGENT_FRAGMENTS = (process.env.FERRUMPROXYGUI_BLOCKED_USER_AGENTS ?? '')
  .split(',')
  .map((fragment) => fragment.trim().toLowerCase())
  .filter(Boolean);

const blockedUserAgentFragments = new Set([
  ...DEFAULT_BLOCKED_USER_AGENT_FRAGMENTS,
  ...EXTRA_BLOCKED_USER_AGENT_FRAGMENTS,
]);

const securityStateByClient = new Map<string, SecurityState>();

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(chalk.yellow(`Ignoring invalid ${name}=${raw}`));
    return fallback;
  }

  return parsed;
}

function getRequestClientKey(req: express.Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function getUpgradeClientKey(req: { socket: { remoteAddress?: string | null } }): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function isBlockedUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent || !userAgent.trim()) {
    return true;
  }

  const normalized = userAgent.toLowerCase();
  return Array.from(blockedUserAgentFragments).some((fragment) => normalized.includes(fragment));
}

function selectSecurityScope(pathname: string): SecurityScope {
  if (pathname.startsWith('/api/auth/')) {
    return 'auth';
  }

  if (pathname.startsWith('/api/')) {
    return 'api';
  }

  return 'web';
}

function getRateLimitPolicy(scope: SecurityScope): { capacity: number; refillPerMs: number } {
  switch (scope) {
    case 'auth':
      return {
        capacity: AUTH_RATE_LIMIT_BURST,
        refillPerMs: AUTH_RATE_LIMIT_PER_MINUTE / 60_000,
      };
    case 'websocket':
      return {
        capacity: WEBSOCKET_RATE_LIMIT_BURST,
        refillPerMs: WEBSOCKET_RATE_LIMIT_PER_MINUTE / 60_000,
      };
    default:
      return {
        capacity: HTTP_RATE_LIMIT_BURST,
        refillPerMs: HTTP_RATE_LIMIT_PER_MINUTE / 60_000,
      };
  }
}

function getSecurityState(clientKey: string, now: number, initialTokens: number): SecurityState {
  const state = securityStateByClient.get(clientKey);
  if (state) {
    return state;
  }

  const created: SecurityState = {
    tokens: initialTokens,
    lastRefillAt: now,
    violations: 0,
  };
  securityStateByClient.set(clientKey, created);
  return created;
}

function pruneExpiredSecurityStates(now: number): void {
  for (const [clientKey, state] of securityStateByClient.entries()) {
    if (state.blockedUntil && state.blockedUntil > now) {
      continue;
    }

    if (now - state.lastRefillAt > 30 * 60 * 1000) {
      securityStateByClient.delete(clientKey);
    }
  }
}

function consumeSecurityToken(clientKey: string, scope: SecurityScope): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  pruneExpiredSecurityStates(now);

  const policy = getRateLimitPolicy(scope);
  const state = getSecurityState(clientKey, now, policy.capacity);
  if (state.blockedUntil && state.blockedUntil > now) {
    return { allowed: false, retryAfterMs: state.blockedUntil - now };
  }

  const elapsed = Math.max(0, now - state.lastRefillAt);
  state.tokens = Math.min(policy.capacity, state.tokens + elapsed * policy.refillPerMs);
  state.lastRefillAt = now;

  if (state.tokens < 1) {
    state.violations += 1;
    if (state.violations >= RATE_LIMIT_BLOCK_AFTER) {
      state.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
      return { allowed: false, retryAfterMs: RATE_LIMIT_BLOCK_MS };
    }

    return { allowed: false, retryAfterMs: Math.ceil((1 - state.tokens) / policy.refillPerMs) };
  }

  state.tokens -= 1;
  if (state.violations > 0) {
    state.violations -= 1;
  }

  return { allowed: true };
}

function rejectSuspiciousRequest(
  req: express.Request,
  res: express.Response,
  status: number,
  message: string,
  retryAfterMs?: number
): void {
  if (retryAfterMs) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
    return;
  }

  res.status(status).type('text/plain').send(message);
}

function rejectSuspiciousUpgrade(socket: { write: (chunk: string) => void; destroy: () => void }, message: string): void {
  socket.write(
    'HTTP/1.1 403 Forbidden\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  );
  socket.destroy();
}

function securityGuard(scopeOverride?: SecurityScope) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const clientKey = getRequestClientKey(req);
    const userAgent = req.get('user-agent');
    const scope = scopeOverride ?? selectSecurityScope(req.path);

    if (!isManagerProxyPath(req.path) && isBlockedUserAgent(userAgent)) {
      console.warn(chalk.yellow(`Blocked suspicious user agent from ${clientKey}: ${userAgent || '<empty>'}`));
      rejectSuspiciousRequest(req, res, 403, 'Forbidden');
      return;
    }

    const result = consumeSecurityToken(clientKey, scope);
    if (!result.allowed) {
      console.warn(chalk.yellow(`Rate limited ${clientKey} on ${scope}`));
      rejectSuspiciousRequest(req, res, 429, 'Too Many Requests', result.retryAfterMs);
      return;
    }

    next();
  };
}


app.use(securityGuard());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(authManager.authMiddleware());

let embeddedIndexBlob: Blob | undefined;

if (isCompiled) {

  // 開発環境では使わんので無視する
  // @ts-ignore Bun compile-time embedded files module
  await import('./embed-files.ts');
  console.log(chalk.blue('Using embedded static files'));

  const staticRoutes: Record<string, Blob> = {};
  for (const blob of embeddedFiles) {
    
    let name = (blob as any).name as string;

    if (name.startsWith('public/')) {
      name = name.substring(7);
    }

    staticRoutes[`/${name}`] = blob;
    if (name === 'index.html') {
      embeddedIndexBlob = blob;
    }

    
    if (name === 'favicon.svg') {
      staticRoutes['/favicon.ico'] = blob;
      staticRoutes['/favicon.png'] = blob;
    }

    if (name.startsWith('index-')) {
      staticRoutes[`/assets/${name}`] = blob;
    }

    console.log(chalk.gray(`Embedded: /${name} (${blob.size} bytes)`));
  }

  app.use(async (req, res, next) => {
    let requestPath = req.path;

    
    if (requestPath === '/') {
      requestPath = '/index.html';
    }

    const blob = staticRoutes[requestPath];

    if (blob) {
      const content = await blob.arrayBuffer();
      const buffer = Buffer.from(content);

      
      let contentType = 'application/octet-stream';
      if (requestPath.endsWith('.html')) contentType = 'text/html';
      else if (requestPath.endsWith('.js')) contentType = 'application/javascript';
      else if (requestPath.endsWith('.css')) contentType = 'text/css';
      else if (requestPath.endsWith('.json')) contentType = 'application/json';
      else if (requestPath.endsWith('.svg')) contentType = 'image/svg+xml';
      else if (requestPath.endsWith('.ico')) contentType = 'image/x-icon';
      else if (requestPath.endsWith('.png')) contentType = 'image/png';
      else if (requestPath.endsWith('.jpg') || requestPath.endsWith('.jpeg')) contentType = 'image/jpeg';

      res.setHeader('Content-Type', contentType);
      res.send(buffer);
    } else {
      next();
    }
  });
} else {
  
  console.log(chalk.blue('Using regular public directory'));
  app.use(express.static(path.join(appRoot, 'public'), {
    index: 'index.html',
    setHeaders: (res) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
    },
  }));
}


const clients: Set<WebSocket> = new Set();

server.prependListener('upgrade', (req, socket) => {
  const clientKey = getUpgradeClientKey(req);
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader.join(' ') : userAgentHeader;

  if (isBlockedUserAgent(userAgent)) {
    console.warn(chalk.yellow(`Blocked suspicious websocket user agent from ${clientKey}: ${userAgent || '<empty>'}`));
    rejectSuspiciousUpgrade(socket, 'Forbidden');
    return;
  }

  const result = consumeSecurityToken(clientKey, 'websocket');
  if (!result.allowed) {
    console.warn(chalk.yellow(`Rate limited websocket upgrade from ${clientKey}`));
    const message = 'Too Many Requests';
    if (result.retryAfterMs) {
      socket.end(
        'HTTP/1.1 429 Too Many Requests\r\n' +
        'Connection: close\r\n' +
        `Retry-After: ${String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)))}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
      );
      return;
    }

    rejectSuspiciousUpgrade(socket, message);
  }
});

wss.on('connection', (ws) => {
  console.log(chalk.green('WebSocket client connected'));
  clients.add(ws);

  ws.on('close', () => {
    console.log(chalk.yellow('WebSocket client disconnected'));
    clients.delete(ws);
  });

  
  ws.send(JSON.stringify({
    type: 'instances',
    data: serviceManager.getAll(),
  }));
});


function broadcast(message: any) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

async function shouldStartWithSudo(instance: FerrumProxyInstance): Promise<boolean> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return false;
  }

  const isPrivilegedPort = (port?: number) => typeof port === 'number' && port > 0 && port < 1024;

  try {
    const config = await configManager.read(instance.configPath);
    if (isPrivilegedPort(config.endpoint)) {
      return true;
    }

    return (config.listeners || []).some((listener) => (
      isPrivilegedPort(listener.tcp) || isPrivilegedPort(listener.udp)
    ));
  } catch (error: any) {
    console.warn(chalk.yellow(`Could not inspect config for sudo decision: ${error.message}`));
    return false;
  }
}


processManager.on('log', (instanceId: string, type: string, message: string, timestamp?: string) => {
  broadcast({
    type: 'log',
    instanceId,
    logType: type,
    message,
    timestamp: timestamp || new Date().toISOString(),
  });
});


const restartAttempts: Map<string, { count: number; firstAttemptAt: number }> = new Map();
const intentionalStops: Set<string> = new Set();

function markIntentionalStop(instanceId: string): void {
  intentionalStops.add(instanceId);
  restartAttempts.delete(instanceId);
}

processManager.on('exit', async (instanceId: string, code: number, signal: string) => {
  
  const instance = serviceManager.getById(instanceId);
  if (instance) {
    await serviceManager.setPid(instanceId, undefined);
  }

  broadcast({
    type: 'processExit',
    instanceId,
    code,
    signal,
  });

  
  broadcast({
    type: 'instances',
    data: serviceManager.getAll(),
  });

  
  try {
    if (intentionalStops.delete(instanceId)) {
      console.log(`Auto-restart: skipped ${instanceId} because it was stopped intentionally`);
      return;
    }

    if (instance && instance.autoRestart) {
      const now = Date.now();
      const info = restartAttempts.get(instanceId) || { count: 0, firstAttemptAt: now };

      
      if (now - info.firstAttemptAt > 60_000) {
        info.count = 0;
        info.firstAttemptAt = now;
      }

      if (info.count >= 5) {
        
        console.warn(`Auto-restart: giving up restarting ${instanceId} after ${info.count} attempts`);
        broadcast({ type: 'autoRestartFailed', instanceId, attempts: info.count });
        return;
      }

      info.count += 1;
      restartAttempts.set(instanceId, info);

      const backoffMs = 1000 * info.count; 
      console.log(`Auto-restart: will attempt to restart ${instanceId} in ${backoffMs}ms (attempt ${info.count})`);
      setTimeout(async () => {
        try {
          
          const fresh = serviceManager.getById(instanceId);
          if (!fresh) return;

          
          if (processManager.isRunning(instanceId)) {
            restartAttempts.delete(instanceId);
            return;
          }

          const startInstance = await ensureManagerApi(fresh);
          const useSudo = await shouldStartWithSudo(startInstance);

          const pid = processManager.start(instanceId, {
            binaryPath: startInstance.binaryPath,
            workingDirectory: startInstance.dataDir,
            args: getManagerApiArgs(startInstance),
            useSudo,
          });

          await serviceManager.setPid(instanceId, pid);
          configManager.watch(instanceId, startInstance.configPath);

          
          restartAttempts.delete(instanceId);

          broadcast({ type: 'instanceStarted', instanceId, pid });
          broadcast({ type: 'instances', data: serviceManager.getAll() });
          console.log(`Auto-restart: restarted ${instanceId} (PID ${pid})`);
        } catch (err: any) {
          console.error(`Auto-restart: failed to restart ${instanceId}: ${err.message}`);
          
          broadcast({ type: 'autoRestartError', instanceId, message: err.message });
        }
      }, backoffMs);
    }
  } catch (err: any) {
    console.error('Auto-restart: unexpected error', err.message);
  }
});

processManager.on('error', (instanceId: string, error: Error) => {
  broadcast({
    type: 'processError',
    instanceId,
    error: error.message,
  });
});


configManager.on('change', (instanceId: string, config: any) => {
  broadcast({
    type: 'configChange',
    instanceId,
    config,
  });
});




app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const loginAttempt = authManager.canAttemptLogin(username);
    if (!loginAttempt.allowed) {
      if (loginAttempt.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(loginAttempt.retryAfterMs / 1000))));
      }
      return res.status(429).json({ error: 'Too many failed login attempts', retryAfterMs: loginAttempt.retryAfterMs });
    }

    const isValid = await serviceManager.verifyAuth(username, password);

    if (!isValid) {
      const failure = authManager.registerFailedLogin(username);
      if (failure.blocked && failure.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))));
        return res.status(429).json({ error: 'Too many failed login attempts', retryAfterMs: failure.retryAfterMs });
      }

      return res.status(401).json({ error: 'Invalid credentials' });
    }

    authManager.clearFailedLogins(username);

    const token = authManager.createSession(username);
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, 
      sameSite: 'strict',
      secure: isRequestHttps(req),
    });

    res.json({ success: true, token });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session || req.headers['x-session-token'];
  if (token) {
    authManager.deleteSession(token as string);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/auth/status', async (req, res) => {
  try {
    const hasAuth = serviceManager.hasAuth();
    const token = req.cookies?.session || req.headers['x-session-token'];
    const isAuthenticated = token ? authManager.validateSession(token as string) : false;

    res.json({
      hasAuth,
      isAuthenticated: !hasAuth || isAuthenticated,
      requireAuth: hasAuth && !isAuthenticated,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    
    if (serviceManager.hasAuth()) {
      return res.status(403).json({ error: 'Auth already configured' });
    }

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    await serviceManager.setAuth(username, password);

    const token = authManager.createSession(username);
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'strict',
      secure: isRequestHttps(req),
    });

    res.json({ success: true, token });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const auth = serviceManager.getAuth();
    if (!auth || auth.password !== currentPassword) {
      return res.status(401).json({ error: 'Invalid current password' });
    }

    await serviceManager.setAuth(auth.username, newPassword);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/system', async (req, res) => {
  try {
    
    let platform: FerrumProxyPlatform = 'linux';

    if (process.platform === 'win32') {
      platform = 'windows';
    } else if (process.platform === 'darwin') {
      platform = 'macos-arm64';
    } else if (process.platform === 'linux') {
      platform = process.arch === 'arm64' ? 'linux-arm64' : 'linux';
    }

    res.json({
      platform,
      nodePlatform: process.platform,
      arch: process.arch,
      guiVersion: getCurrentGuiVersion(),
      selfUpdateSupported: isSelfUpdateSupported(isCompiled),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 現在の GUI バージョンと GitHub 上の最新版を返す
app.get('/api/self/version', async (_req, res) => {
  try {
    const current = getCurrentGuiVersion();
    const selfUpdateSupported = isSelfUpdateSupported(isCompiled);
    let latest: Awaited<ReturnType<typeof fetchLatestGuiRelease>> = null;
    try {
      latest = await fetchLatestGuiRelease();
    } catch (err: any) {
      // 取得失敗しても current だけは返す
      return res.json({
        current,
        latest: null,
        hasUpdate: false,
        selfUpdateSupported,
        error: err.message,
      });
    }
    const hasUpdate =
      selfUpdateSupported &&
      !!latest &&
      compareVersions(latest.version, current) > 0;
    res.json({ current, latest, hasUpdate, selfUpdateSupported });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GUI 本体を最新版に差し替えて再起動する
app.post('/api/self/update', async (_req, res) => {
  if (!isSelfUpdateSupported(isCompiled)) {
    return res.status(400).json({
      error:
        'Self-update is only available on compiled binaries (dev mode is unsupported)',
    });
  }
  try {
    const result = await performGuiSelfUpdate(isCompiled, (downloaded, total) => {
      broadcast({
        type: 'guiUpdateProgress',
        downloaded,
        total,
        percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
      });
    });
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    broadcast({
      type: 'guiUpdateReady',
      version: result.version,
      restartInMs: result.restartInMs,
    });
    res.json({
      success: true,
      version: result.version,
      restartInMs: result.restartInMs,
      message: `Updated to v${result.version}. Restarting in ${result.restartInMs} ms.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances', async (req, res) => {
  try {
    const instances = serviceManager.getAll();
    const allowSensitive = !serviceManager.hasAuth() || requestHasValidGuiSession(req);
    if (allowSensitive) {
      return res.json(instances);
    }

    if (!requestHasAnyManagerBearer(req)) {
      return res.status(401).json({ error: 'Unauthorized', requireAuth: true });
    }

    const redacted = instances.map((instance) => ({
      id: instance.id,
      name: instance.name,
      managerPort: instance.managerPort,
    }));
    return res.json(redacted);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances/:id', async (req, res) => {
  try {
    const instance = serviceManager.getById(req.params.id);
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    res.json(instance);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/instances', async (req, res) => {
  try {
    let { name, platform, version } = req.body;

    if (!name || !platform || !version) {
      return res.status(400).json({ error: 'Missing required fields: name, platform, version' });
    }

    
    if (version === 'latest') {
      const latestRelease = await getLatestRelease();
      version = latestRelease.version;
    }

    const instanceId = randomUUID();
    const instanceDir = path.join(appRoot, 'instances', instanceId);
    const dataDir = path.join(instanceDir, 'data');
    const configPath = path.join(instanceDir, 'config.yml');

    await fs.mkdir(instanceDir, { recursive: true });
    await configManager.write(configPath, createDefaultConfig());

    // version.json.assets[].platform で解決する（アセット名にバージョン埋め込み前提を廃止）
    const release = await getReleaseByVersion(version);
    const asset = resolveAssetForPlatform(release, platform);

    if (!asset) {
      return res.status(404).json({
        error: `No asset for platform '${platform}' in release ${release.version}`,
      });
    }

    const assetName = asset.name;
    const binaryPath = path.join(dataDir, assetName);

    
    await downloadBinary(asset.downloadUrl, binaryPath, (downloaded, total) => {
      broadcast({
        type: 'downloadProgress',
        instanceId,
        downloaded,
        total,
        percentage: Math.round((downloaded / total) * 100),
      });
    });

    
    await setExecutablePermissions(binaryPath);

    
    const instance: FerrumProxyInstance = {
      id: instanceId,
      name,
      version,
      platform,
      binaryPath,
      dataDir: instanceDir, 
      configPath,
      autoStart: false,
      autoRestart: false,
      managerPort: await allocateManagerPort(instanceId),
      managerToken: generateManagerToken(),
      downloadSource: {
        url: asset.downloadUrl
      },
    };

    await serviceManager.add(instance);

    broadcast({
      type: 'instanceAdded',
      instance,
    });

    
    console.log(chalk.blue(`Initializing instance ${instanceId}...`));
    broadcast({
      type: 'instanceInitializing',
      instanceId,
    });

    try {
      const startInstance = await ensureManagerApi(instance);
      const useSudo = await shouldStartWithSudo(startInstance);

      const pid = processManager.start(instanceId, {
        binaryPath: startInstance.binaryPath,
        workingDirectory: startInstance.dataDir,
        args: getManagerApiArgs(startInstance),
        useSudo,
      });

      
      await new Promise(resolve => setTimeout(resolve, 2000));

      
      if (processManager.isRunning(instanceId)) {
        markIntentionalStop(instanceId);
        processManager.stop(instanceId);
        console.log(chalk.green(`✓ Instance initialized and stopped`));
      }
    } catch (error: any) {
      console.warn(chalk.yellow(`Warning: Could not initialize instance: ${error.message}`));
    }

    broadcast({
      type: 'instanceInitialized',
      instanceId,
    });

    res.json(instance);
  } catch (error: any) {
    console.error(chalk.red(`Error creating instance: ${error.message}`));

    if (error.message && error.message.includes('rate limit')) {
      broadcast({
        type: 'rateLimitError',
        message: 'GitHub APIのレート制限に達しました。新規インスタンスの作成と更新確認ができません。しばらく待ってから再度試してください。',
      });
      return res.status(429).json({
        error: 'GitHub APIレート制限に達しました。新規インスタンスの作成ができません。',
        rateLimited: true,
      });
    }

    res.status(500).json({ error: error.message });
  }
});


app.delete('/api/instances/:id', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    
    if (processManager.isRunning(instanceId)) {
      markIntentionalStop(instanceId);
      processManager.stop(instanceId, true);
    }

    
    configManager.unwatch(instanceId);

    
    await serviceManager.remove(instanceId);

    
    try {
      await fs.rm(instance.dataDir, { recursive: true, force: true });
      console.log(chalk.green(`✓ Deleted instance directory: ${instance.dataDir}`));
    } catch (error: any) {
      console.warn(chalk.yellow(`Warning: Could not delete instance directory: ${error.message}`));
    }

    broadcast({
      type: 'instanceRemoved',
      instanceId,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/instances/:id/start', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (processManager.isRunning(instanceId)) {
      return res.status(400).json({ error: 'Instance is already running' });
    }

    const startInstance = await ensureManagerApi(instance);
    const useSudo = await shouldStartWithSudo(startInstance);

    const pid = processManager.start(instanceId, {
      binaryPath: startInstance.binaryPath,
      workingDirectory: startInstance.dataDir,
      args: getManagerApiArgs(startInstance),
      useSudo,
    });

    await serviceManager.setPid(instanceId, pid);

    
    configManager.watch(instanceId, startInstance.configPath);

    broadcast({
      type: 'instanceStarted',
      instanceId,
      pid,
    });

    
    broadcast({
      type: 'instances',
      data: serviceManager.getAll(),
    });

    res.json({ success: true, pid });
  } catch (error: any) {
    console.error('Start instance error:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  }
});


app.post('/api/instances/:id/stop', async (req, res) => {
  try {
    const instanceId = req.params.id;

    if (!processManager.isRunning(instanceId)) {
      return res.status(400).json({ error: 'Instance is not running' });
    }

    markIntentionalStop(instanceId);
    processManager.stop(instanceId);

    
    await serviceManager.setPid(instanceId, undefined);

    
    configManager.unwatch(instanceId);

    broadcast({
      type: 'instanceStopped',
      instanceId,
    });

    
    broadcast({
      type: 'instances',
      data: serviceManager.getAll(),
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/instances/:id/restart', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const startInstance = await ensureManagerApi(instance);
    const useSudo = await shouldStartWithSudo(startInstance);
    if (processManager.isRunning(instanceId)) {
      markIntentionalStop(instanceId);
    }

    const pid = await processManager.restart(instanceId, {
      binaryPath: startInstance.binaryPath,
      workingDirectory: startInstance.dataDir,
      args: getManagerApiArgs(startInstance),
      useSudo,
    });

    await serviceManager.setPid(instanceId, pid);

    broadcast({
      type: 'instanceRestarted',
      instanceId,
      pid,
    });

    
    broadcast({
      type: 'instances',
      data: serviceManager.getAll(),
    });

    res.json({ success: true, pid });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances/:id/logs', async (req, res) => {
  try {
    const instanceId = req.params.id;
    let limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    const logs = processManager.getLogs(instanceId, limit);
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances/:id/config', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const config = await configManager.read(instance.configPath);
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instances/:id/public-metadata', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const config = await configManager.read(instance.configPath);
    const sharedService = config.sharedService;
    const portRange = sharedService?.portRange;

    const currentMetadata = instance.publicMetadata;
    let location = {
      region: currentMetadata?.region || '',
      countryCode: currentMetadata?.countryCode || '',
      latitude: currentMetadata?.latitude,
      longitude: currentMetadata?.longitude,
    };

    const missingLocation =
      !location.region ||
      !location.countryCode ||
      location.latitude == null ||
      location.longitude == null;

    if (missingLocation) {
      const target = getIpInfoTarget(req, sharedService?.publicHost);
      const ipInfoLocation = await resolveLocationFromIpInfo(target);
      if (ipInfoLocation) {
        const nextMetadata = {
          region: location.region || ipInfoLocation.region,
          countryCode: location.countryCode || ipInfoLocation.countryCode,
          latitude: location.latitude ?? ipInfoLocation.latitude,
          longitude: location.longitude ?? ipInfoLocation.longitude,
        };

        const changed =
          nextMetadata.region !== currentMetadata?.region ||
          nextMetadata.countryCode !== currentMetadata?.countryCode ||
          nextMetadata.latitude !== currentMetadata?.latitude ||
          nextMetadata.longitude !== currentMetadata?.longitude;

        if (changed) {
          await serviceManager.update(instanceId, {
            publicMetadata: nextMetadata,
          });
        }

        location = {
          region: nextMetadata.region || '',
          countryCode: nextMetadata.countryCode || '',
          latitude: nextMetadata.latitude,
          longitude: nextMetadata.longitude,
        };
      }
    }

    res.json({
      instance: {
        id: instance.id,
        name: instance.name,
        managerPort: instance.managerPort,
        managerTokenConfigured: !!instance.managerToken,
      },
      sharedService: {
        enabled: !!sharedService?.enabled,
        publicHost: sharedService?.publicHost || '',
        publicBind: sharedService?.publicBind || '',
        publicPort: parseBindPort(sharedService?.publicBind),
        portRangeStart: typeof portRange?.start === 'number' ? portRange.start : undefined,
        portRangeEnd: typeof portRange?.end === 'number' ? portRange.end : undefined,
      },
      location,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/instances/:id/public-metadata', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const {
      region,
      countryCode,
      latitude,
      longitude,
    } = req.body as {
      region?: string | null;
      countryCode?: string | null;
      latitude?: number | null;
      longitude?: number | null;
    };

    const nextMetadata = {
      region: typeof region === 'string' ? region.trim() || undefined : instance.publicMetadata?.region,
      countryCode:
        typeof countryCode === 'string'
          ? countryCode.trim().toUpperCase() || undefined
          : instance.publicMetadata?.countryCode,
      latitude:
        latitude == null
          ? instance.publicMetadata?.latitude
          : typeof latitude === 'number' && Number.isFinite(latitude)
            ? latitude
            : undefined,
      longitude:
        longitude == null
          ? instance.publicMetadata?.longitude
          : typeof longitude === 'number' && Number.isFinite(longitude)
            ? longitude
            : undefined,
    };

    await serviceManager.update(instanceId, {
      publicMetadata: nextMetadata,
    });

    const updated = serviceManager.getById(instanceId);
    return res.json({
      success: true,
      publicMetadata: updated?.publicMetadata || nextMetadata,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances/:id/player-ips', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    
    const playerIPPath = path.join(instance.dataDir, 'playerIP.json');

    try {
      
      await fs.access(playerIPPath);

      
      const content = await fs.readFile(playerIPPath, 'utf-8');
      const playerIPs = JSON.parse(content);

      res.json(playerIPs);
    } catch (error: any) {
      
      if (error.code === 'ENOENT') {
        res.json([]);
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instances/:id/performance', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const config = await configManager.read(instance.configPath);
    if (!config.useRestApi) {
      // 200 で「利用不可」を伝える。フロントは Error を投げずに黙って空表示にする。
      return res.json({
        available: false,
        reason: 'rest_api_disabled',
        restApiEnabled: false,
        instanceId,
        sampledAt: new Date().toISOString(),
      });
    }

    if (!processManager.isRunning(instanceId)) {
      return res.json({
        available: false,
        reason: 'not_running',
        restApiEnabled: true,
        instanceId,
        sampledAt: new Date().toISOString(),
      });
    }

    const endpoint = config.endpoint || 6000;
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${endpoint}/api/performance`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch (fetchErr: any) {
      // ECONNREFUSED / AbortError（起動直後 or 再起動中）はエラーではなく「まだ利用できない」扱い。
      // 500 で返すとフロントが 2.5 秒ごとに console にスパムするので 200 で穏やかに返す。
      return res.json({
        available: false,
        reason: fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError'
          ? 'timeout'
          : 'unreachable',
        restApiEnabled: true,
        instanceId,
        sampledAt: new Date().toISOString(),
      });
    }

    if (!response.ok) {
      return res.json({
        available: false,
        reason: 'backend_error',
        backendStatus: response.status,
        restApiEnabled: true,
        instanceId,
        sampledAt: new Date().toISOString(),
      });
    }

    const performance = await response.json() as Record<string, unknown>;
    res.json({
      ...performance,
      available: true,
      instanceId,
      pid: processManager.getPid(instanceId),
      processStartedAt: processManager.getStartedAt(instanceId)?.toISOString() || instance.lastStarted,
      processUptimeSeconds:
        processManager.getUptimeSeconds(instanceId) ??
        (instance.lastStarted
          ? Math.max(0, Math.floor((Date.now() - new Date(instance.lastStarted).getTime()) / 1000))
          : undefined),
      restApiEnabled: true,
      sampledAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/public/shared-relay/status', async (req, res) => {
  try {
    const instanceIdRaw = req.query.instanceId;
    const relayRaw = req.query.relay;
    const instanceId = typeof instanceIdRaw === 'string' ? instanceIdRaw.trim() : '';
    const relayAddress = typeof relayRaw === 'string' ? relayRaw.trim() : '';

    const candidates = instanceId
      ? serviceManager.getAll().filter((instance) => instance.id === instanceId)
      : serviceManager.getAll();

    if (candidates.length === 0) {
      return res.status(404).json({ error: 'Shared relay instance not found' });
    }

    let matchedInstance: FerrumProxyInstance | null = null;
    let matchedConfig: FerrumProxyConfig | null = null;

    for (const candidate of candidates) {
      const config = await configManager.read(candidate.configPath);
      if (!config.sharedService?.enabled) {
        continue;
      }
      if (relayAddress && !relayMatchesConfig(relayAddress, config)) {
        continue;
      }
      matchedInstance = candidate;
      matchedConfig = config;
      break;
    }

    if (!matchedInstance || !matchedConfig) {
      return res.status(404).json({ error: 'No shared relay matched the requested criteria' });
    }

    const hostLoad = await collectHostLoad();
    const restApiEnabled = !!matchedConfig.useRestApi;
    let pingMs: number | null = null;
    let performance: ManagerPerformanceSnapshot | null = null;
    if (restApiEnabled) {
      try {
        const endpoint = matchedConfig.endpoint || 6000;
        const startedAt = Date.now();
        const response = await fetch(`http://127.0.0.1:${endpoint}/api/performance`, {
          signal: AbortSignal.timeout(2200),
        });
        pingMs = Math.max(0, Date.now() - startedAt);
        if (response.ok) {
          performance = (await response.json()) as ManagerPerformanceSnapshot;
        }
      } catch {
        // Keep host load available even if local performance API is temporarily unavailable.
      }
    }

    const activeSessions = toPositiveIntegerOrNull(performance?.total_active_sessions);
    const sharedService = matchedConfig.sharedService;

    return res.json({
      ok: true,
      instanceId: matchedInstance.id,
      instanceName: matchedInstance.name,
      relayAddress: relayAddress || null,
      pingMs,
      loadRate: hostLoad.loadRate,
      loadPercent: hostLoad.loadPercent,
      loadSource: 'host_system',
      hostCpuPercent: hostLoad.cpuPercent,
      hostMemoryPercent: hostLoad.memoryPercent,
      hostMetrics: {
        cpu: {
          usagePercent: hostLoad.cpuPercent,
          cores: hostLoad.cpuCores,
          loadAverage1m: hostLoad.loadAverage1m,
          loadAverage5m: hostLoad.loadAverage5m,
          loadAverage15m: hostLoad.loadAverage15m,
        },
        memory: {
          usagePercent: hostLoad.memoryPercent,
          totalBytes: hostLoad.memoryTotalBytes,
          usedBytes: hostLoad.memoryUsedBytes,
          freeBytes: hostLoad.memoryFreeBytes,
        },
        uptimeSeconds: hostLoad.uptimeSeconds,
        platform: process.platform,
      },
      activeSessions,
      maxSessions: null,
      restApiEnabled,
      sharedService: {
        enabled: !!sharedService?.enabled,
        publicHost: sharedService?.publicHost || '',
        publicBind: sharedService?.publicBind || '',
        publicPort: parseBindPort(sharedService?.publicBind) ?? null,
      },
      location: {
        region: matchedInstance.publicMetadata?.region || '',
        countryCode: matchedInstance.publicMetadata?.countryCode || '',
        latitude:
          typeof matchedInstance.publicMetadata?.latitude === 'number'
            ? matchedInstance.publicMetadata.latitude
            : null,
        longitude:
          typeof matchedInstance.publicMetadata?.longitude === 'number'
            ? matchedInstance.publicMetadata.longitude
            : null,
      },
      sampledAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});


app.put('/api/instances/:id', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const { name, autoStart, autoRestart, managerPort, managerToken } = req.body as {
      name?: string;
      autoStart?: boolean;
      autoRestart?: boolean;
      managerPort?: number | null;
      managerToken?: string | null;
    };

    const updates: any = {};
    if (typeof name === 'string') updates.name = name.trim();
    if (typeof autoStart === 'boolean') updates.autoStart = autoStart;
    if (typeof autoRestart === 'boolean') updates.autoRestart = autoRestart;
    if (managerPort === null) {
      updates.managerPort = undefined;
    } else if (managerPort !== undefined) {
      if (!Number.isInteger(managerPort) || managerPort < 1 || managerPort > 65535) {
        return res.status(400).json({ error: 'managerPort must be a valid port number' });
      }
      updates.managerPort = managerPort;
    }
    if (managerToken === null) {
      updates.managerToken = generateManagerToken();
    } else if (typeof managerToken === 'string') {
      const trimmed = managerToken.trim();
      updates.managerToken = trimmed || generateManagerToken();
    }

    const effectiveManagerToken = Object.prototype.hasOwnProperty.call(updates, 'managerToken')
      ? updates.managerToken
      : instance.managerToken;
    const effectiveManagerPort = Object.prototype.hasOwnProperty.call(updates, 'managerPort')
      ? updates.managerPort
      : instance.managerPort;
    if (effectiveManagerToken && !effectiveManagerPort) {
      updates.managerPort = await allocateManagerPort(instanceId);
    }
    if (!effectiveManagerToken) {
      updates.managerToken = generateManagerToken();
      if (!effectiveManagerPort) {
        updates.managerPort = await allocateManagerPort(instanceId);
      }
    }

    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await serviceManager.update(instanceId, updates);
    const updatedInstance = serviceManager.getById(instanceId);

    broadcast({ type: 'instanceUpdated', instanceId, updates });

    
    broadcast({ type: 'instances', data: serviceManager.getAll() });

    res.json({ success: true, instance: updatedInstance });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.put('/api/instances/:id/config', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    let config = req.body;

    const isSharedRelayMode = !!config.sharedService?.enabled;
    if (isSharedRelayMode) {
      config.listeners = [];
      console.log(chalk.blue('  Shared relay mode: clearing listeners'));
    }

    // Ensure listeners is at least an empty array
    if (!config.listeners) {
      config.listeners = [];
    }

    const validation = await configManager.validate(config, isSharedRelayMode);
    if (!validation.valid) {
      return res.status(400).json({ errors: validation.errors });
    }

    await configManager.write(instance.configPath, config);

    broadcast({
      type: 'configUpdated',
      instanceId,
      config,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function requestHasValidGuiSession(req: express.Request): boolean {
  if (!serviceManager.hasAuth()) {
    return false;
  }
  const token = authManager.sessionTokenFromRequest(req);
  return !!token && authManager.validateSession(token);
}

function managerTokenFromRequest(req: express.Request): string {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length).trim()
    : '';
}

function requestHasAnyManagerBearer(req: express.Request): boolean {
  const token = managerTokenFromRequest(req);
  if (!token) {
    return false;
  }
  return serviceManager.getAll().some((instance) => instance.managerToken === token);
}

function requestHasManagerBearer(req: express.Request, instance: FerrumProxyInstance): boolean {
  const token = managerTokenFromRequest(req);
  return !!instance.managerToken && token === instance.managerToken;
}

app.all('/api/instances/:id/manager/*', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    if (!instance.managerPort || !instance.managerToken) {
      return res.status(400).json({ error: 'Manager API is not configured for this instance' });
    }
    if (!requestHasValidGuiSession(req) && !requestHasManagerBearer(req, instance)) {
      return res.status(401).json({ error: 'Unauthorized', requireAuth: true });
    }

    const managerPath = String((req.params as Record<string, string>)[0] || '');
    if (!managerPath.startsWith('api/v1/')) {
      return res.status(400).json({ error: 'Manager proxy path must start with api/v1/' });
    }

    const url = new URL(`http://127.0.0.1:${instance.managerPort}/${managerPath}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${instance.managerToken}`,
    };
    const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase()) && req.body !== undefined;
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });

    if (response.status === 204) {
      return res.status(204).send();
    }
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/instances/:id/listeners/:index/tls-assets', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const listenerIndex = parseInt(req.params.index, 10);
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    if (!Number.isInteger(listenerIndex) || listenerIndex < 0) {
      return res.status(400).json({ error: 'Invalid listener index' });
    }

    const { certPem, keyPem } = req.body as { certPem?: string; keyPem?: string };
    if (typeof certPem !== 'string' || certPem.trim() === '') {
      return res.status(400).json({ error: 'certPem is required' });
    }
    if (typeof keyPem !== 'string' || keyPem.trim() === '') {
      return res.status(400).json({ error: 'keyPem is required' });
    }

    const tlsDir = path.join(instance.dataDir, 'certs', `listener-${listenerIndex + 1}`);
    await fs.mkdir(tlsDir, { recursive: true });

    const certPath = path.join(tlsDir, 'fullchain.pem');
    const keyPath = path.join(tlsDir, 'privkey.pem');

    await fs.writeFile(certPath, certPem, 'utf-8');
    await fs.writeFile(keyPath, keyPem, 'utf-8');

    res.json({
      success: true,
      certPath,
      keyPath,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/updates/check', async (req, res) => {
  try {
    const latestRelease = await getLatestRelease();
    const instances = serviceManager.getAll();

    const updates = instances.map((instance) => ({
      instanceId: instance.id,
      currentVersion: instance.version,
      latestVersion: latestRelease.version,
      // 固定タグ運用では commit ベースのバージョン（YYYY.MM.DD-<shortcommit>）を等値比較する
      hasUpdate: instance.version !== latestRelease.version,
      asset: resolveAssetForPlatform(latestRelease, instance.platform) ?? undefined,
    }));

    res.json({
      latestRelease,
      updates,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/releases/latest', async (req, res) => {
  try {
    const release = await getLatestRelease();
    res.json(release);
  } catch (error: any) {
    console.error('Failed to fetch latest release:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/releases', async (req, res) => {
  try {
    const releases = await getAllReleases();
    res.json(releases);
  } catch (error: any) {
    console.error('Failed to fetch releases:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/rate-limit-status', async (req, res) => {
  try {
    const isLimited = isGitHubRateLimited();
    res.json({ rateLimited: isLimited });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/instances/:id/update', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const { version, forceReinstall } = req.body;

    const instance = serviceManager.getById(instanceId);
    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    if (processManager.isRunning(instanceId)) {
      console.log(chalk.blue(`Instance ${instanceId} is running — stopping before update...`));
      try {
        markIntentionalStop(instanceId);
        processManager.stop(instanceId, true);

        
        await serviceManager.setPid(instanceId, undefined);

        
        configManager.unwatch(instanceId);

        
        broadcast({ type: 'instanceStopped', instanceId });
        broadcast({ type: 'instances', data: serviceManager.getAll() });

        
        let wait = 0;
        while (processManager.isRunning(instanceId) && wait < 20) {
          
          
          await new Promise((r) => setTimeout(r, 100));
          wait++;
        }
      } catch (err: any) {
        console.warn(chalk.yellow(`Warning: Failed to stop instance ${instanceId} before update: ${err?.message || err}`));
        
        return res.status(500).json({ error: 'Failed to stop instance before update' });
      }
    }

    
    let targetVersion = version;
    if (version === 'latest') {
      const latestRelease = await getLatestRelease();
      targetVersion = latestRelease.version;
    }

    
    if (instance.version === targetVersion && !forceReinstall) {
      return res.status(400).json({ error: 'Instance is already on this version' });
    }

    // version.json.assets[].platform で解決する
    const release = await getReleaseByVersion(targetVersion);
    const asset = resolveAssetForPlatform(release, instance.platform);

    if (!asset) {
      return res.status(404).json({
        error: `No asset for platform '${instance.platform}' in release ${targetVersion}`,
      });
    }

    const assetName = asset.name;
    const binaryPath = path.join(instance.dataDir, 'data', assetName);

    
    try {
      await fs.rm(instance.binaryPath, { force: true });
      console.log(chalk.green(`✓ Removed old binary: ${instance.binaryPath}`));
    } catch (error: any) {
      console.warn(chalk.yellow(`Warning: Could not remove old binary: ${error.message}`));
    }

    
    await downloadBinary(asset.downloadUrl, binaryPath, (downloaded, total) => {
      broadcast({
        type: 'updateProgress',
        instanceId,
        downloaded,
        total,
        percentage: Math.round((downloaded / total) * 100),
      });
    });

    
    await setExecutablePermissions(binaryPath);

    
    instance.version = targetVersion;
    instance.binaryPath = binaryPath;
    instance.downloadSource = {
      url: asset.downloadUrl
    };

    await serviceManager.update(instanceId, instance);

    broadcast({
      type: 'instanceUpdated',
      instanceId,
      version: targetVersion,
    });

    broadcast({
      type: 'instances',
      data: serviceManager.getAll(),
    });

    res.json({ success: true, version: targetVersion });
  } catch (error: any) {
    console.error(chalk.red(`Error updating instance: ${error.message}`));

    if (error.message && error.message.includes('rate limit')) {
      broadcast({
        type: 'rateLimitError',
        message: 'GitHub APIのレート制限に達しました。アップデートができません。しばらく待ってから再度試してください。',
      });
      return res.status(429).json({
        error: 'GitHub APIレート制限に達しました。アップデートができません。',
        rateLimited: true,
      });
    }

    res.status(500).json({ error: error.message });
  }
});

app.get('*', async (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (isCompiled && embeddedIndexBlob) {
    const content = await embeddedIndexBlob.arrayBuffer();
    res.setHeader('Content-Type', 'text/html');
    return res.send(Buffer.from(content));
  }

  res.sendFile(path.join(appRoot, 'public', 'index.html'));
});


async function init() {
  try {
    console.log(chalk.blue('Initializing FerrumProxy GUI...'));
    console.log(chalk.blue(`GUI version: v${getCurrentGuiVersion()}`));

    // 前回のセルフ更新で残った .old バイナリを掃除
    await cleanupOldBinary();

    
    await serviceManager.load();
    console.log(chalk.green(`✓ Loaded ${serviceManager.getAll().length} instances`));
    for (const instance of serviceManager.getAll()) {
      await ensureManagerApi(instance);
    }

    
    const instances = serviceManager.getAll();
    for (const instance of instances) {
      if (instance.pid) {
        try {
          
          process.kill(instance.pid, 0);
          console.log(chalk.gray(`  Instance ${instance.name} (PID: ${instance.pid}) is still running`));
        } catch (error) {
          
          console.log(chalk.yellow(`  Clearing stale PID for ${instance.name} (PID: ${instance.pid})`));
          await serviceManager.setPid(instance.id, undefined);
        }
      }
    }

    
    for (const instance of instances) {
      try {
        if (instance.autoStart && !processManager.isRunning(instance.id)) {
          
          try {
            await fs.access(instance.binaryPath);
          } catch (err) {
            console.log(chalk.yellow(`  Skipping auto-start for ${instance.name}: binary not found at ${instance.binaryPath}`));
            continue;
          }

          console.log(chalk.blue(`Auto-starting instance ${instance.name} (${instance.id})`));
          const startInstance = await ensureManagerApi(instance);
          const useSudo = await shouldStartWithSudo(startInstance);
          const pid = processManager.start(startInstance.id, {
            binaryPath: startInstance.binaryPath,
            workingDirectory: startInstance.dataDir,
            args: getManagerApiArgs(startInstance),
            useSudo,
          });

          await serviceManager.setPid(startInstance.id, pid);
          configManager.watch(startInstance.id, startInstance.configPath);

          broadcast({ type: 'instanceStarted', instanceId: startInstance.id, pid });
          broadcast({ type: 'instances', data: serviceManager.getAll() });
        }
      } catch (err: any) {
        console.warn(chalk.yellow(`  Failed to auto-start ${instance.name}: ${err?.message || err}`));
      }
    }

    server.listen(Number(PORT), BIND_HOST, () => {
      const scheme = useHttps ? 'https' : 'http';
      const displayHost = PRIVATE_MODE ? 'localhost' : BIND_HOST;
      console.log(chalk.green(`✓ Server running on ${displayHost}:${PORT}`));
      console.log(chalk.green(`✓ WebSocket server running on ${displayHost}:${PORT}`));
      console.log(chalk.blue(`\n  Local: ${scheme}://localhost:${PORT}/\n`));
      if (PRIVATE_MODE) {
        console.log(chalk.yellow('✓ Private mode enabled: GUI is bound to localhost only.'));
      } else {
        console.log(chalk.yellow('✓ Public mode enabled: noindex/nofollow headers and robots.txt are active.'));
      }
    });

    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\nShutting down...'));
      processManager.stopAll();
      configManager.unwatchAll();
      await serviceManager.save();
      process.exit(0);
    });
  } catch (error: any) {
    console.error(chalk.red(`Initialization error: ${error.message}`));
    process.exit(1);
  }
}

init();
