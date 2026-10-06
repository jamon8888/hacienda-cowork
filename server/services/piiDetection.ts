/**
 * PiiDetectionService — main-process PII detection with MCP fallback.
 *
 * Single-engine decision: detection runs through basemind's `redact_text`
 * tool (the same xberg pipeline as document extraction) instead of loading
 * a second GLiNER copy into Electron. The local model cache is used only as
 * a readiness signal; no ONNX inference is fabricated in this process.
 */

import path from 'node:path';
import fs from 'node:fs';

import { ToolManager } from '../tools/toolManager';
import { getAppMcpOwnerThreadId } from './appMcpThread';
import { listCustomTerms, toRedactTextCustomTerms } from './customTerms';
import { buildRedactedText, findRedactedTokens, mergeDetections } from '../../src/lib/pii/labels';
import { detectCustomTerms, type CustomTerm } from '../../src/lib/pii/custom-terms';
import { detectRegex } from '../../src/lib/pii/regex-detector';
import { resolveHubBaseDirs } from '../utils/hubCache';

export interface PiiDetectionResult {
  category: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface RedactTextResult {
  redacted_text: string;
  rehydration_map: Record<string, string>;
  detections: PiiDetectionResult[];
  /**
   * Whether basemind's NER actually ran. Absent from older daemons; `false`
   * means it degraded to pattern-only redaction.
   */
  ner_ran?: boolean;
}

const MODEL_SEARCH_PATTERNS = [
  'models--fastino--gliner2-privacy-filter-PII-multi',
  'models--xberg-io--gliner-pii-models',
  'models--knowledgator--gliner-pii-edge-v1.0',
  'models--xberg-io--gliner-models',
];

/** True for entries that count as downloaded model weights (ONNX or candle safetensors). */
function isWeightEntry(entry: string): boolean {
  return entry.endsWith('.onnx') || entry === 'model.safetensors';
}

/**
 * True when NER weights (ONNX or candle) are cached in any hub candidate dir —
 * the dirs basemind reads and the preseed writes, never a userData path.
 */
export function isPiiModelReady(baseDirs: string[] = resolveHubBaseDirs()): boolean {
  return baseDirs.some((baseDir) => MODEL_SEARCH_PATTERNS.some((pattern) => {
    const dir = path.join(baseDir, pattern);
    if (!fs.existsSync(dir)) return false;
    try {
      // The hub stores weights at <repo>/snapshots/<revision>/..., so a
      // downloaded model has no weights directly under the repo directory and
      // reported false. Check the repo root and one snapshot level down.
      if (fs.readdirSync(dir).some(isWeightEntry)) return true;
      const snapshots = path.join(dir, 'snapshots');
      if (!fs.existsSync(snapshots)) return false;
      return fs.readdirSync(snapshots).some((revision) => {
        const revisionDir = path.join(snapshots, revision);
        try {
          return fs.statSync(revisionDir).isDirectory()
            && fs.readdirSync(revisionDir).some(isWeightEntry);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }));
}

/**
 * The files `redact_text` reads from `ner_model_dir`. The preseed lands the
 * weights first and the small configs after, so weights alone can be a
 * download cut short; existsSync follows links, so a dangling one fails too.
 */
const CANDLE_ARTIFACTS = [
  'model.safetensors',
  'tokenizer.json',
  path.join('encoder_config', 'config.json'),
];

function hasCandleArtifacts(dir: string): boolean {
  return CANDLE_ARTIFACTS.every((file) => fs.existsSync(path.join(dir, file)));
}

/**
 * Snapshot directory holding a candle-ready GLiNER2 layout
 * (`model.safetensors` etc.) for `redact_text`'s `ner_model_dir`, or null when
 * nothing candle-ready is cached. Consults every hub candidate dir because the
 * daemon resolves them in a different order than the app writes them.
 */
export function resolveNerModelDir(baseDirs: string[] = resolveHubBaseDirs()): string | null {
  for (const baseDir of baseDirs) {
    for (const pattern of MODEL_SEARCH_PATTERNS) {
      const snapshots = path.join(baseDir, pattern, 'snapshots');
      let revisions: string[];
      try {
        revisions = fs.readdirSync(snapshots);
      } catch {
        continue;
      }
      for (const revision of revisions) {
        const dir = path.join(snapshots, revision);
        try {
          if (fs.statSync(dir).isDirectory() && hasCandleArtifacts(dir)) return dir;
        } catch {
          // unreadable revision dir — keep looking
        }
      }
    }
  }
  return null;
}

/**
 * True when `redact_text` can actually load the NER model: the same candle
 * criterion and the same hub directories the tool call passes as
 * `ner_model_dir`. `isPiiModelReady` is looser (it also accepts ONNX-only
 * caches), so it cannot vouch that detection will run.
 */
export function isFullDetectionReady(baseDirs?: string[]): boolean {
  return resolveNerModelDir(baseDirs) !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asDetections(value: unknown): PiiDetectionResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const category = typeof record.category === 'string' ? record.category : 'unknown';
      const start = typeof record.start === 'number' ? record.start : 0;
      const end = typeof record.end === 'number' ? record.end : start;
      const text = typeof record.text === 'string' ? record.text : '';
      const confidence = typeof record.confidence === 'number' ? record.confidence : 0.5;
      return { category, start, end, text, confidence };
    })
    .filter((entry): entry is PiiDetectionResult => entry !== null);
}

/** Map a basemind `redact_text` tool result onto the renderer PII contract. */
export function parseRedactTextResult(result: unknown): RedactTextResult {
  const record = asRecord(result) ?? {};
  const structured = asRecord(record.structuredContent) ?? record;
  const payload = asRecord(structured.result) ?? structured;
  const redactedText =
    typeof payload.redacted_text === 'string' ? payload.redacted_text : '';
  const rawMap = asRecord(payload.rehydration_map) ?? {};
  const rehydrationMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawMap)) {
    if (typeof value === 'string') rehydrationMap[key] = value;
  }
  return {
    redacted_text: redactedText,
    rehydration_map: rehydrationMap,
    detections: asDetections(payload.detections),
    ...(typeof payload.ner_ran === 'boolean' ? { ner_ran: payload.ner_ran } : {}),
  };
}

function errorPayloadText(raw: unknown): string {
  const content = asRecord(raw)?.content;
  if (Array.isArray(content)) {
    const text = content.map((part) => asRecord(part)?.text).find((t) => typeof t === 'string');
    if (typeof text === 'string' && text) return text;
  }
  return 'redact_text returned an error';
}

async function detectPii(
  text: string,
  options?: { categories?: string[]; requireNer?: boolean },
): Promise<PiiDetectionResult[]> {
  const manager = new ToolManager();
  const raw = await manager.callTool(
    'basemind',
    'redact_text',
    {
      text,
      categories: options?.categories ?? [],
      // Text detection degrades rather than blocking chat (same policy as the
      // regex fallback); file redaction below fails closed instead.
      custom_terms: toRedactTextCustomTerms(await listCustomTerms().catch(() => [])),
      ner_model_dir: resolveNerModelDir() ?? undefined,
      ...(options?.requireNer ? { require_ner: true } : {}),
    },
    undefined,
    undefined,
    // Without a thread context `callTool` throws before reaching the tool, so
    // detection silently degraded to the regex fallback on every send.
    { threadId: await getAppMcpOwnerThreadId() },
    undefined,
    // The result feeds the redaction gate itself, never model context.
    { appInternal: true },
  );
  // An error payload parses to no detections, which is indistinguishable from
  // "nothing found". Surface it so callers can fall back or, in cabinet mode, block.
  if (asRecord(raw)?.isError === true) throw new Error(errorPayloadText(raw));
  // Confidence is filtered upstream by basemind (DEFAULT_MIN_CONFIDENCE);
  // the Electron side passes detections through untouched.
  const parsed = parseRedactTextResult(raw);
  // basemind reports a silent degrade as ner_ran=false. Callers that asked
  // for full detection must not read an empty list as "nothing found", and a
  // daemon that omits the field cannot vouch that NER ran either.
  if (options?.requireNer && parsed.ner_ran !== true) {
    throw new Error('redact_text: NER did not run (pattern-only redaction)');
  }
  return toStringOffsets(text, parsed.detections);
}

/**
 * redact_text reports UTF-8 byte offsets (Rust slices the original by bytes);
 * callers index JS strings in UTF-16 units. Any accent, symbol or emoji
 * before a span would shift it and leave part of the value in clear, so the
 * offsets are converted here and checked against the text basemind reports.
 */
function toStringOffsets(text: string, detections: PiiDetectionResult[]): PiiDetectionResult[] {
  const indexAtByte = new Map<number, number>();
  let byte = 0;
  let index = 0;
  for (const char of text) {
    indexAtByte.set(byte, index);
    const codePoint = char.codePointAt(0)!;
    byte += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    index += char.length;
  }
  indexAtByte.set(byte, index);
  return detections.map((detection) => {
    const start = indexAtByte.get(detection.start);
    const end = indexAtByte.get(detection.end);
    if (start === undefined || end === undefined || (detection.text && text.slice(start, end) !== detection.text)) {
      throw new Error('redact_text returned offsets that do not match the detected text');
    }
    return { ...detection, start, end };
  });
}

/**
 * Extract + redact one file through the daemon (`redact_text {file_path}` —
 * xberg picks the format, incl. images via OCR). Throws when the tool answered
 * with an error payload, or when NER did not run: the caller writes the result
 * into a copy the agent reads, so a pattern-only result is refused.
 */
async function redactFile(filePath: string): Promise<RedactTextResult> {
  const customTerms = await listCustomTerms();
  const manager = new ToolManager();
  const raw = await manager.callTool(
    'basemind',
    'redact_text',
    {
      file_path: filePath,
      custom_terms: toRedactTextCustomTerms(customTerms),
      ner_model_dir: resolveNerModelDir() ?? undefined,
      // A copy that reaches the agent is only as good as its detection: without
      // NER, names and companies survive and only patterns (amounts, e-mails,
      // phone numbers) are replaced. Refuse rather than write that copy.
      require_ner: true,
    },
    undefined,
    undefined,
    { threadId: await getAppMcpOwnerThreadId() },
    undefined,
    { appInternal: true },
  );
  if (asRecord(raw)?.isError === true) throw new Error(errorPayloadText(raw));
  const parsed = parseRedactTextResult(raw);
  // A daemon that omits the field cannot vouch that NER ran either.
  if (parsed.ner_ran !== true) throw new Error('redact_text: NER did not run (pattern-only redaction)');
  return sweepResidualPii(parsed, customTerms);
}

/**
 * Second pass over basemind's output with the app's own detectors (regex +
 * pinned terms), so a format basemind's patterns miss — e.g. a French phone
 * number written `+33 6 12 34 56 78` — never survives into a safe/ mirror.
 * Tokens basemind already issued are reserved, so new tokens never collide
 * with the map it returned. `detections` keeps basemind's original-text
 * offsets; the swept spans exist only in the redacted text.
 */
export function sweepResidualPii(
  result: RedactTextResult,
  customTerms: readonly CustomTerm[] = [],
): RedactTextResult {
  if (!result.redacted_text) return result;
  // Never match inside a token basemind already issued ("PERSON" in
  // [PERSON_1]): rewriting it would orphan its rehydration-map entry.
  const tokens = findRedactedTokens(result.redacted_text);
  const residual = mergeDetections(
    detectCustomTerms(result.redacted_text, customTerms),
    detectRegex(result.redacted_text),
  ).filter((d) => !tokens.some((t) => d.start < t.end && t.start < d.end));
  if (residual.length === 0) return result;
  const { redactedText, rehydrationMap } = buildRedactedText(
    result.redacted_text,
    residual,
    new Set(Object.keys(result.rehydration_map)),
  );
  return {
    ...result,
    redacted_text: redactedText,
    rehydration_map: { ...result.rehydration_map, ...rehydrationMap },
  };
}

export const piiDetectionService = {
  detectPii,
  redactFile,
  isPiiModelReady,
  isFullDetectionReady,
  resolveNerModelDir,
  parseRedactTextResult,
};
