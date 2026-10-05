/**
 * Checks a pack author runs before shipping a vertical pack (the pack's own
 * CI, `pnpm run pack:validate <folder>`). The app's loader decides whether a
 * pack loads at all; this adds what only matters to whoever writes one: each
 * skill is a runnable skill, and a pack meant for Safe folders has skills
 * that know about them.
 *
 * Errors make the pack unusable or a skill unloadable. Warnings point at
 * something to look at, never block.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadVerticalPack, renderPracticePackSection, type VerticalPack } from './verticalPack';

export interface PackValidation {
  ok: boolean;
  pack: VerticalPack | null;
  skills: string[];
  errors: string[];
  warnings: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function frontmatterField(frontmatter: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(frontmatter);
  const value = match?.[1].trim().replace(/^["']|["']$/g, '');
  return value ? value : null;
}

/** Words a skill written for Safe folders uses: the mirror, the drafts, the export. */
const SAFE_AWARE = /safe\/|_drafts|interpreter_safe_export/;

export function validatePackFolder(dir: string, options: { appVersion?: string } = {}): PackValidation {
  const loaded = loadVerticalPack(dir, options);
  if (!loaded.ok) {
    return { ok: false, pack: null, skills: [], errors: [loaded.error], warnings: [] };
  }
  const { pack } = loaded;
  const errors: string[] = [];
  const warnings: string[] = [];
  const skills: string[] = [];

  if (pack.skillsRoot) {
    for (const name of readdirSync(pack.skillsRoot).sort()) {
      const skillDir = path.join(pack.skillsRoot, name);
      if (!statSync(skillDir).isDirectory()) continue;
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) {
        errors.push(`skills/${name}: SKILL.md is missing`);
        continue;
      }
      const content = readFileSync(skillFile, 'utf8');
      const frontmatter = FRONTMATTER.exec(content)?.[1];
      if (!frontmatter) {
        errors.push(`skills/${name}/SKILL.md: no frontmatter (--- name / description ---)`);
        continue;
      }
      const skillName = frontmatterField(frontmatter, 'name');
      if (!skillName) errors.push(`skills/${name}/SKILL.md: frontmatter has no name`);
      if (!frontmatterField(frontmatter, 'description')) {
        errors.push(`skills/${name}/SKILL.md: frontmatter has no description`);
      }
      if (skillName && skillName !== name) {
        warnings.push(`skills/${name}: its name is "${skillName}", not the folder name`);
      }
      if (pack.requiresSafe && !SAFE_AWARE.test(content)) {
        warnings.push(`skills/${name}: never mentions safe/, _drafts or interpreter_safe_export; in a Safe folder it can only read the redacted copies`);
      }
      skills.push(name);
    }
  } else if (existsSync(path.join(pack.dir, 'skills'))) {
    warnings.push('skills/ is empty or not a plain folder: no skills are registered');
  }

  if (pack.suggestionPills.length === 0) {
    warnings.push('no suggestionPills: the new-tab screen shows no starter prompts for this pack');
  }
  if (!pack.minAppVersion) {
    warnings.push('no requires.app: an older app would load this pack without the features it may rely on');
  }
  const promptChars = renderPracticePackSection(pack).length;
  if (promptChars > 12_000) {
    warnings.push(`the pack adds ${promptChars} characters to every turn's prompt; consider moving detail into skills`);
  }

  return { ok: errors.length === 0, pack, skills, errors, warnings };
}
