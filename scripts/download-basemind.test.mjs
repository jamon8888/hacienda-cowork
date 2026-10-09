import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

// The pin and the submodule pointer are two separate places that must agree, and nothing in either
// repo enforces it. Reading the pointer is the assertion; a literal here would only ever check that
// a number had been typed twice.
//
// This fails until the pointer is moved onto the v0.33.0 tag, which is the point: it is the gate
// that stops the pin and the pointer from being moved at different times.
test('the pinned version is the basemind submodule tag', () => {
  const submodule = path.join(ROOT, 'submodules', 'basemind');
  let at;
  try {
    at = execFileSync('git', ['-C', submodule, 'describe', '--tags', '--exact-match'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    at = execFileSync('git', ['-C', submodule, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.fail(
      `submodules/basemind is at ${at}, which is not a tag, but PINNED_VERSION is ${PINNED_VERSION}. ` +
        `Either the pointer has not been moved onto the ${PINNED_VERSION} tag yet, or that tag does not exist.`,
    );
  }
  assert.equal(
    at,
    PINNED_VERSION,
    `submodules/basemind is at ${at} but PINNED_VERSION is ${PINNED_VERSION}; move both together`,
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
