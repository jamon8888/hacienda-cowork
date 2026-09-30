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
import { detectCustomTerms, type CustomTerm } from '../../src/lib/pii/custom-terms';
import { detectRegex } from '../../src/lib/pii/regex-detector';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

export const RUNTIME_REDACTION_DEFERRED_MARKER =
  '[redaction deferred: non-text content is not scanned for PII]';

export const CABINET_WITHHELD_MARKER =
  '[withheld: cabinet mode — full PII detection unavailable, content not sent]';

/** Full detection (NER) could not run and cabinet mode forbids the fallback. */
export class DetectionUnavailableError extends Error {
  constructor(message = 'Full PII detection is unavailable (cabinet mode).') {
    super(message);
    this.name = 'DetectionUnavailableError';
  }
}

export interface RuntimeRedactionDeps {
  isNerReady?: () => boolean;
  detectNer?: (text: string, options?: { requireNer?: boolean }) => Promise<PiiDetection[]>;
  listCustomTerms?: () => Promise<CustomTerm[]>;
  isCabinetMode?: () => boolean | Promise<boolean>;
  isFullDetectionReady?: () => boolean | Promise<boolean>;
  recordBlock?: (surface: 'outbound' | 'tool') => Promise<void>;
  blockedSendMessage?: () => Promise<string>;
  loadCustomInstructions?: () => Promise<string | null>;
}

async function defaultDetectNer(text: string, options?: { requireNer?: boolean }): Promise<PiiDetection[]> {
  // Lazy import: piiDetection pulls in ToolManager, which loads this module
  // for the callTool hook. Deferring to call time breaks the cycle.
  const { piiDetectionService } = await import('./piiDetection');
  return piiDetectionService.detectPii(text, options?.requireNer ? { requireNer: true } : undefined);
}

async function defaultListCustomTerms(): Promise<CustomTerm[]> {
  // Lazy for the same cycle: customTerms reaches ToolManager through the vault.
  const { listCustomTerms } = await import('./customTerms');
  return listCustomTerms();
}

async function defaultIsNerReady(): Promise<boolean> {
  const { piiDetectionService } = await import('./piiDetection');
  return piiDetectionService.isPiiModelReady();
}

async function defaultIsFullDetectionReady(): Promise<boolean> {
  const { isFullDetectionReady } = await import('./piiDetection');
  return isFullDetectionReady();
}

async function defaultIsCabinetMode(): Promise<boolean> {
  const { getCabinetModeEnabled } = await import('../configStore');
  return getCabinetModeEnabled();
}

async function defaultRecordBlock(surface: 'outbound' | 'tool'): Promise<void> {
  const { appendCabinetAudit } = await import('./cabinetAudit');
  await appendCabinetAudit({ event: 'send_blocked', surface });
}

async function defaultLoadCustomInstructions(): Promise<string | null> {
  const { getCustomInstructions } = await import('../configStore');
  return getCustomInstructions();
}

async function defaultBlockedSendMessage(): Promise<string> {
  // ChatView surfaces send errors as raw err.message, so the sentence is
  // localized here (same rule as attachmentBlockedInSafe in routes/agent.ts).
  const { getLanguage } = await import('../configStore');
  const { resources, supportedLanguages } = await import('../../shared/locales');
  const language = await getLanguage();
  const locale = language && (supportedLanguages as readonly string[]).includes(language)
    ? (language as keyof typeof resources)
    : 'en';
  return resources[locale].translation['basemind.cabinet.blockedSend'];
}

function resolveDeps(deps: RuntimeRedactionDeps = {}): {
  isNerReady: () => boolean | Promise<boolean>;
  detectNer: (text: string, options?: { requireNer?: boolean }) => Promise<PiiDetection[]>;
  listCustomTerms: () => Promise<CustomTerm[]>;
  isCabinetMode: () => boolean | Promise<boolean>;
  isFullDetectionReady: () => boolean | Promise<boolean>;
  recordBlock: (surface: 'outbound' | 'tool') => Promise<void>;
  blockedSendMessage: () => Promise<string>;
  loadCustomInstructions: () => Promise<string | null>;
} {
  return {
    isNerReady: deps.isNerReady ?? defaultIsNerReady,
    detectNer: deps.detectNer ?? defaultDetectNer,
    listCustomTerms: deps.listCustomTerms ?? defaultListCustomTerms,
    isCabinetMode: deps.isCabinetMode ?? defaultIsCabinetMode,
    isFullDetectionReady: deps.isFullDetectionReady ?? defaultIsFullDetectionReady,
    recordBlock: deps.recordBlock ?? defaultRecordBlock,
    blockedSendMessage: deps.blockedSendMessage ?? defaultBlockedSendMessage,
    loadCustomInstructions: deps.loadCustomInstructions ?? defaultLoadCustomInstructions,
  };
}

