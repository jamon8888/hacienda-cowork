import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  SAFE_SYNC_DEBOUNCE_MS,
  clearAllSafeSync,
  clearSafeSync,
  scheduleSafeSync,
  setSafeSyncArmedForTests,
  setSafeSyncDebounceMsForTests,
  setSafeSyncRedactForTests,
  setSafeSyncRegistryForTests,
  setSafeSyncRescanForTests,
  syncSafeMirrorFile,
  setSafeSyncVaultPersistForTests,
  setSafeSyncVaultRemoveForTests,
  shouldSafeSyncForWorkspaceEvent,
  toSafeMirrorPath,
} from './safeSync';
import { WorkspaceTokenRegistry } from '../services/workspaceTokenRegistry';

function memoryRegistry(workspacePath: string): WorkspaceTokenRegistry {
  return new WorkspaceTokenRegistry(workspacePath, {}, {
    exists: () => false,
    decrypt: async () => ({}),
    encrypt: async (map) => JSON.stringify(map),
    write: () => {},
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('shouldSafeSyncForWorkspaceEvent (#21 ignore predicate)', () => {
  test('schedules file add/change/unlink for normal workspace paths', () => {
    expect(shouldSafeSyncForWorkspaceEvent('add', 'docs/report.docx')).toBe(true);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'docs/report.docx')).toBe(true);
    expect(shouldSafeSyncForWorkspaceEvent('unlink', 'docs/report.docx')).toBe(true);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'src/app.ts')).toBe(true);
  });

  test('never schedules directory events', () => {
    expect(shouldSafeSyncForWorkspaceEvent('addDir', 'docs')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('unlinkDir', 'docs')).toBe(false);
  });

  test('skips safe/, .redacted/, and .basemind/ segments (anti-loop, case-insensitive)', () => {
    expect(shouldSafeSyncForWorkspaceEvent('change', 'safe/report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'Safe/report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'SAFE/nested/x.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('add', 'safe/nested/report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', '.redacted/report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', '.Redacted/report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', '.basemind/index.db')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('unlink', 'safe/report.md')).toBe(false);
  });

  test('does not treat a longer segment that merely contains a keyword as ignored', () => {
    expect(shouldSafeSyncForWorkspaceEvent('change', 'unsafe/report.md')).toBe(true);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'docs/safety/report.md')).toBe(true);
  });

  test('normalizes Windows separators before matching ignored roots', () => {
    expect(shouldSafeSyncForWorkspaceEvent('change', 'safe\\report.md')).toBe(false);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'docs\\report.docx')).toBe(true);
  });

  test('has no extension pre-filter — content selection stays with basemind', () => {
    expect(shouldSafeSyncForWorkspaceEvent('change', 'notes/no-extension')).toBe(true);
    expect(shouldSafeSyncForWorkspaceEvent('change', 'data/archive.zip')).toBe(true);
  });
});

describe('toSafeMirrorPath (#21 rescan corpus = safe/ mirror)', () => {
  test('maps originel paths to safe/ mirror, keeping the extension before .md', () => {
    expect(toSafeMirrorPath('docs/report.docx')).toBe('safe/docs/report.docx.md');
    expect(toSafeMirrorPath('notes.txt')).toBe('safe/notes.txt.md');
    expect(toSafeMirrorPath('archive.tar.gz')).toBe('safe/archive.tar.gz.md');
    expect(toSafeMirrorPath('docs\\report.docx')).toBe('safe/docs/report.docx.md');
  });

  test('originals differing only by extension get distinct mirrors', () => {
    expect(toSafeMirrorPath('report.pdf')).not.toBe(toSafeMirrorPath('report.docx'));
  });

  test('extensionless paths get .md appended under safe/', () => {
    expect(toSafeMirrorPath('notes/no-extension')).toBe('safe/notes/no-extension.md');
  });
});

