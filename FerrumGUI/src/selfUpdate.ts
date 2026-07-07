import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';

// Bun のビルド時に `--define BUILD_VERSION="\"1.0.0\""` で埋め込まれる想定。
// 開発モード (bun --watch) では未定義なので try/typeof で判定する。
function readBuildVersionDefine(): string | null {
  try {
    // @ts-ignore - build-time define
    return typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : null;
  } catch {
    return null;
  }
}

function readVersionIniFallback(): string | null {
  const candidates: string[] = [path.join(process.cwd(), 'version.ini')];
  try {
    if (typeof Bun !== 'undefined' && Bun.main) {
      candidates.push(
        path.join(path.dirname(Bun.main), 'version.ini'),
        path.join(path.dirname(Bun.main), '..', 'version.ini')
      );
    }
  } catch {}
  for (const p of candidates) {
    try {
      if (fssync.existsSync(p)) {
        const text = fssync.readFileSync(p, 'utf-8');
        // 固定タグ運用ではバージョン文字列に `.` 以外 (`-`, 英数字) も含む
        const m = text.match(/^version\s*=\s*(\S+)/m);
        if (m) return m[1];
      }
    } catch {}
  }
  return null;
}

let cachedVersion: string | null = null;
export function getCurrentGuiVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion =
    readBuildVersionDefine() || readVersionIniFallback() || 'dev';
  return cachedVersion;
}

export function isSelfUpdateSupported(isCompiled: boolean): boolean {
  return isCompiled && getCurrentGuiVersion() !== 'dev';
}

// FerrumProxyGUI は FerrumProxy モノレポの固定タグ `FerrumProxyGUI` にリリースされる。
// version.json は同じリリースに同梱される（scripts/gen-version-json.mjs 参照）。
const GUI_REPO =
  process.env.FERRUMPROXYGUI_SELF_REPO ||
  process.env.FERRUMPROXY_GITHUB_REPO ||
  'gamelist1990/FerrumProxy';
const GUI_TAG =
  process.env.FERRUMPROXYGUI_SELF_TAG ||
  process.env.FERRUMPROXYGUI_RELEASE_TAG ||
  'FerrumProxyGUI';

export type GuiPlatform =
  | 'windows-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'macos-arm64';

/** 現在のプロセスから version.json の platform キーを解決する。 */
export function getCurrentGuiPlatformKey(): GuiPlatform | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'windows-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  if (p === 'darwin' && a === 'arm64') return 'macos-arm64';
  return null;
}

/** version.json の asset レコード（gen-version-json.mjs と一致）。 */
export interface VersionManifestAsset {
  name: string;
  platform: string;
  size: number;
  downloadUrl: string;
}

export interface VersionManifest {
  schema: number;
  component: string;
  version: string;
  commit?: string;
  shortCommit?: string;
  buildDate?: string;
  tag: string;
  runId?: string;
  assets: VersionManifestAsset[];
}

export interface GuiReleaseInfo {
  version: string;
  tag: string;
  commit?: string;
  assetUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
  publishedAt: string;
}

/**
 * `https://github.com/<repo>/releases/download/<tag>/version.json` を直接取得する。
 * GitHub API を叩かないのでレート制限の影響を受けない。
 *
 * `force = true` のときは cache-buster URL パラメータと no-cache ヘッダーで
 * ブラウザ / CDN の中間キャッシュもバイパスする。GUI の更新確認押下時は必ず
 * force=true を渡す。
 */
export async function fetchGuiVersionManifest(
  force = false
): Promise<VersionManifest | null> {
  const base = `https://github.com/${GUI_REPO}/releases/download/${GUI_TAG}/version.json`;
  const url = force ? `${base}?t=${Date.now()}` : base;
  const headers: Record<string, string> = force
    ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    : {};
  const res = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(
      `Failed to fetch GUI version.json: ${res.status} ${res.statusText}`
    );
  }
  const data = (await res.json()) as VersionManifest;
  if (!data || typeof data.version !== 'string' || !Array.isArray(data.assets)) {
    return null;
  }
  return data;
}

/** version.json を最新リリース情報として返す（呼び出し側との互換用）。 */
export async function fetchLatestGuiRelease(
  force = false
): Promise<GuiReleaseInfo | null> {
  const manifest = await fetchGuiVersionManifest(force);
  if (!manifest) return null;
  const platformKey = getCurrentGuiPlatformKey();
  const asset = platformKey
    ? manifest.assets.find((a) => a.platform === platformKey)
    : null;
  return {
    version: manifest.version,
    tag: manifest.tag || GUI_TAG,
    commit: manifest.commit,
    assetName: asset?.name ?? null,
    assetUrl: asset?.downloadUrl ?? null,
    assetSize: asset?.size ?? null,
    publishedAt: manifest.buildDate || new Date().toISOString(),
  };
}

/**
 * 固定タグ運用では `YYYY.MM.DD-<shortcommit>` を採番している（semver ではない）。
 * commit が違えば内容も違うため、**等値ベース**で判定する。
 * 現在版と最新版が同じなら 0（更新不要）、違えば -1（更新あり）を返す。
 * 古い呼び出し規約（`compareVersions(latest, current) > 0` なら更新あり）と
 * 互換を保つため、「a > b」を「a と b が異なる」にマップする。
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  // 何かしら差分があれば「更新あり」として -1 を返す（呼び出し側は > 0 を更新なしとして扱う）。
  // ※ ここでは常に「更新あり」を通したいので負値を返す運用にする。
  return 1;
}

/** 現在版と最新版が異なる（＝更新が入っている）ときだけ true。 */
export function hasGuiUpdate(current: string, latest: string | null | undefined): boolean {
  if (!latest) return false;
  if (current === 'dev') return false;
  return current !== latest;
}

