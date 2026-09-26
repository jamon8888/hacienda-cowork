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
import { homedir } from 'node:os';

import { ToolManager } from '../tools/toolManager';
import { getAppMcpOwnerThreadId } from './appMcpThread';
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

export function resolvePiiModelBaseDir(homeDir = homedir()): string {
  const override = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (override) return path.join(override, 'basemind-hub');
  return path.join(homeDir, '.local', 'share', 'basemind', 'hub');
}

export function isPiiModelReady(baseDir = resolvePiiModelBaseDir()): boolean {
  return MODEL_SEARCH_PATTERNS.some((pattern) => {
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
  });
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
          if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'model.safetensors'))) {
            return dir;
          }
        } catch {
          // unreadable revision dir — keep looking
        }
      }
    }
  }
  return null;
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
  };
}

async function detectPii(
  text: string,
  options?: { categories?: string[] },
): Promise<PiiDetectionResult[]> {
  const manager = new ToolManager();
  const raw = await manager.callTool(
    'basemind',
    'redact_text',
    { text, categories: options?.categories ?? [], ner_model_dir: resolveNerModelDir() ?? undefined },
    undefined,
    undefined,
    // Without a thread context `callTool` throws before reaching the tool, so
    // detection silently degraded to the regex fallback on every send.
    { threadId: await getAppMcpOwnerThreadId() },
  );
  // Confidence is filtered upstream by basemind (DEFAULT_MIN_CONFIDENCE);
  // the Electron side passes detections through untouched.
  return parseRedactTextResult(raw).detections;
}

/**
 * Extract + redact one file through the daemon (`redact_text {file_path}` —
 * xberg picks the format, incl. images via OCR). Returns `redacted_text: ''`
 * when the tool answered with an error payload instead of throwing.
 */
async function redactFile(filePath: string): Promise<RedactTextResult> {
  const manager = new ToolManager();
  const raw = await manager.callTool(
    'basemind',
    'redact_text',
    { file_path: filePath, ner_model_dir: resolveNerModelDir() ?? undefined },
    undefined,
    undefined,
    { threadId: await getAppMcpOwnerThreadId() },
  );
  return parseRedactTextResult(raw);
}

export const piiDetectionService = {
  detectPii,
  redactFile,
  isPiiModelReady,
  resolveNerModelDir,
  parseRedactTextResult,
};
