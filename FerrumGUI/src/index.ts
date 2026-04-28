import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
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
} from './downloader.js';



const PORT = process.env.PORT || 3000;
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

function isRequestHttps(req: express.Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
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
  app.use(express.static(path.join(appRoot, 'public')));
}


const clients: Set<WebSocket> = new Set();

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


processManager.on('log', (instanceId: string, type: string, message: string) => {
  broadcast({
    type: 'log',
    instanceId,
    logType: type,
    message,
    timestamp: new Date().toISOString(),
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

          const useSudo = await shouldStartWithSudo(fresh);

          const pid = processManager.start(instanceId, {
            binaryPath: fresh.binaryPath,
            workingDirectory: fresh.dataDir,
            useSudo,
          });

          await serviceManager.setPid(instanceId, pid);
          configManager.watch(instanceId, fresh.configPath);

          
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

    const isValid = await serviceManager.verifyAuth(username, password);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

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

    res.json({ platform, nodePlatform: process.platform, arch: process.arch });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/instances', async (req, res) => {
  try {
    const instances = serviceManager.getAll();
    res.json(instances);
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
    const assetName = getPlatformAssetName(platform, version);
    const binaryPath = path.join(dataDir, assetName);
    const configPath = path.join(instanceDir, 'config.yml');

    await fs.mkdir(instanceDir, { recursive: true });
    await configManager.write(configPath, createDefaultConfig());

    
    const release = await getReleaseByVersion(version);
    const asset = release.assets.find((a) => a.name === assetName);

    if (!asset) {
      return res.status(404).json({ error: `Asset ${assetName} not found in release ${version}` });
    }

    
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
      const useSudo = await shouldStartWithSudo(instance);

      const pid = processManager.start(instanceId, {
        binaryPath: instance.binaryPath,
        workingDirectory: instance.dataDir,
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

    const useSudo = await shouldStartWithSudo(instance);

    const pid = processManager.start(instanceId, {
      binaryPath: instance.binaryPath,
      workingDirectory: instance.dataDir,
      useSudo,
    });

    await serviceManager.setPid(instanceId, pid);

    
    configManager.watch(instanceId, instance.configPath);

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

    const useSudo = await shouldStartWithSudo(instance);
    if (processManager.isRunning(instanceId)) {
      markIntentionalStop(instanceId);
    }

    const pid = await processManager.restart(instanceId, {
      binaryPath: instance.binaryPath,
      workingDirectory: instance.dataDir,
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
      return res.status(409).json({
        error: 'FerrumProxy REST API is disabled. Enable useRestApi to collect live performance metrics.',
        restApiEnabled: false,
      });
    }

    const endpoint = config.endpoint || 6000;
    const response = await fetch(`http://127.0.0.1:${endpoint}/api/performance`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `FerrumProxy performance endpoint returned ${response.status}`,
        restApiEnabled: true,
      });
    }

    const performance = await response.json();
    res.json({
      ...performance,
      instanceId,
      pid: processManager.getPid(instanceId),
      restApiEnabled: true,
      sampledAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


app.put('/api/instances/:id', async (req, res) => {
  try {
    const instanceId = req.params.id;
    const instance = serviceManager.getById(instanceId);

    if (!instance) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const { name, autoStart, autoRestart } = req.body as {
      name?: string;
      autoStart?: boolean;
      autoRestart?: boolean;
    };

    const updates: any = {};
    if (typeof name === 'string') updates.name = name.trim();
    if (typeof autoStart === 'boolean') updates.autoStart = autoStart;
    if (typeof autoRestart === 'boolean') updates.autoRestart = autoRestart;

    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await serviceManager.update(instanceId, updates);

    broadcast({ type: 'instanceUpdated', instanceId, updates });

    
    broadcast({ type: 'instances', data: serviceManager.getAll() });

    res.json({ success: true });
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

    const config = req.body;

    const validation = await configManager.validate(config);
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
      hasUpdate: instance.version !== latestRelease.version,
      asset: latestRelease.assets.find((a) => a.name === getPlatformAssetName(instance.platform, latestRelease.version)),
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

    const assetName = getPlatformAssetName(instance.platform, targetVersion);
    const binaryPath = path.join(instance.dataDir, 'data', assetName);

    
    const release = await getReleaseByVersion(targetVersion);
    const asset = release.assets.find((a) => a.name === assetName);

    if (!asset) {
      return res.status(404).json({ error: `Asset ${assetName} not found in release ${targetVersion}` });
    }

    
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

    
    await serviceManager.load();
    console.log(chalk.green(`✓ Loaded ${serviceManager.getAll().length} instances`));

    
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
          const useSudo = await shouldStartWithSudo(instance);
          const pid = processManager.start(instance.id, {
            binaryPath: instance.binaryPath,
            workingDirectory: instance.dataDir,
            useSudo,
          });

          await serviceManager.setPid(instance.id, pid);
          configManager.watch(instance.id, instance.configPath);

          broadcast({ type: 'instanceStarted', instanceId: instance.id, pid });
          broadcast({ type: 'instances', data: serviceManager.getAll() });
        }
      } catch (err: any) {
        console.warn(chalk.yellow(`  Failed to auto-start ${instance.name}: ${err?.message || err}`));
      }
    }

    server.listen(PORT, () => {
      const scheme = useHttps ? 'https' : 'http';
      console.log(chalk.green(`✓ Server running on port ${PORT}`));
      console.log(chalk.green(`✓ WebSocket server running on port ${PORT}`));
      console.log(chalk.blue(`\n  Local: ${scheme}://localhost:${PORT}/\n`));
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
