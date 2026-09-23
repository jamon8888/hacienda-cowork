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
      return {
        structuredContent: {
          result: {
            redacted_text: 'Call [EMAIL_0]',
            rehydration_map: { '[EMAIL_0]': 'john@example.com' },
            detections: nextDetections,
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
