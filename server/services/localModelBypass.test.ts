import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../configStore', () => ({
  getSafeSurfacesConfig: async () => ({}),
  getSafeSurfacesConfigSync: () => ({}),
  setSafeSurfaceInConfig: async () => {},
  getSafeLocalBypassConfig: async () => false,
  setSafeLocalBypassInConfig: async () => {},
}));

const {
  isLocalOnlyRoute,
  routeFromThreadConfig,
  setSafeLocalBypass,
  verifyLocalRoute,
  auditThreadId,
} = await import('./localModelBypass');

const dirs: string[] = [];
function workspace(safe: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bypass-'));
  dirs.push(dir);
  if (safe) mkdirSync(join(dir, 'safe'));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function route(baseUrl: string, modelProvider = 'ollama-1a2b3c4d', requiresAuth = false) {
  return { modelProvider, providerConfig: { base_url: baseUrl, requires_openai_auth: requiresAuth } };
}

describe('verifyLocalRoute', () => {
  test.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://127.0.0.2:8080/v1',
    'http://[::1]:11434/v1',
    'https://LOCALHOST.:8443/v1',
  ])('accepts loopback %s', (url) => {
    expect(verifyLocalRoute(route(url), { appServerPort: 5177 })).toEqual({ local: true });
  });

  test.each([
    ['http://0.0.0.0:11434/v1', 'not-loopback'],
    ['http://10.0.0.5:11434/v1', 'not-loopback'],
    ['http://192.168.1.20:11434/v1', 'not-loopback'],
    ['http://localhost.example.com/v1', 'not-loopback'],
    ['http://127.0.0.1.nip.io/v1', 'not-loopback'],
    ['https://api.groq.com/openai/v1', 'not-loopback'],
    ['ftp://localhost/v1', 'no-endpoint'],
    ['not a url', 'no-endpoint'],
  ])('refuses %s', (url, reason) => {
    expect(verifyLocalRoute(route(url), { appServerPort: 5177 })).toEqual({ local: false, reason: reason as never });
  });

  test('refuses the app server port: it proxies to remote providers', () => {
    expect(verifyLocalRoute(route('http://localhost:5177/api/agent/groq-proxy', 'groq'), { appServerPort: 5177 }))
      .toEqual({ local: false, reason: 'app-proxy' });
  });

  test('refuses hosted providers and account sign-in whatever the URL', () => {
    expect(verifyLocalRoute(route('http://localhost:9000', 'interpreter'))).toEqual({ local: false, reason: 'hosted' });
    expect(verifyLocalRoute(route('http://localhost:9000', 'openai'))).toEqual({ local: false, reason: 'hosted' });
    expect(verifyLocalRoute(route('http://localhost:9000', 'custom', true))).toEqual({ local: false, reason: 'account' });
  });

  test('refuses a route with no endpoint config', () => {
    expect(verifyLocalRoute({ modelProvider: 'ollama' })).toEqual({ local: false, reason: 'no-endpoint' });
    expect(verifyLocalRoute(null)).toEqual({ local: false, reason: 'hosted' });
  });
});

describe('routeFromThreadConfig', () => {
  test('reads the selected provider entry', () => {
    const config = { model_providers: { ollama: { base_url: 'http://localhost:11434/v1' }, other: { base_url: 'https://x' } } };
    expect(routeFromThreadConfig('ollama', config)).toEqual({
      modelProvider: 'ollama',
      providerConfig: { base_url: 'http://localhost:11434/v1' },
    });
  });

  test('has no endpoint when the provider is not in the config', () => {
    expect(routeFromThreadConfig('ollama', {}).providerConfig).toBeNull();
    expect(routeFromThreadConfig(null, { model_providers: {} }).providerConfig).toBeNull();
  });
});

