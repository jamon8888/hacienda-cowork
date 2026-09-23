/**
 * Vault persistence for thread rehydration maps (#162).
 *
 * Two paths produce tokens for one thread: the composer redacts what the user
 * typed, and `runtimeRedaction` redacts file contents the agent reads. A
 * reveal cannot know which produced a given token, so both merge into the same
 * thread store and persist as one blob at `vaults/thread-{threadKey}.enc`.
 * `decrypt('thread-{threadKey}')` reads it back after a reload.
 *
 * Persistence never fails a send. A vault that cannot be written leaves the
 * maps in memory for the rest of the session, and the caller is told so it can
 * say as much — the failure is reported, never swallowed, and never a reason to
 * block the chat or to resend raw text.
 */

import { mergeRuntimeRehydrationMap } from './runtimeRedaction';
import { persistEncryptedBlob, vaultManager, type VaultEncryptOptions } from './vault';
import { VAULT_DEGRADED_MESSAGE } from './vaultKey';
// One definition, shared with the renderer that reads these blobs back (#164).
import { threadVaultDocId } from '../../src/lib/pii/vaultScope';

export { threadVaultDocId };

export type RehydrationPersistResult =
  | { persisted: true; tokenCount: number }
  | { persisted: false; reason: 'os-store-unavailable' | 'write-failed'; message: string };

/** Per-thread mutex to serialize merge/encrypt/write operations for the same thread. */
const threadWriteLocks = new Map<string, Promise<unknown>>();

async function withThreadLock<T>(
  threadKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prev = threadWriteLocks.get(threadKey) ?? Promise.resolve();
  const next = (async () => {
    await prev.catch(() => {});
    return operation();
  })();
  const cleanup = next.then(
    () => {},
    () => {},
  );
  threadWriteLocks.set(threadKey, cleanup);
  try {
    return await next;
  } finally {
    if (threadWriteLocks.get(threadKey) === cleanup) {
      threadWriteLocks.delete(threadKey);
    }
  }
}

export async function persistThreadRehydrationMap(
  threadKey: string,
  map: Record<string, string>,
  options: VaultEncryptOptions = {},
): Promise<RehydrationPersistResult> {
  if (!threadKey) {
    return {
      persisted: false,
      reason: 'write-failed',
      message: '[vault] No thread id for this send; rehydration stays in memory',
    };
  }

  return withThreadLock(threadKey, async () => {
    // Load any existing vault blob and merge it with the in-memory map first,
    // so a post-restart send preserves previously persisted tokens.
    let merged = { ...map };
    try {
      const vaultMap = await vaultManager.decrypt(
        threadVaultDocId(threadKey),
        options.passphrase,
        options.toolManager,
      );
      merged = { ...vaultMap, ...merged };
    } catch {
      // No existing blob or decryption failed — proceed with just the in-memory map.
    }

    // Merge first, persist second. Even when the write fails the union is in the
    // thread store, so a reveal within this session still resolves tokens the
    // composer produced.
    merged = mergeRuntimeRehydrationMap(threadKey, merged);
    if (Object.keys(merged).length === 0) {
      return { persisted: true, tokenCount: 0 };
    }

    try {
      const blob = await vaultManager.encrypt(merged, options);
      persistEncryptedBlob(threadVaultDocId(threadKey), blob);
      return { persisted: true, tokenCount: Object.keys(merged).length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = message.includes(VAULT_DEGRADED_MESSAGE) ? 'os-store-unavailable' : 'write-failed';
      console.warn(`[vault] Rehydration map not persisted for thread ${threadKey}: ${message}`);
      return { persisted: false, reason, message };
    }
  });
}