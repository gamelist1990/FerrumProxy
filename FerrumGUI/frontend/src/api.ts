export type FerrumProxyPlatform = 'linux' | 'linux-arm64' | 'macos-arm64' | 'windows';

export interface FerrumProxyInstance {
  id: string;
  name: string;
  version: string;
  platform: FerrumProxyPlatform;
  binaryPath: string;
  dataDir: string;
  configPath: string;
  pid?: number;
  lastStarted?: string;
  autoStart: boolean;
  autoRestart: boolean;
  downloadSource: {
    url: string;
  };
}

export interface LogEntry {
  timestamp: string;
  type: 'stdout' | 'stderr' | 'system';
  message: string;
}

export interface ListenerConfig {
  bind?: string;
  tcp?: number;
  udp?: number;
  haproxy?: boolean;
  https?: {
    enabled?: boolean;
    autoDetect?: boolean;
    letsEncryptDomain?: string;
    certPath?: string;
    keyPath?: string;
  };
  webhook?: string;
  rewriteBedrockPongPorts?: boolean;
  target?: ProxyTargetConfig;
  targets?: ProxyTargetConfig[];
  httpMappings?: Array<{
    path?: string;
    target?: ProxyTargetConfig;
    targets?: ProxyTargetConfig[];
  }>;
}

export interface ProxyTargetConfig {
    host?: string;
    tcp?: number;
    udp?: number;
}

export interface FerrumProxyConfig {
  endpoint?: number;
  useRestApi?: boolean;
  savePlayerIP?: boolean;
  debug?: boolean;
  listeners?: Array<ListenerConfig>;
}

export interface PlayerIPEntry {
  username: string;
  ips: Array<{
    ip: string;
    protocol: string;
    lastSeen: number;
  }>;
}

export interface ProtocolPerformanceMetrics {
  activeSessions: number;
  totalSessions: number;
  bytesClientToTarget: number;
  bytesTargetToClient: number;
  totalBytes: number;
}

export interface PerformanceMetrics {
  instanceId: string;
  pid?: number;
  uptimeSeconds: number;
  totalActiveSessions: number;
  totalSessions: number;
  totalBytes: number;
  tcp: ProtocolPerformanceMetrics;
  udp: ProtocolPerformanceMetrics;
  restApiEnabled: boolean;
  sampledAt: string;
}

export interface Release {
  version: string;
  tag: string;
  publishedAt: string;
  assets: Array<{
    name: string;
    url: string;
    downloadUrl: string;
    size: number;
  }>;
}


const API_BASE = '/api';

export async function fetchInstances(): Promise<FerrumProxyInstance[]> {
  const res = await fetch(`${API_BASE}/instances`);
  if (!res.ok) throw new Error('Failed to fetch instances');
  return res.json();
}

export async function fetchInstance(id: string): Promise<FerrumProxyInstance> {
  const res = await fetch(`${API_BASE}/instances/${id}`);
  if (!res.ok) throw new Error('Failed to fetch instance');
  return res.json();
}

export async function createInstance(data: {
  name: string;
  platform: string;
  version: string;
}): Promise<FerrumProxyInstance> {
  const res = await fetch(`${API_BASE}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create instance');
  return res.json();
}

export async function deleteInstance(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to delete instance' }));
    throw new Error(error.error || 'Failed to delete instance');
  }
}

export async function startInstance(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}/start`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to start instance' }));
    throw new Error(error.error || 'Failed to start instance');
  }
}

export async function stopInstance(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}/stop`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to stop instance' }));
    throw new Error(error.error || 'Failed to stop instance');
  }
}

export async function restartInstance(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}/restart`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to restart instance' }));
    throw new Error(error.error || 'Failed to restart instance');
  }
}

