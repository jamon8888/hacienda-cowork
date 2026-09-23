import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrphanBlobGcOnce, resetGcFlagForTests } from './vaultGc';

describe('runOrphanBlobGcOnce', () => {
  let dir: string;

  beforeEach(() => {
    resetGcFlagForTests();
    dir = mkdtempSync(join(tmpdir(), 'gc-'));
    process.env.INTERPRETER_USER_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.INTERPRETER_USER_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test('deletes blob files whose thread ID is not in the active list', () => {
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, 'thread-orphan.enc'), 'orphan');
    writeFileSync(join(vaultsDir, 'thread-active.enc'), 'active');

    const result = runOrphanBlobGcOnce({
      activeThreadIds: ['active'],
      userDataDir: dir,
    });

    expect(result.cleaned).toBe(1);
    expect(existsSync(join(vaultsDir, 'thread-orphan.enc'))).toBe(false);
    expect(existsSync(join(vaultsDir, 'thread-active.enc'))).toBe(true);
  });

  test('returns cleaned: 0 when no orphans exist', () => {
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, 'thread-active.enc'), 'active');

    const result = runOrphanBlobGcOnce({
      activeThreadIds: ['active'],
      userDataDir: dir,
    });

    expect(result.cleaned).toBe(0);
  });

  test('only runs once per session (module-level flag)', () => {
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, 'thread-orphan.enc'), 'orphan');

    const first = runOrphanBlobGcOnce({ activeThreadIds: [], userDataDir: dir });
    expect(first.cleaned).toBe(1);

    // Recreate the file — second call should be a no-op
    writeFileSync(join(vaultsDir, 'thread-orphan2.enc'), 'orphan2');
    const second = runOrphanBlobGcOnce({ activeThreadIds: [], userDataDir: dir });
    expect(second.cleaned).toBe(0);
  });

  test('never deletes .vault-key.enc', () => {
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, '.vault-key.enc'), 'key');

    const result = runOrphanBlobGcOnce({ activeThreadIds: [], userDataDir: dir });
    expect(result.cleaned).toBe(0);
    expect(existsSync(join(vaultsDir, '.vault-key.enc'))).toBe(true);
  });

  test('never deletes note rehydration blobs (thread-note<hex>)', () => {
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(vaultsDir, { recursive: true });
    const notePath = join(vaultsDir, 'thread-note8a9b0c1d.enc');
    writeFileSync(notePath, 'note-map');

    const result = runOrphanBlobGcOnce({ activeThreadIds: [], userDataDir: dir });
    expect(result.cleaned).toBe(0);
    expect(existsSync(notePath)).toBe(true);
  });

  test('cleans orphans inside workspace segments', () => {
    const segmentDir = join(dir, 'vaults', 'deadbeef');
    mkdirSync(segmentDir, { recursive: true });
    writeFileSync(join(segmentDir, 'thread-orphan.enc'), 'orphan');

    const result = runOrphanBlobGcOnce({ activeThreadIds: [], userDataDir: dir });
    expect(result.cleaned).toBe(1);
    expect(existsSync(join(segmentDir, 'thread-orphan.enc'))).toBe(false);
  });
});
