import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

import { basemindScan, basemindRescan, resolveBasemindBinary, isDaemonRunning } from '../utils/basemindManager';
import { isModelResourceReady } from '../utils/hubCache';
import { getCurrentWorkspace } from '../utils/workspace';
import { getCodeIndexingEnabled } from '../configStore';
import { getScanState, setIndexingState } from '../utils/scanState';

export { setIndexingState };

export interface WorkspaceScanRequest {
  /** Absolute workspace root (informational — MCP rescan is daemon-rooted). */
  workspacePath: string;
  /** Honored only when the code-indexing opt-in is on (#13); the corpus is the
   * safe/ mirror otherwise (.redacted is dead per #18). */
  paths?: string[];
  /** Use --json for machine-readable output. */
  json?: boolean;
}

export interface WorkspaceScanResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorkspaceScanStatus {
  redactionActive: boolean;
  indexing: boolean;
  fileCount: number;
  /** Anonymised redaction tokens ([PERSON_1], [EMAIL_0], …) found under safe/. */
  entities: number;
  /** Initial-population progress (done/total files); null when no run is active. */
  progress: { done: number; total: number } | null;
  lastScanAt: string | null;
  xbergAvailable: boolean;
  basemindAvailable: boolean;
  resourcesReady: {
    nerModel: boolean;
    embeddings: boolean;
    reranker: boolean;
  };
}

/** Recursive count of regular files under the workspace safe/ mirror. */
function countSafeFiles(dir: string, budget: { remaining: number }): number {
  if (budget.remaining <= 0 || !existsSync(dir)) return 0;
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    const full = pathJoin(dir, entry.name);
    if (entry.isDirectory()) {
      total += countSafeFiles(full, budget);
    } else if (entry.isFile()) {
      budget.remaining -= 1;
      total += 1;
    }
  }
  return total;
}

function countWorkspaceSafeFiles(): number {
  const workspace = getCurrentWorkspace();
  if (!workspace) return 0;
  return countSafeFiles(pathJoin(workspace, 'safe'), { remaining: 100_000 });
}

/** The mirror's redaction tokens: [PERSON_1], [EMAIL_0], [ORGANIZATION_12], … */
const REDACTION_TOKEN_RE = /\[[A-Z][A-Z0-9_]*_\d+\]/g;

/** ponytail: 10 s TTL on the token walk — lower it if the count feels stale
 * on slow mirrors (a filesystem watcher invalidating the cache is the upgrade). */
const ENTITY_CACHE_TTL_MS = 10_000;
/** Mirrors are ≤1 MiB (basemind's redact_text cap); 2 MiB leaves headroom. */
const ENTITY_MAX_FILE_BYTES = 2 << 20;

let entityCache: { workspace: string; count: number; at: number } | null = null;

function countTokensInDir(dir: string, budget: { files: number }): number {
  if (budget.files <= 0 || !existsSync(dir)) return 0;
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.files <= 0) break;
    const full = pathJoin(dir, entry.name);
    if (entry.isDirectory()) {
      total += countTokensInDir(full, budget);
    } else if (entry.isFile()) {
      budget.files -= 1;
      try {
        if (statSync(full).size > ENTITY_MAX_FILE_BYTES) continue;
        const matches = readFileSync(full, 'utf8').match(REDACTION_TOKEN_RE);
        if (matches) total += matches.length;
      } catch {
        // unreadable file — skip
      }
    }
  }
  return total;
}

function countWorkspaceEntities(workspace: string | null): number {
  if (!workspace) return 0;
  const now = Date.now();
  const cached = entityCache;
  if (cached && cached.workspace === workspace && now - cached.at < ENTITY_CACHE_TTL_MS) {
    return cached.count;
  }
  const count = countTokensInDir(pathJoin(workspace, 'safe'), { files: 10_000 });
  entityCache = { workspace, count, at: now };
  return count;
}

// basemind has no .ready marker files; model presence is probed in the hub
// cache (see server/utils/hubCache.ts) — the <name>.ready markers this module
// used to look for were never written by anything.

/**
 * Returns the current status of workspace scanning, pipeline availability,
 * and global resource readiness.
 */
export function getWorkspaceScanStatus(): WorkspaceScanStatus {
  // xberg ships inside the basemind binary (no standalone pipeline binary
  // exists), so binary presence is the honest availability signal.
  const xbergAvailable = resolveBasemindBinary() !== '';

  const basemindAvailable = isDaemonRunning();

  const scanState = getScanState();
  return {
    redactionActive: xbergAvailable,
    indexing: scanState.indexing,
    fileCount: countWorkspaceSafeFiles(),
    entities: countWorkspaceEntities(getCurrentWorkspace()),
    progress: scanState.progress,
    lastScanAt: scanState.lastScanAt,
    xbergAvailable,
    basemindAvailable,
    resourcesReady: {
      nerModel: isModelResourceReady('nerModel'),
      embeddings: isModelResourceReady('embeddings'),
      reranker: isModelResourceReady('reranker'),
    },
  };
}

/**
 * #13/#18: code indexing is OFF by default — the rescan corpus is the safe/
 * mirror only, so raw code is never embedded unless the user opts in.
 * ponytail: one global flag; per-workspace if a split ever matters.
 */
export function resolveScanPaths(reqPaths: string[] | undefined, codeIndexingEnabled: boolean): string[] {
  return codeIndexingEnabled ? (reqPaths ?? ['safe']) : ['safe'];
}

/**
 * Scan the safe/ mirror corpus with basemind.
 * Call this after safe-sync writes mirror files.
 */
export async function workspaceScan(req: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
  const { workspacePath, json = true } = req;
  const paths = resolveScanPaths(req.paths, await getCodeIndexingEnabled());

  setIndexingState(true);
  const result = await basemindScan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * Re-scan specific paths (faster than full scan for incremental updates).
 */
export async function workspaceRescan(req: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
  const { workspacePath, json = true } = req;
  const paths = resolveScanPaths(req.paths, await getCodeIndexingEnabled());

  setIndexingState(true);
  const result = await basemindRescan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}
