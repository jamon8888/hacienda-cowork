import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getPlatformKey,
  parseArgs,
  getPlatformsToDownload,
  hasAvx2,
  isMissingAssetError,
  PLATFORM_KEYS,
  BASEMIND_PLATFORMS,
  PINNED_VERSION,
} from './download-basemind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('getPlatformKey maps current OS and arch', () => {
  const key = getPlatformKey('darwin', 'arm64');
  assert.equal(key, 'darwin-arm64');
});

test('getPlatformKey normalises win32', () => {
  assert.equal(getPlatformKey('win32', 'x64'), 'win32-x64');
});

test('parseArgs extracts version and flags', () => {
  const result = parseArgs(['v1.2.3', '--current-platform']);
  assert.equal(result.version, 'v1.2.3');
  assert.equal(result.currentPlatformOnly, true);
  assert.equal(result.requestedPlatform, undefined);
});

test('parseArgs extracts --platform', () => {
  const result = parseArgs(['--platform', 'linux-x64']);
  assert.equal(result.requestedPlatform, 'linux-x64');
});

test('parseArgs falls back to pinned version', () => {
  const result = parseArgs([]);
  assert.ok(result.version.startsWith('v'), 'default version is a tag');
});

test('parseArgs falls back to the pinned version', () => {
  const result = parseArgs([]);
  assert.equal(result.version, PINNED_VERSION);
});

// `resources/basemind/VERSION` is written by the last successful download, so it is the one thing
// that records which basemind this checkout will actually *run*. Comparing it to the pin catches the
// failure that matters locally: bumping the pin without re-downloading leaves a stale binary staged
// under the new version number, and every local test then reports against the old build.
test('the staged basemind binary matches the pin', () => {
  const staged = path.join(ROOT, 'resources', 'basemind', 'VERSION');
  let actual;
  try {
    actual = readFileSync(staged, 'utf8').trim();
  } catch {
    // No staged binary at all — nothing has been downloaded yet. Not drift.
    return;
  }
  assert.equal(
    actual,
    PINNED_VERSION,
    `resources/basemind/VERSION says ${actual} but the pin is ${PINNED_VERSION}. ` +
      `Run \`pnpm run download:basemind -- --current-platform\`, or the app will run ${actual} ` +
      `while every test and doc claims ${PINNED_VERSION}.`,
  );
});

// The pin names a **released** basemind build; the submodule pointer is a source checkout. They are
// different things and are not required to be the same commit — the app downloads
// `releases/download/<PINNED_VERSION>/…` and never builds from the submodule.
//
// What must hold is that the pointer *contains* the pinned release. Otherwise the checkout and the
// binary describe different code, which is the failure that actually costs something: a reviewer
// reads `fts.rs` in the submodule while the running daemon answers from an older build.
//
// So this asserts ancestry, not equality. Equality would also be wrong in the other direction — the
// pointer legitimately moves past the tag as further basemind work merges — and it would make every
// unrelated basemind commit a reason to re-pin.
test('the basemind submodule contains the pinned release', () => {
  const submodule = path.join(ROOT, 'submodules', 'basemind');
  const git = (args) => execFileSync('git', ['-C', submodule, ...args], { encoding: 'utf8' }).trim();

  let tagged;
  try {
    tagged = git(['rev-parse', '--verify', `${PINNED_VERSION}^{commit}`]);
  } catch {
    assert.fail(
      `${PINNED_VERSION} is not tagged in submodules/basemind, so there is nothing to pin against. ` +
        `Cut the basemind release first — a pin to an unreleased version downloads nothing at build time.`,
    );
  }

  assert.ok(
    execFileSync('git', ['-C', submodule, 'merge-base', '--is-ancestor', tagged, 'HEAD'], { stdio: 'pipe' }),
    `submodules/basemind does not contain ${PINNED_VERSION}. The pin downloads that release's binary, ` +
      `so the checkout must be at or past it — move the pointer forward.`,
  );
});

