/**
 * interpreter_safe_export — deliver a Safe-workspace draft with the real
 * values put back.
 *
 * In a Safe workspace the agent only ever holds tokens (`[PERSON_0]`) and can
 * write only under `safe/_drafts/`. This tool is the one way a draft becomes a
 * deliverable: the user approves the export (never auto-approved), the app
 * rehydrates the draft locally from the workspace token registry and writes
 * it to `<workspace>/exports/`. The model gets back the path and token
 * counts, never a value, so the result needs no redaction.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { approvalManager } from '../../../approvalManager';
import { getRuntimeRehydrationMap } from '../../../services/runtimeRedaction';
import {
  findTokens,
  findTokensInOoxml,
  rehydrateOoxml,
  rehydrateText,
  resolveTokens,
} from '../../../services/safeExport/rehydrate';
import { findSafeWorkspaceForCwd, getSafeRoots } from '../../../utils/safeWorkspace';
import { getCurrentWorkspace } from '../../../utils/workspace';

const TOOL_NAME = 'interpreter_safe_export';
const EXPORTS_DIR = 'exports';
const TEXT_DRAFTS = new Set(['.md', '.markdown', '.txt']);
const OOXML_DRAFTS = new Set(['.docx', '.xlsx', '.pptx']);

export interface SafeExportApproval {
  draft: string;
  output: string;
  format: string;
  tokensReplaced: number;
  unresolvedTokens: string[];
  message: string;
}

export interface SafeExportDeps {
  workspaceTokens: (workspacePath: string) => Promise<Record<string, string>>;
  threadTokens: (threadId: string | undefined) => Record<string, string>;
  approve: (request: SafeExportApproval, context?: BuiltinToolContext) => Promise<boolean>;
  renderPdf: (markdown: string, outputPath: string) => Promise<void>;
}

const defaultDeps: SafeExportDeps = {
  workspaceTokens: async (workspacePath) => {
    const { loadWorkspaceTokenRegistry } = await import('../../../services/workspaceTokenRegistry');
    return (await loadWorkspaceTokenRegistry(workspacePath)).tokens();
  },
  threadTokens: (threadId) => (threadId ? getRuntimeRehydrationMap(threadId) : {}),
  approve: (request, context) => approvalManager.createApproval(
    TOOL_NAME,
    'builtin-interpreter',
    request,
    0,
    context?.toolCallId,
    context?.agentId,
  ),
  renderPdf: async (markdown, outputPath) => {
    const { marked } = await import('marked');
    const { renderHtmlFileToPdf } = await import('../../../utils/chromiumPdf');
    const body = await marked.parse(markdown);
    const htmlPath = path.join(os.tmpdir(), `safe-export-${process.pid}-${Date.now()}.html`);
    await writeFile(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.45;margin:0}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 6px}</style></head><body>${body}</body></html>`,
      { encoding: 'utf8', mode: 0o600 },
    );
    try {
      await renderHtmlFileToPdf(htmlPath, outputPath);
    } finally {
      await rm(htmlPath, { force: true });
    }
  },
};

let deps: SafeExportDeps = defaultDeps;

export function setSafeExportDepsForTests(next: Partial<SafeExportDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The draft's real path, if it is a file inside `safe/_drafts/` (symlinks resolved). */
async function resolveDraft(rawPath: string, safeRoot: string, root: string, draftsRoot: string): Promise<string | null> {
  const candidates = path.isAbsolute(rawPath)
    ? [rawPath]
    : [path.join(safeRoot, rawPath), path.join(root, rawPath)];
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (!existing) return null;
  const [real, realDrafts] = await Promise.all([realpath(existing), realpath(draftsRoot)]);
  if (!isWithin(real, realDrafts) || !(await stat(real)).isFile()) return null;
  return real;
}

/** A plain file name, never a path; a taken name gets " (2)", " (3)", … */
function uniqueOutputPath(exportsDir: string, name: string): string {
  const parsed = path.parse(name);
  let candidate = path.join(exportsDir, name);
  for (let index = 2; existsSync(candidate); index += 1) {
    candidate = path.join(exportsDir, `${parsed.name} (${index})${parsed.ext}`);
  }
  return candidate;
}