async function recordBlockQuietly(
  resolved: ReturnType<typeof resolveDeps>,
  surface: 'outbound' | 'tool',
): Promise<void> {
  // The block stands whether or not it could be logged.
  try {
    await resolved.recordBlock(surface);
  } catch (error) {
    console.warn('[cabinet] could not record a blocked send', error);
  }
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
  activeTurnWorkspaces.clear();
}

// Workspace of each thread with a turn in flight, recorded by /chat/stream so
// a mid-turn steer redacts under the same safe/ gate as the turn it joins.
const activeTurnWorkspaces = new Map<string, string>();

export function setActiveTurnWorkspace(threadId: string, workspacePath: string): void {
  activeTurnWorkspaces.set(threadId, workspacePath);
}

export function getActiveTurnWorkspace(threadId: string): string | undefined {
  return activeTurnWorkspaces.get(threadId);
}

export function clearActiveTurnWorkspace(threadId: string): void {
  activeTurnWorkspaces.delete(threadId);
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
  /** Cabinet mode: throw DetectionUnavailableError instead of the regex-only fallback. */
  requireFullDetection?: boolean;
  /** Reuse the thread's token for a value it already maps (custom instructions). */
  reuseThreadTokens?: boolean;
}

type RedactedText = { text: string; redacted: boolean; deferred: boolean };

/** One text of a batch. `scanOnly` texts (structuredContent keys) are sent to
 * the detector, so they count toward the gate, but are never rewritten. */
interface BatchEntry {
  text: string;
  scanOnly?: boolean;
}

/** A paragraph break keeps NER from reading two texts as one sentence; a span
 * that still crosses it is split, so each side stays redacted. */
const BATCH_SEPARATOR = '\n\n';

/** redact_text refuses inputs over 1 MiB (UTF-8); leave room for separators. */
const DETECTOR_MAX_BYTES = (1 << 20) - 1024;

/** Group text positions into runs whose joined UTF-8 size fits one call. A
 * text too large on its own gets a run of its own and fails as it did before. */
