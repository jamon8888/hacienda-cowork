/**
 * Which vertical pack is in force right now, resolved from the user's choice,
 * the packs installed in the app-data folder and the pack the distribution
 * ships. `verticalPack.ts` holds the format and the loading; this file only
 * knows where things live.
 */

import path from 'node:path';

import { getActiveVerticalPackId } from '../configStore';
import { getDistributionVerticalPack } from '../../shared/productConfig';
import { getInterpreterUserDataDir } from '../utils/skillsPaths';
import {
  listPacks,
  resolveActivePack,
  type PackEntry,
  type PackSource,
  type VerticalPack,
} from './verticalPack';

export function getInstalledPacksRoot(): string {
  return path.join(getInterpreterUserDataDir(), 'packs');
}

/** The packaged `resources/` folder: next to the app when packaged, in the repo in dev. */
function resourcesRoot(): string {
  return process.resourcesPath
    ? process.resourcesPath
    : path.resolve(process.cwd(), 'resources');
}

export function getPackSource(): PackSource {
  const shipped = getDistributionVerticalPack();
  return {
    installedRoot: getInstalledPacksRoot(),
    distributionPackDir: shipped ? path.join(resourcesRoot(), shipped.resourcePath) : null,
  };
}

export async function getActiveVerticalPack(): Promise<VerticalPack | null> {
  try {
    return resolveActivePack(getPackSource(), await getActiveVerticalPackId());
  } catch (error) {
    // A pack must never stop a turn from starting.
    console.warn('[vertical-pack] could not resolve the active pack', error);
    return null;
  }
}

export function listAvailablePacks(): PackEntry[] {
  return listPacks(getPackSource());
}

/** Skills folders the active pack adds to the runtime (empty without a pack). */
export async function getVerticalPackSkillRoots(): Promise<string[]> {
  const pack = await getActiveVerticalPack();
  return pack?.skillsRoot ? [pack.skillsRoot] : [];
}
