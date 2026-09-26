import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * Seams F+H: the tool is registered under the documented name, degrades when
 * the daemon is down, and filters hits to the agent's file scope (AGENTS.md:
 * file permissions are per agent).
 */

let daemonRunning = true;
let searchHits: Array<Record<string, unknown>> = [];
let searchQuery = '';
let accessAllowed = true;

mock.module('../../../handlers/search', () => ({
  basemindSearchCode: async (params: { query: string }) => {
    searchQuery = params.query;
    return {
      query: params.query,
      budgeted: false,
      hits: searchHits,
      degradedLanes: [],
      elapsedUs: 1500,
    };
  },
}));

mock.module('../../../utils/basemindManager', () => ({
  isDaemonRunning: () => daemonRunning,
}));

mock.module('../../../utils/permissions', () => ({
  checkFileAccessPermissionAsync: async () => accessAllowed,
}));

async function loadTool() {
  return import('./workspaceSearchTool');
}

afterEach(() => {
  daemonRunning = true;
  searchHits = [];
  searchQuery = '';
  accessAllowed = true;
});

describe('workspaceSearchTool', () => {
  test('is named interpreter_workspace_search and requires query', async () => {
    const { workspaceSearchTool } = await loadTool();
    expect(workspaceSearchTool.name).toBe('interpreter_workspace_search');
    expect(workspaceSearchTool.inputSchema.required).toEqual(['query']);
    expect(workspaceSearchTool.annotations?.readOnlyHint).toBe(true);
  });

  test('returns a clear error when the query is missing', async () => {
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({});
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('query is required');
  });

  test('degrades with an actionable message when the daemon is down', async () => {
    daemonRunning = false;
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({ query: 'anything' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('basemind daemon is not running');
  });

  test('formats ranked hits', async () => {
    searchHits = [
      {
        path: 'src/a.ts',
        chunkId: 'c1',
        symbol: 'foo',
        kind: 'func',
        lang: 'ts',
        lineStart: 1,
        lineEnd: 4,
        byteStart: 0,
        byteEnd: 10,
        matchedLanes: ['vector'],
        score: 0.9,
      },
    ];
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({ query: 'foo', limit: 3 });
    expect(result.isError).toBe(false);
    const text = String(result.content[0]?.text);
    expect(text).toContain('1 hit');
    expect(text).toContain('src/a.ts:1–4');
    expect(searchQuery).toBe('foo');
  });

  test('filters hits to the agent file scope when context.agentId is set', async () => {
    searchHits = [
      { path: 'src/ok.ts', chunkId: 'a', symbol: '', kind: '', lang: '', lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 1, matchedLanes: [] },
      { path: 'src/denied.ts', chunkId: 'b', symbol: '', kind: '', lang: '', lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 1, matchedLanes: [] },
    ];
    accessAllowed = false;
    mock.module('../../../utils/permissions', () => ({
      checkFileAccessPermissionAsync: async (_id: string, filePath: string) => filePath.endsWith('ok.ts'),
    }));
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler(
      { query: 'x' },
      { agentId: 'agent-scoped', workspace: null } as never,
    );
    expect(result.isError).toBe(false);
    const text = String(result.content[0]?.text);
    expect(text).toContain('src/ok.ts');
    expect(text).not.toContain('src/denied.ts');
  });
});
