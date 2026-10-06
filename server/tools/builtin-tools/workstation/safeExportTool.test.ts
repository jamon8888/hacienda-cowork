import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

import { safeExportTool, setSafeExportDepsForTests, type SafeExportApproval } from './safeExportTool';

let workspace = '';
let approvals: SafeExportApproval[] = [];
let approveAnswer = true;
let registry: Record<string, string> = {};
let threadMap: Record<string, string> = {};

function run(args: Record<string, unknown>) {
  return safeExportTool.handler(args, { workspace, threadId: 'thr_1' } as never);
}

function text(result: { content: Array<{ text?: string }> }): string {
  return String(result.content[0]?.text);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'safe-export-'));
  mkdirSync(join(workspace, 'safe', '_drafts'), { recursive: true });
  writeFileSync(join(workspace, 'contrat.txt'), 'Jean Dupont original');
  approvals = [];
  approveAnswer = true;
  registry = { '[PERSON_0]': 'Jean Dupont', '[ORGANIZATION_0]': 'Acme SAS' };
  threadMap = {};
  setSafeExportDepsForTests({
    workspaceTokens: async () => registry,
    threadTokens: () => threadMap,
    approve: async (request) => {
      approvals.push(request);
      return approveAnswer;
    },
    renderPdf: async (markdown, outputPath) => writeFileSync(outputPath, `PDF:${markdown}`),
  });
});

afterEach(() => {
  setSafeExportDepsForTests(null);
  rmSync(workspace, { recursive: true, force: true });
});

describe('interpreter_safe_export', () => {
  test('writes the rehydrated draft to exports/ after approval and returns no value', async () => {
    writeFileSync(join(workspace, 'safe', '_drafts', 'note.md'), '[PERSON_0] for [ORGANIZATION_0]; [EMAIL_4].');
    const result = await run({ draft_path: '_drafts/note.md' });

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, 'exports', 'note.md'), 'utf8')).toBe('Jean Dupont for Acme SAS; [EMAIL_4].');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ output: join('exports', 'note.md'), tokensReplaced: 2, unresolvedTokens: ['[EMAIL_4]'] });
    // Neither the approval nor the model-facing result carries a real value.
    expect(JSON.stringify(approvals[0])).not.toContain('Jean');
    expect(text(result)).not.toContain('Jean');
    expect(text(result)).not.toContain('Acme');
    expect(JSON.parse(text(result))).toMatchObject({ exported: true, tokens_replaced: 2, unresolved_tokens: ['[EMAIL_4]'] });
  });

  test('a declined approval writes nothing', async () => {
    approveAnswer = false;
    writeFileSync(join(workspace, 'safe', '_drafts', 'note.md'), '[PERSON_0]');
    const result = await run({ draft_path: 'safe/_drafts/note.md' });
    expect(result.isError).toBe(true);
    expect(existsSync(join(workspace, 'exports'))).toBe(false);
  });

  test('refuses a draft outside safe/_drafts/, including through a symlink', async () => {
    writeFileSync(join(workspace, 'safe', 'contrat.txt.md'), '[PERSON_0]');
    expect((await run({ draft_path: 'contrat.txt.md' })).isError).toBe(true);
    expect((await run({ draft_path: join(workspace, 'contrat.txt') })).isError).toBe(true);
    symlinkSync(join(workspace, 'contrat.txt'), join(workspace, 'safe', '_drafts', 'leak.txt'));
    expect((await run({ draft_path: '_drafts/leak.txt' })).isError).toBe(true);
    expect(approvals).toHaveLength(0);
  });

  test('refuses tokens two sources disagree on, before asking', async () => {
    threadMap = { '[PERSON_0]': 'Paul Martin' };
    writeFileSync(join(workspace, 'safe', '_drafts', 'note.md'), '[PERSON_0]');
    const result = await run({ draft_path: '_drafts/note.md' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('[PERSON_0]');
    expect(text(result)).not.toContain('Paul');
    expect(approvals).toHaveLength(0);
  });

  test('rehydrates a Word draft and never overwrites an earlier export', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Bail: [PERS</w:t></w:r><w:r><w:t>ON_0]</w:t></w:r></w:p></w:body></w:document>');
    writeFileSync(join(workspace, 'safe', '_drafts', 'bail.docx'), await zip.generateAsync({ type: 'nodebuffer' }));

    expect((await run({ draft_path: '_drafts/bail.docx' })).isError).toBe(false);
    expect((await run({ draft_path: '_drafts/bail.docx' })).isError).toBe(false);
    const second = await JSZip.loadAsync(readFileSync(join(workspace, 'exports', 'bail (2).docx')));
    expect(await second.file('word/document.xml')!.async('string')).toContain('Bail: Jean Dupont');
    expect(existsSync(join(workspace, 'exports', 'bail.docx'))).toBe(true);
  });

  test('renders a Markdown draft as PDF with HTML-escaped values', async () => {
    registry = { '[ORGANIZATION_0]': 'Dupont & <Fils>' };
    writeFileSync(join(workspace, 'safe', '_drafts', 'note.md'), '# [ORGANIZATION_0]');
    const result = await run({ draft_path: '_drafts/note.md', format: 'pdf', output_name: 'Note finale.md' });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, 'exports', 'Note finale.pdf'), 'utf8')).toBe('PDF:# Dupont &amp; &lt;Fils&gt;');
  });

  test('refuses outside a Safe workspace and for in-place edits', async () => {
    rmSync(join(workspace, 'safe'), { recursive: true });
    expect(text(await run({ draft_path: 'x.md' }))).toContain('only works in a Safe workspace');
    mkdirSync(join(workspace, 'safe', '_drafts'), { recursive: true });
    expect(text(await run({ draft_path: 'x.md', mode: 'redline' }))).toContain('Only mode "new"');
  });
});
