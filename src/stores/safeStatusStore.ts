import { workspace, workspaceScan, type WorkspaceScanStatus } from '@/ipc';

/**
 * #37: shared safe/ status for the Safe banner and the explorer safe/ badge.
 * One fetch serves every subscriber; the store polls only while population is
 * running and drops its snapshot once nobody listens, so a remount never
 * renders another workspace's counts.
 */

type Listener = () => void;

const POLL_INTERVAL_MS = 1500;

let snapshot: WorkspaceScanStatus | null = null;
let listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeWorkspaceChange: (() => void) | null = null;
/** Bumped on reset and workspace switch so late responses are discarded. */
let generation = 0;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function clearPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function isProcessing(status: WorkspaceScanStatus | null): boolean {
  return Boolean(status && (status.indexing || status.progress));
}

function schedulePoll(): void {
  clearPoll();
  if (listeners.size === 0 || !isProcessing(snapshot)) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshSafeStatus();
  }, POLL_INTERVAL_MS);
}

export function getSafeStatusSnapshot(): WorkspaceScanStatus | null {
  return snapshot;
}

export async function refreshSafeStatus(): Promise<void> {
  const requestGeneration = generation;
  let next: WorkspaceScanStatus | null;
  try {
    next = await workspaceScan.status();
  } catch {
    next = null;
  }
  if (requestGeneration !== generation) return;
  snapshot = next;
  emitChange();
  schedulePoll();
}

function handleWorkspaceChange(): void {
  generation += 1;
  clearPoll();
  snapshot = null;
  emitChange();
  void refreshSafeStatus();
}

export function subscribeSafeStatus(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribeWorkspaceChange = workspace.onChanged?.(handleWorkspaceChange) ?? null;
    void refreshSafeStatus();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      resetSafeStatusStore();
    }
  };
}

function resetSafeStatusStore(): void {
  generation += 1;
  clearPoll();
  unsubscribeWorkspaceChange?.();
  unsubscribeWorkspaceChange = null;
  snapshot = null;
}

export function resetSafeStatusStoreForTests(): void {
  resetSafeStatusStore();
  listeners = new Set<Listener>();
}
