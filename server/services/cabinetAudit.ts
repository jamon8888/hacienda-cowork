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
  | { event: 'send_blocked'; surface: 'outbound' | 'tool' }
  /** A surface was switched on or off in Safe workspaces (never what it was used for). */
  | { event: 'safe_surface_changed'; surface: 'voice' | 'computerUse' | 'browserControl' | 'network'; enabled: boolean }
  /** Safe folders may run without pseudonymization on a verified local model. */
  | { event: 'local_bypass_enabled' }
  | { event: 'local_bypass_disabled' }
  /** A conversation ran its first turn without pseudonymization (hashed id, never content). */
  | { event: 'local_bypass_used'; thread: string }
  /** A turn on such a conversation was refused because its model is not local. */
  | { event: 'local_bypass_refused'; thread: string };

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

async function readRaw(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, 'utf8') : '';
}

function splitLines(raw: string): string[] {
  return raw.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Hash the next line must point to. A tail that is truncated or has no hash
 * (crash mid-append, tampering) must not lock the log: the next entry chains
 * to the raw bytes of that line, so the break stays visible to verify at that
 * line while appending keeps working.
 */
function chainHeadOf(lastLine: string | undefined): string {
  if (lastLine === undefined) return CABINET_AUDIT_GENESIS;
  try {
    const parsed = JSON.parse(lastLine) as { hash?: unknown };
    if (typeof parsed?.hash === 'string') return parsed.hash;
  } catch {
    // fall through to the raw-bytes anchor
  }
  return createHash('sha256').update(lastLine).digest('hex');
}

// Appends are serialized: each one must read the hash the previous one wrote.
let appendQueue: Promise<void> = Promise.resolve();

export function appendCabinetAudit(entry: CabinetAuditEntry): Promise<void> {
  const run = appendQueue.then(async () => {
    const file = await resolveAuditFile();
    await mkdir(dirname(file), { recursive: true });
    const raw = await readRaw(file);
    const lines = splitLines(raw);
    const prev = chainHeadOf(lines[lines.length - 1]);
    // A truncated tail has no newline; start on a fresh line so it stays a
    // separate (broken) line instead of swallowing this entry.
    const lead = raw !== '' && !raw.endsWith('\n') ? '\n' : '';
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
    await appendFile(file, `${lead}${line}\n`, 'utf8');
  });
  // A failed append must not poison the queue for later ones.
  appendQueue = run.catch(() => {});
  return run;
}

/**
 * Recompute the chain. `broken` lists every 1-based line that fails (an edited
 * line fails itself, a deleted line fails the one after it); `brokenAt` is
 * the first. After a break the check carries on from where appendCabinetAudit
 * chained the next entry (the line's hash, or its raw bytes when it has
 * none), so a later edit or deletion is not hidden behind the first one.
 */
export async function verifyCabinetAuditChain(
  file?: string,
): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: number; broken: number[] }> {
  const lines = splitLines(await readRaw(file ?? (await resolveAuditFile())));
  const broken: number[] = [];
  let prev = CABINET_AUDIT_GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let valid = false;
    try {
      const { hash, ...body } = JSON.parse(lines[i]) as Record<string, unknown>;
      valid = body.prev === prev && hash === hashLine(prev, JSON.stringify(body));
    } catch {
      valid = false;
    }
    if (!valid) broken.push(i + 1);
    prev = chainHeadOf(lines[i]);
  }
  return broken.length === 0
    ? { ok: true, entries: lines.length }
    : { ok: false, brokenAt: broken[0], broken };
}
