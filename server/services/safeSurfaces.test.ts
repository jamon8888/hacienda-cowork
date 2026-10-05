import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../configStore', () => ({
  getSafeSurfacesConfig: async () => ({}),
  getSafeSurfacesConfigSync: () => ({}),
  setSafeSurfaceInConfig: async () => {},
}));

const {
  DEFAULT_SAFE_SURFACES,
  applySafeBrowserSurface,
  applySafeCuaSurface,
  denyAllBrowserAccess,
  denyAllCuaAccess,
  getSafeHiddenServerIds,
  isSurfaceBlockedInSafe,
  resolveSafeSurfaces,
  setSafeSurface,
  surfaceHiddenServerIds,
} = await import('./safeSurfaces');
const { DEFAULT_BROWSER_ACCESS_POLICY } = await import('../../shared/browserAccessPolicy');
const { DEFAULT_CUA_ACCESS_POLICY } = await import('../../shared/cuaAccessPolicy');

const dirs: string[] = [];
function workspace(safe: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'surfaces-'));
  dirs.push(dir);
  if (safe) mkdirSync(join(dir, 'safe'));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const allOn = { voice: true, computerUse: true, browserControl: true, network: true };
const allOff = { voice: false, computerUse: false, browserControl: false, network: false };

describe('defaults', () => {
  test('voice is off, the other surfaces are on', () => {
    expect(DEFAULT_SAFE_SURFACES).toEqual({ voice: false, computerUse: true, browserControl: true, network: true });
    expect(resolveSafeSurfaces(undefined)).toEqual(DEFAULT_SAFE_SURFACES);
  });

  test('stored booleans win, anything else is ignored', () => {
    expect(resolveSafeSurfaces({ voice: true, network: false, computerUse: 'no', browserControl: null }))
      .toEqual({ voice: true, computerUse: true, browserControl: true, network: false });
  });
});

describe('setSafeSurface', () => {
  function fakes(current = DEFAULT_SAFE_SURFACES) {
    const log: string[] = [];
    return {
      log,
      deps: {
        read: async () => current,
        audit: async (entry: unknown) => { log.push(`audit:${JSON.stringify(entry)}`); },
        write: async (surface: string, enabled: boolean) => { log.push(`write:${surface}=${enabled}`); },
      },
    };
  }

  test('turning a surface off is audited first, then written, with no confirmation', async () => {
    const { log, deps } = fakes();
    const result = await setSafeSurface('network', false, {}, deps);
    expect(result.network).toBe(false);
    expect(log).toEqual([
      'audit:{"event":"safe_surface_changed","surface":"network","enabled":false}',
      'write:network=false',
    ]);
  });

  test('turning a surface on needs confirmation', async () => {
    const { log, deps } = fakes();
    await expect(setSafeSurface('voice', true, {}, deps)).rejects.toThrow('requires explicit confirmation');
    await expect(setSafeSurface('voice', true, { confirmed: false }, deps)).rejects.toThrow();
    expect(log).toEqual([]);
    const result = await setSafeSurface('voice', true, { confirmed: true }, deps);
    expect(result.voice).toBe(true);
    expect(log).toHaveLength(2);
  });

  test('no trace, no change: a failed audit leaves the setting alone', async () => {
    const { log, deps } = fakes();
    deps.audit = async () => { throw new Error('disk full'); };
    await expect(setSafeSurface('network', false, {}, deps)).rejects.toThrow('disk full');
    expect(log).toEqual([]);
  });

  test('a change that changes nothing records nothing', async () => {
    const { log, deps } = fakes();
    await setSafeSurface('voice', false, {}, deps);
    expect(log).toEqual([]);
  });

  test('untyped input is refused', async () => {
    const { log, deps } = fakes();
    await expect(setSafeSurface('microphone', true, { confirmed: true }, deps)).rejects.toThrow();
    await expect(setSafeSurface('voice', 'yes', { confirmed: true }, deps)).rejects.toThrow();
    await expect(setSafeSurface('voice', true, { confirmed: 'yes' as never }, deps)).rejects.toThrow();
    expect(log).toEqual([]);
  });
});

