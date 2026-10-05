import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { validatePackFolder } from './packValidation';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-validate-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePack(overrides: Record<string, unknown> = {}, skills: Record<string, string> = {}): string {
  const dir = tmp();
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    id: 'droit-des-affaires',
    version: '1.0.0',
    name: 'Droit des affaires',
    requiresSafe: true,
    requires: { app: '>=0.1.0' },
    identityFile: 'identity.md',
    deontologyFile: 'deontology.md',
    suggestionPills: [{ label: 'Relire un contrat', prompt: 'Relis ce contrat.' }],
    ...overrides,
  }));
  writeFileSync(join(dir, 'identity.md'), 'Tu assistes un avocat.');
  writeFileSync(join(dir, 'deontology.md'), 'Secret professionnel.');
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    if (content) writeFileSync(join(dir, 'skills', name, 'SKILL.md'), content);
  }
  return dir;
}

const safeSkill = (name: string) => `---\nname: ${name}\ndescription: Relit un contrat.\n---\nLis la copie dans safe/, écris dans safe/_drafts/.\n`;

describe('validatePackFolder', () => {
  test('a complete Safe-aware pack is valid without warnings', () => {
    const result = validatePackFolder(writePack({}, { 'revue-contrat': safeSkill('revue-contrat') }), { appVersion: '0.1.24' });
    expect(result).toMatchObject({ ok: true, skills: ['revue-contrat'], errors: [], warnings: [] });
  });

  test('a pack the app would refuse is reported with the loader reason', () => {
    const result = validatePackFolder(writePack({ requires: { app: '>=2.0.0' } }), { appVersion: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['needs Interpreter 2.0.0 or later (this is 1.0.0)']);
  });

  test('a skill without SKILL.md, frontmatter, name or description is an error', () => {
    const result = validatePackFolder(writePack({}, {
      missing: '',
      bare: 'Just text, no frontmatter.',
      nameless: '---\ndescription: x\n---\nsafe/',
      undescribed: '---\nname: undescribed\n---\nsafe/',
    }), { appVersion: '0.1.24' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'skills/bare/SKILL.md: no frontmatter (--- name / description ---)',
      'skills/missing: SKILL.md is missing',
      'skills/nameless/SKILL.md: frontmatter has no name',
      'skills/undescribed/SKILL.md: frontmatter has no description',
    ]);
  });

  test('warns about a skill that ignores Safe folders, a name mismatch, no pills and no requirement', () => {
    const result = validatePackFolder(writePack(
      { suggestionPills: [], requires: undefined },
      { 'revue-contrat': '---\nname: relecture\ndescription: Relit.\n---\nOuvre le .docx avec python-docx.\n' },
    ), { appVersion: '0.1.24' });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings.join('\n')).toContain('its name is "relecture"');
    expect(result.warnings.join('\n')).toContain('never mentions safe/');
    expect(result.warnings.join('\n')).toContain('no suggestionPills');
    expect(result.warnings.join('\n')).toContain('no requires.app');
  });

  test('a pack that does not need Safe is not asked about safe/', () => {
    const result = validatePackFolder(writePack({ requiresSafe: false }, {
      memo: '---\nname: memo\ndescription: Rédige.\n---\nRédige un mémo.\n',
    }), { appVersion: '0.1.24' });
    expect(result.warnings).toEqual([]);
  });
});

describe('pack:validate script', () => {
  const script = resolve(import.meta.dir, '../../scripts/validate-pack.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  test('exits 0 for a valid pack and 1 for an invalid one', () => {
    const valid = run(writePack({}, { 'revue-contrat': safeSkill('revue-contrat') }), '--app-version', '0.1.24');
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain('Pack is valid.');
    const invalid = run(writePack({ id: 'Not Valid' }));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('error:');
  });

  test('exits 2 without a folder', () => {
    expect(run().status).toBe(2);
  });
});
