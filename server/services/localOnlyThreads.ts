/**
 * Conversations that ran without pseudonymization (local-only Safe work).
 *
 * Their history holds real names and values, so they must never be sent to a
 * remote model afterwards, not even after a restart. The set is kept on disk
 * and only ever grows: a conversation stays local-only for its whole life,
 * forks included.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getInterpreterAppDataDir } from '../configStore';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';
import { auditThreadId } from './localModelBypass';

let fileOverride: string | null = null;
let cache: Set<string> | null = null;

export function setLocalOnlyThreadsFileForTests(path: string | null): void {
  fileOverride = path;
  cache = null;
}

function resolveFile(): string {
  if (fileOverride) return fileOverride;
  return join(getInterpreterAppDataDir(), 'safe', 'local-only-threads.json');
}

/**
 * The set, read once. A file that exists but cannot be read throws: treating
 * it as empty would let a local-only conversation go remote.
 */
function load(): Set<string> {
  if (cache) return cache;
  const file = resolveFile();
  if (!existsSync(file)) {
    cache = new Set();
    return cache;
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) {
    throw new Error('[local-only-threads] the conversation list is corrupt');
  }
  cache = new Set(parsed);
  return cache;
}

function save(ids: Set<string>): void {
  const file = resolveFile();
  mkdirSync(dirname(file), { recursive: true });
  const staging = `${file}.tmp`;
  writeFileSync(staging, JSON.stringify([...ids]), { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, file);
}

export function isLocalOnlyThread(threadId: string | null | undefined): boolean {
  return Boolean(threadId) && load().has(threadId!);
}

/**
 * Mark a conversation local-only, auditing the first time. The audit entry
 * and the file are written before this returns; if either fails, it throws
 * and the caller must not run the conversation unpseudonymized.
 */
export async function recordLocalOnlyThread(
  threadId: string,
  deps: { audit?: (entry: CabinetAuditEntry) => Promise<void> } = {},
): Promise<void> {
  const ids = load();
  if (ids.has(threadId)) return;
  await (deps.audit ?? appendCabinetAudit)({ event: 'local_bypass_used', thread: auditThreadId(threadId) });
  const next = new Set(ids).add(threadId);
  save(next);
  cache = next;
}

/** Thrown when a local-only conversation would continue on a model that is not local. */
export class LocalOnlyThreadError extends Error {
  constructor(message = 'This conversation read files without pseudonymization, so it can only continue with a model on this computer. Switch back to a local model, or start a new conversation.') {
    super(message);
    this.name = 'LocalOnlyThreadError';
  }
}

/** The refusal in the user's language (it reaches the screen as the turn error). */
async function refusalMessage(): Promise<string | undefined> {
  try {
    const { getLanguage } = await import('../configStore');
    const { resources, supportedLanguages } = await import('../../shared/locales');
    const language = await getLanguage();
    const locale = language && (supportedLanguages as readonly string[]).includes(language)
      ? (language as keyof typeof resources)
      : 'en';
    return resources[locale].translation['safe.localOnly.refused'];
  } catch {
    return undefined;
  }
}

/** Audit, then refuse. A failed audit write still refuses. */
export async function refuseLocalOnlyThread(
  threadId: string,
  deps: { audit?: (entry: CabinetAuditEntry) => Promise<void>; message?: string } = {},
): Promise<never> {
  try {
    await (deps.audit ?? appendCabinetAudit)({ event: 'local_bypass_refused', thread: auditThreadId(threadId) });
  } catch (error) {
    console.warn('[local-only-threads] could not record a refusal', error instanceof Error ? error.message : error);
  }
  throw new LocalOnlyThreadError(deps.message ?? await refusalMessage());
}
