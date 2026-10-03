/**
 * Vertical packs: identity, professional rules, skills and starter prompts for
 * a regulated profession (law, medicine, accounting…), as a folder.
 *
 * A pack never changes application behaviour: it adds text to the prompt and
 * skills to the runtime. Anyone can install one; a distribution may ship one
 * (`distribution.verticalPack`) but that unlocks nothing private (CLAUDE.md:
 * no behaviour fork per distribution).
 *
 * Loading never throws. A broken pack is reported and left out, so it cannot
 * stop the app or a turn from starting.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const PACK_MANIFEST_FILE = 'pack.json';
export const PACK_SKILLS_DIR = 'skills';
export const PACK_TEXT_MAX_CHARS = 16_000;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PILL_MAX = 12;

export interface PackSuggestionPill {
  label: string;
  prompt: string;
}

export interface VerticalPack {
  id: string;
  version: string;
  name: string;
  description: string;
  /** The pack only makes sense in a Safe workspace (confidential material). */
  requiresSafe: boolean;
  identity: string;
  deontology: string;
  suggestionPills: PackSuggestionPill[];
  /** Absolute pack folder. */
  dir: string;
  /** Absolute `skills/` folder when the pack ships skills. */
  skillsRoot: string | null;
}

export type PackLoadResult = { ok: true; pack: VerticalPack } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${field}" must be a non-empty string`);
  if (value.length > max) throw new Error(`"${field}" is longer than ${max} characters`);
  return value.trim();
}

/** Read a file the manifest names, refusing anything that resolves outside the pack. */
function readPackFile(packDir: string, relativePath: unknown, field: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`"${field}" must name a file in the pack`);
  }
  const target = path.resolve(packDir, relativePath);
  const within = path.relative(packDir, target);
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`"${field}" must stay inside the pack folder`);
  }
  if (!existsSync(target)) throw new Error(`"${field}" points to a file that does not exist: ${relativePath}`);
  const real = realpathSync(target);
  const realRoot = realpathSync(packDir);
  const realWithin = path.relative(realRoot, real);
  if (realWithin.startsWith('..') || path.isAbsolute(realWithin)) {
    throw new Error(`"${field}" must not link outside the pack folder`);
  }
  if (!statSync(real).isFile()) throw new Error(`"${field}" must be a file`);
  const content = readFileSync(real, 'utf8').trim();
  if (!content) throw new Error(`"${field}" is empty`);
  if (content.length > PACK_TEXT_MAX_CHARS) {
    throw new Error(`"${field}" is longer than ${PACK_TEXT_MAX_CHARS} characters`);
  }
  return content;
}

function readPills(value: unknown): PackSuggestionPill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PILL_MAX) {
    throw new Error(`"suggestionPills" must be a list of at most ${PILL_MAX} entries`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`"suggestionPills[${index}]" must be an object`);
    return {
      label: text(entry.label, `suggestionPills[${index}].label`, 80),
      prompt: text(entry.prompt, `suggestionPills[${index}].prompt`, 4000),
    };
  });
}

/** Skills folder of a pack, or null when it has none (or it is not a plain folder). */
function packSkillsRoot(packDir: string): string | null {
  const skills = path.join(packDir, PACK_SKILLS_DIR);
  try {
    const stat = lstatSync(skills);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return readdirSync(skills).length > 0 ? realpathSync(skills) : null;
  } catch {
    return null;
  }
}

