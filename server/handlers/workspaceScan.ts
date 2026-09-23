import { basemindScan, basemindRescan, resolveBasemindBinary, isDaemonRunning } from '../utils/basemindManager';
import { isModelResourceReady, type ModelResource } from '../utils/hubCache';

export interface WorkspaceScanRequest {
  /** Absolute workspace root (informational — MCP rescan is daemon-rooted). */
  workspacePath: string;
  /** Paths to scan relative to the daemon workspace root. Defaults to ['safe'] (.redacted is dead per #18). */
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
let filesRemaining = 0;
let lastScanAt: string | null = null;

export function setIndexingState(inProgress: boolean, count: number = 0) {
  if (inProgress) {
    activeScanCount++;
  } else {
    activeScanCount = Math.max(0, activeScanCount - 1);
  }
  filesRemaining = count;
  if (activeScanCount === 0 && count === 0) {
    lastScanAt = new Date().toISOString();
  }
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
    fileCount: filesRemaining,
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
 * Scan the safe/ mirror corpus with basemind.
 * Call this after safe-sync writes mirror files.
 */
export async function workspaceScan(req: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
  const { workspacePath, paths = ['safe'], json = true } = req;

  setIndexingState(true, 1);
  const result = await basemindScan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false, 0);

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
  const { workspacePath, paths = ['safe'], json = true } = req;

  setIndexingState(true, paths.length);
  const result = await basemindRescan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false, 0);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}