describe('scheduleSafeSync (#21 coalescing)', () => {
  const rescanMock = mock(async (_opts: { paths: string[] }) => ({ success: true }));

  beforeEach(() => {
    clearAllSafeSync();
    rescanMock.mockClear();
    setSafeSyncRescanForTests(rescanMock);
    setSafeSyncArmedForTests(() => true);
    setSafeSyncDebounceMsForTests(15);
    // These tests schedule nonexistent originals only: keep the flush off the
    // real redact/vault module graph (heavy dynamic imports, real userData).
    setSafeSyncRedactForTests(async () => ({ redacted_text: '', rehydration_map: {} }));
    setSafeSyncVaultPersistForTests(async () => {});
    setSafeSyncVaultRemoveForTests(() => {});
  });

  afterEach(() => {
    clearAllSafeSync();
    setSafeSyncRescanForTests(null);
    setSafeSyncArmedForTests(null);
    setSafeSyncDebounceMsForTests(null);
    setSafeSyncRedactForTests(null);
    setSafeSyncVaultPersistForTests(null);
    setSafeSyncVaultRemoveForTests(null);
  });

  test('default debounce window is 2s', () => {
    expect(SAFE_SYNC_DEBOUNCE_MS).toBe(2000);
  });

  test('disarmed workspace never schedules (opt-in gate)', async () => {
    setSafeSyncArmedForTests(() => false);
    scheduleSafeSync('ws', 'a.docx');
    await sleep(40);
    expect(rescanMock).not.toHaveBeenCalled();
  });

  test('coalesces N paths into one trailing rescan of safe/ mirror paths', async () => {
    scheduleSafeSync('ws', 'a.docx');
    scheduleSafeSync('ws', 'b.docx');
    scheduleSafeSync('ws', 'a.docx'); // duplicate collapses
    scheduleSafeSync('ws', 'c.pdf');

    expect(rescanMock).not.toHaveBeenCalled();
    await sleep(40);

    expect(rescanMock).toHaveBeenCalledTimes(1);
    const paths = rescanMock.mock.calls[0][0].paths;
    expect([...paths].sort()).toEqual(['safe/a.docx.md', 'safe/b.docx.md', 'safe/c.pdf.md']);
  });

  test('trailing-edge: a later event extends the window before one flush', async () => {
    scheduleSafeSync('ws', 'first.docx');
    await sleep(8);
    scheduleSafeSync('ws', 'second.docx');
    await sleep(8);
    expect(rescanMock).not.toHaveBeenCalled();
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths.sort()).toEqual([
      'safe/first.docx.md',
      'safe/second.docx.md',
    ]);
  });

  test('workspaces debounce independently', async () => {
    scheduleSafeSync('ws-a', 'a.txt');
    scheduleSafeSync('ws-b', 'b.txt');
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(2);
  });

  test('clearSafeSync drops pending work (watch release)', async () => {
    scheduleSafeSync('ws', 'a.docx');
    clearSafeSync('ws');
    await sleep(40);
    expect(rescanMock).not.toHaveBeenCalled();
  });

  test('rescan failure is swallowed so the scheduler keeps accepting events', async () => {
    rescanMock.mockRejectedValueOnce(new Error('daemon down'));
    scheduleSafeSync('ws', 'a.docx');
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(1);

    scheduleSafeSync('ws', 'b.docx');
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(2);
    expect(rescanMock.mock.calls[1][0].paths).toEqual(['safe/b.docx.md']);
  });

  test('false success envelope does not throw out of the flush', async () => {
    rescanMock.mockResolvedValueOnce({ success: false, error: 'daemon not running' });
    scheduleSafeSync('ws', 'a.docx');
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });
});

