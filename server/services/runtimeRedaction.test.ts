import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  applyFileReadRedaction,
  assertCabinetTurnAllowed,
  CABINET_WITHHELD_MARKER,
  clearActiveTurnWorkspace,
  clearRuntimeRehydrationMaps,
  deleteRuntimeRehydrationMap,
  DetectionUnavailableError,
  getActiveTurnWorkspace,
  getRuntimeRehydrationMap,
  maybeRedactOutboundText,
  maybeRedactToolResult,
  mergeRuntimeRehydrationMap,
  redactOutboundTurnInput,
  rekeyRuntimeRehydrationMap,
  RUNTIME_REDACTION_DEFERRED_MARKER,
  setActiveTurnWorkspace,
} from './runtimeRedaction';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

const PROBE_EMAIL = 'john@example.com';

const tempDirs: string[] = [];

function workspace(armed: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'pii-ws-'));
  if (armed) mkdirSync(join(dir, 'safe'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const stubDeps = {
  // NER down by default: regex-only fallback must still redact.
  isNerReady: () => false,
  detectNer: async (_text: string): Promise<never[]> => [],
  listCustomTerms: async () => [],
  // Cabinet mode has its own describe block; everything else keeps today's fallback.
  isCabinetMode: () => false,
  recordBlock: async () => {},
  blockedSendMessage: async () => 'blocked',
  loadCustomInstructions: async () => null,
};

describe('applyFileReadRedaction', () => {
  test('redacts PII in MCP text content to tokens only', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      { content: [{ type: 'text', text: `Contact ${PROBE_EMAIL} for the report` }], isError: false },
      { threadKey: 'thread-1' },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    expect(text).not.toContain(PROBE_EMAIL);
    expect(getRuntimeRehydrationMap('thread-1')['[EMAIL_0]']).toBe(PROBE_EMAIL);
  });

  test('uses the same token vocabulary as pasted-file redaction', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      `Call ${PROBE_EMAIL}`,
      { threadKey: 'thread-2' },
      stubDeps,
    );
    expect(result).toBe('Call [EMAIL_0]');
  });

  test('merges NER detections over regex when models are ready', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      { content: [{ type: 'text', text: 'Jane Doe <jane@example.com>' }], isError: false },
      { threadKey: 'thread-3' },
      {
        isNerReady: () => true,
        listCustomTerms: async () => [],
        detectNer: async () => [
          { category: 'person_full_name', start: 0, end: 8, text: 'Jane Doe', confidence: 0.9 },
        ],
      },
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/\[NAME_\d+\]/);
    expect(text).not.toContain('Jane Doe');
    expect(text).not.toContain('jane@example.com');
  });

  test('runs NER even when regex finds nothing (NER-only PII)', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      { content: [{ type: 'text', text: 'Authored by Jane Doe yesterday' }], isError: false },
      { threadKey: 'thread-ner-only' },
      {
        isNerReady: () => true,
        listCustomTerms: async () => [],
        detectNer: async () => [
          { category: 'person_full_name', start: 12, end: 20, text: 'Jane Doe', confidence: 0.9 },
        ],
      },
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('Jane Doe');
    expect(text).toMatch(/\[NAME_\d+\]/);
  });

  test('repeated reads never re-emit a live thread token', async () => {
    clearRuntimeRehydrationMaps();
    const first = await applyFileReadRedaction(
      { content: [{ type: 'text', text: `first ${PROBE_EMAIL}` }], isError: false },
      { threadKey: 'thread-repeat' },
      stubDeps,
    );
    const firstText = (first as { content: Array<{ text: string }> }).content[0].text;
    expect(firstText).toContain('[EMAIL_0]');
    const second = await applyFileReadRedaction(
      { content: [{ type: 'text', text: 'second bob@example.com' }], isError: false },
      { threadKey: 'thread-repeat' },
      stubDeps,
    );
    const secondText = (second as { content: Array<{ text: string }> }).content[0].text;
    expect(secondText).toContain('[EMAIL_1]');
    expect(secondText).not.toContain('[EMAIL_0]');
    const map = getRuntimeRehydrationMap('thread-repeat');
    expect(map['[EMAIL_0]']).toBe(PROBE_EMAIL);
    expect(map['[EMAIL_1]']).toBe('bob@example.com');
  });

  test('marks binary content deferred with marker only (no raw bytes)', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      { content: [{ type: 'text', text: 'PNG\0\x01\x02binary' }], isError: false },
      { threadKey: 'thread-4' },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('redaction deferred');
    expect(text).not.toContain('PNG');
  });

  test('redacts error-result text while preserving isError', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      { content: [{ type: 'text', text: `denied ${PROBE_EMAIL}` }], isError: true },
      { threadKey: 'thread-5' },
      stubDeps,
    );
    const envelope = result as { content: Array<{ text: string }>; isError: boolean };
    expect(envelope.isError).toBe(true);
    expect(envelope.content[0].text).not.toContain(PROBE_EMAIL);
  });

  test('multipart results never reuse a token across parts', async () => {
    clearRuntimeRehydrationMaps();
    const result = await applyFileReadRedaction(
      {
        content: [
          { type: 'text', text: `first ${PROBE_EMAIL}` },
          { type: 'text', text: 'second bob@example.com' },
        ],
        isError: false,
      },
      { threadKey: 'thread-multi' },
      stubDeps,
    );
    const parts = (result as { content: Array<{ text: string }> }).content;
    expect(parts[0].text).toContain('[EMAIL_0]');
    expect(parts[1].text).toContain('[EMAIL_1]');
    expect(parts[1].text).not.toContain('[EMAIL_0]');
    expect(getRuntimeRehydrationMap('thread-multi')).toEqual({
      '[EMAIL_0]': PROBE_EMAIL,
      '[EMAIL_1]': 'bob@example.com',
    });
  });

  test('deletes a thread rehydration map', async () => {
    clearRuntimeRehydrationMaps();
    await applyFileReadRedaction(`mail ${PROBE_EMAIL}`, { threadKey: 'thread-gone' }, stubDeps);
    expect(Object.keys(getRuntimeRehydrationMap('thread-gone')).length).toBeGreaterThan(0);
    deleteRuntimeRehydrationMap('thread-gone');
    expect(getRuntimeRehydrationMap('thread-gone')).toEqual({});
  });

  test('deletion during in-flight NER leaves text redacted with no stored map', async () => {
    clearRuntimeRehydrationMaps();
    let resolveNer!: (detections: Array<{ category: string; start: number; end: number; text: string; confidence: number }>) => void;
    const nerGate = new Promise<Array<{ category: string; start: number; end: number; text: string; confidence: number }>>(
      (resolve) => { resolveNer = resolve; },
    );
    const pending = applyFileReadRedaction(
      { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }], isError: false },
      { threadKey: 'thread-race' },
      { isNerReady: () => true, detectNer: () => nerGate, listCustomTerms: async () => [] },
    );
    deleteRuntimeRehydrationMap('thread-race');
    resolveNer([]);
    const result = await pending;
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain(PROBE_EMAIL);
    expect(getRuntimeRehydrationMap('thread-race')).toEqual({});
  });
});

