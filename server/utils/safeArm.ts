import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { IGNORED_SEGMENTS, syncSafeMirrorFile } from './safeSync';
import { setIndexingState, setPopulationProgress } from './scanState';

/**
 * Root-guard marker: basemind refuses a non-git workspace root without
 * basemind.toml (host_build_failed, serve dies before initialize). Never
 * clobber a config the user already has. Shared by arm and the MCP-config
 * ensure so a serve (re)start always finds it. Idempotent.
 */
export function ensureBasemindRootMarker(workspacePath: string): void {
  const marker = join(workspacePath, 'basemind.toml');
  if (!existsSync(marker)) {
    writeFileSync(marker, '"$schema" = "v1"\n');
  }
}

/**
 * Arm gate: `safe/` existing is what opens every downstream gate
 * (`safeSync.isArmed`, redaction interception, file counting). Idempotent.
 */
export function armSafeWorkspace(workspacePath: string): void {
  mkdirSync(join(workspacePath, 'safe'), { recursive: true });
  ensureBasemindRootMarker(workspacePath);
}

/** ponytail: fixed 2000-file population cap — raise or make adaptive if real
 * workspaces outgrow it (full re-scan beyond the cap is a non-goal). */
export const POPULATION_FILE_LIMIT = 2000;

export interface PopulationResult {
  written: number;
  skipped: number;
}

type RescanFn = (opts: { paths: string[] }) => Promise<unknown>;

async function defaultRescan(opts: { paths: string[] }): Promise<unknown> {
  const { basemindRescan } = await import('./basemindManager');
  return basemindRescan({ paths: opts.paths });
}

let rescanFn: RescanFn = defaultRescan;

export function setSafeArmRescanForTests(fn: RescanFn | null): void {
  rescanFn = fn ?? defaultRescan;
}

/**
 * Workspace files for initial population: depth-first walk, skips the
 * anti-loop segments, directories and non-files; capped.
 */
function listWorkspaceFiles(workspacePath: string, limit: number): string[] {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0 && files.length < limit) {
    const relDir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(join(workspacePath, relDir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const rel = relDir ? `${relDir}/${entry}` : entry;
      if (IGNORED_SEGMENTS.has(entry.toLowerCase())) continue;
      if (entry.toLowerCase() === 'basemind.toml') continue;
      let isDir = false;
      try {
        isDir = statSync(join(workspacePath, rel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(rel);
      else files.push(rel);
    }
  }
  return files;
}

/**
 * Spec §Arm + initial population: mirror the whole workspace once after
 * opt-in, then one batch rescan so the banner's `fileCount` is honest from
 * the first paint. Per-file failures count as skipped (isolation); a
 * throwing rescan propagates to the caller's try/catch (download unaffected).
 */
export async function runInitialPopulation(
  workspacePath: string,
): Promise<PopulationResult> {
  armSafeWorkspace(workspacePath);
  const files = listWorkspaceFiles(workspacePath, POPULATION_FILE_LIMIT);
  const mirrorPaths: string[] = [];
  let countWritten = 0;
  let skipped = 0;

  setIndexingState(true);
  setPopulationProgress({ done: 0, total: files.length });
  try {
    for (const relativePath of files) {
      const { mirrorRel, written } = await syncSafeMirrorFile(workspacePath, relativePath);
      mirrorPaths.push(mirrorRel);
      if (written) countWritten += 1;
      else skipped += 1;
      setPopulationProgress({ done: countWritten + skipped, total: files.length });
    }

    if (mirrorPaths.length > 0) {
      await rescanFn({ paths: mirrorPaths });
    }
  } finally {
    setPopulationProgress(null);
    setIndexingState(false);
  }
  return { written: countWritten, skipped };
}
