/**
 * Safe workspace helpers. A workspace is Safe once `<workspace>/safe/` exists
 * (the redacted mirror, spec 2026-09-22 §5); every redaction gate keys on that
 * directory, so this is the one place that names it.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

/**
 * The Safe workspace a runtime cwd belongs to: the cwd itself, or its parent
 * when the cwd is already the `safe/` mirror (a resumed confined thread).
 * Ancestors are not searched, so an unrelated `~/safe` folder never arms
 * every project under home. Callers pass the workspace root.
 */
export function findSafeWorkspaceForCwd(cwd: string | null | undefined): string | null {
  if (!cwd?.trim()) return null;
  const candidate = resolve(cwd);
  if (isSafeWorkspace(candidate)) return candidate;
  if (basename(candidate) === SAFE_DIR_NAME && isSafeWorkspace(dirname(candidate))) {
    return dirname(candidate);
  }
  return null;
}

/**
 * Runtime confinement for a cwd in a Safe workspace, or null outside one. The
 * drafts directory is created here so the sandbox can mount it writable.
 */
export function resolveSafeRuntimeConfinement(
  cwd: string | null | undefined,
  readableRoots: string[] = [],
): (SafeRoots & { readableRoots: string[] }) | null {
  const workspace = findSafeWorkspaceForCwd(cwd);
  if (!workspace) return null;
  const roots = getSafeRoots(workspace);
  mkdirSync(roots.draftsRoot, { recursive: true });
  return { ...roots, readableRoots };
}

/** True when `candidate` (absolute, or relative to the workspace) lies in `safe/`. */
export function isInsideSafeMirror(workspacePath: string, candidate: string): boolean {
  const { safeRoot } = getSafeRoots(workspacePath);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspacePath, candidate);
  const fromMirror = relative(safeRoot, absolute);
  return fromMirror === '' || (!fromMirror.startsWith('..') && !isAbsolute(fromMirror));
}
