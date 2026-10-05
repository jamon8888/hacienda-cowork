import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendCustomInstructionsToPrompt } from '../utils/customInstructions';
import {
  appendPracticePackToPrompt,
  installVerticalPack,
  listPacks,
  loadVerticalPack,
  renderPracticePackSection,
  resolveActivePack,
  uninstallVerticalPack,
} from './verticalPack';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePack(dir: string, overrides: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'droit-des-affaires',
    version: '1.0.0',
    name: 'Droit des affaires',
    requiresSafe: true,
    identityFile: 'identity.md',
    deontologyFile: 'deontology.md',
    suggestionPills: [{ label: 'Relire un contrat', prompt: 'Relis ce contrat.' }],
    ...overrides,
  };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'identity.md'), files['identity.md'] ?? 'Tu assistes un avocat.');
  writeFileSync(join(dir, 'deontology.md'), files['deontology.md'] ?? 'Secret professionnel.');
  return dir;
}

describe('loadVerticalPack', () => {
  test('loads a valid pack with its skills folder', () => {
    const dir = writePack(tmp());
    mkdirSync(join(dir, 'skills', 'revue-contrat'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'revue-contrat', 'SKILL.md'), '---\nname: revue-contrat\n---\n');
    const result = loadVerticalPack(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack).toMatchObject({
      id: 'droit-des-affaires',
      version: '1.0.0',
      requiresSafe: true,
      identity: 'Tu assistes un avocat.',
      deontology: 'Secret professionnel.',
      suggestionPills: [{ label: 'Relire un contrat', prompt: 'Relis ce contrat.' }],
    });
    expect(result.pack.skillsRoot?.endsWith('skills')).toBe(true);
  });

  test('a pack without skills has no skills root', () => {
    const result = loadVerticalPack(writePack(tmp()));
    expect(result.ok && result.pack.skillsRoot).toBe(null);
  });

  test.each([
    ['id with capitals or spaces', { id: 'Droit Des Affaires' }, '"id"'],
    ['missing version', { version: '' }, '"version"'],
    ['requiresSafe not a boolean', { requiresSafe: 'yes' }, '"requiresSafe"'],
    ['identity file missing', { identityFile: 'nope.md' }, 'does not exist'],
    ['identity file outside the pack', { identityFile: '../outside.md' }, 'inside the pack'],
    ['absolute identity file', { identityFile: '/etc/hostname' }, 'inside the pack'],
    ['too many pills', { suggestionPills: Array.from({ length: 13 }, () => ({ label: 'a', prompt: 'b' })) }, 'suggestionPills'],
    ['pill without prompt', { suggestionPills: [{ label: 'a' }] }, 'prompt'],
  ])('rejects %s without throwing', (_name, overrides, message) => {
    const result = loadVerticalPack(writePack(tmp(), overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  test('rejects an oversized file, a broken manifest and a missing folder', () => {
    const big = loadVerticalPack(writePack(tmp(), {}, { 'identity.md': 'x'.repeat(16_001) }));
    expect(big.ok).toBe(false);

    const broken = tmp();
    writeFileSync(join(broken, 'pack.json'), '{ not json');
    const brokenResult = loadVerticalPack(broken);
    expect(brokenResult.ok).toBe(false);
    if (!brokenResult.ok) expect(brokenResult.error).toContain('not valid JSON');

    expect(loadVerticalPack(join(tmp(), 'absent')).ok).toBe(false);
    expect(loadVerticalPack(tmp()).ok).toBe(false);
  });

  test('rejects a file that links outside the pack', () => {
    const outside = join(tmp(), 'secret.md');
    writeFileSync(outside, 'not the pack');
    const dir = writePack(tmp());
    rmSync(join(dir, 'identity.md'));
    symlinkSync(outside, join(dir, 'identity.md'));
    const result = loadVerticalPack(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('link outside');
  });
});

describe('renderPracticePackSection', () => {
  test('puts identity first, then the professional rules', () => {
    const result = loadVerticalPack(writePack(tmp()));
    if (!result.ok) throw new Error(result.error);
    const section = renderPracticePackSection(result.pack);
    expect(section.startsWith('## Practice pack: Droit des affaires')).toBe(true);
    expect(section.indexOf('Tu assistes un avocat.')).toBeLessThan(section.indexOf('### Professional rules'));
    expect(section).toContain('Secret professionnel.');
  });
});

describe('appendPracticePackToPrompt', () => {
  test('without a pack the prompt is unchanged', () => {
    expect(appendPracticePackToPrompt('core prompt', null)).toBe('core prompt');
  });

  test('the pack sits after the core prompt and before the user\'s custom instructions', () => {
    const loaded = loadVerticalPack(writePack(tmp()));
    if (!loaded.ok) throw new Error(loaded.error);
    const withPack = appendPracticePackToPrompt('CORE PROMPT', loaded.pack);
    // codexRuntime appends custom instructions to the result, so the user keeps the last word.
    const final = appendCustomInstructionsToPrompt(withPack, 'MY OWN RULE');
    expect(final.indexOf('CORE PROMPT')).toBeLessThan(final.indexOf('## Practice pack'));
    expect(final.indexOf('## Practice pack')).toBeLessThan(final.indexOf('MY OWN RULE'));
  });
});

describe('installing and choosing packs', () => {
  test('installs into the installed root and lists it', () => {
    const root = tmp();
    const result = installVerticalPack(writePack(tmp()), root);
    expect(result.installed).toBe(true);
    expect(existsSync(join(root, 'droit-des-affaires', 'pack.json'))).toBe(true);
    const entries = listPacks({ installedRoot: root });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'installed' });
  });

  test('refuses to replace another version unless allowed, and refreshes the same one', () => {
    const root = tmp();
    installVerticalPack(writePack(tmp()), root);
    const newer = writePack(tmp(), { version: '2.0.0' }, { 'identity.md': 'Nouvelle identité.' });
    const refused = installVerticalPack(newer, root);
    expect(refused.installed).toBe(false);
    if (!refused.installed) expect(refused.existingVersion).toBe('1.0.0');
    expect(readFileSync(join(root, 'droit-des-affaires', 'identity.md'), 'utf8')).toBe('Tu assistes un avocat.');

    const replaced = installVerticalPack(newer, root, { allowReplace: true });
    expect(replaced.installed && replaced.replaced).toBe(true);
    expect(readFileSync(join(root, 'droit-des-affaires', 'identity.md'), 'utf8')).toBe('Nouvelle identité.');

    const sameVersion = installVerticalPack(newer, root);
    expect(sameVersion.installed).toBe(true);
  });

  test('an invalid pack is not installed and leaves nothing behind', () => {
    const root = tmp();
    const result = installVerticalPack(writePack(tmp(), { id: 'BAD ID' }), root);
    expect(result.installed).toBe(false);
    expect(listPacks({ installedRoot: root })).toHaveLength(0);
  });

  test('the active pack: the chosen one, else the distribution pack, else none', () => {
    const root = tmp();
    const shipped = writePack(tmp(), { id: 'cabinet', name: 'Cabinet' });
    installVerticalPack(writePack(tmp(), { id: 'sante', name: 'Santé' }), root);
    const source = { installedRoot: root, distributionPackDir: shipped };

    expect(resolveActivePack(source, 'sante')?.id).toBe('sante');
    expect(resolveActivePack(source, null)?.id).toBe('cabinet');
    // An id that matches nothing falls back instead of leaving a broken session.
    expect(resolveActivePack(source, 'gone')?.id).toBe('cabinet');
    expect(resolveActivePack({ installedRoot: root }, null)).toBeNull();
    expect(resolveActivePack({ installedRoot: join(root, 'absent') }, 'sante')).toBeNull();
  });

  test('a broken installed pack is listed as an error and never active', () => {
    const root = tmp();
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', 'pack.json'), '{}');
    const entries = listPacks({ installedRoot: root });
    expect(entries[0].result.ok).toBe(false);
    expect(resolveActivePack({ installedRoot: root }, 'broken')).toBeNull();
  });

  test('uninstalls an installed pack and ignores unsafe ids', () => {
    const root = tmp();
    installVerticalPack(writePack(tmp()), root);
    expect(uninstallVerticalPack('../etc', root)).toBe(false);
    expect(uninstallVerticalPack('droit-des-affaires', root)).toBe(true);
    expect(existsSync(join(root, 'droit-des-affaires'))).toBe(false);
  });
});
