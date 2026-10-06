import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Safe workspace trusts the engine's sandbox to keep the agent's shell and
 * file reads inside `safe/`. A configuration that looks enforced but is not
 * (an engine or OS where the sandbox cannot start, a profile that silently
 * degrades) would send originals to the provider. So before a confined thread
 * starts, check that the sandbox refuses a write.
 *
 * A refused write alone proves nothing: the command may simply be wrong on
 * this system (shell, quoting) or the sandbox may be unable to start any
 * process. Two controls rule that out before the refusal is believed:
 *   1. the same write succeeds where it is allowed (the command works here);
 *   2. a read succeeds under the read-only policy (processes run in it).
 */

export type SandboxProbePolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    };

export type SandboxProbeParams = {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  sandboxPolicy: SandboxProbePolicy;
};

export type SandboxProbeExec = (
  params: SandboxProbeParams,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** After a failed probe, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * Results are kept per network setting: with no network the Linux sandbox needs
 * a network namespace that some hosts refuse, so one setting working says
 * nothing about the other.
 */
const verified = new Set<boolean>();
const failedAt = new Map<boolean, number>();

export function resetSandboxProbeCacheForTests(): void {
  verified.clear();
  failedAt.clear();
}

/**
 * The write or read of the file named by `SBX_PROBE_TARGET`. The path travels in
 * the environment, not in the command line, so quoting cannot change it.
 */
export function probeCommand(platform: NodeJS.Platform, action: 'write' | 'read'): string[] {
  if (platform === 'win32') {
    const body =
      action === 'write'
        ? 'Set-Content -LiteralPath $env:SBX_PROBE_TARGET -Value x'
        : 'Get-Content -LiteralPath $env:SBX_PROBE_TARGET | Out-Null';
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${body}`];
  }
  const body = action === 'write' ? 'echo x > "$SBX_PROBE_TARGET"' : 'cat "$SBX_PROBE_TARGET" > /dev/null';
  return ['/bin/sh', '-c', body];
}

/**
 * True only when the probe command works, a read works under the read-only
 * policy, and a write there is refused with no file landing. Any other outcome,
 * including an engine that cannot run the probe, is "not enforced": the caller
 * fails closed.
 */
export async function probeSandboxEnforced(
  exec: SandboxProbeExec,
  options: { dir: string; networkAccess: boolean; platform?: NodeJS.Platform; now?: () => number },
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const { networkAccess } = options;
  if (verified.has(networkAccess)) return true;
  const lastFailure = failedAt.get(networkAccess);
  if (lastFailure !== undefined && now() - lastFailure < RETRY_AFTER_FAILURE_MS) return false;

  const platform = options.platform ?? process.platform;
  const control = join(options.dir, 'probe-control');
  const target = join(options.dir, 'probe-target');
  const readOnly: SandboxProbePolicy = { type: 'readOnly', networkAccess };
  const writeable: SandboxProbePolicy = {
    type: 'workspaceWrite',
    writableRoots: [options.dir],
    networkAccess,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };

  let enforced = false;
  try {
    mkdirSync(options.dir, { recursive: true });
    rmSync(control, { force: true });
    rmSync(target, { force: true });
    const run = (action: 'write' | 'read', file: string, sandboxPolicy: SandboxProbePolicy) =>
      exec({ command: probeCommand(platform, action), cwd: options.dir, env: { SBX_PROBE_TARGET: file }, sandboxPolicy });

    const wrote = await run('write', control, writeable);
    if (wrote.exitCode === 0 && existsSync(control)) {
      const read = await run('read', control, readOnly);
      if (read.exitCode === 0) {
        const refused = await run('write', target, readOnly);
        enforced = refused.exitCode !== 0 && !existsSync(target);
      }
    }
  } catch {
    enforced = false;
  } finally {
    for (const file of [control, target]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // not removable: the verdict stands either way
      }
    }
  }

  if (enforced) {
    verified.add(networkAccess);
    failedAt.delete(networkAccess);
  } else {
    failedAt.set(networkAccess, now());
  }
  return enforced;
}
