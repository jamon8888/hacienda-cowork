import { existsSync, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

import { basemindScan, basemindRescan, resolveBasemindBinary, isDaemonRunning } from '../utils/basemindManager';
import { isModelResourceReady } from '../utils/hubCache';
import { getCurrentWorkspace } from '../utils/workspace';
import { getCodeIndexingEnabled } from '../configStore';

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
  lastScanAt: string | null;
  xbergAvailable: boolean;
  basemindAvailable: boolean;
  resourcesReady: {
    nerModel: boolean;
    embeddings: boolean;
    reranker: boolean;
  };
}

let activeScanCount = 0;
let lastScanAt: string | null = null;

export function setIndexingState(inProgress: boolean) {
  if (inProgress) {
    activeScanCount++;
  } else {
    activeScanCount = Math.max(0, activeScanCount - 1);
  }
  if (activeScanCount === 0) {
    lastScanAt = new Date().toISOString();
  }
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

  return {
    redactionActive: xbergAvailable,
    indexing: activeScanCount > 0,
    fileCount: countWorkspaceSafeFiles(),
    lastScanAt,
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
