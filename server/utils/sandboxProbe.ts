import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Safe workspace trusts the engine's sandbox to keep the agent's shell and
 * file reads inside `safe/`. A configuration that looks enforced but is not
 * (an engine or OS where the sandbox cannot start, a profile that silently
 * degrades) would send originals to the provider. So before a confined thread
 * starts, run one command the sandbox must refuse and check that it did.
 */

export type SandboxProbeExec = (params: {
  command: string[];
  cwd: string;
  sandboxPolicy: { type: 'readOnly'; networkAccess: false };
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** After a failed probe, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;

let verified = false;
let failedAt: number | null = null;

export function resetSandboxProbeCacheForTests(): void {
  verified = false;
  failedAt = null;
}

/** A write to `target`; the target is the last argument on unix. */
export function probeCommand(platform: NodeJS.Platform, target: string): string[] {
  if (platform === 'win32') {
    return ['cmd.exe', '/d', '/c', `echo x> "${target}"`];
  }
  return ['/bin/sh', '-c', 'echo x > "$1"', 'sh', target];
}

/**
 * True only when the engine refused a write under a read-only policy and no
 * file landed. Any other outcome, including an engine that cannot run the
 * probe, is "not enforced": the caller fails closed.
 */
export async function probeSandboxEnforced(
  exec: SandboxProbeExec,
  options: { dir: string; platform?: NodeJS.Platform; now?: () => number },
): Promise<boolean> {
  const now = options.now ?? Date.now;
  if (verified) return true;
  if (failedAt !== null && now() - failedAt < RETRY_AFTER_FAILURE_MS) return false;

  const target = join(options.dir, 'probe-target');
  let enforced = false;
  try {
    mkdirSync(options.dir, { recursive: true });
    rmSync(target, { force: true });
    const result = await exec({
      command: probeCommand(options.platform ?? process.platform, target),
      cwd: options.dir,
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    enforced = result.exitCode !== 0 && !existsSync(target);
  } catch {
    enforced = false;
  } finally {
    try {
      rmSync(target, { force: true });
    } catch {
      // nothing to clean, or not removable: the verdict stands either way
    }
  }

  if (enforced) {
    verified = true;
    failedAt = null;
  } else {
    failedAt = now();
  }
  return enforced;
}