describe('where a switched-off surface applies', () => {
  test('only inside a Safe workspace', () => {
    const safe = workspace(true);
    const plain = workspace(false);
    expect(isSurfaceBlockedInSafe('voice', [safe], DEFAULT_SAFE_SURFACES)).toBe(true);
    expect(isSurfaceBlockedInSafe('voice', [plain], DEFAULT_SAFE_SURFACES)).toBe(false);
    expect(isSurfaceBlockedInSafe('voice', [null, undefined], DEFAULT_SAFE_SURFACES)).toBe(false);
    // Any Safe path counts (a voice session has a current and an action folder).
    expect(isSurfaceBlockedInSafe('voice', [plain, safe], DEFAULT_SAFE_SURFACES)).toBe(true);
    // A surface left on blocks nothing.
    expect(isSurfaceBlockedInSafe('network', [safe], DEFAULT_SAFE_SURFACES)).toBe(false);
  });

  test('servers hidden from the model follow the surfaces left off', () => {
    expect([...surfaceHiddenServerIds(allOn)]).toEqual([]);
    expect([...surfaceHiddenServerIds({ ...allOn, computerUse: false })].sort())
      .toEqual(['builtin-cua-driver', 'builtin-interpreter-overlay']);
    expect([...surfaceHiddenServerIds({ ...allOn, network: false })]).toEqual(['builtin-google']);

    const safe = workspace(true);
    const open = workspace(false);
    // Send channels are always hidden in Safe; the rest only when their surface is off.
    expect([...getSafeHiddenServerIds(safe, allOn)].sort())
      .toEqual(['builtin-nylas', 'builtin-telegram', 'builtin-whatsapp']);
    expect(getSafeHiddenServerIds(safe, allOff).has('builtin-cua-driver')).toBe(true);
    expect(getSafeHiddenServerIds(safe, allOff).has('builtin-google')).toBe(true);
    expect(getSafeHiddenServerIds(open, allOff).size).toBe(0);
  });

  test('the browser is denied everywhere, grants and profile rules included', () => {
    const safe = workspace(true);
    const granted = {
      permissions: {
        read: { mode: 'all' as const, allowedPatterns: [] },
        write: { mode: 'allowList' as const, allowedPatterns: ['example.com/*'] },
        action: { mode: 'ask' as const, allowedPatterns: [] },
      },
      profilePolicies: [{
        profileId: 'p1',
        permissions: {
          read: { mode: 'all' as const, allowedPatterns: [] },
          write: { mode: 'all' as const, allowedPatterns: [] },
          action: { mode: 'all' as const, allowedPatterns: [] },
        },
      }],
    };
    const denied = applySafeBrowserSurface(granted, safe, { ...allOn, browserControl: false });
    for (const kind of ['read', 'write', 'action'] as const) {
      expect(denied.permissions[kind]).toEqual({ mode: 'deny', allowedPatterns: [] });
      expect(denied.profilePolicies[0].permissions[kind].mode).toBe('deny');
    }
    // Left on, or outside Safe: the policy is the user's own, untouched.
    expect(applySafeBrowserSurface(granted, safe, allOn)).toBe(granted);
    expect(applySafeBrowserSurface(granted, workspace(false), allOff)).toBe(granted);
    expect(denyAllBrowserAccess(DEFAULT_BROWSER_ACCESS_POLICY).permissions.read.mode).toBe('deny');
  });

  test('Computer Use is denied for inspect and control, per-app rules included', () => {
    const safe = workspace(true);
    const policy = {
      permissions: { inspect: { mode: 'all' as const }, control: { mode: 'all' as const } },
      appPolicies: [{ appId: 'Word', displayName: 'Word', permissions: { inspect: { mode: 'all' as const }, control: { mode: 'all' as const } } }],
    };
    const denied = applySafeCuaSurface(policy, safe, { ...allOn, computerUse: false });
    expect(denied.permissions).toEqual({ inspect: { mode: 'deny' }, control: { mode: 'deny' } });
    expect(denied.appPolicies[0].permissions).toEqual({ inspect: { mode: 'deny' }, control: { mode: 'deny' } });
    expect(applySafeCuaSurface(policy, safe, allOn)).toBe(policy);
    expect(denyAllCuaAccess(DEFAULT_CUA_ACCESS_POLICY).permissions.control.mode).toBe('deny');
  });
});

describe('the audit trail of a change', () => {
  test('lands in the hash-chained cabinet log, without content, and a tampered line breaks the chain', async () => {
    const { setCabinetAuditFileForTests, verifyCabinetAuditChain } = await import('./cabinetAudit');
    const dir = mkdtempSync(join(tmpdir(), 'surfaces-audit-'));
    dirs.push(dir);
    const file = join(dir, 'audit', 'cabinet-mode.jsonl');
    setCabinetAuditFileForTests(file);
    try {
      let current = DEFAULT_SAFE_SURFACES;
      const deps = {
        read: async () => current,
        write: async (surface: 'voice' | 'computerUse' | 'browserControl' | 'network', enabled: boolean) => {
          current = { ...current, [surface]: enabled };
        },
      };
      await setSafeSurface('voice', true, { confirmed: true }, deps);
      await setSafeSurface('network', false, {}, deps);

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => [line.event, line.surface, line.enabled]))
        .toEqual([['safe_surface_changed', 'voice', true], ['safe_surface_changed', 'network', false]]);
      expect(await verifyCabinetAuditChain(file)).toEqual({ ok: true, entries: 2 });

      const tampered = readFileSync(file, 'utf8').replace('"enabled":true', '"enabled":false');
      writeFileSync(file, tampered);
      expect((await verifyCabinetAuditChain(file)).ok).toBe(false);
    } finally {
      setCabinetAuditFileForTests(null);
    }
  });
});

