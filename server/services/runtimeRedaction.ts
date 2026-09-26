/**
 * Runtime redaction for linked-file reads (#113).
 *
 * Composer redaction covers serialized submission text, but a `fileMention`
 * serializes to `[label](<path>)` — the *contents* reach the model later,
 * when the agent calls a file-read tool at runtime. This module redacts
 * those tool outputs through the same token vocabulary (`[LABEL_N]` via
 * `buildRedactedText`) so linked files produce artifacts indistinguishable
 * from pasted-file redaction.
 *
 * Hook point: `ToolManager.callTool` passes every builtin and MCP result
 * through `maybeRedactToolResult` before it returns to the agent loop
 * (spec §7: all tool results, not only file reads). The hook re-enters
 * itself via basemind `redact_text`, so both `redact_text` and `vault`
 * (which returns originals for Show Originals) are exempted by name.
 *
 * Rehydration maps accumulate in a thread-scoped in-memory store. Nothing
 * here writes to disk: vault persistence waits on the passphrase UX
 * decision (#114), and a missing key degrades to tokens-without-reveal.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildRedactedText, mergeDetections } from '../../src/lib/pii/labels';
import { detectRegex } from '../../src/lib/pii/regex-detector';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

export const RUNTIME_REDACTION_DEFERRED_MARKER =
  '[redaction deferred: non-text content is not scanned for PII]';

export interface RuntimeRedactionDeps {
  isNerReady?: () => boolean;
  detectNer?: (text: string) => Promise<PiiDetection[]>;
}

async function defaultDetectNer(text: string): Promise<PiiDetection[]> {
  // Lazy import: piiDetection pulls in ToolManager, which loads this module
  // for the callTool hook. Deferring to call time breaks the cycle.
  const { piiDetectionService } = await import('./piiDetection');
  return piiDetectionService.detectPii(text);
}

async function defaultIsNerReady(): Promise<boolean> {
  const { piiDetectionService } = await import('./piiDetection');
  return piiDetectionService.isPiiModelReady();
}

function resolveDeps(deps: RuntimeRedactionDeps = {}): {
  isNerReady: () => boolean | Promise<boolean>;
  detectNer: (text: string) => Promise<PiiDetection[]>;
} {
  return {
    isNerReady: deps.isNerReady ?? defaultIsNerReady,
    detectNer: deps.detectNer ?? defaultDetectNer,
  };
}

// Thread-scoped rehydration maps: token -> original text. In-memory only;
// vault persistence (#114) will adopt this shape once the passphrase UX lands.
const runtimeRehydrationMaps = new Map<string, Record<string, string>>();
// Tombstones for deleted threads: if trashThread runs while a redaction is
// still awaiting NER, the stale result must not recreate the map afterwards.
// Thread ids are unique per thread, so a tombstone never blocks a live thread.
const deletedThreadKeys = new Set<string>();

export function getRuntimeRehydrationMap(threadKey: string): Record<string, string> {
  return { ...(runtimeRehydrationMaps.get(threadKey) ?? {}) };
}

/**
 * Merge a map produced outside this module — the composer's send-path map —
 * into the same thread store, so one blob per thread holds every token a
 * reveal might be asked for, whoever redacted it. Honours the tombstone for
 * the same reason the runtime path does.
 */
export function mergeRuntimeRehydrationMap(
  threadKey: string,
  map: Record<string, string>,
): Record<string, string> {
  storeRuntimeRehydrationMap(threadKey, map);
  return getRuntimeRehydrationMap(threadKey);
}

export function clearRuntimeRehydrationMaps(): void {
  runtimeRehydrationMaps.clear();
  deletedThreadKeys.clear();
}

function storeRuntimeRehydrationMap(threadKey: string, map: Record<string, string>): void {
  // A thread deleted mid-redaction stays deleted: dropping the stale map
  // keeps text redaction intact while leaving no PII behind.
  if (deletedThreadKeys.has(threadKey)) return;
  const existing = runtimeRehydrationMaps.get(threadKey) ?? {};
  runtimeRehydrationMaps.set(threadKey, { ...existing, ...map });
}

export function deleteRuntimeRehydrationMap(threadKey: string): void {
  runtimeRehydrationMaps.delete(threadKey);
  deletedThreadKeys.add(threadKey);
}

function isNonTextContent(text: string): boolean {
  if (text.includes('\0')) return true;
  const sample = text.slice(0, 4000);
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 32;
    if (code < 9 || (code > 13 && code < 32) || code === 127) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
}

export interface RedactTextOptions {
  threadKey?: string;
}