/** 前回の更新で残った .old ファイルを削除する（起動時に呼ぶ）。 */
export async function cleanupOldBinary(): Promise<void> {
  try {
    const execPath = process.execPath;
    const oldPath = execPath + '.old';
    if (fssync.existsSync(oldPath)) {
      await fs.rm(oldPath, { force: true });
      console.log(chalk.gray(`Cleaned up previous binary: ${oldPath}`));
    }
  } catch {
    // Windows でロックされてる可能性があるが致命的ではないので無視
  }
}

export type SelfUpdateProgress = (downloaded: number, total: number) => void;

export type SelfUpdateResult =
  | { success: true; version: string; restartInMs: number }
  | { success: false; error: string };

/**
 * 現在の実行バイナリを最新版に差し替えて再起動する。
 *
 * フロー:
 *  1. GitHub Release から現在プラットフォームに合うアセット URL を取得
 *  2. `{execPath}.new` にダウンロード
 *  3. 現在の `{execPath}` を `{execPath}.old` にリネーム
 *  4. `{execPath}.new` を `{execPath}` にリネーム（インストール）
 *  5. detached で新バイナリを起動、現プロセスを終了
 */
export async function performGuiSelfUpdate(
  isCompiled: boolean,
  onProgress?: SelfUpdateProgress
): Promise<SelfUpdateResult> {
  if (!isSelfUpdateSupported(isCompiled)) {
    return {
      success: false,
      error: 'Self-update is only available on compiled binaries',
    };
  }

  // self-update は必ず最新の version.json を取り直す（キャッシュ回避）
  const manifest = await fetchGuiVersionManifest(true);
  if (!manifest) {
    return { success: false, error: 'No GUI release manifest (version.json) found' };
  }

  const current = getCurrentGuiVersion();
  if (!hasGuiUpdate(current, manifest.version)) {
    return {
      success: false,
      error: `Already up to date (current v${current}, latest v${manifest.version})`,
    };
  }

  const platformKey = getCurrentGuiPlatformKey();
  if (!platformKey) {
    return {
      success: false,
      error: `Unsupported platform: ${process.platform}/${process.arch}`,
    };
  }
  const asset = manifest.assets.find((a) => a.platform === platformKey);
  if (!asset || !asset.downloadUrl) {
    return {
      success: false,
      error: `No matching asset for ${platformKey} in release ${manifest.version}`,
    };
  }
  const latest = {
    version: manifest.version,
    assetUrl: asset.downloadUrl,
    assetName: asset.name,
    assetSize: asset.size,
  };

  const execPath = process.execPath;
  const newPath = execPath + '.new';
  const oldPath = execPath + '.old';

  // 前回の残骸を掃除しておく
  try {
    if (fssync.existsSync(newPath)) await fs.rm(newPath, { force: true });
  } catch {}
  try {
    if (fssync.existsSync(oldPath)) await fs.rm(oldPath, { force: true });
  } catch {}

  console.log(
    chalk.blue(
      `Downloading GUI v${latest.version} from ${latest.assetUrl}...`
    )
  );
  const res = await fetch(latest.assetUrl);
  if (!res.ok || !res.body) {
    return {
      success: false,
      error: `Download failed: ${res.status} ${res.statusText}`,
    };
  }
  const totalSize =
    Number.parseInt(res.headers.get('content-length') || '0', 10) ||
    (latest.assetSize ?? 0);
  const fileStream = fssync.createWriteStream(newPath);
  const reader = res.body.getReader();
  let downloaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      downloaded += value.length;
      if (onProgress && totalSize > 0) onProgress(downloaded, totalSize);
    }
    await new Promise<void>((resolve, reject) => {
      fileStream.end(() => resolve());
      fileStream.on('error', reject);
    });
  } catch (err: any) {
    try {
      fileStream.destroy();
    } catch {}
    try {
      await fs.rm(newPath, { force: true });
    } catch {}
    return { success: false, error: `Download error: ${err.message}` };
  }

  if (process.platform !== 'win32') {
    try {
      await fs.chmod(newPath, 0o755);
    } catch {}
  }

  try {
    await fs.rename(execPath, oldPath);
  } catch (err: any) {
    try {
      await fs.rm(newPath, { force: true });
    } catch {}
    return {
      success: false,
      error: `Failed to move current binary aside: ${err.message}`,
    };
  }

  try {
    await fs.rename(newPath, execPath);
  } catch (err: any) {
    // ロールバック
    try {
      await fs.rename(oldPath, execPath);
    } catch {}
    return {
      success: false,
      error: `Failed to install new binary: ${err.message}`,
    };
  }

  const restartInMs = 1500;
  console.log(
    chalk.green(
      `✓ GUI updated to v${latest.version}. Restarting in ${restartInMs} ms...`
    )
  );

  setTimeout(() => {
    try {
      const child = spawn(execPath, process.argv.slice(2), {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
    } catch (err: any) {
      console.error(chalk.red('Failed to spawn new binary:'), err);
    }
    setTimeout(() => process.exit(0), 200);
  }, restartInMs);

  return { success: true, version: latest.version, restartInMs };
}
