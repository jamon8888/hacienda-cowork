import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  armSafeWorkspace,
  POPULATION_FILE_LIMIT,
  runInitialPopulation,
  setSafeArmRescanForTests,
} from './safeArm';
import { clearAllSafeSync, mirrorDocId, setSafeSyncArmedForTests, setSafeSyncRedactForTests, setSafeSyncVaultPersistForTests, setSafeSyncVaultRemoveForTests } from './safeSync';

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
  });

  afterEach(() => {
    clearAllSafeSync();
    setSafeArmRescanForTests(null);
    setSafeSyncArmedForTests(null);
    setSafeSyncRedactForTests(null);
    setSafeSyncVaultPersistForTests(null);
    setSafeSyncVaultRemoveForTests(null);
    rmSync(workspace, { recursive: true, force: true });
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
    expect(existsSync(join(workspace, 'safe/notes.md'))).toBe(true);
    expect(existsSync(join(workspace, 'safe/docs/report.md'))).toBe(true);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    const paths = rescanMock.mock.calls[0][0].paths;
    expect([...paths].sort()).toEqual(['safe/docs/report.md', 'safe/notes.md']);
  });

  test('per-file redact failure counts as skipped without aborting', async () => {
    writeFileSync(join(workspace, 'bad.bin'), 'zz');
    writeFileSync(join(workspace, 'good.txt'), 'ok');

    const result = await runInitialPopulation(workspace);

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(1);
    expect(existsSync(join(workspace, 'safe/good.md'))).toBe(true);
    expect(existsSync(join(workspace, 'safe/bad.md'))).toBe(false);
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });

  test('empty workspace arms without a rescan call', async () => {
    const result = await runInitialPopulation(workspace);
    expect(existsSync(join(workspace, 'safe'))).toBe(true);
    expect(result).toEqual({ written: 0, skipped: 0 });
    expect(rescanMock).not.toHaveBeenCalled();
  });

  test('population stops at POPULATION_FILE_LIMIT', async () => {
    for (let i = 0; i <= POPULATION_FILE_LIMIT; i += 1) {
      writeFileSync(join(workspace, `f${i}.txt`), 'x');
    }

    const result = await runInitialPopulation(workspace);

    expect(result.written + result.skipped).toBe(POPULATION_FILE_LIMIT);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths.length).toBe(POPULATION_FILE_LIMIT);
  });
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
