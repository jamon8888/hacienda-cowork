import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveBasemindBinary } from '../utils/basemindManager';
import { isModelResourceReady, type ModelResource } from '../utils/hubCache';

const execFileAsync = promisify(execFile);

export type BasemindDownloadStage = 'embeddings' | 'reranker' | 'nerModel';

export interface BasemindDownloadProgress {
  stage: BasemindDownloadStage;
  progress: number;
  done: boolean;
  error?: string;
}

// Spec §9 order: preseed pinned weights first, embeddings warmup last.
const STAGES: Array<{ stage: BasemindDownloadStage; resource: ModelResource }> = [
  { stage: 'nerModel', resource: 'nerModel' },
  { stage: 'reranker', resource: 'reranker' },
  { stage: 'embeddings', resource: 'embeddings' },
];

const WARMUP_TIMEOUT_MS = 5 * 60_000;
const WARMUP_QUERY = 'quarterly report renewable energy';

/**
 * A tiny, throwaway workspace basemind is allowed to index for the sole
 * purpose of forcing its lazy model loaders to run. Seeded once with content
 * that exercises every lane a warmup call needs: an HTML "document" (for the
 * embeddings/NER document pipeline — plain .txt isn't a recognized document
 * MIME type and falls back to code parsing) and a source file (for `code
 * semantic`, which the reranker warmup runs through).
 *
 * Each call creates an isolated private temp dir (mkdtemp, 0700) so a
 * pre-existing /tmp path can't be used for symlink attacks. Caller must
 * remove it via cleanupTempDir in a finally block. No stage needs git:
 * reranker/NER are pre-seeded and embeddings warms via `memory documents`,
 * which keeps packaged builds git-free.
 */
async function ensureWarmupWorkspace(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'basemind-model-warmup-'));
  try {
    const docPath = path.join(dir, 'warmup.html');
    writeFileSync(
      docPath,
      '<html><body><p>Contact Jane Doe at jane.doe@example.com about the quarterly '
      + 'report on renewable energy adoption in rural communities.</p></body></html>\n',
    );
    const codePath = path.join(dir, 'warmup.js');
    writeFileSync(
      codePath,
      '// Sums renewable energy output for a quarterly report.\n'
      + 'function sumQuarterlyReport(values) {\n'
      + '  return values.reduce((total, value) => total + value, 0);\n'
      + '}\n'
      + 'module.exports = { sumQuarterlyReport };\n',
    );
    return dir;
  } catch (err) {
    cleanupTempDir(dir);
    throw err;
  }
}

function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function stageArgs(stage: BasemindDownloadStage, workspace: string): string[] {
  switch (stage) {
    case 'embeddings':
      return ['memory', 'documents', WARMUP_QUERY, '--root', workspace, '--limit', '1'];
    case 'reranker':
    case 'nerModel':
      throw new Error(`${stage} is pre-seeded directly, never warmed up`);
  }
}

/**
 * Run a one-shot basemind CLI command whose only purpose is to exercise the
 * lazy loader for one model family, so its first-use Hugging Face hub
 * download actually happens. basemind has no dedicated "download models"
 * command (confirmed: no models/warmup/pull subcommand exists), so this
 * piggybacks on the real commands documented to trigger it — `code semantic
 * --rerank`'s own help text states verbatim "first call downloads a model".
 * `BASEMIND_ALLOW_ANY_ROOT` is scoped to this one invocation via env — the
 * warmup workspace is a plain throwaway git repo, not a real project, and
 * would otherwise be refused as an accidentally-inherited scan root.
 * `BASEMIND_COMMS_DIR` points the warmup at a private comms socket so it
 * never collides with a user-running daemon (e.g. an editor-integrated
 * basemind of another version holding ~/.local/share/basemind/comms):
 * without isolation the warmup fails with "a previous/incompatible daemon
 * holds the socket" instead of downloading anything. Model downloads still
 * land in the shared Hugging Face hub cache — only the socket is isolated.
 */
