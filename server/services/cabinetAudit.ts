/**
 * Append-only audit log for cabinet mode (spec 2026-09-29): who turned it
 * off or on, and when a send was blocked. Never content, file names or
 * detections — the log must be safe to hand over as it is.
 *
 * Hash-chained: each line carries `prev` (the previous line's `hash`) and
 * `hash` = sha256(prev + "\n" + the line's JSON without `hash`). Editing or
 * deleting a line breaks the chain from that point. The chain alone does not
 * stop someone from deleting or rewriting the whole file; anchoring it off
 * the machine is out of scope for v1 (spec, open question 2).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const CABINET_AUDIT_GENESIS = '0'.repeat(64);

export type CabinetAuditEntry =
  | { event: 'cabinet_mode_disabled' }
  | { event: 'cabinet_mode_enabled' }
  | { event: 'send_blocked'; surface: 'outbound' | 'tool' };

let auditFileOverride: string | null = null;

export function setCabinetAuditFileForTests(path: string | null): void {
  auditFileOverride = path;
}

async function resolveAuditFile(): Promise<string> {
  if (auditFileOverride) return auditFileOverride;
  const { getInterpreterAppDataDir } = await import('../configStore');
  return join(getInterpreterAppDataDir(), 'audit', 'cabinet-mode.jsonl');
}

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function appVersion(): string {
  if (process.versions.electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron');
      return app.getVersion() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'dev';
}

function hashLine(prev: string, bodyJson: string): string {
  return createHash('sha256').update(`${prev}\n${bodyJson}`).digest('hex');
}

async function readLines(file: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
}

// Appends are serialized: each one must read the hash the previous one wrote.
let appendQueue: Promise<void> = Promise.resolve();

export function appendCabinetAudit(entry: CabinetAuditEntry): Promise<void> {
  const run = appendQueue.then(async () => {
    const file = await resolveAuditFile();
    await mkdir(dirname(file), { recursive: true });
    const lines = await readLines(file);
    const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) as { hash?: string } : null;
    const prev = last?.hash ?? CABINET_AUDIT_GENESIS;
    const body = {
      at: new Date().toISOString(),
      ...entry,
      osUser: osUser(),
      hostname: hostname(),
      appVersion: appVersion(),
      prev,
    };
    const bodyJson = JSON.stringify(body);
    // `hash` is written last so verification can drop it and re-serialize.
    const line = JSON.stringify({ ...body, hash: hashLine(prev, bodyJson) });
    await appendFile(file, `${line}\n`, 'utf8');
  });
  // A failed append must not poison the queue for later ones.
  appendQueue = run.catch(() => {});
  return run;
}

/**
 * Recompute the chain. `brokenAt` is the 1-based line where it first fails:
 * an edited line fails itself, a deleted line fails the one after it.
 */
export async function verifyCabinetAuditChain(
  file?: string,
): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: number }> {
  const lines = await readLines(file ?? (await resolveAuditFile()));
  let prev = CABINET_AUDIT_GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, brokenAt: i + 1 };
    }
    const { hash, ...body } = parsed;
    if (body.prev !== prev || hash !== hashLine(prev, JSON.stringify(body))) {
      return { ok: false, brokenAt: i + 1 };
    }
    prev = hash as string;
  }
  return { ok: true, entries: lines.length };
}
