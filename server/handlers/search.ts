import { isDaemonRunning, mcpRequest } from '../utils/basemindManager';

export interface SearchHit {
  path: string;
  chunkId: string;
  symbol: string;
  kind: string;
  lang: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  distance?: number;
  score?: number;
  rerankScore?: number;
  matchedLanes: string[];
  keywordRank?: number;
  vectorRank?: number;
  exactRank?: number;
}

export interface SearchCodeParams {
  query: string;
  limit?: number;
  maxTokens?: number;
  /** Unused by `basemindSearchCode`: the outbound call always pins `format: 'json'`. */
  format?: string;
  lane?: string;
  rerankerEnabled?: boolean;
  rerankerPreset?: string;
  rerankerTopK?: number;
}

export interface SearchCodeResponse {
  query: string;
  budgeted: boolean;
  hits: SearchHit[];
  degradedLanes: string[];
  degradedReason?: string;
  elapsedUs: number;
}

function mapSearchHit(hit: unknown): SearchHit {
  const h = hit as Record<string, unknown>;
  return {
    path: String(h.path ?? ''),
    chunkId: String(h.chunk_id ?? ''),
    symbol: String(h.symbol ?? ''),
    kind: String(h.kind ?? ''),
    lang: String(h.lang ?? ''),
    lineStart: Number(h.line_start ?? 0),
    lineEnd: Number(h.line_end ?? 0),
    byteStart: Number(h.byte_start ?? 0),
    byteEnd: Number(h.byte_end ?? 0),
    distance: h.distance !== undefined && h.distance !== null ? Number(h.distance) : undefined,
    score: h.score !== undefined && h.score !== null ? Number(h.score) : undefined,
    rerankScore: h.rerank_score !== undefined && h.rerank_score !== null ? Number(h.rerank_score) : undefined,
    matchedLanes: Array.isArray(h.matched_lanes) ? h.matched_lanes.map(String) : [],
    keywordRank: h.keyword_rank !== undefined && h.keyword_rank !== null ? Number(h.keyword_rank) : undefined,
    vectorRank: h.vector_rank !== undefined && h.vector_rank !== null ? Number(h.vector_rank) : undefined,
    exactRank: h.exact_rank !== undefined && h.exact_rank !== null ? Number(h.exact_rank) : undefined,
  };
}

export async function basemindSearchCode(params: {
  query: string;
  limit?: number;
  maxTokens?: number;
  format?: string;
  lane?: string;
  rerankerEnabled?: boolean;
  rerankerPreset?: string;
  rerankerTopK?: number;
}): Promise<{
  query: string;
  budgeted: boolean;
  hits: Array<{
    path: string;
    chunkId: string;
    symbol: string;
    kind: string;
    lang: string;
    lineStart: number;
    lineEnd: number;
    byteStart: number;
    byteEnd: number;
    distance?: number;
    score?: number;
    rerankScore?: number;
    matchedLanes: string[];
    keywordRank?: number;
    vectorRank?: number;
    exactRank?: number;
  }>;
  degradedLanes: string[];
  degradedReason?: string;
  elapsedUs: number;
}> {
  if (!isDaemonRunning()) {
    throw new Error('basemind daemon not running');
  }

  if (!params.query || !params.query.trim()) {
    throw new Error('query must be a non-empty string');
  }
  if (params.limit !== undefined && (typeof params.limit !== 'number' || params.limit <= 0)) {
    throw new Error('limit must be a positive number');
  }
  if (params.maxTokens !== undefined && (typeof params.maxTokens !== 'number' || params.maxTokens <= 0)) {
    throw new Error('maxTokens must be a positive number');
  }
  if (params.rerankerTopK !== undefined && (typeof params.rerankerTopK !== 'number' || params.rerankerTopK <= 0)) {
    throw new Error('rerankerTopK must be a positive number');
  }

  const args: Record<string, unknown> = {
    query: params.query,
  };

  if (params.limit !== undefined) args.limit = params.limit;  if (params.maxTokens !== undefined) args.max_tokens = params.maxTokens;
  // `lane` is a sibling field of `mode` on basemind's CodeParams, not an
  // alternate value for it — `mode` selects the domain operation (symbols,
  // grep, semantic, ...) and only applies to the "semantic" mode. Folding it
  // into `mode` (as a prior commit here did) sends basemind an invalid mode
  // enum value ("keyword", "hybrid") for anything but the default lane.
  if (params.lane !== undefined) args.lane = params.lane;
  // Explicit per-call value wins; otherwise the stored toggle (override or
  // per-machine default, never without the downloaded model).
  if (params.rerankerEnabled !== undefined) {
    args.reranker_enabled = params.rerankerEnabled;
  } else {
    const { getRerankerEnabled } = await import('./rerankerPreference');
    args.reranker_enabled = await getRerankerEnabled();
  }
  if (params.rerankerPreset !== undefined) args.reranker_preset = params.rerankerPreset;
  if (params.rerankerTopK !== undefined) args.reranker_top_k = params.rerankerTopK;

  const result = await mcpRequest('tools/call', {
    name: 'code',
    arguments: {
      mode: 'semantic',
      // Pinned regardless of `params.format`: basemind's `wants_toon` falls back
      // to the caller's local `[documents.output] format` config when no format
      // is given, which would silently swap the payload for TOON text on some
      // installs. This handler only ever parses JSON.
      format: 'json',
      ...args,
    },
  });

  // rmcp's CallToolResult carries the typed payload under `structuredContent`
  // (SEP-2106) — `code`'s handler returns `CallToolResult::structured(value)`,
  // never a bare object. `mcpRequest` hands back the JSON-RPC `result` as-is,
  // so the tool payload has to be unwrapped here. Fall back to parsing the
  // mirrored text block for a server that only populates `content`.
  const envelope = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  const payload = envelope.structuredContent
    ?? (() => {
      const text = envelope.content?.find((block) => block.type === 'text')?.text;
      if (text === undefined) {
        throw new Error('basemind search result carried neither structuredContent nor a text content block');
      }
      return JSON.parse(text);
    })();

  const response = payload as {
    query: string;
    budgeted: boolean;
    hits: Array<Record<string, unknown>>;
    degraded_lanes: string[];
    degraded_reason?: string;
    elapsed_us: number;
  };

  if (!Array.isArray(response.hits)) {
    throw new Error(`basemind search returned invalid payload: hits is ${typeof response.hits}, expected array`);
  }

  return {
    query: response.query,
    budgeted: response.budgeted,
    hits: (response.hits ?? []).map(mapSearchHit),
    degradedLanes: response.degraded_lanes ?? [],
    degradedReason: response.degraded_reason,
    elapsedUs: response.elapsed_us,
  };
}