describe('syncSafeMirrorFile (cycle middle: extract → redact → write → vault)', () => {
  let workspace = '';
  // Path predicate, not once-queues: readdir order is filesystem-dependent.
  const redactMock = mock(async (absPath: string) => {
    if (absPath.endsWith('x.bin')) throw new Error('unsupported format');
    return { redacted_text: 'REDACTED BODY', rehydration_map: { TOKEN1: 'alice@example.com' } };
  });
  const vaultPersistMock = mock(async (_docId: string, _map: Record<string, string>) => {});
  const vaultRemoveMock = mock((_docId: string) => {});
  const rescanMock = mock(async (_opts: { paths: string[] }) => ({ success: true }));

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'safe-sync-'));
    clearAllSafeSync();
    rescanMock.mockClear();
    redactMock.mockClear();
    vaultPersistMock.mockClear();
    vaultRemoveMock.mockClear();
    setSafeSyncRescanForTests(rescanMock);
    setSafeSyncArmedForTests(() => true);
    setSafeSyncDebounceMsForTests(15);
    setSafeSyncRedactForTests(redactMock);
    setSafeSyncVaultPersistForTests(vaultPersistMock);
    setSafeSyncVaultRemoveForTests(vaultRemoveMock);
    setSafeSyncRegistryForTests(async (path) => memoryRegistry(path));
  });

  afterEach(() => {
    setSafeSyncRegistryForTests(null);
    clearAllSafeSync();
    setSafeSyncRescanForTests(null);
    setSafeSyncArmedForTests(null);
    setSafeSyncDebounceMsForTests(null);
    setSafeSyncRedactForTests(null);
    setSafeSyncVaultPersistForTests(null);
    setSafeSyncVaultRemoveForTests(null);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('add writes the redacted mirror under safe/ and persists the rehydration map', async () => {
    writeFileSync(join(workspace, 'notes.txt'), 'hello');
    scheduleSafeSync('ws', 'notes.txt', workspace);
    await sleep(50);

    expect(readFileSync(join(workspace, 'safe/notes.txt.md'), 'utf8')).toBe('REDACTED BODY');
    expect(redactMock).toHaveBeenCalledWith(join(workspace, 'notes.txt'));
    expect(vaultPersistMock).toHaveBeenCalledTimes(1);
    expect(String(vaultPersistMock.mock.calls[0][0]).startsWith('sf_')).toBe(true);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/notes.txt.md']);
  });

  test('nested originals get recursive mirror parents', async () => {
    mkdirSync(join(workspace, 'docs'));
    writeFileSync(join(workspace, 'docs/report.docx'), 'x');
    scheduleSafeSync('ws', 'docs/report.docx', workspace);
    await sleep(50);

    expect(readFileSync(join(workspace, 'safe/docs/report.docx.md'), 'utf8')).toBe(
      'REDACTED BODY',
    );
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/docs/report.docx.md']);
  });

  test('missing original removes the mirror and vault blob, still rescans', async () => {
    scheduleSafeSync('ws', 'gone.txt', workspace);
    await sleep(50);

    expect(redactMock).not.toHaveBeenCalled();
    expect(vaultRemoveMock).toHaveBeenCalledTimes(1);
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/gone.txt.md']);
  });

  test('real unlink deletes an existing mirror file', async () => {
    writeFileSync(join(workspace, 'doc.txt'), 'body');
    scheduleSafeSync('ws', 'doc.txt', workspace);
    await sleep(50);
    expect(existsSync(join(workspace, 'safe/doc.txt.md'))).toBe(true);

    rmSync(join(workspace, 'doc.txt'));
    scheduleSafeSync('ws', 'doc.txt', workspace);
    await sleep(50);

    expect(existsSync(join(workspace, 'safe/doc.txt.md'))).toBe(false);
    expect(vaultRemoveMock).toHaveBeenCalledTimes(1);
  });

  test('redact failure skips that write but keeps the batch', async () => {
    writeFileSync(join(workspace, 'x.bin'), 'zz');
    writeFileSync(join(workspace, 'ok.txt'), 'fine');
    scheduleSafeSync('ws', 'x.bin', workspace);
    scheduleSafeSync('ws', 'ok.txt', workspace);
    await sleep(60);

    expect(existsSync(join(workspace, 'safe/x.bin.md'))).toBe(false);
    expect(readFileSync(join(workspace, 'safe/ok.txt.md'), 'utf8')).toBe('REDACTED BODY');
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect([...rescanMock.mock.calls[0][0].paths].sort()).toEqual([
      'safe/ok.txt.md',
      'safe/x.bin.md',
    ]);
  });

  test('vault persist failure does not block the mirror or the rescan', async () => {
    vaultPersistMock.mockRejectedValueOnce(new Error('vault key missing'));
    writeFileSync(join(workspace, 'a.txt'), 'x');
    scheduleSafeSync('ws', 'a.txt', workspace);
    await sleep(50);

    expect(readFileSync(join(workspace, 'safe/a.txt.md'), 'utf8')).toBe('REDACTED BODY');
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });

  test('a file refused for NER coverage loses its old mirror and vault blob', async () => {
    writeFileSync(join(workspace, 'long.txt'), 'body');
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'safe/long.txt.md'), 'OLD MIRROR WITH PAGE TWO IN CLEAR');
    redactMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('redact_text: NER coverage not proven'), { name: 'NerCoverageError' });
    });
    scheduleSafeSync('ws', 'long.txt', workspace);
    await sleep(50);

    expect(existsSync(join(workspace, 'safe/long.txt.md'))).toBe(false);
    expect(vaultRemoveMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/long.txt.md']);
  });

  test('any other redact failure keeps the previous mirror', async () => {
    writeFileSync(join(workspace, 'doc.txt'), 'body');
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'safe/doc.txt.md'), 'PREVIOUS GOOD MIRROR');
    redactMock.mockImplementationOnce(async () => { throw new Error('daemon restarting'); });
    scheduleSafeSync('ws', 'doc.txt', workspace);
    await sleep(50);

    expect(readFileSync(join(workspace, 'safe/doc.txt.md'), 'utf8')).toBe('PREVIOUS GOOD MIRROR');
    expect(vaultRemoveMock).not.toHaveBeenCalled();
  });
});