describe('maybeRedactToolResult', () => {
  test('redacts file reads when the workspace opted into safe/', async () => {
    clearRuntimeRehydrationMaps();
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-fs',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] },
        workspacePath: workspace(true),
        threadKey: 'thread-6',
      },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain(PROBE_EMAIL);
  });

  test('passes file reads through outside a safe workspace', async () => {
    const raw = { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] };
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-fs',
        toolName: 'read_file',
        result: raw,
        workspacePath: workspace(false),
        threadKey: 'thread-7',
      },
      stubDeps,
    );
    expect(result).toBe(raw);
  });

  test('fails closed when the workspace path is unknown', async () => {
    clearRuntimeRehydrationMaps();
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-fs',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] },
        threadKey: 'thread-8',
      },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain(PROBE_EMAIL);
  });

  test('redacts non-read tool results when armed (spec §7 all tool results)', async () => {
    clearRuntimeRehydrationMaps();
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-fs',
        toolName: 'write_file',
        result: { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] },
        workspacePath: workspace(true),
        threadKey: 'thread-9',
      },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain(PROBE_EMAIL);
  });

  test('exempts the permission-test stub server (verbatim E2E output)', async () => {
    const raw = { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] };
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-test-filesystem',
        toolName: 'read_file',
        result: raw,
        workspacePath: workspace(true),
        threadKey: 'thread-tf',
      },
      stubDeps,
    );
    expect(result).toBe(raw);
  });

  test('exempts basemind redact_text (the hook re-enters itself through it)', async () => {
    const raw = { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] };
    const result = await maybeRedactToolResult(
      {
        serverId: 'basemind',
        toolName: 'redact_text',
        result: raw,
        workspacePath: workspace(true),
        threadKey: 'thread-rt',
      },
      stubDeps,
    );
    expect(result).toBe(raw);
  });

  test('exempts basemind vault (returns originals for Show Originals)', async () => {
    const raw = { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] };
    const result = await maybeRedactToolResult(
      {
        serverId: 'basemind',
        toolName: 'vault',
        result: raw,
        workspacePath: workspace(true),
        threadKey: 'thread-v',
      },
      stubDeps,
    );
    expect(result).toBe(raw);
  });

  test('redacts without storing when no thread key exists', async () => {
    clearRuntimeRehydrationMaps();
    const result = await maybeRedactToolResult(
      {
        serverId: 'builtin-fs',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: `mail ${PROBE_EMAIL}` }] },
        workspacePath: workspace(true),
      },
      stubDeps,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain(PROBE_EMAIL);
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    // Tokens without reveal: nothing stored under any other key.
    expect(getRuntimeRehydrationMap('no-such-thread')).toEqual({});
  });
});

