import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  applyFileReadRedaction,
  clearRuntimeRehydrationMaps,
  deleteRuntimeRehydrationMap,
  getRuntimeRehydrationMap,
  maybeRedactOutboundText,
  maybeRedactToolResult,
} from './runtimeRedaction';

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
      { isNerReady: () => true, detectNer: () => nerGate },
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