async function runWarmup(binary: string, stage: BasemindDownloadStage, workspace: string, commsDir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(binary, stageArgs(stage, workspace), {
      env: { ...process.env, BASEMIND_ALLOW_ANY_ROOT: '1', BASEMIND_COMMS_DIR: commsDir },
      timeout: WARMUP_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    // Only SIGILL indicates the stock ONNX Runtime hitting a missing
    // instruction (AVX2 on pre-Haswell CPUs) — it leaves no stderr, so
    // surface a clear cause. SIGTERM is the warmup timeout, anything else
    // keeps the generic message.
    const signal = err && typeof err === 'object' && 'signal' in err
      ? (err as { signal?: unknown }).signal
      : undefined;
    if (signal === 'SIGILL') {
      return { ok: false, error: `warmup command killed by SIGILL — this CPU may lack AVX2, which the bundled ONNX Runtime requires` };
    }
    if (signal === 'SIGTERM') {
      return { ok: false, error: `warmup command timed out after ${WARMUP_TIMEOUT_MS / 1000}s` };
    }
    if (signal) {
      return { ok: false, error: `warmup command killed by ${String(signal)}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: tail || message };
  }
}

/**
 * Trigger (or confirm) each Basemind global resource, one stage at a time.
 * Pass `onlyStage` to run just that stage — the onboarding UI calls this once
 * per stage, and re-running all three on every call would re-spawn already
 * satisfied, multi-hundred-MB warmup commands for no reason.
 */
export async function* basemindDownload(onlyStage?: BasemindDownloadStage): AsyncGenerator<BasemindDownloadProgress> {
  const binary = resolveBasemindBinary();

  for (const { stage, resource } of STAGES) {
    if (onlyStage !== undefined && stage !== onlyStage) continue;

    yield { stage, progress: 0, done: false };

    if (isModelResourceReady(resource)) {
      yield { stage, progress: 100, done: true };
      continue;
    }

    if (!binary) {
      yield { stage, progress: 0, done: false, error: 'basemind binary not found' };
      continue;
    }

    let result: { ok: boolean; error?: string };
    if (stage === 'nerModel' || stage === 'reranker') {
      // No basemind one-shot CLI command exercises these backends the way
      // onboarding needs (scan never initializes NER; `code --rerank` only
      // knows compiled-in presets, not the GTE Custom model) — pre-seed the
      // weights directly so onboarding actually delivers "models downloaded"
      // (see basemindPreseed.ts). nerModel = fastino GLiNER2 run through
      // candle (GLiNER2-redaction spec #37), reranker = GTE-multilingual
      // int8 (decision #228).
      const { preseedNerModel, FASTINO_REPO, FASTINO_REV, FASTINO_FILES, GTE_REPO, GTE_REV, GTE_FILES } =
        await import('./basemindPreseed');
      const opts = stage === 'nerModel'
        ? { repo: FASTINO_REPO, rev: FASTINO_REV, files: FASTINO_FILES }
        : { repo: GTE_REPO, rev: GTE_REV, files: GTE_FILES };
      try {
        result = await preseedNerModel(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: `${stage} model cache setup failed: ${message}` };
      }
      // rerankerWorkspace activation deferred (phase-2): #22 ports preseed
      // + embeddings warmup only; workspace GTE materialization lands later.
    } else {
      let workspace: string;
      try {
        // Only the embeddings stage still warms up (no git needed: `memory
        // documents` doesn't enumerate via git). Reranker/NER are pre-seeded.
        workspace = await ensureWarmupWorkspace();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { stage, progress: 0, done: false, error: `warmup workspace setup failed: ${message}` };
        continue;
      }
      // Private comms socket for this warmup (see runWarmup). Created beside
      // the workspace with a matching name so both are throwaway, listed
      // together, and cleaned together.
      const commsDir = mkdtempSync(path.join(tmpdir(), 'basemind-model-warmup-comms-'));
      try {
        result = await runWarmup(binary, stage, workspace, commsDir);
      } finally {
        try {
          cleanupTempDir(workspace);
        } catch (err) {
          console.warn(`[basemindDownload] warmup workspace cleanup failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          cleanupTempDir(commsDir);
        } catch (err) {
          console.warn(`[basemindDownload] warmup comms cleanup failed for ${commsDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // The warmup command downloads the model, then immediately exercises it
    // (embeds/reranks/detects on the sample doc). A machine-local failure in
    // that second step (e.g. an ONNX Runtime load error) must not be reported
    // as a download failure when the artifact landed in the hub cache anyway.
    if (isModelResourceReady(resource)) {
      yield { stage, progress: 100, done: true };
    } else {
      yield {
        stage,
        progress: 0,
        done: false,
        error: result.error ?? 'warmup command completed but no model artifact was found in the Hugging Face hub cache afterward',
      };
    }
  }
}

/** Drain the stage generator into the IPC result shape (router stays thin). */
export async function runBasemindDownload(
  onlyStage?: BasemindDownloadStage,
): Promise<{ stages: Array<{ stage: string; success: boolean; error?: string }>; success: boolean }> {
  const results: Array<{ stage: string; success: boolean; error?: string }> = [];
  for await (const update of basemindDownload(onlyStage)) {
    if (update.done || update.error) {
      results.push({ stage: update.stage, success: update.done, error: update.error });
    }
  }
  const success = results.every((r) => r.success);
  if (success) {
    // Opt-in succeeded → arm safe/ and mirror the workspace once, so the
    // banner's fileCount, the redaction gate and the RAG corpus reflect
    // reality. Population failure must never fail the download itself.
    try {
      const { getCurrentWorkspace } = await import('../utils/workspace');
      const workspacePath = getCurrentWorkspace();
      if (workspacePath) {
        const { runInitialPopulation } = await import('../utils/safeArm');
        await runInitialPopulation(workspacePath);
      }
    } catch (err) {
      console.warn(
        `[basemindDownload] safe population failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { stages: results, success };
}
