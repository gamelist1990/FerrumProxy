// Generates a `version.json` manifest describing a fixed-tag GitHub release so
// the FerrumProxy GUI can do reliable update detection ("更新確認 & 一括更新").
//
// Fixed-tag releases (FerrumProxy / FerrumProxyGUI / FerrumProxyClient) carry no
// semantic version, so this manifest is the source of truth: a commit/date-based
// version string plus the concrete downloadable assets for each platform.
//
// Usage: node scripts/gen-version-json.mjs <component> <tag> [assetsDir]
//   component : "proxy" | "gui" | "client"
//   tag       : the fixed release tag the assets are published under
//   assetsDir : directory containing the built assets (default: release-assets)
//
// Reads GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_RUN_ID from the environment when
// available (GitHub Actions); falls back to sensible defaults for local runs.

import fs from 'node:fs';
import path from 'node:path';

const [, , component, tag, assetsDir = 'release-assets'] = process.argv;

if (!component || !tag) {
  console.error('usage: node scripts/gen-version-json.mjs <component> <tag> [assetsDir]');
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || 'gamelist1990/FerrumProxy';
const sha = process.env.GITHUB_SHA || 'unknown';
const shortCommit = sha.slice(0, 7);
const runId = process.env.GITHUB_RUN_ID || '';
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(
  now.getUTCDate()
)}-${shortCommit}`;

/** Infer a platform key from an asset filename. */
function platformOf(name) {
  const s = name.toLowerCase();
  if (s.includes('windows') || s.endsWith('.exe') || s.endsWith('.msi')) {
    return s.includes('arm64') ? 'windows-arm64' : 'windows-x64';
  }
  if (
    s.includes('macos') ||
    s.includes('darwin') ||
    s.endsWith('.dmg') ||
    s.endsWith('.app.tar.gz')
  ) {
    return 'macos-arm64';
  }
  if (s.includes('linux-arm64') || s.includes('aarch64') || s.includes('arm64')) {
    return 'linux-arm64';
  }
  if (
    s.includes('linux') ||
    s.endsWith('.deb') ||
    s.endsWith('.rpm') ||
    s.endsWith('.appimage')
  ) {
    return 'linux-x64';
  }
  return 'unknown';
}

const files = fs
  .readdirSync(assetsDir)
  .filter((f) => f !== 'version.json' && fs.statSync(path.join(assetsDir, f)).isFile());

const assets = files.map((name) => ({
  name,
  platform: platformOf(name),
  size: fs.statSync(path.join(assetsDir, name)).size,
  downloadUrl: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
}));

const manifest = {
  schema: 1,
  component,
  version,
  commit: sha,
  shortCommit,
  buildDate: now.toISOString(),
  tag,
  runId,
  assets,
};

const outPath = path.join(assetsDir, 'version.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${outPath}:`);
console.log(JSON.stringify(manifest, null, 2));
