import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeCommand,
  probeSandboxEnforced,
  resetSandboxProbeCacheForTests,
  type SandboxProbeExec,
} from './sandboxProbe';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-probe-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  resetSandboxProbeCacheForTests();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An engine whose sandbox works: the write is refused and nothing lands. */
const enforcing: SandboxProbeExec = async () => ({ exitCode: 1, stdout: '', stderr: 'Operation not permitted' });

/** An engine with no sandbox: the command really runs. */
const unenforced: SandboxProbeExec = async (params) => {
  writeFileSync(params.command.at(-1)!, 'x');
  return { exitCode: 0, stdout: '', stderr: '' };
};

describe('probeSandboxEnforced', () => {
  test('true when the write is refused and no file lands', async () => {
    expect(await probeSandboxEnforced(enforcing, { dir: root() })).toBe(true);
  });

  test('false when the write succeeds, and the stray file is removed', async () => {
    const dir = root();
    expect(await probeSandboxEnforced(unenforced, { dir })).toBe(false);
    expect(existsSync(join(dir, 'probe-target'))).toBe(false);
  });

  test('false when the file landed even though the command reported failure', async () => {
    const exec: SandboxProbeExec = async (params) => {
      writeFileSync(params.command.at(-1)!, 'x');
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    expect(await probeSandboxEnforced(exec, { dir: root() })).toBe(false);
  });

  test('false when the engine cannot run the probe at all, so nothing is vouched for', async () => {
    const exec: SandboxProbeExec = async () => {
      throw new Error('method not found');
    };
    expect(await probeSandboxEnforced(exec, { dir: root() })).toBe(false);
  });

  test('runs under a read-only policy without network', async () => {
    let seen: Parameters<SandboxProbeExec>[0] | undefined;
    await probeSandboxEnforced(async (params) => {
      seen = params;
      return { exitCode: 1, stdout: '', stderr: '' };
    }, { dir: root() });
    expect(seen?.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  });

  test('a positive result is cached, so the probe runs once', async () => {
    let calls = 0;
    const exec: SandboxProbeExec = async () => {
      calls += 1;
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const dir = root();
    await probeSandboxEnforced(exec, { dir });
    await probeSandboxEnforced(exec, { dir });
    expect(calls).toBe(1);
  });

  test('a negative result is retried after the backoff, not kept for the whole session', async () => {
    let now = 1_000;
    let calls = 0;
    const exec: SandboxProbeExec = async () => {
      calls += 1;
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const dir = root();
    const failing: SandboxProbeExec = async () => {
      throw new Error('engine restarting');
    };
    expect(await probeSandboxEnforced(failing, { dir, now: () => now })).toBe(false);
    expect(await probeSandboxEnforced(exec, { dir, now: () => now + 1_000 })).toBe(false);
    expect(calls).toBe(0);
    expect(await probeSandboxEnforced(exec, { dir, now: () => now + 61_000 })).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('probeCommand', () => {
  test('uses sh on unix and cmd on Windows, with the target as the last argument', () => {
    expect(probeCommand('darwin', '/t/x').at(-1)).toBe('/t/x');
    expect(probeCommand('linux', '/t/x')[0]).toBe('/bin/sh');
    expect(probeCommand('win32', 'C:\\t\\x')[0].toLowerCase()).toContain('cmd');
  });
});
