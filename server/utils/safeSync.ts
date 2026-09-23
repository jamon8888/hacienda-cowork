import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ponytail: 2s trailing debounce — up to ~2s search lag after a single save;
 * knob is this constant if that ceiling ever matters.
 */
export const SAFE_SYNC_DEBOUNCE_MS = 2_000;

const IGNORED_SEGMENTS = new Set(['safe', '.redacted', '.basemind']);

export type SafeSyncEventType = 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change';

/**
 * Spec §5 / #21: files only (add|change|unlink); skip safe/, .redacted/,
 * .basemind/ (any segment, case-insensitive — Windows/macOS FS); no
 * extension pre-filter — basemind owns content selection.
 */
export function shouldSafeSyncForWorkspaceEvent(
  eventType: SafeSyncEventType,
  relativePath: string,
): boolean {
  if (eventType !== 'add' && eventType !== 'change' && eventType !== 'unlink') {
    return false;
  }

  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const segment of segments) {
    if (IGNORED_SEGMENTS.has(segment.toLowerCase())) return false;
  }
  return true;
}

/**
 * Spec §5 cycle: rescan targets the safe/ mirror file, never the originel.
 * Extension forced to .md — exact mirror layout is provisional until the
 * extract pipeline lands; a wrong path is a silent no-op rescan (#21).
 */
export function toSafeMirrorPath(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, '/');
  const withoutExt = posix.replace(/\.[^./]+$/, '');
  return `safe/${withoutExt}.md`;
}

type RescanFn = (opts: { paths: string[] }) => Promise<unknown>;
type ArmedFn = (workspaceKey: string) => boolean;

async function defaultRescan(opts: { paths: string[] }): Promise<unknown> {
  const { basemindRescan } = await import('./basemindManager');
  return basemindRescan({ paths: opts.paths });
}

/**
 * Spec row 21 / §7: workspace-gated — armed only once safe/ exists (created
 * on opt-in). workspaceKey is the workspace path on Linux and lowercased on
 * case-insensitive platforms, so join() still resolves.
 */
function defaultIsArmed(workspaceKey: string): boolean {
  return existsSync(join(workspaceKey, 'safe'));
}

let rescanFn: RescanFn = defaultRescan;
let isArmedFn: ArmedFn = defaultIsArmed;
let debounceMs = SAFE_SYNC_DEBOUNCE_MS;

interface WorkspaceSyncState {
  timer: ReturnType<typeof setTimeout> | null;
  pending: Set<string>;
}

const states = new Map<string, WorkspaceSyncState>();

export function setSafeSyncRescanForTests(fn: RescanFn | null): void {
  rescanFn = fn ?? defaultRescan;
}

export function setSafeSyncArmedForTests(fn: ArmedFn | null): void {
  isArmedFn = fn ?? defaultIsArmed;
}

export function setSafeSyncDebounceMsForTests(ms: number | null): void {
  debounceMs = ms ?? SAFE_SYNC_DEBOUNCE_MS;
}

export function clearAllSafeSync(): void {
  for (const key of Array.from(states.keys())) {
    clearSafeSync(key);
  }
}

/** Drop any pending work for one workspace (watch release). */
export function clearSafeSync(workspaceKey: string): void {
  const state = states.get(workspaceKey);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  states.delete(workspaceKey);
}

function flush(workspaceKey: string): void {
  // ponytail: workspaceKey dropped here — single MCP daemon, paths are
  // workspace-relative; per-daemon paths if multi-workspace ever matters.
  const state = states.get(workspaceKey);
  if (!state) return;
  state.timer = null;
  const paths = Array.from(state.pending, toSafeMirrorPath);
  state.pending.clear();
  if (paths.length === 0) return;

  // Incremental failures are silent (#21): log and let the next event retry.
  void Promise.resolve()
    .then(() => rescanFn({ paths }))
    .then((result) => {
      if (
        result &&
        typeof result === 'object' &&
        'success' in result &&
        (result as { success?: boolean }).success === false
      ) {
        const error = 'error' in result ? String((result as { error?: unknown }).error) : 'unknown';
        console.warn(
          `[safe-sync] incremental rescan failed for ${paths.length} path(s): ${error}`,
        );
      }
    })
    .catch((err: unknown) => {
      console.warn(
        `[safe-sync] incremental rescan threw for ${paths.length} path(s): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/**
 * Trailing-edge debounce per workspace: coalesce N path events into one
 * MCP `admin {mode:rescan, paths}` call. Timer is unref'd so it never holds
 * the process open.
 */
export function scheduleSafeSync(workspaceKey: string, relativePath: string): void {
  if (!isArmedFn(workspaceKey)) return;

  let state = states.get(workspaceKey);
  if (!state) {
    state = { timer: null, pending: new Set() };
    states.set(workspaceKey, state);
  }

  state.pending.add(relativePath);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => flush(workspaceKey), debounceMs);
  state.timer.unref?.();
}
