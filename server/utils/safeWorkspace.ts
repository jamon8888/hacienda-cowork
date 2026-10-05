/**
 * Safe workspace helpers. A workspace is Safe once `<workspace>/safe/` exists
 * (the redacted mirror, spec 2026-09-22 §5); every redaction gate keys on that
 * directory, so this is the one place that names it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const SAFE_DIR_NAME = 'safe';
export const SAFE_DRAFTS_DIR_NAME = '_drafts';

export interface SafeRoots {
  /** The real workspace root (originals live here). */
  root: string;
  /** The redacted mirror the agent works in. */
  safeRoot: string;
  /** Where the agent writes tokenized drafts, inside the mirror. */
  draftsRoot: string;
}

export function getSafeRoots(workspacePath: string): SafeRoots {
  const safeRoot = join(workspacePath, SAFE_DIR_NAME);
  return { root: workspacePath, safeRoot, draftsRoot: join(safeRoot, SAFE_DRAFTS_DIR_NAME) };
}

/**
 * True when the workspace opted into `safe/`. A missing path is not Safe: with
 * no workspace there is no mirror to protect. The redaction gates fail closed
 * on an unknown workspace on their own (`maybeRedactToolResult`).
 */
export function isSafeWorkspace(workspacePath: string | null | undefined): boolean {
  if (!workspacePath) return false;
  return existsSync(join(workspacePath, SAFE_DIR_NAME));
}
