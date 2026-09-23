import { listVaultBlobs, deleteVaultBlobPath } from './vault';
import { threadVaultDocId } from '../../src/lib/pii/vaultScope';

let gcRanThisSession = false;

export function resetGcFlagForTests(): void {
  gcRanThisSession = false;
}

/** Note rehydration blobs are keyed `thread-note<fnv1a-hex>`, not by a thread
 * id, so the active-thread list never contains them — exempt by shape rather
 * than deleting every note map on first vault access. */
const NOTE_BLOB_DOC_ID = /^thread-note[0-9a-f]+$/;

export function runOrphanBlobGcOnce(options: {
  activeThreadIds: string[];
  userDataDir?: string;
}): { cleaned: number } {
  if (gcRanThisSession) return { cleaned: 0 };
  gcRanThisSession = true;

  const { activeThreadIds, userDataDir } = options;
  const activeBlobIds = new Set(activeThreadIds.map(threadVaultDocId));

  let cleaned = 0;
  for (const { docId, fullPath } of listVaultBlobs(userDataDir)) {
    if (NOTE_BLOB_DOC_ID.test(docId)) continue;
    if (!activeBlobIds.has(docId)) {
      deleteVaultBlobPath(fullPath);
      cleaned++;
    }
  }

  return { cleaned };
}
