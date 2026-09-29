/**
 * How a vault blob is addressed, in one place.
 *
 * The writer is server-side (`rehydrationPersistence`, at the send seam) and a
 * reader is renderer-side (chat detokenization, #164). Both have to agree on
 * the key exactly, and a convention duplicated on either side of the IPC
 * boundary is a convention that drifts. `src/lib/pii` is the module the server
 * already imports from, so it is where the two can share one definition.
 */

/** Vault blob id for a thread's rehydration map; `sanitizeVaultDocId` accepts this shape. */
export function threadVaultDocId(threadKey: string): string {
  return `thread-${threadKey}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Session key for a note's rehydration map (#19 Show Originals). FNV-1a of the
 * absolute path so the id fits `sanitizeVaultDocId` (no path separators).
 * Collisions are negligible for a single workspace's note set; upgrade to a
 * full-path encoding if two notes ever share a key.
 */
export function noteRehydrationKey(filePath: string): string {
  return `note${fnv1aHex(filePath)}`;
}

/** Per-workspace vault segment: FNV-1a of the absolute workspace path. */
export function workspaceVaultSegment(workspacePath: string): string {
  return fnv1aHex(workspacePath);
}
