#!/usr/bin/env node
/**
 * Downloads basemind binaries from GitHub releases.
 *
 * Usage:
 *   node scripts/download-basemind.mjs [version] [--current-platform]
 *   node scripts/download-basemind.mjs [version] --platform darwin-x64
 *
 * Options:
 *   version             Specific version tag (default: pinned version)
 *   --current-platform  Only download for current OS/arch
 *   --platform <key>    Download only the specified platform key
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASEMIND_DIR = path.join(ROOT, 'resources', 'basemind');
const BASEMIND_REPO = 'jamon8888/basemind';
const PINNED_VERSION = 'v0.31.0';

// The checksum file carries the bare version, not the tag: v0.29.0 ships
// basemind_0.29.0_checksums.txt.
function checksumAssetFor(version) {
  return `basemind_${version.replace(/^v/, '')}_checksums.txt`;
}

const PLATFORMS = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    asset: 'basemind-aarch64-apple-darwin.tar.gz',
    binary: 'basemind',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    asset: 'basemind-x86_64-apple-darwin.tar.gz',
    binary: 'basemind',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-gnu',
    asset: 'basemind-x86_64-unknown-linux-gnu.tar.gz',
    binary: 'basemind',
  },
  // SSE2-baseline build for pre-Haswell CPUs without AVX2 (e.g. Sandy Bridge):
  // same `full` feature set, ONNX Runtime built from source + loaded via
  // ort-dynamic. --current-platform on linux-x64 stages both variants; other
  // platforms have no AVX2-less variant.
  'linux-x64-noavx2': {
    target: 'x86_64-unknown-linux-gnu',
    asset: 'basemind-x86_64-unknown-linux-gnu-noavx2.tar.gz',
    binary: 'basemind',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    asset: 'basemind-aarch64-unknown-linux-gnu.tar.gz',
    binary: 'basemind',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    asset: 'basemind-x86_64-pc-windows-msvc.zip',
    binary: 'basemind.exe',
  },
};

export const BASEMIND_PLATFORMS = PLATFORMS;
export const PLATFORM_KEYS = Object.keys(PLATFORMS);

// Platforms whose release asset may legitimately not exist yet (shipped by a
// newer fork release than the pinned one). A missing asset warns and skips;
// anything else (checksum mismatch, extraction failure) still fails hard.
const OPTIONAL_PLATFORMS = new Set(['linux-x64-noavx2']);

export function isMissingAssetError(platform, error) {
  if (!OPTIONAL_PLATFORMS.has(platform)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('No checksum found for') || /error: 404\b/.test(message);
}

export function getPlatformKey(platform = process.platform, arch = process.arch) {
  const osPlatform = platform === 'win32' ? 'win32' : platform;
  return `${osPlatform}-${arch}`;
}

/**
 * True when the CPU supports AVX2. Only linux-x64 has a noavx2 variant, so
 * every other platform short-circuits to true. Unknown state (unreadable
 * cpuinfo, no flags lines) fails CLOSED to false, matching cpuHasAvx2() in
 * the server: the noavx2 binary runs anywhere, the stock one SIGILL-crashes
 * without AVX2. This only affects download ordering (both variants stage).
 */
export function hasAvx2({ platform = process.platform, cpuinfo } = {}) {
  if (platform !== 'linux') return true;
  try {
    const text = cpuinfo ?? fs.readFileSync('/proc/cpuinfo', 'utf8');
    const flagLines = text.split('\n').filter((line) => line.startsWith('flags'));
    if (flagLines.length === 0) return false;
    // Require AVX2 on every core — the process can migrate, so one AVX2-less
    // core means the stock build can SIGILL. Mirrors cpuHasAvx2() server-side.
    return flagLines.every((line) => (line.split(':')[1] ?? '').trim().split(/\s+/).includes('avx2'));
  } catch {
    return false;
  }
}

