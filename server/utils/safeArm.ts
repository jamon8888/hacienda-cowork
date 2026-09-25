import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { IGNORED_SEGMENTS, syncSafeMirrorFile } from './safeSync';

/**
 * Arm gate: `safe/` existing is what opens every downstream gate
 * (`safeSync.isArmed`, redaction interception, file counting). Idempotent.
 */
export function armSafeWorkspace(workspacePath: string): void {
  mkdirSync(join(workspacePath, 'safe'), { recursive: true });
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

  for (const relativePath of files) {
    const { mirrorRel, written } = await syncSafeMirrorFile(workspacePath, relativePath);
    mirrorPaths.push(mirrorRel);
    if (written) countWritten += 1;
    else skipped += 1;
  }

  if (mirrorPaths.length > 0) {
    await rescanFn({ paths: mirrorPaths });
  }
  return { written: countWritten, skipped };
}