describe('maybeRedactOutboundText', () => {
  test('redacts free text when the workspace opted into safe/', async () => {
    clearRuntimeRehydrationMaps();
    const { text, redacted } = await maybeRedactOutboundText(
      `mail ${PROBE_EMAIL}`,
      { workspacePath: workspace(true), threadKey: 'thread-out-1' },
      stubDeps,
    );
    expect(redacted).toBe(true);
    expect(text).not.toContain(PROBE_EMAIL);
    expect(getRuntimeRehydrationMap('thread-out-1')['[EMAIL_0]']).toBe(PROBE_EMAIL);
  });

  test('passes free text through outside a safe workspace', async () => {
    const { text, redacted } = await maybeRedactOutboundText(
      `mail ${PROBE_EMAIL}`,
      { workspacePath: workspace(false), threadKey: 'thread-out-2' },
      stubDeps,
    );
    expect(redacted).toBe(false);
    expect(text).toBe(`mail ${PROBE_EMAIL}`);
  });

  test('fails closed when the workspace path is unknown', async () => {
    clearRuntimeRehydrationMaps();
    const { text, redacted } = await maybeRedactOutboundText(
      `mail ${PROBE_EMAIL}`,
      { threadKey: 'thread-out-3' },
      stubDeps,
    );
    expect(redacted).toBe(true);
    expect(text).not.toContain(PROBE_EMAIL);
  });

  test('redacts without storing when no thread key exists', async () => {
    clearRuntimeRehydrationMaps();
    const { text, redacted } = await maybeRedactOutboundText(
      `mail ${PROBE_EMAIL}`,
      { workspacePath: workspace(true) },
      stubDeps,
    );
    expect(redacted).toBe(true);
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    expect(getRuntimeRehydrationMap('no-such-thread')).toEqual({});
  });

  test('leaves clean free text unchanged even when armed', async () => {
    const { text, redacted } = await maybeRedactOutboundText(
      'just a normal message',
      { workspacePath: workspace(true), threadKey: 'thread-out-4' },
      stubDeps,
    );
    expect(redacted).toBe(false);
    expect(text).toBe('just a normal message');
  });
});

describe('active turn workspace registry', () => {
  test('resolves the workspace of a running turn for mid-turn steers', () => {
    clearRuntimeRehydrationMaps();
    setActiveTurnWorkspace('thread-steer-1', '/ws/a');
    expect(getActiveTurnWorkspace('thread-steer-1')).toBe('/ws/a');

    clearActiveTurnWorkspace('thread-steer-1');
    expect(getActiveTurnWorkspace('thread-steer-1')).toBeUndefined();
  });

  test('is emptied with the rehydration maps', () => {
    setActiveTurnWorkspace('thread-steer-2', '/ws/b');
    clearRuntimeRehydrationMaps();
    expect(getActiveTurnWorkspace('thread-steer-2')).toBeUndefined();
  });
});