export const safeExportTool: BuiltinToolDefinition = {
  name: TOOL_NAME,
  description:
    'Safe workspace only. Deliver a finished draft from safe/_drafts/ (.md, .txt, .docx, .xlsx, .pptx) to the user with the real names and values put back in place of the tokens. The user approves first, then the app writes the file to the workspace exports/ folder. You get back its path and token counts, never the values. Markdown drafts can also be exported as PDF.',
  inputSchema: {
    type: 'object',
    properties: {
      draft_path: {
        type: 'string',
        description: 'The draft to deliver, inside safe/_drafts/ (relative to safe/, to the workspace, or absolute).',
      },
      output_name: {
        type: 'string',
        description: 'File name for the delivered file (no folders). Defaults to the draft name.',
      },
      format: {
        type: 'string',
        enum: ['same', 'pdf'],
        description: '"same" keeps the draft format (default); "pdf" renders a Markdown draft as PDF.',
      },
      mode: {
        type: 'string',
        enum: ['new'],
        description: 'Only "new" is supported: write a new file. Editing an original in place is not available.',
      },
    },
    required: ['draft_path'],
  },
  mode: 'write',
  handler: async (args, context) => {
    const workspace = findSafeWorkspaceForCwd(context?.workspace ?? getCurrentWorkspace());
    if (!workspace) {
      return fail('interpreter_safe_export only works in a Safe workspace (one with a safe/ folder). Elsewhere, write the file directly.');
    }
    if (args.mode !== undefined && args.mode !== 'new') {
      return fail('Only mode "new" is supported: the export writes a new file and never edits an original.');
    }
    const rawDraft = typeof args.draft_path === 'string' ? args.draft_path.trim() : '';
    if (!rawDraft) return fail('Missing required parameter: draft_path');

    const { root, safeRoot, draftsRoot } = getSafeRoots(workspace);
    await mkdir(draftsRoot, { recursive: true });
    const draft = await resolveDraft(rawDraft, safeRoot, root, draftsRoot);
    if (!draft) return fail(`No draft file at "${rawDraft}" inside safe/_drafts/. Write the draft there first.`);

    const extension = path.extname(draft).toLowerCase();
    const isText = TEXT_DRAFTS.has(extension);
    if (!isText && !OOXML_DRAFTS.has(extension)) {
      return fail(`Unsupported draft type "${extension || 'none'}". Export .md, .txt, .docx, .xlsx or .pptx drafts.`);
    }
    const format = args.format === 'pdf' ? 'pdf' : 'same';
    if (format === 'pdf' && !isText) return fail('PDF export takes a Markdown or text draft.');

    const requestedName = typeof args.output_name === 'string' && args.output_name.trim()
      ? path.basename(args.output_name.trim())
      : path.basename(draft);
    const outputName = format === 'pdf'
      ? `${path.parse(requestedName).name}.pdf`
      : `${path.parse(requestedName).name}${extension}`;

    const content = await readFile(draft);
    const tokens = isText ? findTokens(content.toString('utf8')) : await findTokensInOoxml(content);

    let workspaceTokens: Record<string, string>;
    try {
      workspaceTokens = await deps.workspaceTokens(workspace);
    } catch {
      return fail('The workspace token registry could not be read (is Basemind running?). Nothing was exported.');
    }
    const resolution = resolveTokens(tokens, { workspace: workspaceTokens, thread: deps.threadTokens(context?.threadId) });
    if (resolution.conflicting.length > 0) {
      return fail(`These tokens stand for different values in different sources, so the export would have to guess: ${resolution.conflicting.join(', ')}. Nothing was exported; ask the user which value is meant.`);
    }

    const exportsDir = path.join(root, EXPORTS_DIR);
    const outputPath = uniqueOutputPath(exportsDir, outputName);
    const relativeOutput = path.relative(root, outputPath);
    const replaced = Object.keys(resolution.values).length;
    const approved = await deps.approve({
      draft: path.relative(root, draft),
      output: relativeOutput,
      format: format === 'pdf' ? 'pdf' : extension.slice(1),
      tokensReplaced: replaced,
      unresolvedTokens: resolution.unresolved,
      message: `Write ${relativeOutput} with the real values in place of ${replaced} token(s)?`
        + (resolution.unresolved.length > 0
          ? ` ${resolution.unresolved.length} token(s) have no known value and stay as written: ${resolution.unresolved.join(', ')}.`
          : ''),
    }, context);
    if (!approved) return fail('The user declined the export. Nothing was written.');

    await mkdir(exportsDir, { recursive: true });
    if (format === 'pdf') {
      const escaped = Object.fromEntries(Object.entries(resolution.values).map(([token, value]) => [token, escapeHtml(value)]));
      await deps.renderPdf(rehydrateText(content.toString('utf8'), escaped), outputPath);
    } else if (isText) {
      await writeFile(outputPath, rehydrateText(content.toString('utf8'), resolution.values), { encoding: 'utf8', flag: 'wx' });
    } else {
      await writeFile(outputPath, await rehydrateOoxml(content, resolution.values), { flag: 'wx' });
    }
    const bytes = (await stat(outputPath)).size;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          exported: true,
          path: relativeOutput,
          bytes,
          tokens_replaced: replaced,
          unresolved_tokens: resolution.unresolved,
        }, null, 2),
      }],
      isError: false,
    };
  },
};