export async function fetchLogs(id: string, limit?: number): Promise<LogEntry[]> {
  const url = limit ? `${API_BASE}/instances/${id}/logs?limit=${limit}` : `${API_BASE}/instances/${id}/logs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch logs');
  return res.json();
}

export async function fetchConfig(id: string): Promise<FerrumProxyConfig> {
  const res = await fetch(`${API_BASE}/instances/${id}/config`);
  if (!res.ok) throw new Error('Failed to fetch config');
  return res.json();
}

export async function updateConfig(id: string, config: FerrumProxyConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.errors?.join(', ') || 'Failed to update config');
  }
}

export async function uploadListenerTlsAssets(
  id: string,
  listenerIndex: number,
  payload: { certPem: string; keyPem: string }
): Promise<{ certPath: string; keyPath: string }> {
  const res = await fetch(`${API_BASE}/instances/${id}/listeners/${listenerIndex}/tls-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to upload TLS assets' }));
    throw new Error(error.error || 'Failed to upload TLS assets');
  }
  return res.json();
}

export async function fetchPlayerIPs(id: string): Promise<PlayerIPEntry[]> {
  const res = await fetch(`${API_BASE}/instances/${id}/player-ips`);
  if (!res.ok) throw new Error('Failed to fetch player IPs');
  return res.json();
}

export async function fetchPerformance(id: string): Promise<PerformanceMetrics> {
  const res = await fetch(`${API_BASE}/instances/${id}/performance`);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to fetch performance metrics' }));
    throw new Error(error.error || 'Failed to fetch performance metrics');
  }
  return res.json();
}

export async function updateInstance(id: string, version: string, forceReinstall = false): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, forceReinstall }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to update instance' }));
    throw new Error(error.error || 'Failed to update instance');
  }
}

export async function updateInstanceMetadata(
  id: string,
  data: { name?: string; autoStart?: boolean; autoRestart?: boolean }
): Promise<void> {
  const res = await fetch(`${API_BASE}/instances/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update instance' }));
    throw new Error(err.error || 'Failed to update instance');
  }
}

export async function fetchLatestRelease(): Promise<Release> {
  const res = await fetch(`${API_BASE}/releases/latest`);
  if (!res.ok) throw new Error('Failed to fetch latest release');
  return res.json();
}

export async function fetchAllReleases(): Promise<Release[]> {
  const res = await fetch(`${API_BASE}/releases`);
  if (!res.ok) throw new Error('Failed to fetch releases');
  return res.json();
}

export async function fetchSystemInfo(): Promise<{ platform: FerrumProxyPlatform; nodePlatform: string; arch: string }> {
  const res = await fetch(`${API_BASE}/system`);
  if (!res.ok) throw new Error('Failed to fetch system info');
  return res.json();
}


export interface AuthStatus {
  hasAuth: boolean;
  isAuthenticated: boolean;
  requireAuth: boolean;
}

export async function checkAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/auth/status`);
  if (!res.ok) throw new Error('Failed to check auth status');
  return res.json();
}

export async function login(username: string, password: string): Promise<{ success: boolean; token: string }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(error.error || 'Login failed');
  }
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Logout failed');
}

export async function setupAuth(username: string, password: string): Promise<{ success: boolean; token: string }> {
  const res = await fetch(`${API_BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Setup failed' }));
    throw new Error(error.error || 'Setup failed');
  }
  return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/change-password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Password change failed' }));
    throw new Error(error.error || 'Password change failed');
  }
}


export interface WebSocketEventMap {
  instances: FerrumProxyInstance[] | { data: FerrumProxyInstance[] };
  instanceAdded: void;
  instanceRemoved: void;
  instanceStarted: { instanceId: string; pid: number };
  instanceStopped: { instanceId: string };
  instanceRestarted: { instanceId: string; pid: number };
  processExit: { instanceId: string };
  instanceInitializing: { instanceId: string };
  instanceInitialized: { instanceId: string };
  updateProgress: { instanceId: string; percentage: number };
  instanceUpdated: { instanceId: string; version: string };
  log: { instanceId: string; timestamp: string; logType: string; message: string };
  configUpdated: { instanceId: string; config: FerrumProxyConfig };
  rateLimitError: { message: string };
}

export interface UpdateCheckResult {
  updates: Array<{
    instanceId: string;
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
  }>;
  latestRelease: Release;
}

export async function checkUpdates(): Promise<UpdateCheckResult> {
  const res = await fetch(`${API_BASE}/updates/check`);
  if (!res.ok) throw new Error('Failed to check updates');
  return res.json();
}
