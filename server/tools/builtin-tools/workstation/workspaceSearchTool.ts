/**
 * Workspace Search Tool
 *
 * Agent-callable builtin that searches the workspace corpus (code, docs, notes)
 * via basemind's hybrid BM25+RRF+rerank search.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { basemindSearchCode, type SearchHit } from '../../../handlers/search';
import { isDaemonRunning } from '../../../utils/basemindManager';
import { checkFileAccessPermissionAsync } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

/**
 * basemind indexes the whole workspace, so a hit's `path` can name anything in
 * it — not just what the calling agent is scoped to. The declarative
 * `fileAccess`/`pathArg` mechanism (see filesystemBoundary.ts) only checks
 * arguments the model passed in against the workspace boundary; it has no way
 * to filter a tool's *return value*, and `query` is a search string, not a
 * path, so pointing `pathArg` at it would be a no-op at best. Filtering has to
 * happen here, the same way `vaultTool.ts` filters `VaultSnapshot.notes`.
 */
async function filterHitsByAgentScope(
  hits: SearchHit[],
  agentId: string | undefined,
  workspace: string | null,
): Promise<SearchHit[]> {
  if (!agentId) return hits;
  const accessible = await Promise.all(
    hits.map((hit) => checkFileAccessPermissionAsync(agentId, hit.path, 'read', workspace)),
  );
  return hits.filter((_, i) => accessible[i]);
}

export const workspaceSearchTool: BuiltinToolDefinition = {
  name: 'interpreter_workspace_search',
  description:
    'Search the workspace corpus — code, documents, and notes — using semantic, keyword, or hybrid search. Returns ranked hits with file path, symbol, kind, language, and line range. Use this to find relevant code, documentation, or notes before reading or editing files.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of hits to return (default: 10).',
      },
      lane: {
        type: 'string',
        enum: ['semantic', 'keyword', 'hybrid'],
        description: 'Search lane. "hybrid" combines BM25 + vector + reranker (default). "semantic" is vector-only. "keyword" is BM25-only.',
      },
    },
    required: ['query'],
  },
  annotations: {
    readOnlyHint: true,
  },
  // No `fileAccess` declaration: the model-supplied argument here (`query`) is
  // a search string, not a path, so the boundary mechanism has nothing to
  // check on the way in. The scope check that matters runs on the way out —
  // see `filterHitsByAgentScope` above.
  handler: async (args, context) => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return {
        content: [{ type: 'text', text: 'Error: query is required.' }],
        isError: true,
      };
    }

    if (!isDaemonRunning()) {
      return {
        content: [
          {
            type: 'text',
            text: 'basemind daemon is not running. Workspace search is unavailable — start the daemon or enable it in Settings.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await basemindSearchCode({
        query,
        limit: typeof args.limit === 'number' ? args.limit : 10,
        lane: typeof args.lane === 'string' ? args.lane : 'hybrid',
      });

      const workspace = context?.workspace ?? getCurrentWorkspace();
      const hits = await filterHitsByAgentScope(result.hits, context?.agentId, workspace);

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No results for "${result.query}". Try a different query or lane.`,
            },
          ],
          isError: false,
        };
      }

      const lines = hits.map((hit, i) => {
        const parts = [
          `[${i + 1}] ${hit.path}:${hit.lineStart}–${hit.lineEnd}`,
          hit.symbol && `symbol: ${hit.symbol}`,
          hit.kind && `kind: ${hit.kind}`,
          hit.lang && `lang: ${hit.lang}`,
          hit.score !== undefined && `score: ${hit.score.toFixed(3)}`,
          hit.rerankScore !== undefined && `rerank: ${hit.rerankScore.toFixed(3)}`,
        ].filter(Boolean);
        return parts.join(' | ');
      });

      const degraded = result.degradedLanes.length > 0
        ? `\nDegraded lanes: ${result.degradedLanes.join(', ')}${result.degradedReason ? ` (${result.degradedReason})` : ''}`
        : '';

      return {
        content: [
          {
            type: 'text',
            text: `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${result.query}" (${(result.elapsedUs / 1000).toFixed(0)}ms):\n${lines.join('\n')}${degraded}`,
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Workspace search failed: ${error?.message ?? String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
};
