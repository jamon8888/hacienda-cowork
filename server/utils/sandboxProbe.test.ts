import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeCommand,
  probeSandboxEnforced,
  resetSandboxProbeCacheForTests,
  type SandboxProbeExec,
  type SandboxProbeParams,
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

const READ_ONLY = { type: 'readOnly', networkAccess: false };
const isWriteCommand = (params: SandboxProbeParams) => /echo x|Set-Content/.test(params.command.join(' '));

/**
 * A stand-in engine. `enforcing`: a write is allowed only under a writeable
 * policy, reads always work. `unenforced`: nothing is ever refused.
 * `broken`: the command cannot run at all (wrong shell, bad quoting).
 */
function engine(mode: 'enforcing' | 'unenforced' | 'broken', seen: SandboxProbeParams[] = []): SandboxProbeExec {
  return async (params) => {
    seen.push(params);
    if (mode === 'broken') return { exitCode: 1, stdout: '', stderr: 'bad command' };
    const target = params.env.SBX_PROBE_TARGET;
    const isWrite = isWriteCommand(params);
    if (isWrite) {
      if (mode === 'enforcing' && params.sandboxPolicy.type === 'readOnly') {
        return { exitCode: 1, stdout: '', stderr: 'Operation not permitted' };
      }
      writeFileSync(target, 'x');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return existsSync(target)
      ? { exitCode: 0, stdout: readFileSync(target, 'utf8'), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'no such file' };
  };
}

describe('probeSandboxEnforced', () => {
  test('true when the command works, the sandbox lets it read, and refuses the write', async () => {
    expect(await probeSandboxEnforced(engine('enforcing'), { dir: root(), platform: 'linux' })).toBe(true);
  });

  test('false when nothing is refused, and no file is left behind', async () => {
    const dir = root();
    expect(await probeSandboxEnforced(engine('unenforced'), { dir, platform: 'linux' })).toBe(false);
    expect(existsSync(join(dir, 'probe-control'))).toBe(false);
    expect(existsSync(join(dir, 'probe-target'))).toBe(false);
  });

  test('false when the probe command cannot run here: a refusal is not told apart from a bad command', async () => {
    // This is the Windows failure that motivated the control step: the write
    // "failed" because the command was wrong, not because a sandbox refused it.
    expect(await probeSandboxEnforced(engine('broken'), { dir: root(), platform: 'linux' })).toBe(false);
  });

  test('false when the sandbox cannot even run a read, so the refusal proves nothing', async () => {
    const exec: SandboxProbeExec = async (params) => {
      if (params.sandboxPolicy.type === 'readOnly') return { exitCode: 1, stdout: '', stderr: 'cannot start' };
      writeFileSync(params.env.SBX_PROBE_TARGET, 'x');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    expect(await probeSandboxEnforced(exec, { dir: root(), platform: 'linux' })).toBe(false);
  });

  test('false when the file landed even though the command reported failure', async () => {
    const exec: SandboxProbeExec = async (params) => {
      writeFileSync(params.env.SBX_PROBE_TARGET, 'x');
      return { exitCode: params.sandboxPolicy.type === 'readOnly' && isWriteCommand(params) ? 1 : 0, stdout: '', stderr: '' };
    };
    expect(await probeSandboxEnforced(exec, { dir: root(), platform: 'linux' })).toBe(false);
  });

  test('false when the engine cannot run the probe at all', async () => {
    const exec: SandboxProbeExec = async () => {
      throw new Error('method not found');
    };
    expect(await probeSandboxEnforced(exec, { dir: root(), platform: 'linux' })).toBe(false);
  });

  test('runs a writeable control, then a read and a write under a read-only policy without network', async () => {
    const seen: SandboxProbeParams[] = [];
    const dir = root();
    await probeSandboxEnforced(engine('enforcing', seen), { dir, platform: 'linux' });
    expect(seen.map((params) => params.sandboxPolicy.type)).toEqual(['workspaceWrite', 'readOnly', 'readOnly']);
    expect(seen[0].sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [dir], networkAccess: false });
    expect(seen[1].sandboxPolicy).toEqual(READ_ONLY);
    expect(seen[2].sandboxPolicy).toEqual(READ_ONLY);
  });

  test('a positive result is cached, so the probe runs once', async () => {
    const seen: SandboxProbeParams[] = [];
    const dir = root();
    await probeSandboxEnforced(engine('enforcing', seen), { dir, platform: 'linux' });
    const first = seen.length;
    await probeSandboxEnforced(engine('enforcing', seen), { dir, platform: 'linux' });
    expect(seen.length).toBe(first);
  });

  test('a negative result is retried after the backoff, not kept for the whole session', async () => {
    const dir = root();
    const now = 1_000;
    const failing: SandboxProbeExec = async () => {
      throw new Error('engine restarting');
    };
    expect(await probeSandboxEnforced(failing, { dir, platform: 'linux', now: () => now })).toBe(false);
    const seen: SandboxProbeParams[] = [];
    expect(await probeSandboxEnforced(engine('enforcing', seen), { dir, platform: 'linux', now: () => now + 1_000 })).toBe(false);
    expect(seen.length).toBe(0);
    expect(await probeSandboxEnforced(engine('enforcing', seen), { dir, platform: 'linux', now: () => now + 61_000 })).toBe(true);
  });
});

describe('probeCommand', () => {
  test('writes and reads through the same shell, taking the path from the environment', () => {
    expect(probeCommand('darwin', 'write')[0]).toBe('/bin/sh');
    expect(probeCommand('linux', 'read')[0]).toBe('/bin/sh');
    expect(probeCommand('win32', 'write')[0].toLowerCase()).toContain('powershell');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(probeCommand(platform, 'write').join(' ')).toContain('SBX_PROBE_TARGET');
      expect(probeCommand(platform, 'read').join(' ')).toContain('SBX_PROBE_TARGET');
    }
  });

  test('the PowerShell form stops on error, so a failed write exits non-zero', () => {
    expect(probeCommand('win32', 'write').join(' ')).toContain("$ErrorActionPreference='Stop'");
  });
});
