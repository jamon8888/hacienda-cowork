import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  SAFE_SYNC_DEBOUNCE_MS,
  clearAllSafeSync,
  clearSafeSync,
  scheduleSafeSync,
  setSafeSyncArmedForTests,
  setSafeSyncDebounceMsForTests,
  setSafeSyncRescanForTests,
  shouldSafeSyncForWorkspaceEvent,
  toSafeMirrorPath,
} from './safeSync';

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
  test('maps originel paths to safe/ mirror with .md extension', () => {
    expect(toSafeMirrorPath('docs/report.docx')).toBe('safe/docs/report.md');
    expect(toSafeMirrorPath('notes.txt')).toBe('safe/notes.md');
    expect(toSafeMirrorPath('archive.tar.gz')).toBe('safe/archive.tar.md');
    expect(toSafeMirrorPath('docs\\report.docx')).toBe('safe/docs/report.md');
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
  });

  afterEach(() => {
    clearAllSafeSync();
    setSafeSyncRescanForTests(null);
    setSafeSyncArmedForTests(null);
    setSafeSyncDebounceMsForTests(null);
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
    expect([...paths].sort()).toEqual(['safe/a.md', 'safe/b.md', 'safe/c.md']);
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
      'safe/first.md',
      'safe/second.md',
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
    expect(rescanMock.mock.calls[1][0].paths).toEqual(['safe/b.md']);
  });

  test('false success envelope does not throw out of the flush', async () => {
    rescanMock.mockResolvedValueOnce({ success: false, error: 'daemon not running' });
    scheduleSafeSync('ws', 'a.docx');
    await sleep(40);
    expect(rescanMock).toHaveBeenCalledTimes(1);
  });
});
