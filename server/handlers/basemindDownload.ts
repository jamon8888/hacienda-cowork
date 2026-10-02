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

const WARMUP_TIMEOUT_MS = 60_000;
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
 * 
 * Parallelization: nerModel and reranker are independent HF Hub fetches and
 * run concurrently. embeddings runs after them (requires warmup workspace).
 */
export async function* basemindDownload(onlyStage?: BasemindDownloadStage): AsyncGenerator<BasemindDownloadProgress> {
  const binary = resolveBasemindBinary();

  // First, check which stages are already satisfied
  const stagesToRun: Array<{ stage: BasemindDownloadStage; resource: ModelResource }> = [];
  for (const { stage, resource } of STAGES) {
    if (onlyStage !== undefined && stage !== onlyStage) continue;
    if (isModelResourceReady(resource)) {
      yield { stage, progress: 100, done: true };
    } else {
      stagesToRun.push({ stage, resource });
    }
  }

  if (stagesToRun.length === 0) return;

  if (!binary) {
    for (const { stage } of stagesToRun) {
      yield { stage, progress: 0, done: false, error: 'basemind binary not found' };
    }
    return;
  }

  // Partition stages: pre-seed (nerModel, reranker) can run in parallel;
  // embeddings requires warmup workspace and runs sequentially after.
  const preSeedStages = stagesToRun.filter(s => s.stage === 'nerModel' || s.stage === 'reranker');
  const warmupStages = stagesToRun.filter(s => s.stage === 'embeddings');

  // Phase 1: Run pre-seed stages (nerModel + reranker) in parallel
  if (preSeedStages.length > 0) {
    const { preseedNerModel, FASTINO_REPO, FASTINO_REV, FASTINO_FILES, GTE_REPO, GTE_REV, GTE_FILES } =
      await import('./basemindPreseed');

    // Start: yield progress 0 for all pre-seed stages
    for (const { stage } of preSeedStages) {
      yield { stage, progress: 0, done: false };
    }

    // Run pre-seeds concurrently - each returns final progress update
    const preSeedResults = await Promise.all(
      preSeedStages.map(async ({ stage, resource }) => {
        const opts = stage === 'nerModel'
          ? { repo: FASTINO_REPO, rev: FASTINO_REV, files: FASTINO_FILES }
          : { repo: GTE_REPO, rev: GTE_REV, files: GTE_FILES };
        try {
          const result = await preseedNerModel(opts);
          if (isModelResourceReady(resource)) {
            return { stage, progress: 100, done: true, error: undefined as string | undefined };
          }
          return { stage, progress: 0, done: false, error: result.error ?? `${stage} model not ready after pre-seed` };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { stage, progress: 0, done: false, error: `${stage} model cache setup failed: ${message}` };
        }
      })
    );

    // Yield results in original order
    for (const result of preSeedResults) {
      yield result;
    }

    // Phase 1.5: Activate reranker for known workspaces (GTE custom_model)
    // This runs after the reranker weights are downloaded. (Future: import when module exists)
    // if (preSeedStages.some(s => s.stage === 'reranker')) {
    //   try {
    //     const { ensureKnownWorkspacesRerankerModels } = await import('./rerankerWorkspace');
    //     await ensureKnownWorkspacesRerankerModels();
    //   } catch (err) {
    //     console.warn(`[basemindDownload] workspace GTE activation failed: ${err instanceof Error ? err.message : String(err)}`);
    //   }
    // }
  }

  // Phase 2: Run warmup stages (embeddings) sequentially (requires workspace)
  for (const { stage, resource } of warmupStages) {
    yield { stage, progress: 0, done: false };

    let workspace: string;
    try {
      workspace = await ensureWarmupWorkspace();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { stage, progress: 0, done: false, error: `warmup workspace setup failed: ${message}` };
      continue;
    }

    let commsDir: string | null = null;
    try {
      commsDir = mkdtempSync(path.join(tmpdir(), 'basemind-model-warmup-comms-'));
      const result = await runWarmup(binary, stage, workspace, commsDir);

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { stage, progress: 0, done: false, error: `warmup failed: ${message}` };
    } finally {
      try {
        cleanupTempDir(workspace);
      } catch (err) {
        console.warn(`[basemindDownload] warmup workspace cleanup failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (commsDir) {
        try {
          cleanupTempDir(commsDir);
        } catch (err) {
          console.warn(`[basemindDownload] warmup comms cleanup failed for ${commsDir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
        // Population redacts through basemind; register it (with auto
        // approval for the app's own tools) before the first call.
        const { registerBasemindServer } = await import('../utils/basemindManager');
        await registerBasemindServer();
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
