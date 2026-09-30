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
  // Pinned custom terms (#11) match locally, so they redact even when NER is
  // down; NER also receives them through redact_text when it is up.
  let customTerms: CustomTerm[] = [];
  try {
    customTerms = await resolved.listCustomTerms();
  } catch {
    customTerms = [];
  }
  const regexDetections = mergeDetections(detectCustomTerms(text, customTerms), detectRegex(text));
  // NER runs unconditionally when ready: regex covers patterns (email, phone,
  // …) but NER-only categories (names, addresses) would otherwise pass raw.
  let detections: PiiDetection[] = regexDetections;
  let nerRan = false;
  try {
    // isNerReady also accepts ONNX-only caches that redact_text cannot load;
    // it then degrades to pattern-only without saying so. Cabinet mode asks
    // for the stricter criterion before trusting an empty NER result.
    const canRunFullDetection = !options.requireFullDetection || await resolved.isFullDetectionReady();
    if (canRunFullDetection && await resolved.isNerReady()) {
      detections = mergeDetections(
        await resolved.detectNer(text, options.requireFullDetection ? { requireNer: true } : undefined),
        regexDetections,
      );
      nerRan = true;
    }
  } catch {
    detections = regexDetections;
  }
  if (options.requireFullDetection && !nerRan) throw new DetectionUnavailableError();
  if (detections.length === 0) return { text, redacted: false, deferred: false };
  const reserved = options.threadKey ? Object.keys(runtimeRehydrationMaps.get(options.threadKey) ?? {}) : [];
  const { redactedText, rehydrationMap } = buildRedactedText(text, detections, new Set(reserved));
  if (options.threadKey) storeRuntimeRehydrationMap(options.threadKey, rehydrationMap);
  return { text: redactedText, redacted: true, deferred: false };
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

/**
 * Redact every string inside a JSON-like value, in place of the original
 * shape (keys, numbers, booleans and nesting are kept). Sequential for the
 * same reason as the content parts: reserved tokens accumulate in order.
 */
async function redactStringLeaves(
  value: unknown,
  redact: (text: string) => Promise<{ text: string; redacted: boolean; deferred: boolean }>,
): Promise<{ value: unknown; changed: boolean }> {
  if (typeof value === 'string') {
    if (value === '') return { value, changed: false };
    const result = await redact(value);
    const changed = result.redacted || result.deferred;
    return { value: changed ? result.text : value, changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const walked = await redactStringLeaves(item, redact);
      out.push(walked.value);
      changed ||= walked.changed;
    }
    return { value: changed ? out : value, changed };
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const walked = await redactStringLeaves(item, redact);
      out[key] = walked.value;
      changed ||= walked.changed;
    }
    return { value: changed ? out : value, changed };
  }
  return { value, changed: false };
}

export async function applyFileReadRedaction(
  result: unknown,
  options: RedactTextOptions & { onWithheld?: () => void } = {},
  deps: RuntimeRedactionDeps = {},
): Promise<unknown> {
  const redactOrWithhold = async (text: string) => {
    try {
      return await redactFileReadOutputText(text, options, deps);
    } catch (error) {
      if (!(error instanceof DetectionUnavailableError)) throw error;
      options.onWithheld?.();
      return { text: CABINET_WITHHELD_MARKER, redacted: false, deferred: true };
    }
  };
  // Error text can echo paths or content, so it redacts like any other text;
  // the isError flag survives via the spread below and diagnostics keep working.
  if (typeof result === 'string') {
    return (await redactOrWithhold(result)).text;
  }
  if (isMcpContentResult(result)) {
    // Sequential on purpose: each part stores into the thread map before the
    // next part redacts, so reserved tokens accumulate and two parts can never
    // emit the same token for different originals (see the multipart test).
    const content: McpContentPart[] = [];
    let changed = false;
    for (const part of result.content) {
      if (part?.type === 'resource' && typeof part.resource?.text === 'string') {
        // Embedded resources carry text the model reads just like a text part.
        const redacted = await redactOrWithhold(part.resource.text);
        if (redacted.redacted || redacted.deferred) {
          content.push({ ...part, resource: { ...part.resource, text: redacted.text } });
          changed = true;
        } else {
          content.push(part);
        }
        continue;
      }
      if (part?.type !== 'text' || typeof part.text !== 'string') {
        content.push(part);
        continue;
      }
      const redacted = await redactOrWithhold(part.text);
      if (redacted.redacted || redacted.deferred) {
        content.push({ ...part, text: redacted.text });
        changed = true;
      } else {
        content.push(part);
      }
    }
    // The CLI surface prints the whole result body, so structuredContent
    // reaches the model as well: a copy of the text parts, or more.
    let structuredContent = result.structuredContent;
    if (structuredContent !== undefined) {
      const walked = await redactStringLeaves(structuredContent, redactOrWithhold);
      if (walked.changed) {
        structuredContent = walked.value;
        changed = true;
      }
    }
    if (!changed) return result;
    return {
      ...result,
      content,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
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
  const resolved = resolveDeps(deps);
  const requireFullDetection = await resolved.isCabinetMode();
  try {
    const result = await redactFileReadOutputText(
      text,
      { ...(options.threadKey ? { threadKey: options.threadKey } : {}), requireFullDetection },
      deps,
    );
    return { text: result.text, redacted: result.redacted || result.deferred };
  } catch (error) {
    if (!(error instanceof DetectionUnavailableError)) throw error;
    await recordBlockQuietly(resolved, 'outbound');
    throw new DetectionUnavailableError(await resolved.blockedSendMessage());
  }
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
    const customInstructions = savedInstructions
      ? (await maybeRedactOutboundText(savedInstructions, options, deps)).text
      : null;
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
