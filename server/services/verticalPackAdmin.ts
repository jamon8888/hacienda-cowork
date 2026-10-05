/**
 * What the settings screen shows and does with vertical packs. Kept apart from
 * the route table so it can be tested without the app: the view never carries
 * a pack's prompt text, only what the user chooses by.
 */

import { getActiveVerticalPackId, setActiveVerticalPackId } from '../configStore';
import {
  getInstalledPacksRoot,
  getPackSource,
} from './activeVerticalPack';
import {
  installVerticalPack,
  listPacks,
  resolveActivePack,
  uninstallVerticalPack,
  type InstallResult,
} from './verticalPack';

export interface PackListEntry {
  id: string | null;
  name: string;
  version: string | null;
  description: string;
  source: 'installed' | 'distribution';
  requiresSafe: boolean;
  hasSkills: boolean;
  /** Set when the pack cannot be used; the other fields may then be empty. */
  error: string | null;
}

export interface PackListView {
  /** The pack in force (the user's pick, else the distribution's). */
  activeId: string | null;
  /** The user's own pick; null means "the distribution default, if any". */
  chosenId: string | null;
  packs: PackListEntry[];
}

export async function getPackListView(): Promise<PackListView> {
  const source = getPackSource();
  const chosenId = await getActiveVerticalPackId();
  return {
    activeId: resolveActivePack(source, chosenId)?.id ?? null,
    chosenId,
    packs: listPacks(source).map((entry) => entry.result.ok
      ? {
        id: entry.result.pack.id,
        name: entry.result.pack.name,
        version: entry.result.pack.version,
        description: entry.result.pack.description,
        source: entry.source,
        requiresSafe: entry.result.pack.requiresSafe,
        hasSkills: entry.result.pack.skillsRoot !== null,
        error: null,
      }
      : {
        id: null,
        name: entry.dir.split(/[\\/]/).pop() ?? entry.dir,
        version: null,
        description: '',
        source: entry.source,
        requiresSafe: false,
        hasSkills: false,
        error: entry.result.error,
      }),
  };
}

/** Pick a pack, or null to go back to the distribution default. Only a valid pack can be picked. */
export async function chooseActivePack(packId: string | null): Promise<PackListView> {
  if (packId !== null) {
    const known = listPacks(getPackSource()).some((entry) => entry.result.ok && entry.result.pack.id === packId);
    if (!known) throw new Error(`No valid pack "${packId}" is available.`);
  }
  await setActiveVerticalPackId(packId);
  return getPackListView();
}

export type InstallOutcome =
  | { installed: true; packId: string; replaced: boolean }
  | { installed: false; error: string; existingVersion: string | null };

export async function installPackFromFolder(sourceDir: string, allowReplace: boolean): Promise<InstallOutcome> {
  const result: InstallResult = installVerticalPack(sourceDir, getInstalledPacksRoot(), { allowReplace });
  if (!result.installed) {
    return { installed: false, error: result.error, existingVersion: result.existingVersion ?? null };
  }
  return { installed: true, packId: result.pack.id, replaced: result.replaced };
}

export async function removeInstalledPack(packId: string): Promise<PackListView> {
  uninstallVerticalPack(packId, getInstalledPacksRoot());
  // A removed pack must not stay the user's pick.
  if ((await getActiveVerticalPackId()) === packId) await setActiveVerticalPackId(null);
  return getPackListView();
}