describe('redactOutboundTurnInput', () => {
  test('redacts message and system prompt in a safe workspace', async () => {
    clearRuntimeRehydrationMaps();
    const result = await redactOutboundTurnInput(
      { message: `task for ${PROBE_EMAIL}`, system: `owner ${PROBE_EMAIL}` },
      { workspacePath: workspace(true), threadKey: 'pending-task-1' },
      stubDeps,
    );
    expect(result.message).not.toContain(PROBE_EMAIL);
    expect(result.system).not.toContain(PROBE_EMAIL);
    expect(Object.values(getRuntimeRehydrationMap('pending-task-1'))).toContain(PROBE_EMAIL);
  });

  test('passes through outside a safe workspace', async () => {
    const result = await redactOutboundTurnInput(
      { message: `task for ${PROBE_EMAIL}` },
      { workspacePath: workspace(false), threadKey: 'pending-task-2' },
      stubDeps,
    );
    expect(result).toEqual({ message: `task for ${PROBE_EMAIL}`, system: undefined, customInstructions: null });
  });

  test('redacts saved custom instructions under the same thread key', async () => {
    clearRuntimeRehydrationMaps();
    const result = await redactOutboundTurnInput(
      { message: `task for ${PROBE_EMAIL}` },
      { workspacePath: workspace(true), threadKey: 'pending-task-ci' },
      { ...stubDeps, loadCustomInstructions: async () => 'Our client is jane@client.test' },
    );
    expect(result.customInstructions).not.toContain('jane@client.test');
    const map = getRuntimeRehydrationMap('pending-task-ci');
    expect(Object.values(map)).toEqual(expect.arrayContaining([PROBE_EMAIL, 'jane@client.test']));
    // One map, distinct tokens: a reveal can never mix the two originals up.
    expect(result.customInstructions).toMatch(/\[EMAIL_1\]/);
    expect(result.message).toContain('[EMAIL_0]');
  });

  test('keeps the same tokens for unchanged custom instructions across turns', async () => {
    // New tokens every turn broke the provider's prompt cache and grew the
    // thread map by one entry per value per turn.
    clearRuntimeRehydrationMaps();
    const ws = workspace(true);
    const deps = {
      ...stubDeps,
      loadCustomInstructions: async () => 'Our client is jane@client.test, cc bob@client.test',
    };
    const first = await redactOutboundTurnInput({ message: `turn one for ${PROBE_EMAIL}` }, { workspacePath: ws, threadKey: 't-ci-cache' }, deps);
    const size = Object.keys(getRuntimeRehydrationMap('t-ci-cache')).length;
    const second = await redactOutboundTurnInput({ message: 'turn two, nothing new' }, { workspacePath: ws, threadKey: 't-ci-cache' }, deps);

    expect(second.customInstructions).toBe(first.customInstructions);
    expect(Object.keys(getRuntimeRehydrationMap('t-ci-cache'))).toHaveLength(size);
  });

  test('gives a value the same token across messages of a thread', async () => {
    // One value, one token for the whole conversation: the model can follow the
    // same company or person from message to message, and the map does not
    // grow by one entry per mention.
    clearRuntimeRehydrationMaps();
    const ws = workspace(true);
    await redactOutboundTurnInput({ message: `ping ${PROBE_EMAIL}` }, { workspacePath: ws, threadKey: 't-ci-msg' }, stubDeps);
    const second = await redactOutboundTurnInput({ message: `ping ${PROBE_EMAIL}` }, { workspacePath: ws, threadKey: 't-ci-msg' }, stubDeps);
    expect(second.message).toBe('ping [EMAIL_0]');
    expect(Object.keys(getRuntimeRehydrationMap('t-ci-msg'))).toEqual(['[EMAIL_0]']);
  });

  test('gives a value the same token within one message, and a new value a new one', async () => {
    clearRuntimeRehydrationMaps();
    const result = await redactOutboundTurnInput(
      { message: `${PROBE_EMAIL} then ${PROBE_EMAIL} then other@client.test` },
      { workspacePath: workspace(true), threadKey: 't-ci-same' },
      stubDeps,
    );
    expect(result.message).toBe('[EMAIL_0] then [EMAIL_0] then [EMAIL_1]');
  });

  test('gives a value the same token without a thread, within one call', async () => {
    const result = await redactOutboundTurnInput(
      { message: `${PROBE_EMAIL} and again ${PROBE_EMAIL}` },
      { workspacePath: workspace(true) },
      stubDeps,
    );
    expect(result.message).toBe('[EMAIL_0] and again [EMAIL_0]');
  });

  test('passes custom instructions through outside a safe workspace', async () => {
    const result = await redactOutboundTurnInput(
      { message: 'hi' },
      { workspacePath: workspace(false), threadKey: 'pending-task-ci2' },
      { ...stubDeps, loadCustomInstructions: async () => 'Our client is jane@client.test' },
    );
    expect(result.customInstructions).toBe('Our client is jane@client.test');
  });
});

describe('rekeyRuntimeRehydrationMap', () => {
  test('moves a provisional map onto the real thread id', () => {
    clearRuntimeRehydrationMaps();
    mergeRuntimeRehydrationMap('pending-x', { '[EMAIL_0]': PROBE_EMAIL });

    const moved = rekeyRuntimeRehydrationMap('pending-x', 'thread-x');

    expect(moved).toEqual({ '[EMAIL_0]': PROBE_EMAIL });
    expect(getRuntimeRehydrationMap('thread-x')).toEqual({ '[EMAIL_0]': PROBE_EMAIL });
    expect(getRuntimeRehydrationMap('pending-x')).toEqual({});
  });

  test('is a no-op when the key is already the thread id', () => {
    clearRuntimeRehydrationMaps();
    mergeRuntimeRehydrationMap('thread-y', { '[EMAIL_0]': PROBE_EMAIL });
    expect(rekeyRuntimeRehydrationMap('thread-y', 'thread-y')).toEqual({});
    expect(getRuntimeRehydrationMap('thread-y')).toEqual({ '[EMAIL_0]': PROBE_EMAIL });
  });
});

