import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import chalk from 'chalk';

const GITHUB_REPO = process.env.FERRUMPROXY_GITHUB_REPO || 'gamelist1990/FerrumProxy';
const FERRUMPROXY_RELEASE_TAG = process.env.FERRUMPROXY_RELEASE_TAG || 'FerrumProxy';
const DEFAULT_VERSION = 'latest';

const CACHE_DURATION = 60 * 60 * 1000; // 1時間

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

class ReleaseCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private rateLimited: boolean = false;
  private rateLimitUntil: number = 0;

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > CACHE_DURATION) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  setRateLimited(until?: number): void {
    this.rateLimited = true;
    this.rateLimitUntil = until || Date.now() + 60 * 60 * 1000; // 1時間後
  }

  isRateLimited(): boolean {
    if (!this.rateLimited) return false;
    if (Date.now() > this.rateLimitUntil) {
      this.rateLimited = false;
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }
}

const releaseCache = new ReleaseCache();

export function isGitHubRateLimited(): boolean {
  return releaseCache.isRateLimited();
}


export interface ReleaseAsset {
  name: string;
  url: string;
  downloadUrl: string;
  size: number;
  /** version.json で採番された platform キー（`windows-x64` など）。 */
  platform?: string;
}

export interface Release {
  version: string;
  tag: string;
  publishedAt: string;
  assets: ReleaseAsset[];
  commit?: string;
}

export type FerrumProxyPlatform = 'linux' | 'linux-arm64' | 'macos-arm64' | 'windows';

/** GUI 側の platform 表記から version.json 側の platform キーへ。 */
function toVersionJsonPlatform(platform: FerrumProxyPlatform): string {
  switch (platform) {
    case 'linux':
      return 'linux-x64';
    case 'linux-arm64':
      return 'linux-arm64';
    case 'macos-arm64':
      return 'macos-arm64';
    case 'windows':
      return 'windows-x64';
  }
}

/**
 * 固定タグの Release には version.json が同梱される。これが真の source of truth。
 * 直接 HTTP で version.json を取得するので GitHub API のレート制限を消費しない。
 *
 * `force = true` のときはブラウザ / CDN の中間キャッシュもバイパスするため、
 *   - URL に `?t=<Date.now()>` を付ける (cache-buster)
 *   - `Cache-Control: no-cache` / `Pragma: no-cache` を送る
 * を組み合わせる。update 確認や self-update ではこちらを使う。
 */
async function fetchVersionManifest(force = false): Promise<Release | null> {
  const base = `https://github.com/${GITHUB_REPO}/releases/download/${FERRUMPROXY_RELEASE_TAG}/version.json`;
  const url = force ? `${base}?t=${Date.now()}` : base;
  const headers: Record<string, string> = force
    ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    : {};
  try {
    const res = await fetch(url, { redirect: 'follow', headers });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`version.json fetch failed: ${res.status} ${res.statusText}`);
    }
    const manifest: any = await res.json();
    if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) {
      return null;
    }
    return {
      version: manifest.version,
      tag: manifest.tag || FERRUMPROXY_RELEASE_TAG,
      publishedAt: manifest.buildDate || new Date().toISOString(),
      commit: manifest.commit,
      assets: (manifest.assets as any[]).map((a) => ({
        name: a.name,
        url: a.downloadUrl,
        downloadUrl: a.downloadUrl,
        size: typeof a.size === 'number' ? a.size : 0,
        platform: typeof a.platform === 'string' ? a.platform : undefined,
      })),
    };
  } catch (err: any) {
    console.log(chalk.yellow(`Failed to read version.json manifest: ${err?.message ?? err}`));
    return null;
  }
}

function fallbackRelease(): Release {
  return {
    version: DEFAULT_VERSION,
    tag: FERRUMPROXY_RELEASE_TAG,
    publishedAt: new Date().toISOString(),
    assets: [],
  };
}

/**
 * @param force `true` のときはローカルキャッシュも中間 CDN もバイパスし、
 *              毎回 GitHub Releases から version.json を取り直す。
 *              update 確認や self-update パスは必ず force=true で呼ぶ。
 */
