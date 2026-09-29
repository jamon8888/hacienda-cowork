import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getCabinetModeEnabled, setConfigOverride } from '../configStore';
import {
  appendCabinetAudit,
  CABINET_AUDIT_GENESIS,
  setCabinetAuditFileForTests,
  verifyCabinetAuditChain,
} from './cabinetAudit';
import { setCabinetMode } from './cabinetMode';

let dir: string;
let auditFile: string;

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cabinet-'));
  auditFile = join(dir, 'audit', 'cabinet-mode.jsonl');
  setCabinetAuditFileForTests(auditFile);
  setConfigOverride({} as never);
});

afterEach(() => {
  setCabinetAuditFileForTests(null);
  setConfigOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('cabinet mode setting', () => {
  test('is on for a fresh config', async () => {
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('refuses to turn off without confirmation and leaves config unchanged', async () => {
    await expect(setCabinetMode(false, {})).rejects.toThrow('confirmation');
    expect(await getCabinetModeEnabled()).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  test('turns off with confirmation and records who and when', async () => {
    const result = await setCabinetMode(false, { confirmed: true });
    expect(result).toEqual({ enabled: false });
    expect(await getCabinetModeEnabled()).toBe(false);
    const [entry] = auditLines();
    expect(entry.event).toBe('cabinet_mode_disabled');
    expect(typeof entry.at).toBe('string');
    expect(typeof entry.osUser).toBe('string');
    expect(typeof entry.hostname).toBe('string');
    expect(typeof entry.appVersion).toBe('string');
  });

  test('keeps cabinet mode on when the audit entry cannot be written', async () => {
    await expect(
      setCabinetMode(false, { confirmed: true }, {
        audit: async () => { throw new Error('disk full'); },
      }),
    ).rejects.toThrow('disk full');
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('turning back on needs no confirmation and is recorded', async () => {
    await setCabinetMode(false, { confirmed: true });
    const result = await setCabinetMode(true, {});
    expect(result).toEqual({ enabled: true });
    expect(auditLines().map((e) => e.event)).toEqual(['cabinet_mode_disabled', 'cabinet_mode_enabled']);
  });

  test('turning back on still works when the audit entry cannot be written', async () => {
    await setCabinetMode(false, { confirmed: true });
    const result = await setCabinetMode(true, {}, {
      audit: async () => { throw new Error('disk full'); },
    });
    expect(result).toEqual({ enabled: true });
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('rejects non-boolean input without touching config or the log', async () => {
    for (const [value, confirmed] of [[null, true], ['x', false], [undefined, undefined], [false, 'true'], [false, 1]] as const) {
      await expect(setCabinetMode(value as never, { confirmed: confirmed as never })).rejects.toThrow('boolean');
    }
    expect(await getCabinetModeEnabled()).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  test('a block entry carries the surface and nothing else from the request', async () => {
    await appendCabinetAudit({ event: 'send_blocked', surface: 'tool' });
    const [entry] = auditLines();
    expect(Object.keys(entry).sort()).toEqual(['appVersion', 'at', 'event', 'hash', 'hostname', 'osUser', 'prev', 'surface']);
    expect(entry.surface).toBe('tool');
  });
});

describe('cabinet audit chain', () => {
  async function threeEntries(): Promise<void> {
    await appendCabinetAudit({ event: 'send_blocked', surface: 'outbound' });
    await appendCabinetAudit({ event: 'cabinet_mode_disabled' });
    await appendCabinetAudit({ event: 'cabinet_mode_enabled' });
  }

  test('each entry points to the previous one; the first to the genesis value', async () => {
    await threeEntries();
    const lines = auditLines();
    expect(lines[0].prev).toBe(CABINET_AUDIT_GENESIS);
    expect(lines[1].prev).toBe(lines[0].hash);
    expect(lines[2].prev).toBe(lines[1].hash);
    expect(String(lines[0].hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an untouched log verifies', async () => {
    await threeEntries();
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: true, entries: 3 });
  });

  test('a missing log verifies as empty', async () => {
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: true, entries: 0 });
  });

  test('editing one entry breaks the chain at that line', async () => {
    await threeEntries();
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    lines[1] = lines[1].replace('cabinet_mode_disabled', 'cabinet_mode_enabled');
    writeFileSync(auditFile, `${lines.join('\n')}\n`);
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: false, brokenAt: 2 });
  });

  test('deleting one entry breaks the chain at the next line', async () => {
    await threeEntries();
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    lines.splice(1, 1);
    writeFileSync(auditFile, `${lines.join('\n')}\n`);
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: false, brokenAt: 2 });
  });

  test('a truncated last line does not lock the log: appends continue, the break stays visible', async () => {
    await threeEntries();
    writeFileSync(auditFile, `${readFileSync(auditFile, 'utf8')}{"at":"2026-`);
    await appendCabinetAudit({ event: 'send_blocked', surface: 'tool' });
    const raw = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(5);
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: false, brokenAt: 4 });
  });

  test('a last line that parses but has no hash is treated the same way', async () => {
    await threeEntries();
    writeFileSync(auditFile, `${readFileSync(auditFile, 'utf8')}{"event":"x"}\n`);
    await appendCabinetAudit({ event: 'cabinet_mode_enabled' });
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: false, brokenAt: 4 });
  });

  test('concurrent appends still form one chain', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => appendCabinetAudit({ event: 'send_blocked', surface: 'tool' })),
    );
    expect(await verifyCabinetAuditChain(auditFile)).toEqual({ ok: true, entries: 10 });
  });
});