function chunkForDetector(texts: string[]): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  texts.forEach((text, position) => {
    const size = Buffer.byteLength(text, 'utf8') + (current.length > 0 ? BATCH_SEPARATOR.length : 0);
    if (current.length > 0 && bytes + size > DETECTOR_MAX_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    bytes += current.length > 0 ? size : Buffer.byteLength(text, 'utf8');
    current.push(position);
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Redact several texts with as few full-detection calls as the input cap allows. A tool result can carry
 * hundreds of strings; one call per string made a search result cost hundreds
 * of sequential detector round trips, and in cabinet mode kept knocking on a
 * dead daemon. Tokens accumulate across the batch (and the thread's live map)
 * so two different values never share a token, thread or not.
 */
async function redactTextBatch(
  entries: BatchEntry[],
  options: RedactTextOptions,
  deps: RuntimeRedactionDeps,
): Promise<RedactedText[]> {
  const resolved = resolveDeps(deps);
  // Pinned custom terms (#11) match locally, so they redact even when NER is
  // down; NER also receives them through redact_text when it is up.
  let customTerms: CustomTerm[] = [];
  try {
    customTerms = await resolved.listCustomTerms();
  } catch {
    customTerms = [];
  }
  // Unscannable bytes never reach the model, only the marker. Non-text MCP
  // parts (images) never get here: image OCR redaction is out of scope (#110).
  const scannable = entries.map((entry) => !isNonTextContent(entry.text));
  const toScan = entries.map((_, index) => index).filter((index) => scannable[index] && entries[index].text !== '');
  const nerByEntry: PiiDetection[][] = entries.map(() => []);
  if (toScan.length > 0) {
    let nerRan = false;
    try {
      // isNerReady also accepts ONNX-only caches that redact_text cannot load;
      // it then degrades to pattern-only without saying so. Cabinet mode asks
      // for the stricter criterion before trusting an empty NER result.
      const canRunFullDetection = !options.requireFullDetection || await resolved.isFullDetectionReady();
      if (canRunFullDetection && await resolved.isNerReady()) {
        // Sequential chunks under redact_text's input cap; the first refusal
        // throws and stops the rest.
        for (const chunk of chunkForDetector(toScan.map((index) => entries[index].text))) {
          const starts: number[] = [];
          let joined = '';
          for (const position of chunk) {
            if (joined) joined += BATCH_SEPARATOR;
            starts.push(joined.length);
            joined += entries[toScan[position]].text;
          }
          const found = await resolved.detectNer(joined, options.requireFullDetection ? { requireNer: true } : undefined);
          chunk.forEach((position, slot) => {
            const index = toScan[position];
            const from = starts[slot];
            const to = from + entries[index].text.length;
            for (const detection of found) {
              const start = Math.max(detection.start, from);
              const end = Math.min(detection.end, to);
              if (start >= end) continue;
              nerByEntry[index].push({
                ...detection,
                start: start - from,
                end: end - from,
                text: entries[index].text.slice(start - from, end - from),
              });
            }
          });
        }
        nerRan = true;
      }
    } catch {
      nerRan = false;
    }
    if (options.requireFullDetection && !nerRan) throw new DetectionUnavailableError();
  }
  const threadMap = options.threadKey ? runtimeRehydrationMaps.get(options.threadKey) : undefined;
  const reserved = new Set(Object.keys(threadMap ?? {}));
  const reusable = options.reuseThreadTokens ? threadMap : undefined;
  return entries.map((entry, index): RedactedText => {
    if (!scannable[index]) return { text: RUNTIME_REDACTION_DEFERRED_MARKER, redacted: false, deferred: true };
    if (entry.scanOnly) return { text: entry.text, redacted: false, deferred: false };
    // NER runs unconditionally when ready: regex covers patterns (email,
    // phone, …) but NER-only categories (names, addresses) would pass raw.
    const detections = mergeDetections(
      nerByEntry[index],
      mergeDetections(detectCustomTerms(entry.text, customTerms), detectRegex(entry.text)),
    );
    if (detections.length === 0) return { text: entry.text, redacted: false, deferred: false };
    const { redactedText, rehydrationMap } = buildRedactedText(entry.text, detections, reserved, reusable);
    for (const token of Object.keys(rehydrationMap)) reserved.add(token);
    if (options.threadKey) storeRuntimeRehydrationMap(options.threadKey, rehydrationMap);
    return { text: redactedText, redacted: true, deferred: false };
  });
}

export async function redactFileReadOutputText(
  text: string,
  options: RedactTextOptions = {},
  deps: RuntimeRedactionDeps = {},
): Promise<RedactedText> {
  return (await redactTextBatch([{ text }], options, deps))[0];
}

interface McpContentPart {
  type: string;
  text?: string;
  resource?: { text?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

function isMcpContentResult(value: unknown): value is { content: McpContentPart[]; structuredContent?: unknown } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content);
}

/** Queue the strings of a JSON-like value in walk order; keys are scanned only. */
function collectStructuredTexts(value: unknown, entries: BatchEntry[]): void {
  if (typeof value === 'string') {
    if (value !== '') entries.push({ text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredTexts(item, entries);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      entries.push({ text: key, scanOnly: true });
      collectStructuredTexts(item, entries);
    }
  }
}

/** Rebuild a JSON-like value from batch results, in collectStructuredTexts order. */
function rebuildStructured(
  value: unknown,
  results: RedactedText[],
  cursor: { at: number },
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value === '') return { value, changed: false };
    const result = results[cursor.at++];
    const changed = result.redacted || result.deferred;
    return { value: changed ? result.text : value, changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const rebuilt = rebuildStructured(item, results, cursor);
      changed ||= rebuilt.changed;
      return rebuilt.value;
    });
    return { value: changed ? out : value, changed };
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      cursor.at += 1; // the scan-only key
      const rebuilt = rebuildStructured(item, results, cursor);
      out[key] = rebuilt.value;
      changed ||= rebuilt.changed;
    }
    return { value: changed ? out : value, changed };
  }
  return { value, changed: false };
}

function mcpPartText(part: McpContentPart): string | null {
  // Embedded resources carry text the model reads just like a text part.
  if (part?.type === 'resource' && typeof part.resource?.text === 'string') return part.resource.text;
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  return null;
}

export async function applyFileReadRedaction(
  result: unknown,
  options: RedactTextOptions & { onWithheld?: () => void } = {},
  deps: RuntimeRedactionDeps = {},
): Promise<unknown> {
  // Every text of one result goes to the detector in one call, so a refusal
  // withholds the whole result at once and is recorded once.
  const redactAll = async (entries: BatchEntry[]): Promise<RedactedText[] | null> => {
    try {
      return await redactTextBatch(entries, options, deps);
    } catch (error) {
      if (!(error instanceof DetectionUnavailableError)) throw error;
      options.onWithheld?.();
      return null;
    }
  };
  const withheld: RedactedText = { text: CABINET_WITHHELD_MARKER, redacted: false, deferred: true };
  // Error text can echo paths or content, so it redacts like any other text;
  // the isError flag survives via the spread below and diagnostics keep working.
  if (typeof result === 'string') {
    return ((await redactAll([{ text: result }]))?.[0] ?? withheld).text;
  }
  if (!isMcpContentResult(result)) return result;

  const entries: BatchEntry[] = [];
  const entryOfPart = result.content.map((part) => {
    const text = mcpPartText(part);
    if (text === null) return null;
    entries.push({ text });
    return entries.length - 1;
  });
  // The CLI surface prints the whole result body, so structuredContent
  // reaches the model as well: a copy of the text parts, or more.
  const structuredFrom = entries.length;
  if (result.structuredContent !== undefined) collectStructuredTexts(result.structuredContent, entries);
  const results = await redactAll(entries);

  let changed = false;
  const content = result.content.map((part, index) => {
    const at = entryOfPart[index];
    if (at === null) return part;
    const redacted = results ? results[at] : withheld;
    if (!redacted.redacted && !redacted.deferred) return part;
    changed = true;
    return part.type === 'resource'
      ? { ...part, resource: { ...part.resource, text: redacted.text } }
      : { ...part, text: redacted.text };
  });
  let structuredContent = result.structuredContent;
  if (structuredContent !== undefined) {
    if (!results) {
      // Withheld as a whole: keys and numbers (a client name used as a key,
      // an amount stored as a number) are not string leaves and would pass.
      structuredContent = { withheld: CABINET_WITHHELD_MARKER };
      changed = true;
    } else {
      const rebuilt = rebuildStructured(structuredContent, results, { at: structuredFrom });
      if (rebuilt.changed) {
        structuredContent = rebuilt.value;
        changed = true;
      }
    }
  }
  if (!changed) return result;
  return {
    ...result,
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
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
  const resolved = resolveDeps(deps);
  const requireFullDetection = await resolved.isCabinetMode();
  let withheld = false;
  const redacted = await applyFileReadRedaction(result, {
    ...(threadKey ? { threadKey } : {}),
    requireFullDetection,
    onWithheld: () => { withheld = true; },
  }, deps);
  if (withheld) await recordBlockQuietly(resolved, 'tool');
  return redacted;
}

/**
 * Gate for an error a tool threw. The bridges turn a thrown error into text
 * the model reads, and the message can carry what the tool choked on (a path,
 * an address), so it goes through the same gate as a tool result. Returns the
 * redacted `isError` result, or null when the gate leaves the message alone
 * (outside a Safe workspace, exempt servers) and the caller should rethrow.
 */
export async function maybeRedactToolError(
  options: Omit<MaybeRedactOptions, 'result'> & { error: unknown },
  deps: RuntimeRedactionDeps = {},
): Promise<unknown | null> {
  const { error, ...rest } = options;
  const original = {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
  const gated = await maybeRedactToolResult({ ...rest, result: original }, deps);
  return gated === original ? null : gated;
}

export interface OutboundTextOptions {
  /** Workspace root; redaction arms only when `<workspace>/safe/` exists (#19). */
  workspacePath?: string | null;
  threadKey?: string | null;
  /** See RedactTextOptions.reuseThreadTokens. */
  reuseThreadTokens?: boolean;
}

/**
 * Outbound free-text leg of #19: user message and system prompt are redacted
 * before `runCodexAgentTurn`, under the same workspace `safe/` gate as tool
 * results. threadKey may be a provisional key for a new thread; the caller
 * re-keys when the real thread id arrives.
 */
const CABINET_PROBE_TEXT = 'Cabinet mode detection probe.';

export async function maybeRedactOutboundText(
  text: string,
  options: OutboundTextOptions = {},
  deps: RuntimeRedactionDeps = {},
): Promise<{ text: string; redacted: boolean }> {
  if (!text) return { text, redacted: false };
  if (options.workspacePath != null && !existsSync(join(options.workspacePath, 'safe'))) {
    return { text, redacted: false };
  }
  const resolved = resolveDeps(deps);
  const requireFullDetection = await resolved.isCabinetMode();
  try {
    const result = await redactFileReadOutputText(
      text,
      {
        ...(options.threadKey ? { threadKey: options.threadKey } : {}),
        requireFullDetection,
        reuseThreadTokens: options.reuseThreadTokens,
      },
      deps,
    );
    // Unscannable text (binary, NUL bytes) is replaced by a marker without
    // reaching the detector, so nothing has checked that detection can run;
    // in cabinet mode the turn must not start without that check.
    if (requireFullDetection && result.deferred) {
      await redactFileReadOutputText(CABINET_PROBE_TEXT, { requireFullDetection }, deps);
    }
    return { text: result.text, redacted: result.redacted || result.deferred };
  } catch (error) {
    if (!(error instanceof DetectionUnavailableError)) throw error;
    await recordBlockQuietly(resolved, 'outbound');
    throw new DetectionUnavailableError(await resolved.blockedSendMessage());
  }
}

/**
 * Turn-level cabinet check for input with no free text to scan (a
 * skills-only turn or steer). Runs one real detector call, because the
 * readiness checks only look for model files and cannot see a dead daemon.
 * The probe is local; nothing is sent to the provider. Refuses (and
 * records the block) exactly like a refused message.
 */
export async function assertCabinetTurnAllowed(
  options: Pick<OutboundTextOptions, 'workspacePath'>,
  deps: RuntimeRedactionDeps = {},
): Promise<void> {
  if (options.workspacePath != null && !existsSync(join(options.workspacePath, 'safe'))) return;
  if (!(await resolveDeps(deps).isCabinetMode())) return;
  await maybeRedactOutboundText(CABINET_PROBE_TEXT, { workspacePath: options.workspacePath }, deps);
}

/**
 * Message, system prompt and saved custom instructions of one outbound turn,
 * redacted under the same workspace safe/ gate (#19). /chat/stream calls it
 * for Safe workspaces; headless tasks and subagents call it for every turn.
 * The custom instructions are read here, not by the runtime, so every piece
 * of free text the provider receives passes the one cabinet gate; the caller
 * hands `customInstructions` to runCodexAgentTurn unchanged.
 */
export async function redactOutboundTurnInput(
  input: { message: string; system?: string },
  options: OutboundTextOptions & {
    /** threadKey is a provisional key for a thread with no id yet. */
    provisionalKey?: boolean;
  },
  deps: RuntimeRedactionDeps = {},
): Promise<{ message: string; system?: string; customInstructions: string | null }> {
  try {
    const message = (await maybeRedactOutboundText(input.message, options, deps)).text;
    const system = input.system
      ? (await maybeRedactOutboundText(input.system, options, deps)).text
      : input.system;
    const savedInstructions = await resolveDeps(deps).loadCustomInstructions();
    // Resent unchanged every turn: the same values keep the same tokens, so the
    // provider's prompt cache holds and the thread map stops growing.
    const customInstructions = savedInstructions
      ? (await maybeRedactOutboundText(savedInstructions, { ...options, reuseThreadTokens: true }, deps)).text
      : null;
    // A skills-only turn has no text to scan, so nothing above reached the
    // detector; the turn itself still needs it (native tools read files).
    if (!input.message && !input.system && !savedInstructions) {
      await assertCabinetTurnAllowed(options, deps);
    }
    return { message, system, customInstructions };
  } catch (error) {
    // The message may already have stored originals under the provisional key
    // before the system prompt was refused; nothing will ever re-key them, so
    // they would sit in memory for the life of the process. A real thread's
    // map is not ours to drop.
    if (options.provisionalKey && options.threadKey) deleteRuntimeRehydrationMap(options.threadKey);
    throw error;
  }
}

/**
 * Move a provisional key's map onto the real thread id once the runtime
 * reports it; returns the moved map (empty when there was nothing to move).
 */
export function rekeyRuntimeRehydrationMap(
  fromKey: string,
  toKey: string,
): Record<string, string> {
  if (fromKey === toKey) return {};
  const provisional = getRuntimeRehydrationMap(fromKey);
  if (Object.keys(provisional).length === 0) return {};
  mergeRuntimeRehydrationMap(toKey, provisional);
  deleteRuntimeRehydrationMap(fromKey);
  return provisional;
}