describe('syncSafeMirrorFile numbers every mirror on the workspace registry', () => {
  let workspace = '';
  let registry: WorkspaceTokenRegistry;
  const persisted = new Map<string, Record<string, string>>();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'safe-sync-registry-'));
    registry = memoryRegistry(workspace);
    persisted.clear();
    setSafeSyncRegistryForTests(async () => registry);
    setSafeSyncVaultPersistForTests(async (docId, map) => {
      persisted.set(docId, map);
    });
    // basemind numbers each file from scratch: both files say [PERSON_1].
    setSafeSyncRedactForTests(async (absPath: string) => absPath.endsWith('a.txt')
      ? { redacted_text: 'Seller [PERSON_1], buyer [PERSON_2].', rehydration_map: { '[PERSON_1]': 'Jean Dupont', '[PERSON_2]': 'Marie Curie' } }
      : { redacted_text: 'Witness [PERSON_1] and [PERSON_2].', rehydration_map: { '[PERSON_1]': 'Paul Martin', '[PERSON_2]': 'Jean Dupont' } });
  });

  afterEach(() => {
    setSafeSyncRegistryForTests(null);
    setSafeSyncRedactForTests(null);
    setSafeSyncVaultPersistForTests(null);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('a value keeps one token across files and different values never share one', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'original a');
    writeFileSync(join(workspace, 'b.txt'), 'original b');
    await syncSafeMirrorFile(workspace, 'a.txt');
    await syncSafeMirrorFile(workspace, 'b.txt');

    const mirrorA = readFileSync(join(workspace, 'safe', 'a.txt.md'), 'utf8');
    const mirrorB = readFileSync(join(workspace, 'safe', 'b.txt.md'), 'utf8');
    const jean = Object.entries(registry.tokens()).find(([, value]) => value === 'Jean Dupont')?.[0];
    const paul = Object.entries(registry.tokens()).find(([, value]) => value === 'Paul Martin')?.[0];
    expect(jean).toBeDefined();
    expect(paul).toBeDefined();
    expect(jean).not.toBe(paul);
    expect(mirrorA).toContain(`Seller ${jean}`);
    expect(mirrorB).toContain(`Witness ${paul} and ${jean}.`);
    expect(Object.keys(registry.tokens())).toHaveLength(3);
    // The per-document maps (Show Originals) carry the workspace tokens too.
    for (const map of persisted.values()) {
      for (const [token, value] of Object.entries(map)) expect(registry.valueOf(token)).toBe(value);
    }
  });

  test('a registry that cannot be written leaves the mirror unwritten', async () => {
    registry = new WorkspaceTokenRegistry(workspace, {}, {
      exists: () => false,
      decrypt: async () => ({}),
      encrypt: async () => { throw new Error('vault down'); },
      write: () => {},
    });
    writeFileSync(join(workspace, 'a.txt'), 'original a');
    const { written } = await syncSafeMirrorFile(workspace, 'a.txt');
    expect(written).toBe(false);
    expect(existsSync(join(workspace, 'safe', 'a.txt.md'))).toBe(false);
  });
});

