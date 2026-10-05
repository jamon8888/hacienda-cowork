/**
 * Rehydration for Safe exports: put the real values back into a draft the
 * agent wrote with tokens. Runs in the app only; nothing here returns text to
 * the model.
 *
 * Office drafts are the agent's own files (python-docx, openpyxl,
 * python-pptx), so their formatting is kept: tokens are replaced inside the
 * XML text runs. Word and PowerPoint split text into runs freely, so a token
 * can arrive as `[PERS` + `ON_0]`; runs are joined per part to find it, the
 * value goes in the run where the token starts, and the rest of the token is
 * removed from the following runs.
 */

import JSZip from 'jszip';

const TOKEN_IN_TEXT = /\[[A-Z_]+_\d+\]/g;

export type TokenLookup = (token: string) => string | undefined;

export interface TokenResolution {
  /** Token → value for every token of the draft that resolved. */
  values: Record<string, string>;
  unresolved: string[];
  /** Tokens two sources give different values: exporting would guess. */
  conflicting: string[];
}

/**
 * Resolve `tokens` against the workspace registry first, then the thread's
 * own map (tokens issued while the registry was unavailable). A token the two
 * disagree on is a conflict, never a choice.
 */
export function resolveTokens(
  tokens: Iterable<string>,
  sources: { workspace: Record<string, string>; thread: Record<string, string> },
): TokenResolution {
  const values: Record<string, string> = {};
  const unresolved: string[] = [];
  const conflicting: string[] = [];
  for (const token of new Set(tokens)) {
    const fromWorkspace = sources.workspace[token];
    const fromThread = sources.thread[token];
    if (fromWorkspace !== undefined && fromThread !== undefined && fromWorkspace !== fromThread) {
      conflicting.push(token);
    } else if (fromWorkspace !== undefined || fromThread !== undefined) {
      values[token] = (fromWorkspace ?? fromThread)!;
    } else {
      unresolved.push(token);
    }
  }
  return { values, unresolved: unresolved.sort(), conflicting: conflicting.sort() };
}

export function findTokens(text: string): string[] {
  return text.match(TOKEN_IN_TEXT) ?? [];
}

/** Replace every resolved token of plain text; unresolved tokens stay as written. */
export function rehydrateText(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN_IN_TEXT, (token) => values[token] ?? token);
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The text-run element of each OOXML family, by part path. */
function textRunPattern(partPath: string): RegExp | null {
  if (partPath.startsWith('word/')) return /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
  if (partPath.startsWith('ppt/')) return /(<a:t(?:\s[^>]*)?>)([^<]*)(<\/a:t>)/g;
  if (partPath.startsWith('xl/')) return /(<t(?:\s[^>]*)?>)([^<]*)(<\/t>)/g;
  return null;
}

interface TextRun {
  open: string;
  text: string;
  close: string;
  start: number;
  end: number;
  changed: boolean;
}

/**
 * Tokens of one XML part, read across its text runs (escaped text: tokens
 * hold no character XML escapes, so offsets match).
 */
function runsOf(xml: string, pattern: RegExp): TextRun[] {
  const runs: TextRun[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    runs.push({
      open: match[1],
      text: match[2],
      close: match[3],
      start: match.index,
      end: match.index + match[0].length,
      changed: false,
    });
  }
  return runs;
}

export function findTokensInXml(partPath: string, xml: string): string[] {
  const pattern = textRunPattern(partPath);
  if (!pattern) return findTokens(xml);
  return findTokens(runsOf(xml, pattern).map((run) => run.text).join(''));
}

/** Rehydrate the text runs of one OOXML part (or, for other parts, the raw XML). */
export function rehydrateXmlPart(partPath: string, xml: string, values: Record<string, string>): string {
  const pattern = textRunPattern(partPath);
  if (!pattern) {
    return xml.replace(TOKEN_IN_TEXT, (token) => (values[token] !== undefined ? escapeXmlText(values[token]) : token));
  }
  const runs = runsOf(xml, pattern);
  if (runs.length === 0) return xml;

  const joined = runs.map((run) => run.text).join('');
  const runOfOffset: number[] = [];
  runs.forEach((run, index) => {
    for (let i = 0; i < run.text.length; i += 1) runOfOffset.push(index);
  });
  const runStart: number[] = [];
  let offset = 0;
  for (const run of runs) {
    runStart.push(offset);
    offset += run.text.length;
  }

  // Right to left, so earlier offsets stay valid while runs are rewritten.
  const tokens = [...joined.matchAll(TOKEN_IN_TEXT)].reverse();
  for (const match of tokens) {
    const value = values[match[0]];
    if (value === undefined) continue;
    const from = match.index!;
    const to = from + match[0].length;
    const first = runOfOffset[from];
    const last = runOfOffset[to - 1];
    for (let index = last; index >= first; index -= 1) {
      const run = runs[index];
      const localFrom = Math.max(from, runStart[index]) - runStart[index];
      const localTo = Math.min(to, runStart[index] + run.text.length) - runStart[index];
      const insert = index === first ? escapeXmlText(value) : '';
      run.text = run.text.slice(0, localFrom) + insert + run.text.slice(localTo);
      run.changed = true;
    }
  }

  let out = '';
  let cursor = 0;
  for (const run of runs) {
    out += xml.slice(cursor, run.start);
    // A value can start or end with a space; Word drops those unless told.
    const open = run.changed && run.open.startsWith('<w:t') && !run.open.includes('xml:space')
      ? run.open.replace('<w:t', '<w:t xml:space="preserve"')
      : run.open;
    out += open + run.text + run.close;
    cursor = run.end;
  }
  return out + xml.slice(cursor);
}

const XML_PART = /\.(xml|rels)$/i;

export async function findTokensInOoxml(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const tokens: string[] = [];
  for (const [partPath, file] of Object.entries(zip.files)) {
    if (file.dir || !XML_PART.test(partPath)) continue;
    tokens.push(...findTokensInXml(partPath, await file.async('string')));
  }
  return tokens;
}

export async function rehydrateOoxml(buffer: Buffer, values: Record<string, string>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  for (const [partPath, file] of Object.entries(zip.files)) {
    if (file.dir || !XML_PART.test(partPath)) continue;
    const xml = await file.async('string');
    const next = rehydrateXmlPart(partPath, xml, values);
    if (next !== xml) zip.file(partPath, next);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