export function parseArgs(args) {
  const currentPlatformOnly = args.includes('--current-platform');
  const platformIndex = args.indexOf('--platform');
  const requestedPlatform = platformIndex !== -1 ? args[platformIndex + 1] : undefined;
  const version = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--platform') || PINNED_VERSION;

  return { version, currentPlatformOnly, requestedPlatform };
}

export function getPlatformsToDownload({ currentPlatformOnly = false, requestedPlatform, currentPlatformKey = getPlatformKey(), avx2 = hasAvx2() } = {}) {
  if (requestedPlatform) {
    if (!PLATFORM_KEYS.includes(requestedPlatform)) {
      throw new Error(`No basemind binary available for platform: ${requestedPlatform}`);
    }
    return [requestedPlatform];
  }

  if (currentPlatformOnly) {
    // Linux x64 ships two variants and the electron-builder config packages
    // both, so --current-platform stages both regardless of host AVX2. The
    // runtime resolver picks the right one per machine.
    if (currentPlatformKey === 'linux-x64') {
      return avx2 ? ['linux-x64', 'linux-x64-noavx2'] : ['linux-x64-noavx2', 'linux-x64'];
    }
    if (!PLATFORM_KEYS.includes(currentPlatformKey)) {
      throw new Error(`No basemind binary available for platform: ${currentPlatformKey}`);
    }
    return [currentPlatformKey];
  }

  return [...PLATFORM_KEYS];
}

function hasGhWithAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function downloadWithCurl(version, asset, destinationDir) {
  const url = `https://github.com/${BASEMIND_REPO}/releases/download/${version}/${asset}`;
  execFileSync(
    'curl',
    [
      '-sSL', '--fail',
      // Without these a stalled connection hangs indefinitely and `--retry`
      // never fires: observed hanging 13+ minutes on a few-hundred-byte
      // checksum file. Fail fast, then retry.
      '--connect-timeout', '20',
      '--max-time', '600',
      '--retry', '3', '--retry-all-errors', '--retry-delay', '3',
      '-o', path.join(destinationDir, asset), url,
    ],
    { stdio: 'pipe' },
  );
}

function downloadAsset(version, asset, destinationDir) {
  // `gh` is preferred because it carries the user's auth for a private or
  // rate-limited repo, but its asset redirect has been seen to time out in
  // TLS handshake where a plain curl of the same signed URL succeeds — so a
  // `gh` failure falls through to curl rather than aborting the download.
  if (hasGhWithAuth()) {
    try {
      execFileSync(
        'gh',
        ['release', 'download', version, '--repo', BASEMIND_REPO, '--pattern', asset, '--dir', destinationDir],
        { stdio: 'pipe' },
      );
      return;
    } catch {
      console.log(`  gh failed for ${asset}, falling back to curl`);
    }
  }
  downloadWithCurl(version, asset, destinationDir);
}

