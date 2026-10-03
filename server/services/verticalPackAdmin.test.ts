import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stored: string | null = null;
mock.module('../configStore', () => ({
  getActiveVerticalPackId: async () => stored,
  setActiveVerticalPackId: async (id: string | null) => {
    stored = id;
  },
}));

const admin = await import('./verticalPackAdmin');

let dataDir = '';
const ORIGINAL = process.env.INTERPRETER_USER_DATA_DIR;

function makePack(id: string, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `src-${id}-`));
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    id, version: '1.0.0', name: `Pack ${id}`, requiresSafe: true,
    identityFile: 'i.md', deontologyFile: 'd.md', ...extra,
  }));
  writeFileSync(join(dir, 'i.md'), 'PRIVATE IDENTITY TEXT');
  writeFileSync(join(dir, 'd.md'), 'PRIVATE RULES TEXT');
  return dir;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pack-admin-'));
  process.env.INTERPRETER_USER_DATA_DIR = dataDir;
  stored = null;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
  else process.env.INTERPRETER_USER_DATA_DIR = ORIGINAL;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('verticalPackAdmin', () => {
  test('installs a pack, lists it without its prompt text, and shows nothing active until picked', async () => {
    const outcome = await admin.installPackFromFolder(makePack('droit'), false);
    expect(outcome).toEqual({ installed: true, packId: 'droit', replaced: false });

    const view = await admin.getPackListView();
    expect(view.activeId).toBeNull();
    expect(view.packs).toHaveLength(1);
    expect(view.packs[0]).toMatchObject({ id: 'droit', name: 'Pack droit', version: '1.0.0', source: 'installed', error: null });
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
  });

  test('the pack in force offers its starter prompts to the new-tab screen, never its text', async () => {
    await admin.installPackFromFolder(makePack('droit', {
      suggestionPills: [{ label: 'Relire un contrat', prompt: 'Relis ce contrat.' }],
    }), false);
    expect((await admin.getPackListView()).activePack).toBeNull();
    const view = await admin.chooseActivePack('droit');
    expect(view.activePack).toEqual({
      id: 'droit',
      name: 'Pack droit',
      suggestionPills: [{ label: 'Relire un contrat', prompt: 'Relis ce contrat.' }],
    });
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
    expect((await admin.chooseActivePack(null)).activePack).toBeNull();
  });

  test('picking a pack makes it active; only a valid pack can be picked', async () => {
    await admin.installPackFromFolder(makePack('droit'), false);
    const view = await admin.chooseActivePack('droit');
    expect(view).toMatchObject({ activeId: 'droit', chosenId: 'droit' });
    await expect(admin.chooseActivePack('unknown')).rejects.toThrow('No valid pack');
    expect(stored).toBe('droit');
    expect((await admin.chooseActivePack(null)).activeId).toBeNull();
  });

  test('a broken installed pack is listed with its error and cannot be picked', async () => {
    const root = join(dataDir, 'packs', 'broken');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pack.json'), '{}');
    const view = await admin.getPackListView();
    expect(view.packs[0]).toMatchObject({ id: null, name: 'broken', source: 'installed' });
    expect(view.packs[0].error).toBeTruthy();
    await expect(admin.chooseActivePack('broken')).rejects.toThrow();
  });

  test('replacing another version needs consent and reports the installed version', async () => {
    await admin.installPackFromFolder(makePack('droit'), false);
    const refused = await admin.installPackFromFolder(makePack('droit', { version: '2.0.0' }), false);
    expect(refused).toMatchObject({ installed: false, existingVersion: '1.0.0' });
    expect(await admin.installPackFromFolder(makePack('droit', { version: '2.0.0' }), true))
      .toEqual({ installed: true, packId: 'droit', replaced: true });
  });

  test('removing the picked pack clears the pick', async () => {
    await admin.installPackFromFolder(makePack('droit'), false);
    await admin.chooseActivePack('droit');
    const view = await admin.removeInstalledPack('droit');
    expect(view.packs).toHaveLength(0);
    expect(stored).toBeNull();
  });
});
