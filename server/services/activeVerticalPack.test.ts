import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let activeId: string | null = null;
mock.module('../configStore', () => ({ getActiveVerticalPackId: async () => activeId }));

const { getActiveVerticalPack, getInstalledPacksRoot, getVerticalPackSkillRoots } = await import('./activeVerticalPack');

let dataDir = '';
const ORIGINAL = process.env.INTERPRETER_USER_DATA_DIR;

function installPack(id: string, withSkills = false): void {
  const dir = join(getInstalledPacksRoot(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    id, version: '1', name: id, requiresSafe: true, identityFile: 'i.md', deontologyFile: 'd.md',
  }));
  writeFileSync(join(dir, 'i.md'), `Identity of ${id}.`);
  writeFileSync(join(dir, 'd.md'), 'Rules.');
  if (withSkills) {
    mkdirSync(join(dir, 'skills', 's1'), { recursive: true });
    writeFileSync(join(dir, 'skills', 's1', 'SKILL.md'), 'x');
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'active-pack-'));
  process.env.INTERPRETER_USER_DATA_DIR = dataDir;
  activeId = null;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
  else process.env.INTERPRETER_USER_DATA_DIR = ORIGINAL;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('activeVerticalPack', () => {
  test('no installed pack and none shipped by the community profile: no pack, no skills', async () => {
    expect(await getActiveVerticalPack()).toBeNull();
    expect(await getVerticalPackSkillRoots()).toEqual([]);
  });

  test('the pack the user picked is the active one, with its skills root', async () => {
    installPack('droit', true);
    installPack('sante');
    activeId = 'droit';
    expect((await getActiveVerticalPack())?.id).toBe('droit');
    expect(await getVerticalPackSkillRoots()).toHaveLength(1);
    activeId = 'sante';
    expect(await getVerticalPackSkillRoots()).toEqual([]);
  });

  test('installed packs live under the app data folder', () => {
    expect(getInstalledPacksRoot()).toBe(join(dataDir, 'packs'));
  });

  test('picking nothing leaves no pack when nothing is shipped', async () => {
    installPack('droit');
    expect(await getActiveVerticalPack()).toBeNull();
  });
});
