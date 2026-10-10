import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Seams F+H: the tool is registered under the documented name, degrades when
 * the daemon is down, and filters hits to the agent's file scope (AGENTS.md:
 * file permissions are per agent).
 */

let daemonRunning = true;
let searchHits: Array<Record<string, unknown>> = [];
let searchQuery = '';
let searchLane: string | undefined;
let searchLimit: number | undefined;
let accessAllowed = true;

mock.module('../../../handlers/search', () => ({
  basemindSearchCode: async (params: { query: string; lane?: string; limit?: number }) => {
    searchQuery = params.query;
    searchLane = params.lane;
    searchLimit = params.limit;
    return {
      query: params.query,
      budgeted: false,
      hits: searchHits,
      degradedLanes: [],
      elapsedUs: 1500,
    };
  },
  basemindSearchDocuments: async (params: { query: string; limit?: number }) => {
    searchQuery = params.query;
    searchLimit = params.limit;
    // No `degradedLanes`: `SearchDocumentsResponse` has no such field.
    return {
      query: params.query,
      budgeted: false,
      hits: searchHits,
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
  searchLane = undefined;
  searchLimit = undefined;
  accessAllowed = true;
  // Reset the permissions mock that may have been overridden by a previous test
  mock.module('../../../utils/permissions', () => ({
    checkFileAccessPermissionAsync: async () => accessAllowed,
  }));
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

  test('keeps only mirror hits in a Safe workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'search-safe-'));
    try {
      mkdirSync(join(workspace, 'safe'));
      const hit = (path: string) => ({ path, chunkId: path, symbol: '', kind: '', lang: '', lineStart: 1, lineEnd: 2, byteStart: 0, byteEnd: 1, matchedLanes: [] });
      searchHits = [hit('contrat.docx'), hit('safe/contrat.docx.md'), hit(join(workspace, 'note.pdf'))];
      const { workspaceSearchTool } = await loadTool();
      const result = await workspaceSearchTool.handler({ query: 'x' }, { workspace } as never);
      const text = String(result.content[0]?.text);
      expect(text).toContain('safe/contrat.docx.md');
      expect(text).not.toContain('contrat.docx:');
      expect(text).not.toContain('note.pdf');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('documents tier searches the documents store and renders byte spans', async () => {
    searchHits = [
      {
        path: 'safe/contract.pdf.md',
        chunkIdx: 0,
        text: 'Contract text',
        mimeType: 'application/pdf',
        byteStart: 0,
        byteEnd: 100,
        distance: 0.15,
        rerankScore: 0.92,
      },
    ];
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({ query: 'contract', tier: 'documents', limit: 5 });
    expect(result.isError).toBe(false);
    const text = String(result.content[0]?.text);
    expect(text).toContain('safe/contract.pdf.md#0-100');
    expect(text).toContain('mime: application/pdf');
    expect(text).toContain('rerank: 0.920');
    expect(searchQuery).toBe('contract');
    expect(searchLimit).toBe(5);
  });

  test('documents tier never renders the code-tier line range', async () => {
    // A document hit carries no line numbers; printing `:1-2` for one would send
    // the agent to read at coordinates that do not exist in its mirror.
    searchHits = [
      {
        path: 'safe/report.pdf.md',
        chunkIdx: 3,
        text: 'Report text',
        mimeType: 'application/pdf',
        byteStart: 120,
        byteEnd: 400,
      },
    ];
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({ query: 'report', tier: 'documents' });
    const text = String(result.content[0]?.text);
    expect(text).toContain('safe/report.pdf.md#120-400');
    expect(text).not.toContain('symbol:');
    expect(text).not.toContain('lang:');
  });

  test('lane reaches the code tier but is not offered as a documents concept', async () => {
    const { workspaceSearchTool } = await loadTool();
    searchHits = [{ path: 'src/a.ts', chunkId: 'c', symbol: 'f', kind: 'func', lang: 'ts', lineStart: 1, lineEnd: 2, byteStart: 0, byteEnd: 4 }];
    await workspaceSearchTool.handler({ query: 'x', tier: 'code', lane: 'keyword' });
    expect(searchLane).toBe('keyword');

    // `exact` is not a lane basemind's documents tier has, so it is not in the enum.
    expect((workspaceSearchTool.inputSchema.properties as Record<string, { enum?: string[] }>).lane.enum).toEqual([
      'semantic',
      'keyword',
      'hybrid',
    ]);
  });

  test('documents tier filters hits to Safe workspace mirrors', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'search-safe-doc-'));
    try {
      mkdirSync(join(workspace, 'safe'));
      searchHits = [
        {
          path: 'safe/report.pdf.md',
          chunkIdx: 0,
          text: 'Report',
          mimeType: 'application/pdf',
          byteStart: 0,
          byteEnd: 50,
        },
        {
          path: 'external.docx',
          chunkIdx: 0,
          text: 'External',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byteStart: 0,
          byteEnd: 50,
        },
      ];
      const { workspaceSearchTool } = await loadTool();
      const result = await workspaceSearchTool.handler({ query: 'x', tier: 'documents' }, { workspace } as never);
      const text = String(result.content[0]?.text);
      expect(text).toContain('safe/report.pdf.md');
      expect(text).not.toContain('external.docx');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('documents tier filters by agent scope when context.agentId is set', async () => {
    searchHits = [
      {
        path: 'safe/allowed.pdf.md',
        chunkIdx: 0,
        text: 'Allowed',
        mimeType: 'application/pdf',
        byteStart: 0,
        byteEnd: 50,
      },
      {
        path: 'safe/denied.pdf.md',
        chunkIdx: 0,
        text: 'Denied',
        mimeType: 'application/pdf',
        byteStart: 0,
        byteEnd: 50,
      },
    ];
    mock.module('../../../utils/permissions', () => ({
      checkFileAccessPermissionAsync: async (_id: string, filePath: string) => filePath.endsWith('allowed.pdf.md'),
    }));
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler(
      { query: 'x', tier: 'documents' },
      { agentId: 'agent-scoped', workspace: null } as never,
    );
    expect(result.isError).toBe(false);
    const text = String(result.content[0]?.text);
    expect(text).toContain('safe/allowed.pdf.md');
    expect(text).not.toContain('safe/denied.pdf.md');
  });

  test('code tier still works with tier: code (default)', async () => {
    searchHits = [
      {
        path: 'src/main.ts',
        chunkId: 'c1',
        symbol: 'main',
        kind: 'func',
        lang: 'ts',
        lineStart: 10,
        lineEnd: 20,
        byteStart: 0,
        byteEnd: 100,
        matchedLanes: ['vector'],
        score: 0.9,
      },
    ];
    const { workspaceSearchTool } = await loadTool();
    const result = await workspaceSearchTool.handler({ query: 'main', tier: 'code' });
    expect(result.isError).toBe(false);
    const text = String(result.content[0]?.text);
    expect(text).toContain('src/main.ts:10–20');
    expect(text).toContain('symbol: main');
    expect(text).toContain('kind: func');
    expect(text).toContain('lang: ts');
  });
});