export async function getLatestRelease(force = false): Promise<Release> {
  if (!force) {
    const cached = releaseCache.get<Release>('latest');
    if (cached) {
      console.log(chalk.blue('Using cached latest release'));
      return cached;
    }
  }

  console.log(
    chalk.blue(
      `Fetching version.json for ${FERRUMPROXY_RELEASE_TAG}${force ? ' (force refresh)' : ''}...`
    )
  );
  const release = await fetchVersionManifest(force);
  if (!release) {
    console.log(
      chalk.yellow('version.json unavailable, falling back to default "latest" placeholder')
    );
    const fb = fallbackRelease();
    releaseCache.set('latest', fb);
    return fb;
  }

  releaseCache.set('latest', release);
  releaseCache.set('all', [release]);
  return release;
}

export async function getAllReleases(force = false): Promise<Release[]> {
  // 固定タグ運用では単一リリースしか公開しないので、latest をそのまま返す。
  if (!force) {
    const cached = releaseCache.get<Release[]>('all');
    if (cached) {
      return cached;
    }
  }
  const latest = await getLatestRelease(force);
  const list = [latest];
  releaseCache.set('all', list);
  return list;
}

export async function getReleaseByVersion(_version: string, force = false): Promise<Release> {
  // 固定タグでは常に最新版だけを扱う（過去バージョンは同一タグに残さない前提）。
  return getLatestRelease(force);
}

/**
 * 指定プラットフォーム向けのアセットを version.json.assets[].platform から解決する。
 * これで「アセット名にバージョンが埋め込まれている」前提を廃止できる。
 */
export function resolveAssetForPlatform(
  release: Release,
  platform: FerrumProxyPlatform
): ReleaseAsset | null {
  const wanted = toVersionJsonPlatform(platform);
  return release.assets.find((a) => a.platform === wanted) || null;
}

export async function downloadBinary(
  downloadUrl: string,
  destinationPath: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  console.log(chalk.blue(`Downloading from ${downloadUrl}...`));
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0', 10);

  if (!response.body) {
    throw new Error('Response body is null');
  }

  const fileStream = createWriteStream(destinationPath);
  const reader = response.body.getReader();
  let downloadedSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      downloadedSize += value.length;
      if (onProgress) {
        onProgress(downloadedSize, totalSize);
      }

      fileStream.write(value);
    }

    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });
  } catch (error) {
    fileStream.destroy();
    throw error;
  }

  console.log(chalk.green(`Downloaded to ${destinationPath}`));
}





export async function setExecutablePermissions(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(chalk.blue('Setting executable permissions...'));
    await fs.chmod(filePath, 0o755);
    console.log(chalk.green('✓ Executable permissions set'));
  }
}

/**
 * 後方互換用: プラットフォームごとの既定アセット名を返す。
 * 新しい呼び出し側は `resolveAssetForPlatform` を使うこと。
 */
export function getPlatformAssetName(platform: FerrumProxyPlatform, _version: string): string {
  switch (platform) {
    case 'linux':
      return 'FerrumProxy-linux-x64';
    case 'linux-arm64':
      return 'FerrumProxy-linux-arm64';
    case 'macos-arm64':
      return 'FerrumProxy-macos-arm64';
    case 'windows':
      return 'FerrumProxy-windows-x64.exe';
  }
}

export async function downloadAndVerifyBinary(
  platform: FerrumProxyPlatform,
  _version: string,
  destinationPath: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  const release = await getLatestRelease();
  const asset = resolveAssetForPlatform(release, platform);

  if (!asset) {
    throw new Error(`No asset for ${platform} in release ${release.version}`);
  }

  console.log(chalk.blue(`Downloading FerrumProxy ${release.version} for ${platform}...`));
  await downloadBinary(asset.downloadUrl, destinationPath, onProgress);
  await setExecutablePermissions(destinationPath);

  console.log(chalk.green(`✓ Successfully downloaded ${asset.name}`));
}