export function loadVerticalPack(dir: string): PackLoadResult {
  try {
    const packDir = realpathSync(dir);
    const manifestPath = path.join(packDir, PACK_MANIFEST_FILE);
    if (!existsSync(manifestPath)) throw new Error(`${PACK_MANIFEST_FILE} not found`);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error(`${PACK_MANIFEST_FILE} is not valid JSON`);
    }
    if (!isRecord(manifest)) throw new Error(`${PACK_MANIFEST_FILE} must be an object`);

    const id = text(manifest.id, 'id', 64);
    if (!PACK_ID.test(id)) throw new Error('"id" must use lowercase letters, digits and dashes');
    if (typeof manifest.requiresSafe !== 'boolean') throw new Error('"requiresSafe" must be true or false');

    return {
      ok: true,
      pack: {
        id,
        version: text(manifest.version, 'version', 40),
        name: text(manifest.name, 'name', 120),
        description: text(manifest.description, 'description', 500, false),
        requiresSafe: manifest.requiresSafe,
        identity: readPackFile(packDir, manifest.identityFile, 'identityFile'),
        deontology: readPackFile(packDir, manifest.deontologyFile, 'deontologyFile'),
        suggestionPills: readPills(manifest.suggestionPills),
        dir: packDir,
        skillsRoot: packSkillsRoot(packDir),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The prompt section a pack adds. Not redacted: it is firm-authored text, no client data. */
export function renderPracticePackSection(pack: VerticalPack): string {
  return `## Practice pack: ${pack.name}

${pack.identity}

### Professional rules

${pack.deontology}`;
}

/** Developer instructions with the pack's section appended; unchanged without a pack. */
export function appendPracticePackToPrompt(prompt: string, pack: VerticalPack | null): string {
  return pack ? `${prompt}\n\n${renderPracticePackSection(pack)}` : prompt;
}

export interface PackSource {
  /** Folder of packs the user installed. */
  installedRoot: string;
  /** Folder of the pack the distribution ships, if any. */
  distributionPackDir?: string | null;
}

export interface PackEntry {
  source: 'installed' | 'distribution';
  dir: string;
  result: PackLoadResult;
}

export function listPacks(source: PackSource): PackEntry[] {
  const entries: PackEntry[] = [];
  if (source.distributionPackDir) {
    entries.push({ source: 'distribution', dir: source.distributionPackDir, result: loadVerticalPack(source.distributionPackDir) });
  }
  let names: string[] = [];
  try {
    names = readdirSync(source.installedRoot).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const dir = path.join(source.installedRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ source: 'installed', dir, result: loadVerticalPack(dir) });
  }
  return entries;
}

/**
 * The pack in force: the one the user picked, else the distribution's, else
 * none. An explicit `activeId` that matches no valid pack falls back rather
 * than leaving the user with a broken session.
 */
export function resolveActivePack(source: PackSource, activeId: string | null | undefined): VerticalPack | null {
  const valid = listPacks(source).flatMap((entry) => (entry.result.ok ? [{ entry, pack: entry.result.pack }] : []));
  if (activeId) {
    const picked = valid.find(({ pack }) => pack.id === activeId);
    if (picked) return picked.pack;
  }
  const shipped = valid.find(({ entry }) => entry.source === 'distribution');
  return shipped?.pack ?? null;
}

export type InstallResult =
  | { installed: true; pack: VerticalPack; replaced: boolean }
  | { installed: false; error: string; existingVersion?: string };

/**
 * Copy a validated pack folder into the installed root. Replacing a pack
 * whose version differs needs `allowReplace`; the same version is refreshed.
 * The copy is staged next to its target and renamed, so a failure leaves the
 * installed pack as it was.
 */
export function installVerticalPack(
  sourceDir: string,
  installedRoot: string,
  options: { allowReplace?: boolean } = {},
): InstallResult {
  const loaded = loadVerticalPack(sourceDir);
  if (!loaded.ok) return { installed: false, error: loaded.error };
  const { pack } = loaded;
  const target = path.join(installedRoot, pack.id);
  const existing = existsSync(target) ? loadVerticalPack(target) : null;
  if (existing?.ok && existing.pack.version !== pack.version && !options.allowReplace) {
    return {
      installed: false,
      error: `Pack "${pack.id}" ${existing.pack.version} is installed; installing ${pack.version} replaces it.`,
      existingVersion: existing.pack.version,
    };
  }
  const staging = path.join(installedRoot, `.${pack.id}.installing`);
  try {
    mkdirSync(installedRoot, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(pack.dir, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
    // A symlink inside the copy would point back at the source: re-validate.
    const staged = loadVerticalPack(staging);
    if (!staged.ok) throw new Error(staged.error);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = loadVerticalPack(target);
  return result.ok
    ? { installed: true, pack: result.pack, replaced: existing !== null }
    : { installed: false, error: result.error };
}

export function uninstallVerticalPack(packId: string, installedRoot: string): boolean {
  if (!PACK_ID.test(packId)) return false;
  const target = path.join(installedRoot, packId);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
