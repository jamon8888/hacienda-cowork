import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  armSafeWorkspace,
  ensureMirrorsOnWorkspaceRegistry,
  POPULATION_FILE_LIMIT,
  runInitialPopulation,
  setSafeArmRegistryForTests,
  setSafeArmRescanForTests,
} from './safeArm';
import { clearAllSafeSync, mirrorDocId, setSafeSyncArmedForTests, setSafeSyncRedactForTests, setSafeSyncRegistryForTests, setSafeSyncVaultPersistForTests, setSafeSyncVaultRemoveForTests } from './safeSync';
import { WorkspaceTokenRegistry } from '../services/workspaceTokenRegistry';

// One in-memory registry per workspace; `written` records what reached the vault.
const registries = new Map<string, WorkspaceTokenRegistry>();
const written = new Set<string>();
function memoryRegistry(workspacePath: string): WorkspaceTokenRegistry {
  let registry = registries.get(workspacePath);
  if (!registry) {
    registry = new WorkspaceTokenRegistry(workspacePath, {}, {
      exists: () => false,
      decrypt: async () => ({}),
      encrypt: async (map) => JSON.stringify(map),
      write: () => {
        written.add(workspacePath);
      },
    });
    registries.set(workspacePath, registry);
  }
  return registry;
}

describe('safeArm (arm + initial population)', () => {
  let workspace = '';
  const redactMock = mock(async (absPath: string) => {
    if (absPath.endsWith('bad.bin')) throw new Error('unsupported format');
    return { redacted_text: 'REDACTED BODY', rehydration_map: { T: 'v' } };
  });
  const rescanMock = mock(async (_opts: { paths: string[] }) => ({ success: true }));

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'safe-arm-'));
    clearAllSafeSync();
    redactMock.mockClear();
    rescanMock.mockClear();
    setSafeArmRescanForTests(rescanMock);
    setSafeSyncArmedForTests(() => true);
    setSafeSyncRedactForTests(redactMock);
    setSafeSyncVaultPersistForTests(async () => {});
    setSafeSyncVaultRemoveForTests(() => {});
    registries.clear();
    written.clear();
    setSafeSyncRegistryForTests(async (path) => memoryRegistry(path));
    setSafeArmRegistryForTests({
      load: async (path) => memoryRegistry(path),
      has: async (path) => written.has(path),
    });
  });

  afterEach(() => {
    clearAllSafeSync();
    setSafeArmRescanForTests(null);
    setSafeSyncArmedForTests(null);
    setSafeSyncRedactForTests(null);
    setSafeSyncVaultPersistForTests(null);
    setSafeSyncVaultRemoveForTests(null);
    setSafeSyncRegistryForTests(null);
    setSafeArmRegistryForTests(null);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('population leaves a registry behind even when no file held PII', async () => {
    armSafeWorkspace(workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'hi');
    await runInitialPopulation(workspace);
    expect(written.has(workspace)).toBe(true);
  });

  test('mirrors written before the registry are mirrored again once', async () => {
    armSafeWorkspace(workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'hi');
    writeFileSync(join(workspace, 'safe', 'notes.txt.md'), 'old per-file numbering');
    expect(await ensureMirrorsOnWorkspaceRegistry(workspace)).toBe(true);
    expect(redactMock).toHaveBeenCalledTimes(1);
    // The registry now marks the workspace done.
    expect(await ensureMirrorsOnWorkspaceRegistry(workspace)).toBe(false);
    expect(redactMock).toHaveBeenCalledTimes(1);
  });

  test('a Safe workspace with no mirror yet, or a workspace that is not Safe, is left alone', async () => {
    expect(await ensureMirrorsOnWorkspaceRegistry(workspace)).toBe(false);
    armSafeWorkspace(workspace);
    expect(await ensureMirrorsOnWorkspaceRegistry(workspace)).toBe(false);
    expect(redactMock).not.toHaveBeenCalled();
  });

  test('armSafeWorkspace creates safe/ and is idempotent', () => {
    expect(existsSync(join(workspace, 'safe'))).toBe(false);
    armSafeWorkspace(workspace);
    expect(existsSync(join(workspace, 'safe'))).toBe(true);
    armSafeWorkspace(workspace); // no throw
    expect(existsSync(join(workspace, 'safe'))).toBe(true);
  });

  test('population mirrors files, skips safe/ and junk, one batch rescan', async () => {
    armSafeWorkspace(workspace);
    writeFileSync(join(workspace, 'notes.txt'), 'hi');
    mkdirSync(join(workspace, 'docs'));
    writeFileSync(join(workspace, 'docs/report.docx'), 'x');
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'safe/old.md'), 'stale');
    mkdirSync(join(workspace, '.basemind'));
    writeFileSync(join(workspace, '.basemind/index.db'), 'idx');

    const result = await runInitialPopulation(workspace);

    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(existsSync(join(workspace, 'safe/notes.txt.md'))).toBe(true);
    expect(existsSync(join(workspace, 'safe/docs/report.docx.md'))).toBe(true);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    const paths = rescanMock.mock.calls[0][0].paths;
    expect([...paths].sort()).toEqual(['safe/docs/report.docx.md', 'safe/notes.txt.md']);
  });

  test('population skips what the file watcher ignores (.git, node_modules)', async () => {
    writeFileSync(join(workspace, 'notes.txt'), 'hi');
    mkdirSync(join(workspace, '.git/objects'), { recursive: true });
    writeFileSync(join(workspace, '.git/objects/ab'), 'blob');
    mkdirSync(join(workspace, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules/pkg/index.js'), 'x');
    writeFileSync(join(workspace, '.DS_Store'), 'x');

    const result = await runInitialPopulation(workspace);

    expect(result).toEqual({ written: 1, skipped: 0 });
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/notes.txt.md']);
  });

  test('per-file redact failure counts as skipped without aborting', async () => {
    writeFileSync(join(workspace, 'bad.bin'), 'zz');
    writeFileSync(join(workspace, 'good.txt'), 'ok');

    const result = await runInitialPopulation(workspace);

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(1);
    expect(existsSync(join(workspace, 'safe/good.txt.md'))).toBe(true);
    expect(existsSync(join(workspace, 'safe/bad.bin.md'))).toBe(false);
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });

  test('empty workspace arms without a rescan call', async () => {
    const result = await runInitialPopulation(workspace);
    expect(existsSync(join(workspace, 'safe'))).toBe(true);
    expect(result).toEqual({ written: 0, skipped: 0 });
    expect(rescanMock).not.toHaveBeenCalled();
  });

  // Real I/O on POPULATION_FILE_LIMIT + 1 files: the 5 s default is too tight
  // on a loaded machine or slow disk.
  test('population stops at POPULATION_FILE_LIMIT', async () => {
    for (let i = 0; i <= POPULATION_FILE_LIMIT; i += 1) {
      writeFileSync(join(workspace, `f${i}.txt`), 'x');
    }

    const result = await runInitialPopulation(workspace);

    expect(result.written + result.skipped).toBe(POPULATION_FILE_LIMIT);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths.length).toBe(POPULATION_FILE_LIMIT);
  }, 30_000);
});

describe('mirrorDocId', () => {
  test('is stable, distinct per path, and fits sanitizeVaultDocId', () => {
    const id = mirrorDocId('/ws', 'docs/report.docx');
    expect(id.startsWith('sf_')).toBe(true);
    expect(id).toBe(mirrorDocId('/ws', 'docs/report.docx'));
    expect(id).not.toBe(mirrorDocId('/ws', 'docs/other.docx'));
    expect(id.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
  });

  test('normalizes Windows separators before hashing', () => {
    expect(mirrorDocId('/ws', 'docs\\report.docx')).toBe(mirrorDocId('/ws', 'docs/report.docx'));
  });
});
