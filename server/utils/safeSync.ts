import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { setIndexingState } from './scanState';

/**
 * ponytail: 2s trailing debounce — up to ~2s search lag after a single save;
 * knob is this constant if that ceiling ever matters.
 */
export const SAFE_SYNC_DEBOUNCE_MS = 2_000;

export const IGNORED_SEGMENTS = new Set(['safe', '.redacted', '.basemind']);

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
  // basemind.toml is the daemon's own config (armSafeWorkspace writes the
  // root marker), not user content — never mirror or rescan it.
  if (segments[segments.length - 1]?.toLowerCase() === 'basemind.toml') return false;
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

export interface SafeRedactResult {
  redacted_text: string;
  rehydration_map: Record<string, string>;
}

type RedactFn = (absolutePath: string) => Promise<SafeRedactResult>;
type VaultPersistFn = (docId: string, map: Record<string, string>) => Promise<void> | void;
type VaultRemoveFn = (docId: string) => Promise<void> | void;

async function defaultRedactFile(absolutePath: string): Promise<SafeRedactResult> {
  const { piiDetectionService } = await import('../services/piiDetection');
  return piiDetectionService.redactFile(absolutePath);
}

async function defaultVaultPersist(docId: string, map: Record<string, string>): Promise<void> {
  const { persistEncryptedBlob, vaultManager } = await import('../services/vault');
  const blob = await vaultManager.encrypt(map);
  persistEncryptedBlob(docId, blob);
}

async function defaultVaultRemove(docId: string): Promise<void> {
  const { deleteVaultBlobPath, resolveVaultBlobPath } = await import('../services/vault');
  deleteVaultBlobPath(resolveVaultBlobPath(docId));
}

let redactFn: RedactFn = defaultRedactFile;
let vaultPersistFn: VaultPersistFn = defaultVaultPersist;
let vaultRemoveFn: VaultRemoveFn = defaultVaultRemove;

/**
 * Vault docId for one safe mirror (`sf_` + sha256 hex — fits
 * `sanitizeVaultDocId`'s `[A-Za-z0-9_-]{1,128}`). Keyed on the real
 * workspacePath (not the case-folded workspaceKey) so population and watcher
 * events agree on case-insensitive platforms.
 */
export function mirrorDocId(workspacePath: string, relativePath: string): string {
  const hash = createHash('sha256')
    .update(workspacePath)
    .update('\0')
    .update(relativePath.replace(/\\/g, '/'))
    .digest('hex');
  return `sf_${hash}`;
}

interface WorkspaceSyncState {
  timer: ReturnType<typeof setTimeout> | null;
  pending: Set<string>;
  workspacePath: string;
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

export function setSafeSyncRedactForTests(fn: RedactFn | null): void {
  redactFn = fn ?? defaultRedactFile;
}

export function setSafeSyncVaultPersistForTests(fn: VaultPersistFn | null): void {
  vaultPersistFn = fn ?? defaultVaultPersist;
}

export function setSafeSyncVaultRemoveForTests(fn: VaultRemoveFn | null): void {
  vaultRemoveFn = fn ?? defaultVaultRemove;
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

/**
 * Spec §cycle: one pending original → mirror lifecycle.
 * Returns the mirror's workspace-relative path (always — no-op rescan is the
 * documented safe failure, #21) plus whether a write actually landed, so
 * population counts don't mistake a stale mirror for fresh output. Per-file
 * failures warn and never throw.
 */
export async function syncSafeMirrorFile(
  workspacePath: string,
  relativePath: string,
): Promise<{ mirrorRel: string; written: boolean }> {
  const mirrorRel = toSafeMirrorPath(relativePath);
  const originalAbs = join(workspacePath, relativePath);
  const mirrorAbs = join(workspacePath, mirrorRel);
  const docId = mirrorDocId(workspacePath, relativePath);

  if (!existsSync(originalAbs)) {
    try {
      await rm(mirrorAbs, { force: true });
    } catch (err) {
      console.warn(
        `[safe-sync] mirror cleanup failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await vaultRemoveFn(docId);
    } catch (err) {
      console.warn(
        `[safe-sync] vault cleanup failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { mirrorRel, written: false };
  }

  try {
    const { redacted_text, rehydration_map } = await redactFn(originalAbs);
    if (!redacted_text) throw new Error('redact returned no content');
    await mkdir(dirname(mirrorAbs), { recursive: true });
    await writeFile(mirrorAbs, redacted_text, 'utf8');
    try {
      await vaultPersistFn(docId, rehydration_map);
    } catch (err) {
      // PII never lands un-redacted; only Show-Originals for this file degrades.
      console.warn(
        `[safe-sync] vault persist failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { mirrorRel, written: true };
  } catch (err) {
    console.warn(
      `[safe-sync] mirror write failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { mirrorRel, written: false };
}

async function flush(workspaceKey: string): Promise<void> {
  // ponytail: workspaceKey dropped from the rescan itself — single MCP
  // daemon, paths are workspace-relative; per-daemon paths if
  // multi-workspace ever matters.
  const state = states.get(workspaceKey);
  if (!state) return;
  state.timer = null;
  const relatives = Array.from(state.pending);
  state.pending.clear();
  if (relatives.length === 0) return;

  const paths: string[] = [];
  setIndexingState(true);
  try {
    for (const relativePath of relatives) {
      const { mirrorRel } = await syncSafeMirrorFile(state.workspacePath, relativePath);
      paths.push(mirrorRel);
    }
  } finally {
    setIndexingState(false);
  }

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
 * extract→redact→write cycle plus one MCP `admin {mode:rescan, paths}` call.
 * `workspacePath` is the real FS path (workspaceKey is lowercased on
 * case-insensitive platforms); omitted → falls back to workspaceKey.
 * Timer is unref'd so it never holds the process open.
 */
export function scheduleSafeSync(
  workspaceKey: string,
  relativePath: string,
  workspacePath?: string,
): void {
  if (!isArmedFn(workspaceKey)) return;

  let state = states.get(workspaceKey);
  if (!state) {
    state = { timer: null, pending: new Set(), workspacePath: workspacePath ?? workspaceKey };
    states.set(workspaceKey, state);
  } else if (workspacePath) {
    state.workspacePath = workspacePath;
  }

  state.pending.add(relativePath);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void flush(workspaceKey).catch((err: unknown) => {
      console.warn(
        `[safe-sync] flush failed for ${workspaceKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, debounceMs);
  state.timer.unref?.();
}