export async function redactFileReadOutputText(
  text: string,
  options: RedactTextOptions = {},
  deps: RuntimeRedactionDeps = {},
): Promise<{ text: string; redacted: boolean; deferred: boolean }> {
  if (isNonTextContent(text)) {
    // Fail closed: unscannable bytes never reach the model, only the marker.
    // Non-text MCP parts (images) are left untouched — image OCR redaction is
    // out of scope (#110) and replacing them would break the vision contract.
    return { text: RUNTIME_REDACTION_DEFERRED_MARKER, redacted: false, deferred: true };
  }
  const resolved = resolveDeps(deps);
  const regexDetections = detectRegex(text);
  // NER runs unconditionally when ready: regex covers patterns (email, phone,
  // …) but NER-only categories (names, addresses) would otherwise pass raw.
  let detections: PiiDetection[] = regexDetections;
  try {
    if (await resolved.isNerReady()) {
      detections = mergeDetections(await resolved.detectNer(text), regexDetections);
    }
  } catch {
    detections = regexDetections;
  }
  if (detections.length === 0) return { text, redacted: false, deferred: false };
  const reserved = options.threadKey ? Object.keys(runtimeRehydrationMaps.get(options.threadKey) ?? {}) : [];
  const { redactedText, rehydrationMap } = buildRedactedText(text, detections, new Set(reserved));
  if (options.threadKey) storeRuntimeRehydrationMap(options.threadKey, rehydrationMap);
  return { text: redactedText, redacted: true, deferred: false };
}

interface McpContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

function isMcpContentResult(value: unknown): value is { content: McpContentPart[] } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content);
}

export async function applyFileReadRedaction(
  result: unknown,
  options: RedactTextOptions = {},
  deps: RuntimeRedactionDeps = {},
): Promise<unknown> {
  // Error text can echo paths or content, so it redacts like any other text;
  // the isError flag survives via the spread below and diagnostics keep working.
  if (typeof result === 'string') {
    return (await redactFileReadOutputText(result, options, deps)).text;
  }
  if (isMcpContentResult(result)) {
    // Sequential on purpose: each part stores into the thread map before the
    // next part redacts, so reserved tokens accumulate and two parts can never
    // emit the same token for different originals (see the multipart test).
    const content: McpContentPart[] = [];
    let changed = false;
    for (const part of result.content) {
      if (part?.type !== 'text' || typeof part.text !== 'string') {
        content.push(part);
        continue;
      }
      const redacted = await redactFileReadOutputText(part.text, options, deps);
      if (redacted.redacted || redacted.deferred) {
        content.push({ ...part, text: redacted.text });
        changed = true;
      } else {
        content.push(part);
      }
    }
    if (!changed) return result;
    return { ...result, content };
  }
  return result;
}

export interface MaybeRedactOptions {
  serverId: string;
  toolName: string;
  result: unknown;
  /** Workspace root; redaction arms only when `<workspace>/safe/` exists (#19). */
  workspacePath?: string | null;
  threadKey?: string | null;
}

export async function maybeRedactToolResult(
  options: MaybeRedactOptions,
  deps: RuntimeRedactionDeps = {},
): Promise<unknown> {
  const { serverId, toolName, result, workspacePath, threadKey } = options;
  // builtin-test-filesystem is test infrastructure asserting verbatim tool
  // output (permission E2E); the production gate must not rewrite its results.
  if (serverId === 'builtin-test-filesystem') return result;
  // redact_text is this hook's own NER backend (recursion) and vault returns
  // the decrypted originals Show Originals displays; both pass through raw.
  if (
    serverId === 'basemind'
    && (toolName === 'redact_text' || toolName === 'vault')
  ) return result;
  // Workspace-gated (#19 §9): redaction arms only on safe/ opt-in. Outside a
  // safe workspace the workspace sends cleartext — no provider heuristic.
  // An unknown workspacePath fails closed (treat as armed) so a missing
  // resolution never leaks file bytes to a remote model.
  if (workspacePath != null && !existsSync(join(workspacePath, 'safe'))) return result;
  return applyFileReadRedaction(result, threadKey ? { threadKey } : {}, deps);
}

export interface OutboundTextOptions {
  /** Workspace root; redaction arms only when `<workspace>/safe/` exists (#19). */
  workspacePath?: string | null;
  threadKey?: string | null;
}

/**
 * Outbound free-text leg of #19: user message and system prompt are redacted
 * before `runCodexAgentTurn`, under the same workspace `safe/` gate as tool
 * results. threadKey may be a provisional key for a new thread; the caller
 * re-keys when the real thread id arrives.
 */
export async function maybeRedactOutboundText(
  text: string,
  options: OutboundTextOptions = {},
  deps: RuntimeRedactionDeps = {},
): Promise<{ text: string; redacted: boolean }> {
  if (!text) return { text, redacted: false };
  if (options.workspacePath != null && !existsSync(join(options.workspacePath, 'safe'))) {
    return { text, redacted: false };
  }
  const result = await redactFileReadOutputText(
    text,
    options.threadKey ? { threadKey: options.threadKey } : {},
    deps,
  );
  return { text: result.text, redacted: result.redacted || result.deferred };
}
