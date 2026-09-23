import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Seam C: basemindSearchCode validates input and maps snake_case hits to the
 * camelCase IPC contract. Daemon is mocked — no network.
 */

let daemonRunning = true;
let lastCall: { method: string; params: Record<string, unknown> } | null = null;
let mcpResult: unknown = null;
let mcpError: Error | null = null;

mock.module('../utils/basemindManager', () => ({
  isDaemonRunning: () => daemonRunning,
  mcpRequest: async (method: string, params: Record<string, unknown>) => {
    lastCall = { method, params };
    if (mcpError) throw mcpError;
    return mcpResult;
  },
}));

mock.module('./rerankerPreference', () => ({
  getRerankerEnabled: async () => false,
}));

async function loadSearch() {
  return import('./search');
}

beforeEach(() => {
  daemonRunning = true;
  lastCall = null;
  mcpError = null;
  mcpResult = {
    structuredContent: {
      query: 'foo',
      budgeted: false,
      hits: [
        {
          path: 'src/a.ts',
          chunk_id: 'c1',
          symbol: 'foo',
          kind: 'func',
          lang: 'ts',
          line_start: 3,
          line_end: 9,
          byte_start: 10,
          byte_end: 99,
          matched_lanes: ['vector', 'keyword'],
          keyword_rank: 2,
          vector_rank: 1,
          rerank_score: 0.5,
        },
      ],
      degraded_lanes: [],
      elapsed_us: 1200,
    },
  };
});

afterEach(() => {
  lastCall = null;
});

describe('basemindSearchCode', () => {
  test('throws when the daemon is not running', async () => {
    daemonRunning = false;
    const { basemindSearchCode } = await loadSearch();
    await expect(basemindSearchCode({ query: 'x' })).rejects.toThrow('basemind daemon not running');
  });

  test('rejects an empty query', async () => {
    const { basemindSearchCode } = await loadSearch();
    await expect(basemindSearchCode({ query: '   ' })).rejects.toThrow('non-empty');
  });

  test('rejects a non-positive limit', async () => {
    const { basemindSearchCode } = await loadSearch();
    await expect(basemindSearchCode({ query: 'x', limit: 0 })).rejects.toThrow('positive');
  });

  test('calls the pin-correct code tool with mode=semantic, format=json, and lane sibling', async () => {
    const { basemindSearchCode } = await loadSearch();
    await basemindSearchCode({ query: 'find parser', lane: 'hybrid', limit: 5 });
    expect(lastCall).not.toBeNull();
    expect(lastCall!.method).toBe('tools/call');
    expect(lastCall!.params.name).toBe('code');
    const args = lastCall!.params.arguments as Record<string, unknown>;
    expect(args.mode).toBe('semantic');
    expect(args.format).toBe('json');
    expect(args.query).toBe('find parser');
    expect(args.lane).toBe('hybrid');
    expect(args.limit).toBe(5);
    // pin field names via aliases — not subcommand/root
    expect(args).not.toHaveProperty('subcommand');
    expect(args).not.toHaveProperty('root');
  });

  test('maps snake_case hits to the camelCase response contract', async () => {
    const { basemindSearchCode } = await loadSearch();
    const result = await basemindSearchCode({ query: 'foo' });
    expect(result.query).toBe('foo');
    expect(result.budgeted).toBe(false);
    expect(result.elapsedUs).toBe(1200);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      path: 'src/a.ts',
      chunkId: 'c1',
      lineStart: 3,
      lineEnd: 9,
      matchedLanes: ['vector', 'keyword'],
      keywordRank: 2,
      vectorRank: 1,
      rerankScore: 0.5,
    });
  });

  test('rejects a payload whose hits is not an array', async () => {
    mcpResult = {
      structuredContent: { query: 'q', budgeted: false, hits: 'nope', degraded_lanes: [], elapsed_us: 1 },
    };
    const { basemindSearchCode } = await loadSearch();
    await expect(basemindSearchCode({ query: 'q' })).rejects.toThrow('hits is');
  });
});
