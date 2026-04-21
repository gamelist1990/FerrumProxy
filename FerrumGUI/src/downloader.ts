import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import chalk from 'chalk';

const GITHUB_REPO = process.env.FERRUMPROXY_GITHUB_REPO || 'gamelist1990/FerrumProxy';
const RELEASE_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
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
}

export interface Release {
  version: string;
  tag: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

export async function getLatestRelease(): Promise<Release> {
  const cached = releaseCache.get<Release>('latest');
  if (cached) {
    console.log(chalk.blue('Using cached latest release'));
    return cached;
  }

  console.log(chalk.blue(`Fetching ${FERRUMPROXY_RELEASE_TAG} release from GitHub...`));
  const response = await fetch(`${RELEASE_API_BASE}/tags/${FERRUMPROXY_RELEASE_TAG}`);

  if (!response.ok) {
    if (response.status === 403) {
      console.log(chalk.yellow('GitHub API rate limit exceeded, using default version'));
      releaseCache.setRateLimited();
      const defaultRelease: Release = {
        version: DEFAULT_VERSION,
        tag: FERRUMPROXY_RELEASE_TAG,
        publishedAt: new Date().toISOString(),
        assets: [],
      };
      releaseCache.set('latest', defaultRelease);
      return defaultRelease;
    }
    throw new Error(`Failed to fetch latest release: ${response.statusText}`);
  }

  const data: any = await response.json();
  const release: Release = {
    version: DEFAULT_VERSION,
    tag: data.tag_name,
    publishedAt: data.published_at,
    assets: data.assets.map((asset: any) => ({
      name: asset.name,
      url: asset.url,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
    })),
  };

  releaseCache.set('latest', release);
  return release;
}

export async function getAllReleases(): Promise<Release[]> {
  const cached = releaseCache.get<Release[]>('all');
  if (cached) {
    console.log(chalk.blue('Using cached releases list'));
    return cached;
  }

  console.log(chalk.blue(`Fetching ${FERRUMPROXY_RELEASE_TAG} release from GitHub...`));
  const response = await fetch(`${RELEASE_API_BASE}/tags/${FERRUMPROXY_RELEASE_TAG}`);

  if (!response.ok) {
    if (response.status === 403) {
      console.log(chalk.yellow('GitHub API rate limit exceeded, using default version'));
      releaseCache.setRateLimited();
      const defaultReleases: Release[] = [{
        version: DEFAULT_VERSION,
        tag: FERRUMPROXY_RELEASE_TAG,
        publishedAt: new Date().toISOString(),
        assets: [],
      }];
      releaseCache.set('all', defaultReleases);
      return defaultReleases;
    }
    throw new Error(`Failed to fetch releases: ${response.statusText}`);
  }

  const data: any = await response.json();
  const releases: Release[] = [{
    version: DEFAULT_VERSION,
    tag: data.tag_name,
    publishedAt: data.published_at,
    assets: data.assets.map((asset: any) => ({
      name: asset.name,
      url: asset.url,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
    })),
  }];

  releaseCache.set('all', releases);
  return releases;
}

export async function getReleaseByVersion(version: string): Promise<Release> {
  console.log(chalk.blue(`Fetching ${FERRUMPROXY_RELEASE_TAG} release from GitHub...`));
  const response = await fetch(`${RELEASE_API_BASE}/tags/${FERRUMPROXY_RELEASE_TAG}`);

  if (!response.ok) {
    if (response.status === 403) {
      releaseCache.setRateLimited();
      throw new Error(`rate limit exceeded`);
    }
    throw new Error(`Failed to fetch release ${version}: ${response.statusText}`);
  }

  const data: any = await response.json();

  return {
    version: DEFAULT_VERSION,
    tag: data.tag_name,
    publishedAt: data.published_at,
    assets: data.assets.map((asset: any) => ({
      name: asset.name,
      url: asset.url,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
    })),
  };
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

export type FerrumProxyPlatform = 'linux' | 'linux-arm64' | 'macos-arm64' | 'windows';

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
  version: string,
  destinationPath: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  console.log(chalk.blue(`Downloading FerrumProxy ${version} for ${platform}...`));

  const release = await getLatestRelease();
  const assetName = getPlatformAssetName(platform, version);
  const asset = release.assets.find(a => a.name === assetName);

  if (!asset) {
    throw new Error(`Asset ${assetName} not found in release ${release.version}`);
  }

  await downloadBinary(asset.downloadUrl, destinationPath, onProgress);


  await setExecutablePermissions(destinationPath);

  console.log(chalk.green(`✓ Successfully downloaded and verified ${assetName}`));
}