describe('pinned custom terms', () => {
  test('redact outbound text even when NER is down', async () => {
    clearRuntimeRehydrationMaps();
    const { text, redacted } = await maybeRedactOutboundText(
      'Contrat avec ACME Holding signé',
      { workspacePath: workspace(true), threadKey: 'thread-custom-1' },
      { ...stubDeps, listCustomTerms: async () => [{ label: 'Client', value: 'acme holding' }] },
    );
    expect(redacted).toBe(true);
    expect(text).toBe('Contrat avec [CLIENT_0] signé');
    expect(getRuntimeRehydrationMap('thread-custom-1')['[CLIENT_0]']).toBe('ACME Holding');
  });

  test('a term pinned from a palette category redacts under that category', async () => {
    clearRuntimeRehydrationMaps();
    const { text } = await maybeRedactOutboundText(
      'Écrire à Jean Dupond',
      { workspacePath: workspace(true), threadKey: 'thread-custom-2' },
      { ...stubDeps, listCustomTerms: async () => [{ label: 'Name', value: 'Jean Dupond' }] },
    );
    expect(text).not.toContain('Jean Dupond');
    expect(text).not.toContain('CUSTOM');
  });
});

describe('structured MCP output', () => {
  test('redacts structuredContent strings and resource text like text parts', async () => {
    clearRuntimeRehydrationMaps();
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'search',
      result: {
        content: [
          { type: 'text', text: `Mail ${PROBE_EMAIL}` },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: `Mail ${PROBE_EMAIL}` } },
        ],
        structuredContent: { hits: [{ snippet: `Mail ${PROBE_EMAIL}`, score: 3 }] },
      },
      workspacePath: ws,
      threadKey: 't-sc1',
    }, stubDeps);
    expect(JSON.stringify(result)).not.toContain(PROBE_EMAIL);
    const r = result as { structuredContent: { hits: Array<{ snippet: string; score: number }> } };
    expect(r.structuredContent.hits[0].snippet).toMatch(/^Mail \[EMAIL_\d+\]$/);
    expect(r.structuredContent.hits[0].score).toBe(3);
  });
});

describe('one detector call per tool result', () => {
  // Detector stand-in that finds every "Jane Doe" in whatever text it gets,
  // so offsets come from the text actually sent to it.
  function namesDetector(calls: string[]) {
    return async (text: string): Promise<PiiDetection[]> => {
      calls.push(text);
      const found: PiiDetection[] = [];
      for (let at = text.indexOf('Jane Doe'); at !== -1; at = text.indexOf('Jane Doe', at + 1)) {
        found.push({ category: 'person', start: at, end: at + 8, text: 'Jane Doe', confidence: 0.9 });
      }
      return found;
    };
  }

  test('sends every text of a result to the detector in a single call', async () => {
    const calls: string[] = [];
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'search',
      result: {
        content: [
          { type: 'text', text: 'Jane Doe signed' },
          { type: 'text', text: 'Counsel for Jane Doe' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'Jane Doe again' } },
        ],
        structuredContent: { hits: [{ snippet: 'Jane Doe owes' }, { snippet: 'nothing here' }] },
        isError: false,
      },
      workspacePath: workspace(true),
      threadKey: 't-batch-1',
    }, { ...stubDeps, isNerReady: () => true, detectNer: namesDetector(calls) });

    expect(calls).toHaveLength(1);
    const r = result as {
      content: Array<{ text?: string; resource?: { text: string } }>;
      structuredContent: { hits: Array<{ snippet: string }> };
    };
    // Offsets land on each text, and one name keeps one token across the result.
    expect(r.content[0].text).toBe('[NAME_0] signed');
    expect(r.content[1].text).toBe('Counsel for [NAME_0]');
    expect(r.content[2].resource?.text).toBe('[NAME_0] again');
    expect(r.structuredContent.hits.map((h) => h.snippet)).toEqual(['[NAME_0] owes', 'nothing here']);
  });

  test('splits a batch that would exceed the detector input limit', async () => {
    // redact_text refuses more than 1 MiB per call; each text alone fits.
    const sizes: number[] = [];
    const big = 'é'.repeat(300_000); // 600 000 UTF-8 bytes
    await maybeRedactToolResult({
      serverId: 'builtin-filesystem',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: big }, { type: 'text', text: big }], isError: false },
      workspacePath: workspace(true),
      threadKey: 't-batch-4',
    }, {
      ...stubDeps,
      isNerReady: () => true,
      detectNer: async (text: string) => { sizes.push(Buffer.byteLength(text, 'utf8')); return []; },
    });
    expect(sizes).toHaveLength(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1 << 20);
  });

  test('stops at the first refusal and records one block per result', async () => {
    const calls: string[] = [];
    const blocks: string[] = [];
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'search',
      result: {
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }],
        structuredContent: { hits: ['d', 'e'] },
        isError: false,
      },
      workspacePath: workspace(true),
      threadKey: 't-batch-2',
    }, {
      ...stubDeps,
      isCabinetMode: () => true,
      isFullDetectionReady: () => true,
      isNerReady: () => true,
      detectNer: async (text: string) => { calls.push(text); throw new Error('daemon down'); },
      recordBlock: async (surface: 'outbound' | 'tool') => { blocks.push(surface); },
    });

    expect(calls).toHaveLength(1);
    expect(blocks).toEqual(['tool']);
    const r = result as { content: Array<{ text: string }>; structuredContent: unknown };
    expect(r.content.map((part) => part.text)).toEqual([CABINET_WITHHELD_MARKER, CABINET_WITHHELD_MARKER, CABINET_WITHHELD_MARKER]);
    expect(r.structuredContent).toEqual({ withheld: CABINET_WITHHELD_MARKER });
  });

  test('never gives two different values the same token, even without a thread', async () => {
    const result = await maybeRedactToolResult({
      serverId: 'builtin-filesystem',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: 'a@example.com' }, { type: 'text', text: 'b@example.com' }], isError: false },
      workspacePath: workspace(true),
    }, stubDeps);
    const texts = (result as { content: Array<{ text: string }> }).content.map((part) => part.text);
    expect(new Set(texts).size).toBe(2);
  });

  test('redacts a structuredContent key that holds PII when detection runs', async () => {
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'stats',
      result: { content: [], structuredContent: { 'Jane Doe': { owed: 125000 }, total: 1 }, isError: false },
      workspacePath: workspace(true),
      threadKey: 't-batch-5',
    }, { ...stubDeps, isNerReady: () => true, detectNer: namesDetector([]) });
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(JSON.stringify(structured)).not.toContain('Jane Doe');
    expect(Object.keys(structured)).toEqual([expect.stringMatching(/^\[NAME_\d+\]$/), 'total']);
    expect(Object.values(structured)).toEqual([{ owed: 125000 }, 1]);
  });

  test('checks structuredContent keys too, so a keys-only result is still gated', async () => {
    const blocks: string[] = [];
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'stats',
      result: { content: [], structuredContent: { 'Acme SAS': 125000 }, isError: false },
      workspacePath: workspace(true),
      threadKey: 't-batch-3',
    }, {
      ...stubDeps,
      isCabinetMode: () => true,
      isFullDetectionReady: () => true,
      recordBlock: async (surface: 'outbound' | 'tool') => { blocks.push(surface); },
    });
    expect((result as { structuredContent: unknown }).structuredContent).toEqual({ withheld: CABINET_WITHHELD_MARKER });
    expect(blocks).toEqual(['tool']);
  });
});