describe('isLocalOnlyRoute', () => {
  const allOff = { voice: false, computerUse: false, browserControl: false, network: false };
  const base = {
    enabled: async () => true,
    surfaces: async () => allOff,
    guardRoute: async () => null,
    appServerPort: () => 5177,
  };
  const local = route('http://127.0.0.1:11434/v1');

  test('true for a Safe folder, the setting on, surfaces off and a local model', async () => {
    expect(await isLocalOnlyRoute(workspace(true), local, base)).toBe(true);
  });

  test('false outside a Safe folder', async () => {
    expect(await isLocalOnlyRoute(workspace(false), local, base)).toBe(false);
    expect(await isLocalOnlyRoute(null, local, base)).toBe(false);
  });

  test('false with the setting off', async () => {
    expect(await isLocalOnlyRoute(workspace(true), local, { ...base, enabled: async () => false })).toBe(false);
  });

  test.each(['network', 'browserControl', 'computerUse'] as const)('false while %s is on', async (surface) => {
    expect(await isLocalOnlyRoute(workspace(true), local, { ...base, surfaces: async () => ({ ...allOff, [surface]: true }) }))
      .toBe(false);
  });

  test('voice does not count: it is its own channel', async () => {
    expect(await isLocalOnlyRoute(workspace(true), local, { ...base, surfaces: async () => ({ ...allOff, voice: true }) }))
      .toBe(true);
  });

  test('false for a remote model', async () => {
    expect(await isLocalOnlyRoute(workspace(true), route('https://api.example.com/v1'), base)).toBe(false);
  });

  test('false when the read-tool guard model is remote', async () => {
    expect(await isLocalOnlyRoute(workspace(true), local, {
      ...base,
      guardRoute: async () => route('https://api.example.com/v1'),
    })).toBe(false);
    expect(await isLocalOnlyRoute(workspace(true), local, {
      ...base,
      guardRoute: async () => route('http://localhost:11434/v1'),
    })).toBe(true);
  });

  test('false, not thrown, when a check fails', async () => {
    expect(await isLocalOnlyRoute(workspace(true), local, {
      ...base,
      enabled: async () => { throw new Error('config unreadable'); },
    })).toBe(false);
  });
});

describe('setSafeLocalBypass', () => {
  function recorder(current: boolean) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        read: async () => current,
        audit: async (entry: { event: string }) => { calls.push(`audit:${entry.event}`); },
        write: async (value: boolean) => { calls.push(`write:${value}`); },
        surfaceOff: async (surface: string) => { calls.push(`off:${surface}`); },
        state: async () => ({ enabled: !current, blockingSurfaces: [] }),
      },
    };
  }

  test('turning on needs confirmation and changes nothing without it', async () => {
    const { calls, deps } = recorder(false);
    await expect(setSafeLocalBypass(true, {}, deps)).rejects.toThrow(/confirmation/);
    expect(calls).toEqual([]);
  });

  test('turning on switches the outward surfaces off, then audits, then stores', async () => {
    const { calls, deps } = recorder(false);
    await setSafeLocalBypass(true, { confirmed: true }, deps);
    expect(calls).toEqual([
      'off:network', 'off:browserControl', 'off:computerUse',
      'audit:local_bypass_enabled', 'write:true',
    ]);
  });

  test('turning off audits then stores, without confirmation', async () => {
    const { calls, deps } = recorder(true);
    await setSafeLocalBypass(false, {}, deps);
    expect(calls).toEqual(['audit:local_bypass_disabled', 'write:false']);
  });

  test('a failed audit stores nothing', async () => {
    const { calls, deps } = recorder(true);
    await expect(setSafeLocalBypass(false, {}, {
      ...deps,
      audit: async () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    expect(calls).toEqual([]);
  });

  test('no change records nothing; bad input is refused', async () => {
    const { calls, deps } = recorder(true);
    await setSafeLocalBypass(true, { confirmed: true }, deps);
    expect(calls).toEqual([]);
    await expect(setSafeLocalBypass('yes', {}, deps)).rejects.toThrow();
  });
});

test('auditThreadId hides the id but is stable', () => {
  expect(auditThreadId('thread-1')).toMatch(/^[0-9a-f]{16}$/);
  expect(auditThreadId('thread-1')).toBe(auditThreadId('thread-1'));
  expect(auditThreadId('thread-1')).not.toContain('thread');
});