test('getPlatformsToDownload returns all keys when no filter', () => {
  const platforms = getPlatformsToDownload();
  assert.deepEqual(platforms, [...PLATFORM_KEYS]);
});

test('getPlatformsToDownload returns single platform for --platform', () => {
  const platforms = getPlatformsToDownload({ requestedPlatform: 'darwin-arm64' });
  assert.deepEqual(platforms, ['darwin-arm64']);
});

test('getPlatformsToDownload returns current platform for --current-platform', () => {
  const platforms = getPlatformsToDownload({ currentPlatformOnly: true, currentPlatformKey: 'darwin-arm64', avx2: true });
  assert.deepEqual(platforms, ['darwin-arm64']);
});

test('getPlatformsToDownload stages both linux variants (AVX2 host)', () => {
  const platforms = getPlatformsToDownload({ currentPlatformOnly: true, currentPlatformKey: 'linux-x64', avx2: true });
  assert.deepEqual(platforms, ['linux-x64', 'linux-x64-noavx2']);
});

test('getPlatformsToDownload stages noavx2 first on AVX2-less linux-x64', () => {
  const platforms = getPlatformsToDownload({ currentPlatformOnly: true, currentPlatformKey: 'linux-x64', avx2: false });
  assert.deepEqual(platforms, ['linux-x64-noavx2', 'linux-x64']);
});

test('getPlatformsToDownload accepts explicit --platform linux-x64-noavx2', () => {
  const platforms = getPlatformsToDownload({ requestedPlatform: 'linux-x64-noavx2' });
  assert.deepEqual(platforms, ['linux-x64-noavx2']);
});

test('hasAvx2 detects flags from cpuinfo text', () => {
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: 'flags\t\t: fpu avx avx2 sse4_1\n' }), true);
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: 'flags\t\t: fpu avx sse4_1\n' }), false);
});

test('hasAvx2 fails closed when flags are missing', () => {
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: 'processor\t: 0\nmodel name\t: Unknown CPU\n' }), false);
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: '' }), false);
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: 'processor\t: 0\nvendor_id\t: GenuineIntel\n' }), false);
});

test('hasAvx2 requires avx2 on every flags line', () => {
  const mixed = 'flags\t\t: fpu avx avx2\nflags\t\t: fpu avx sse4_1\n';
  assert.equal(hasAvx2({ platform: 'linux', cpuinfo: mixed }), false);
});

test('hasAvx2 is true off-linux (no noavx2 variant elsewhere)', () => {
  assert.equal(hasAvx2({ platform: 'darwin' }), true);
  assert.equal(hasAvx2({ platform: 'win32' }), true);
});

test('isMissingAssetError skips only unpublished noavx2 assets', () => {
  assert.equal(isMissingAssetError('linux-x64-noavx2', new Error('No checksum found for basemind-x.noavx2.tar.gz in x_checksums.txt')), true);
  assert.equal(isMissingAssetError('linux-x64-noavx2', new Error('Command failed: curl: (22) The requested URL returned error: 404')), true);
  assert.equal(isMissingAssetError('linux-x64-noavx2', new Error('Checksum mismatch for basemind-x.noavx2.tar.gz')), false);
  assert.equal(isMissingAssetError('linux-x64', new Error('No checksum found for basemind-x.tar.gz')), false);
});

test('getPlatformsToDownload throws on unknown platform', () => {
  assert.throws(
    () => getPlatformsToDownload({ requestedPlatform: 'unknown' }),
    /No basemind binary available for platform/,
  );
});

test('all platforms have required fields', () => {
  for (const [key, config] of Object.entries(BASEMIND_PLATFORMS)) {
    assert.ok(config.asset, `${key} missing asset`);
    assert.ok(config.binary, `${key} missing binary`);
    assert.ok(config.target, `${key} missing target`);
  }
});