describe('cabinet mode', () => {
  const blocks: string[] = [];
  const cabinetDeps = {
    ...stubDeps,
    isCabinetMode: () => true,
    isFullDetectionReady: () => true,
    recordBlock: async (surface: 'outbound' | 'tool') => { blocks.push(surface); },
    blockedSendMessage: async () => 'Cabinet mode: nothing was sent.',
  };

  test('refuses outbound text when NER is not ready', async () => {
    blocks.length = 0;
    const ws = workspace(true);
    const call = maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c1' }, cabinetDeps);
    await expect(call).rejects.toBeInstanceOf(DetectionUnavailableError);
    await expect(
      maybeRedactOutboundText('x', { workspacePath: ws, threadKey: 't-c1' }, cabinetDeps),
    ).rejects.toThrow('Cabinet mode: nothing was sent.');
    expect(blocks).toEqual(['outbound', 'outbound']);
  });

  test('refuses unscannable outbound text too when detection is down', async () => {
    // A NUL byte makes the text "binary": it is replaced by a marker and
    // never reaches the detector, so nothing checked that detection could
    // run and the turn started with NER down.
    blocks.length = 0;
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('hello\0world', { workspacePath: ws, threadKey: 't-c-nul' }, cabinetDeps),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(blocks).toEqual(['outbound']);
  });

  test('lets unscannable outbound text through as a marker when detection runs', async () => {
    const ws = workspace(true);
    const { text } = await maybeRedactOutboundText('hello\0world', { workspacePath: ws }, {
      ...cabinetDeps,
      isNerReady: () => true,
      detectNer: async () => [],
    });
    expect(text).toBe(RUNTIME_REDACTION_DEFERRED_MARKER);
  });

  test('refuses outbound text when NER throws', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe', { workspacePath: ws, threadKey: 't-c2' }, {
        ...cabinetDeps,
        isNerReady: () => true,
        detectNer: async () => { throw new Error('daemon down'); },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });

  test('asks the detector to fail rather than degrade, only in cabinet mode', async () => {
    const ws = workspace(true);
    const seen: Array<boolean | undefined> = [];
    const detectNer = async (_text: string, options?: { requireNer?: boolean }) => {
      seen.push(options?.requireNer);
      return [];
    };
    const ready = { isNerReady: () => true, detectNer };
    await maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, { ...cabinetDeps, ...ready });
    await maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, { ...stubDeps, ...ready });
    expect(seen).toEqual([true, undefined]);
  });

  test('refuses when NER reports ready but the candle model cannot load', async () => {
    // isNerReady also accepts ONNX-only caches, where redact_text silently
    // returns no NER detections and would redact pattern-only.
    const ws = workspace(true);
    let nerCalled = false;
    await expect(
      maybeRedactOutboundText('Jane Doe signs for Acme', { workspacePath: ws }, {
        ...cabinetDeps,
        isNerReady: () => true,
        isFullDetectionReady: () => false,
        detectNer: async () => { nerCalled = true; return []; },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(nerCalled).toBe(false);
  });

  test('refuses even text with no regex match (names are NER-only)', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe signs for Acme', { workspacePath: ws }, cabinetDeps),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });

  test('withholds tool result text parts when NER is not ready', async () => {
    blocks.length = 0;
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'builtin-filesystem',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: 'Jane Doe owes 10 000 €' }, { type: 'image', data: 'x' }], isError: false },
      workspacePath: ws,
      threadKey: 't-c3',
    }, cabinetDeps);
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0].text).toBe(CABINET_WITHHELD_MARKER);
    expect(content[1].type).toBe('image');
    expect(blocks).toEqual(['tool']);
  });

  test('withholds a plain string tool result', async () => {
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'builtin-filesystem', toolName: 'read_file', result: 'Jane Doe', workspacePath: ws, threadKey: 't-c4',
    }, cabinetDeps);
    expect(result).toBe(CABINET_WITHHELD_MARKER);
  });

  test('withholds structuredContent strings and embedded resource text too', async () => {
    blocks.length = 0;
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'search',
      result: {
        content: [
          { type: 'text', text: 'Jane Doe owes 10 000 €' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'Jane Doe again' } },
        ],
        structuredContent: { hits: [{ snippet: 'Jane Doe owes 10 000 €', score: 3, tags: ['Acme'] }], total: 1 },
        isError: false,
      },
      workspacePath: ws,
      threadKey: 't-c7',
    }, cabinetDeps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('Acme');
    const r = result as {
      content: Array<{ resource?: { uri: string; text: string } }>;
      structuredContent: { hits: Array<{ snippet: string; score: number; tags: string[] }>; total: number };
    };
    expect(r.content[1].resource).toEqual({ uri: 'file:///a.txt', text: CABINET_WITHHELD_MARKER });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b === 'tool')).toBe(true);
  });

  test('withholds structuredContent as a whole: keys and numbers never pass', async () => {
    // An amount stored as a number, or a client name used as a key, is not a
    // string leaf; withholding leaf by leaf would let both through.
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'basemind',
      toolName: 'search',
      result: {
        content: [{ type: 'text', text: 'found' }],
        structuredContent: { 'Acme SAS': { owed: 125000, score: 3 }, total: 1 },
        isError: false,
      },
      workspacePath: ws,
      threadKey: 't-c8',
    }, cabinetDeps);
    const r = result as { structuredContent: unknown; isError: boolean };
    expect(r.structuredContent).toEqual({ withheld: CABINET_WITHHELD_MARKER });
    expect(JSON.stringify(result)).not.toContain('Acme');
    expect(JSON.stringify(result)).not.toContain('125000');
    expect(r.isError).toBe(false);
  });

  test('behaves as today when NER is ready', async () => {
    const ws = workspace(true);
    const { text } = await maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c5' }, {
      ...cabinetDeps,
      isNerReady: () => true,
      detectNer: async () => [],
    });
    expect(text).toBe('Mail [EMAIL_0]');
  });

  test('does nothing outside a Safe workspace', async () => {
    const ws = workspace(false);
    const { text } = await maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, cabinetDeps);
    expect(text).toBe('Jane Doe');
  });

  test('cabinet off keeps the regex fallback', async () => {
    const ws = workspace(true);
    const { text } = await maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c6' }, stubDeps);
    expect(text).toBe('Mail [EMAIL_0]');
  });

  test('lets the turn through in Electron when the model sits in the hub the preseed writes to', async () => {
    // Electron main always sets INTERPRETER_USER_DATA_DIR; the NER preseed
    // writes to resolveHubBaseDirs()[0]. Real readiness checks, no stubs.
    const saved = { userData: process.env.INTERPRETER_USER_DATA_DIR, hub: process.env.HF_HUB_CACHE };
    const userData = mkdtempSync(join(tmpdir(), 'pii-userdata-'));
    const hub = mkdtempSync(join(tmpdir(), 'pii-hub-'));
    tempDirs.push(userData, hub);
    const snapshot = join(hub, 'models--fastino--gliner2-privacy-filter-PII-multi', 'snapshots', 'rev');
    mkdirSync(join(snapshot, 'encoder_config'), { recursive: true });
    writeFileSync(join(snapshot, 'model.safetensors'), 'weights');
    writeFileSync(join(snapshot, 'tokenizer.json'), '{}');
    writeFileSync(join(snapshot, 'encoder_config', 'config.json'), '{}');
    process.env.INTERPRETER_USER_DATA_DIR = userData;
    process.env.HF_HUB_CACHE = hub;
    try {
      const { isNerReady: _ner, isFullDetectionReady: _full, ...realReadiness } = cabinetDeps;
      const { text } = await maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: workspace(true) }, realReadiness);
      expect(text).toBe('Mail [EMAIL_0]');
    } finally {
      if (saved.userData === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
      else process.env.INTERPRETER_USER_DATA_DIR = saved.userData;
      if (saved.hub === undefined) delete process.env.HF_HUB_CACHE;
      else process.env.HF_HUB_CACHE = saved.hub;
    }
  });

  test('a blocked turn leaves no provisional rehydration map behind', async () => {
    const ws = workspace(true);
    let calls = 0;
    const deps = {
      ...cabinetDeps,
      isNerReady: () => true,
      detectNer: async () => {
        calls += 1;
        if (calls > 1) throw new Error('daemon died between the two passes');
        return [];
      },
    };
    await expect(
      redactOutboundTurnInput(
        { message: `Mail ${PROBE_EMAIL}`, system: 'You help Jane Doe' },
        { workspacePath: ws, threadKey: 'pending-turn-1', provisionalKey: true },
        deps,
      ),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(getRuntimeRehydrationMap('pending-turn-1')).toEqual({});
  });

  test('a blocked turn on an existing thread keeps that thread map', async () => {
    const ws = workspace(true);
    mergeRuntimeRehydrationMap('thread-keep', { '[NAME_0]': 'Jane Doe' });
    await expect(
      redactOutboundTurnInput(
        { message: 'x', system: 'y' },
        { workspacePath: ws, threadKey: 'thread-keep' },
        cabinetDeps,
      ),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(getRuntimeRehydrationMap('thread-keep')).toEqual({ '[NAME_0]': 'Jane Doe' });
  });

  test('refuses the turn when only the custom instructions remain to check', async () => {
    const ws = workspace(true);
    let calls = 0;
    const deps = {
      ...cabinetDeps,
      isNerReady: () => true,
      detectNer: async () => {
        calls += 1;
        if (calls > 1) throw new Error('daemon died before the custom instructions');
        return [];
      },
      loadCustomInstructions: async () => 'Always cc Jane Doe',
    };
    await expect(
      redactOutboundTurnInput(
        { message: `Mail ${PROBE_EMAIL}` },
        { workspacePath: ws, threadKey: 'pending-turn-ci', provisionalKey: true },
        deps,
      ),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(getRuntimeRehydrationMap('pending-turn-ci')).toEqual({});
  });

  test('refuses a turn with no free text (skills only) when NER is down', async () => {
    // Nothing to redact means no detector call: without a probe the turn
    // would start and native runtime tools could read safe/ files.
    blocks.length = 0;
    await expect(
      redactOutboundTurnInput(
        { message: '' },
        { workspacePath: workspace(true), threadKey: 'pending-empty', provisionalKey: true },
        cabinetDeps,
      ),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    expect(blocks).toEqual(['outbound']);
  });

  test('a turn with no free text starts when NER runs', async () => {
    const result = await redactOutboundTurnInput(
      { message: '' },
      { workspacePath: workspace(true), threadKey: 'pending-empty-ok', provisionalKey: true },
      { ...cabinetDeps, isNerReady: () => true, detectNer: async () => [] },
    );
    expect(result.message).toBe('');
    expect(getRuntimeRehydrationMap('pending-empty-ok')).toEqual({});
  });

  test('assertCabinetTurnAllowed probes the detector only in armed cabinet mode', async () => {
    let probes = 0;
    const detectNer = async () => { probes += 1; return []; };
    await assertCabinetTurnAllowed({ workspacePath: workspace(true) }, { ...cabinetDeps, isNerReady: () => true, detectNer });
    await assertCabinetTurnAllowed({ workspacePath: workspace(true) }, { ...stubDeps, isNerReady: () => true, detectNer });
    await assertCabinetTurnAllowed({ workspacePath: workspace(false) }, { ...cabinetDeps, isNerReady: () => true, detectNer });
    expect(probes).toBe(1);
    await expect(
      assertCabinetTurnAllowed({ workspacePath: workspace(true) }, {
        ...cabinetDeps,
        isNerReady: () => true,
        detectNer: async () => { throw new Error('daemon down'); },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
    // An unknown workspace fails closed, like every other gate.
    await expect(assertCabinetTurnAllowed({ workspacePath: null }, cabinetDeps))
      .rejects.toBeInstanceOf(DetectionUnavailableError);
  });

  test('a failing audit write never unblocks', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, {
        ...cabinetDeps,
        recordBlock: async () => { throw new Error('disk full'); },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });
});
