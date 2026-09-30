import { describe, expect, mock, test } from 'bun:test';

/**
 * Regression guard for the silent-degradation bug: `ToolManager.callTool`
 * throws `MCP tool calls require a Codex thread context` when no threadId is
 * present, the composer catches that and falls back to regex, so NER detection
 * never ran and nothing surfaced the failure.
 *
 * This is the only file that mocks `./appMcpThread`: a second `mock.module`
 * registration for the same module elsewhere collided with it across files
 * in the same `bun test --isolate` batch and made `appMcpThread.test.ts`
 * flake against a mocked module instead of the real one. Add scenarios that
 * need this pair of mocks here rather than re-registering them.
 */
const callToolCalls: Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolContext: { threadId?: string } | undefined;
}> = [];

// Mutable per-test response: the mocked `callTool` is registered once for the
// whole file, so each test sets this before calling `detectPii` rather than
// the mock varying by argument.
let nextDetections: Array<{ category: string; start: number; end: number; text: string; confidence: number }> = [
  { category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 0.9 },
];

// Value of `ner_ran` in the mocked payload; undefined omits it (older daemon).
let nextNerRan: boolean | undefined;

// When set, the mocked tool answers with an error payload instead of throwing.
let nextIsError = false;

mock.module('../tools/toolManager', () => ({
  ToolManager: class {
    async callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      _saveToDisk?: boolean,
      _callerTabId?: string,
      toolContext?: { threadId?: string },
    ) {
      callToolCalls.push({ serverId, toolName, args, toolContext });
      if (nextIsError) return { isError: true, content: [{ type: 'text', text: 'redact_text failed' }] };
      return {
        structuredContent: {
          result: {
            redacted_text: 'Call [EMAIL_0]',
            rehydration_map: { '[EMAIL_0]': 'john@example.com' },
            detections: nextDetections,
            ...(nextNerRan === undefined ? {} : { ner_ran: nextNerRan }),
          },
        },
      };
    }
  },
}));

mock.module('./appMcpThread', () => ({
  getAppMcpOwnerThreadId: async () => 'mcp-owner-thread-1',
  resetAppMcpOwnerThread: () => {},
}));

describe('detectPii thread context', () => {
  test('passes an owner thread so the MCP call is not rejected', async () => {
    nextDetections = [{ category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 0.9 }];
    const { piiDetectionService } = await import('./piiDetection');
    const detections = await piiDetectionService.detectPii('Call john@example.com');

    expect(callToolCalls).toHaveLength(1);
    expect(callToolCalls[0].serverId).toBe('basemind');
    expect(callToolCalls[0].toolName).toBe('redact_text');
    expect(callToolCalls[0].toolContext?.threadId).toBe('mcp-owner-thread-1');

    // The detections have to survive the round trip: an empty result here is
    // indistinguishable from the regex-only fallback the bug produced.
    expect(detections).toHaveLength(1);
    expect(detections[0].text).toBe('john@example.com');
  });

  test('passes categories through to the tool call untouched', async () => {
    nextDetections = [];
    const { piiDetectionService } = await import('./piiDetection');
    await piiDetectionService.detectPii('text', { categories: ['email'] });
    expect(callToolCalls.at(-1)?.args.categories).toEqual(['email']);
  });
});

describe('detectPii error payloads', () => {
  test('throws on an isError result instead of reporting no detections', async () => {
    nextIsError = true;
    try {
      const { piiDetectionService } = await import('./piiDetection');
      await expect(piiDetectionService.detectPii('Jane Doe')).rejects.toThrow('redact_text failed');
    } finally {
      nextIsError = false;
    }
  });
});

describe('detectPii require_ner', () => {
  test('asks basemind to fail rather than degrade, only when requested', async () => {
    nextDetections = [];
    nextNerRan = true;
    const { piiDetectionService } = await import('./piiDetection');
    await piiDetectionService.detectPii('text');
    expect(callToolCalls.at(-1)?.args.require_ner).toBeUndefined();
    await piiDetectionService.detectPii('text', { requireNer: true });
    expect(callToolCalls.at(-1)?.args.require_ner).toBe(true);
  });

  test('throws when basemind reports that NER did not run', async () => {
    nextDetections = [];
    nextNerRan = false;
    try {
      const { piiDetectionService } = await import('./piiDetection');
      // Without the flag the degrade-to-pattern policy is unchanged.
      await expect(piiDetectionService.detectPii('Jane Doe')).resolves.toEqual([]);
      await expect(piiDetectionService.detectPii('Jane Doe', { requireNer: true })).rejects.toThrow('NER did not run');
    } finally {
      nextNerRan = undefined;
    }
  });

  test('an older daemon that omits ner_ran is not treated as a failure', async () => {
    nextDetections = [];
    nextNerRan = undefined;
    const { piiDetectionService } = await import('./piiDetection');
    await expect(piiDetectionService.detectPii('Jane Doe', { requireNer: true })).resolves.toEqual([]);
  });
});

describe('ner_model_dir wiring (GLiNER2 spec #37)', () => {
  test('detectPii and redactFile pass the candle-ready snapshot dir', async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;

    const base = mkdtempSync(path.join(tmpdir(), 'pii-args-'));
    const snapshot = path.join(
      base,
      'models--fastino--gliner2-privacy-filter-PII-multi',
      'snapshots',
      '36126f612f1f9e376dc2c25b297d827912effef4',
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, 'model.safetensors'), 'weights');
    const previous = process.env.HF_HUB_CACHE;
    process.env.HF_HUB_CACHE = base;
    try {
      const { piiDetectionService } = await import('./piiDetection');
      await piiDetectionService.detectPii('text');
      expect(callToolCalls.at(-1)?.args.ner_model_dir).toBe(snapshot);
      await piiDetectionService.redactFile('/tmp/some-file.txt');
      expect(callToolCalls.at(-1)?.args.ner_model_dir).toBe(snapshot);
    } finally {
      if (previous === undefined) delete process.env.HF_HUB_CACHE;
      else process.env.HF_HUB_CACHE = previous;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('basemind mcpRequest', () => {
  test('marks its calls app-internal so ToolManager hands back the raw result', async () => {
    const { setToolManager } = await import('../tools/toolManagerAccessor');
    const seen: unknown[][] = [];
    setToolManager({
      callTool: async (...args: unknown[]) => {
        seen.push(args);
        return { structuredContent: { hits: [] } };
      },
    } as any);
    const { mcpRequest } = await import('../utils/basemindManager');
    await mcpRequest('tools/call', { name: 'code', arguments: { mode: 'semantic' } });

    expect(seen).toHaveLength(1);
    const [serverId, toolName, , , , toolContext, , options] = seen[0];
    expect([serverId, toolName]).toEqual(['basemind', 'code']);
    expect(toolContext).toEqual({ threadId: 'mcp-owner-thread-1' });
    expect(options).toEqual({ appInternal: true });
  });
});
