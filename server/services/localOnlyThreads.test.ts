import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../configStore', () => ({
  getInterpreterAppDataDir: () => '/nonexistent',
  getSafeSurfacesConfig: async () => ({}),
  getSafeSurfacesConfigSync: () => ({}),
  setSafeSurfaceInConfig: async () => {},
  getLanguage: async () => 'fr',
}));

const {
  LocalOnlyThreadError,
  isLocalOnlyThread,
  recordLocalOnlyThread,
  refuseLocalOnlyThread,
  setLocalOnlyThreadsFileForTests,
} = await import('./localOnlyThreads');

let dir = '';
let file = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-only-'));
  file = join(dir, 'nested', 'local-only-threads.json');
  setLocalOnlyThreadsFileForTests(file);
});
afterEach(() => {
  setLocalOnlyThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('local-only conversations', () => {
  test('nothing is local-only until recorded', () => {
    expect(isLocalOnlyThread('t1')).toBe(false);
    expect(isLocalOnlyThread(undefined)).toBe(false);
    expect(isLocalOnlyThread('')).toBe(false);
  });

  test('recording audits once, then persists across a restart', async () => {
    const audits: unknown[] = [];
    const audit = async (entry: unknown) => { audits.push(entry); };
    await recordLocalOnlyThread('t1', { audit });
    await recordLocalOnlyThread('t1', { audit });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ event: 'local_bypass_used' });
    expect(JSON.stringify(audits[0])).not.toContain('t1');
    expect(isLocalOnlyThread('t1')).toBe(true);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');

    // A new process reads the file again.
    setLocalOnlyThreadsFileForTests(file);
    expect(isLocalOnlyThread('t1')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['t1']);
  });

  test('a failed audit marks nothing', async () => {
    await expect(recordLocalOnlyThread('t2', { audit: async () => { throw new Error('disk full'); } }))
      .rejects.toThrow('disk full');
    expect(isLocalOnlyThread('t2')).toBe(false);
  });

  test('an unreadable list fails closed instead of reading as empty', () => {
    writeFileSync(file.replace('nested/', ''), '{not json');
    setLocalOnlyThreadsFileForTests(file.replace('nested/', ''));
    expect(() => isLocalOnlyThread('t1')).toThrow();
    writeFileSync(file.replace('nested/', ''), JSON.stringify({ t1: true }));
    setLocalOnlyThreadsFileForTests(file.replace('nested/', ''));
    expect(() => isLocalOnlyThread('t1')).toThrow(/corrupt/);
  });

  test('a refusal is audited and thrown in the user language', async () => {
    const audits: unknown[] = [];
    const refused = refuseLocalOnlyThread('t3', { audit: async (entry) => { audits.push(entry); } });
    await expect(refused).rejects.toBeInstanceOf(LocalOnlyThreadError);
    await expect(refuseLocalOnlyThread('t3', { audit: async () => {} })).rejects.toThrow(/pseudonymisation/);
    expect(audits[0]).toMatchObject({ event: 'local_bypass_refused' });
  });

  test('a refusal still throws when the audit cannot be written', async () => {
    await expect(refuseLocalOnlyThread('t4', { audit: async () => { throw new Error('disk full'); }, message: 'refused' }))
      .rejects.toThrow('refused');
  });
});
