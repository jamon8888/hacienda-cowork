/**
 * Workspace Search Tool
 *
 * Agent-callable builtin that searches the workspace corpus (code, docs, notes)
 * via basemind's hybrid BM25+RRF+rerank search.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  basemindSearchCode,
  basemindSearchDocuments,
  type SearchHit,
  type DocumentSearchHit,
} from '../../../handlers/search';
import { isDaemonRunning } from '../../../utils/basemindManager';
import { checkFileAccessPermissionAsync } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { findSafeWorkspaceForCwd, isInsideSafeMirror } from '../../../utils/safeWorkspace';

/**
 * basemind indexes the whole workspace, so a hit's `path` can name anything in
 * it — not just what the calling agent is scoped to. The declarative
 * `fileAccess`/`pathArg` mechanism (see filesystemBoundary.ts) only checks
 * arguments the model passed in against the workspace boundary; it has no way
 * to filter a tool's *return value*, and `query` is a search string, not a
 * path, so pointing `pathArg` at it would be a no-op at best. Filtering has to
 * happen here, the same way `vaultTool.ts` filters `VaultSnapshot.notes`.
 */
/**
 * In a Safe workspace the conversation searches the redacted mirror only
 * (integration spec §6): a hit on an original names a file the agent cannot
 * open and whose line numbers do not match its mirror, so it is dropped. The
 * mirror files are indexed themselves (safe-sync rescans them).
 */
export function keepMirrorHitsInSafeWorkspace<T extends { path: string }>(
  hits: T[],
  workspace: string | null,
): T[] {
  const safeWorkspace = findSafeWorkspaceForCwd(workspace);
  if (!safeWorkspace) return hits;
  return hits.filter((hit) => isInsideSafeMirror(safeWorkspace, hit.path));
}

async function filterHitsByAgentScope<T extends { path: string }>(
  hits: T[],
  agentId: string | undefined,
  workspace: string | null,
): Promise<T[]> {
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
      tier: {
        type: 'string',
        enum: ['code', 'documents'],
        description:
          'Search tier. "code" searches the code graph (default). "documents" searches the documents store (PDFs, Office files, HTML, safe/ mirrors).',
        default: 'code',
      },
      lane: {
        type: 'string',
        enum: ['semantic', 'keyword', 'hybrid'],
        description:
          'Retrieval lane, code tier only. "hybrid" combines BM25 + vector + reranker (default). "semantic" is vector-only. "keyword" is BM25-only. The documents tier picks its own lane from the workspace index configuration and ignores this argument.',
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
      const tier = args.tier === 'documents' ? 'documents' : 'code';
      const workspace = context?.workspace ?? getCurrentWorkspace();

      // The two tiers return different hit shapes and different lane vocabularies,
      // so they are queried and rendered separately rather than merged into one
      // union. `lane` reaches basemind's code tier only; the documents tier has no
      // `lane` field (see `basemindSearchDocuments`).
      let hits: Array<SearchHit | DocumentSearchHit>;
      let elapsedUs: number;
      let resultQuery: string;
      let degraded = '';

      if (tier === 'documents') {
        const result = await basemindSearchDocuments({
          query,
          limit: typeof args.limit === 'number' ? args.limit : 10,
        });
        hits = result.hits;
        elapsedUs = result.elapsedUs;
        resultQuery = result.query;
      } else {
        const result = await basemindSearchCode({
          query,
          limit: typeof args.limit === 'number' ? args.limit : 10,
          lane: args.lane || 'hybrid',
        });
        hits = result.hits;
        elapsedUs = result.elapsedUs;
        resultQuery = result.query;
        if (result.degradedLanes.length > 0) {
          degraded = `\nDegraded lanes: ${result.degradedLanes.join(', ')}${
            result.degradedReason ? ` (${result.degradedReason})` : ''
          }`;
        }
      }

      // Both post-filters key on `hit.path`, so a tier change does not widen what
      // the agent can read: in a Safe workspace only `safe/` mirror hits survive.
      hits = keepMirrorHitsInSafeWorkspace(hits, workspace);
      hits = await filterHitsByAgentScope(hits, context?.agentId, workspace);

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No results for "${resultQuery}". Try a different query or lane.`,
            },
          ],
          isError: false,
        };
      }

      // A document hit has no symbol, kind, language or line range — those are
      // code-tier columns. It is addressed by its byte span instead, which is
      // what `safe/` mirror prose needs.
      const lines = hits.map((hit, i) => {
        if (tier === 'documents') {
          const docHit = hit as DocumentSearchHit;
          const parts = [
            `[${i + 1}] ${docHit.path}#${docHit.byteStart}-${docHit.byteEnd}`,
            docHit.mimeType && `mime: ${docHit.mimeType}`,
            docHit.rerankScore !== undefined && `rerank: ${docHit.rerankScore.toFixed(3)}`,
          ].filter(Boolean);
          return parts.join(' | ');
        }
        const codeHit = hit as SearchHit;
        const parts = [
          `[${i + 1}] ${codeHit.path}:${codeHit.lineStart}–${codeHit.lineEnd}`,
          codeHit.symbol && `symbol: ${codeHit.symbol}`,
          codeHit.kind && `kind: ${codeHit.kind}`,
          codeHit.lang && `lang: ${codeHit.lang}`,
          codeHit.score !== undefined && `score: ${codeHit.score.toFixed(3)}`,
          codeHit.rerankScore !== undefined && `rerank: ${codeHit.rerankScore.toFixed(3)}`,
        ].filter(Boolean);
        return parts.join(' | ');
      });

      return {
        content: [
          {
            type: 'text',
            text: `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${resultQuery}" (${(elapsedUs / 1000).toFixed(0)}ms):\n${lines.join('\n')}${degraded}`,
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