function verifyArchiveDigest(assetPath, checksumPath) {
  const assetName = path.basename(assetPath);
  const line = fs.readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().endsWith(` ${assetName}`) || entry.trim().endsWith(`*${assetName}`));
  if (!line) {
    throw new Error(`No checksum found for ${assetName} in ${path.basename(checksumPath)}`);
  }
  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`);
  }
}

function extractArchive(assetPath, platformDir, assetName) {
  if (assetName.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', assetPath, '-C', platformDir], { stdio: 'pipe' });
    return;
  }

  if (assetName.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-Command', `Expand-Archive -Path '${assetPath}' -DestinationPath '${platformDir}' -Force`], { stdio: 'pipe' });
    } else {
      execFileSync('unzip', ['-o', assetPath, '-d', platformDir], { stdio: 'pipe' });
    }
    return;
  }

  throw new Error(`Unsupported archive format: ${assetName}`);
}

async function downloadAndExtract(version, platform) {
  const config = PLATFORMS[platform];
  if (!config) {
    throw new Error(`No basemind binary available for platform: ${platform}`);
  }

  const platformDir = path.join(BASEMIND_DIR, platform);
  const binaryPath = path.join(platformDir, config.binary);

  if (fs.existsSync(binaryPath)) {
    console.log(`ok ${platform}: already exists`);
    return;
  }

  console.log(`download ${platform}: ${config.asset}...`);
  fs.mkdirSync(platformDir, { recursive: true });

  const tmpDir = path.join(BASEMIND_DIR, '.tmp', platform);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const checksumAsset = checksumAssetFor(version);
    downloadAsset(version, config.asset, tmpDir);
    downloadAsset(version, checksumAsset, tmpDir);

    const assetPath = path.join(tmpDir, config.asset);
    verifyArchiveDigest(assetPath, path.join(tmpDir, checksumAsset));
    extractArchive(assetPath, platformDir, config.asset);

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`basemind binary not found after extraction: ${binaryPath}`);
    }

    if (!platform.startsWith('win32')) {
      fs.chmodSync(binaryPath, 0o755);
      // Also chmod any .dylib / .so* files that need execute permission. A
      // versioned soname (libssl.so.3) doesn't end in literal ".so", so this
      // matches on the substring rather than a suffix.
      for (const entry of fs.readdirSync(platformDir)) {
        if (entry.endsWith('.dylib') || entry.includes('.so')) {
          const entryPath = path.join(platformDir, entry);
          try { fs.chmodSync(entryPath, 0o755); } catch {
            // Shared-library permission update is best effort.
          }
        }
      }
    }

    console.log(`ok ${platform}: done`);
  } catch (error) {
    // Remove partially extracted directory so re-run doesn't treat corrupt
    // binaries as current (the VERSION file won't be updated on failure).
    fs.rmSync(platformDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const { version, currentPlatformOnly, requestedPlatform } = parseArgs(process.argv.slice(2));
  const versionFilePath = path.join(BASEMIND_DIR, 'VERSION');

  let platformsToDownload;
  try {
    platformsToDownload = getPlatformsToDownload({ currentPlatformOnly, requestedPlatform });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Available platforms: ${PLATFORM_KEYS.join(', ')}`);
    process.exit(1);
  }

  if (requestedPlatform) {
    console.log(`Downloading basemind ${version} for ${requestedPlatform}...\n`);
  } else if (currentPlatformOnly) {
    console.log(`Downloading basemind ${version} for ${platformsToDownload.join(', ')}...\n`);
  } else {
    console.log(`Downloading basemind ${version} for all platforms...\n`);
  }

  const existingVersion = fs.existsSync(versionFilePath)
    ? fs.readFileSync(versionFilePath, 'utf-8').trim()
    : null;
  if (existingVersion && existingVersion !== version) {
    console.log(`Detected basemind version change (${existingVersion} -> ${version}), refreshing binaries...`);
    // Clean ALL platform directories on version change, not just the ones
    // being downloaded — otherwise a --current-platform run updates VERSION
    // while other platforms retain stale binaries from the old version.
    for (const platform of PLATFORM_KEYS) {
      fs.rmSync(path.join(BASEMIND_DIR, platform), { recursive: true, force: true });
    }
  }

  const tmpDir = path.join(BASEMIND_DIR, '.tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  for (const platform of platformsToDownload) {
    try {
      await downloadAndExtract(version, platform);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingAssetError(platform, error)) {
        console.error(`warn ${platform}: ${message} (asset not published yet, skipping)`);
        continue;
      }
      console.error(`error ${platform}: ${message}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(BASEMIND_DIR, { recursive: true });
  fs.writeFileSync(versionFilePath, `${version}\n`);

  const platformLabel = platformsToDownload.length === 1 ? 'platform' : 'platforms';
  console.log(`\nok ${platformsToDownload.length} ${platformLabel} downloaded to resources/basemind/`);
}

function isCliEntryPoint(importMetaUrl, argvPath = process.argv[1]) {
  return Boolean(argvPath) && path.resolve(fileURLToPath(importMetaUrl)) === path.resolve(argvPath);
}

if (isCliEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
