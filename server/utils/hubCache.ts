import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ModelResource = 'nerModel' | 'embeddings' | 'reranker';

export const MODEL_RESOURCE_REPOS: Record<ModelResource, string[]> = {
  nerModel: [
    'models--xberg-io--gliner-pii-models',
    'models--knowledgator--gliner-pii-edge-v1.0',
    'models--xberg-io--gliner-models',
  ],
  embeddings: ['models--xberg-io--embedding-models'],
  reranker: [
    'models--xberg-io--reranker-models',
    // GTE-multilingual int8 (FR decision #228): xberg lazy-downloads it on
    // first Custom use; the preseed below writes this same layout.
    'models--onnx-community--gte-multilingual-reranker-base',
  ],
};

/**
 * Candidate Hugging Face hub cache directories, in the order basemind
 * resolves them. Empirically confirmed (2026-09-17) against basemind 0.30.0:
 * the binary downloads into its XDG data home
 * (~/.local/share/basemind/hub) and falls back to the legacy standard cache
 * (~/.cache/huggingface/hub) on reads — an embeddings model cached only in
 * the legacy dir is used without re-download, while fresh downloads land in
 * the data-home dir. Checking a single dir (either one, or the
 * INTERPRETER_USER_DATA_DIR-based path the server sets at startup, which the
 * binary never reads) yields false "no model artifact found" failures, so
 * readiness must consult every candidate.
 */
export function resolveHubBaseDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.HF_HUB_CACHE?.trim() || process.env.HUGGINGFACE_HUB_CACHE?.trim();
  if (override) dirs.push(override);
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  dirs.push(path.join(dataHome, 'basemind', 'hub'));
  dirs.push(path.join(homedir(), '.cache', 'huggingface', 'hub'));
  return dirs;
}

const MAX_ARTIFACT_SEARCH_DEPTH = 4;

/**
 * Recursively look for a `.onnx` file under `dir`, up to `depth` levels down.
 * A real download landed at
 * snapshots/<rev>/<preset-name>/model.onnx — one level deeper than a plain
 * <repo>/snapshots/<rev>/model.onnx guess, so this can't stop at a fixed
 * depth. hf-hub links blobs from the snapshot dir, so symlinks count.
 */
function hasOnnxFile(dir: string, depth: number): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.onnx')) return true;
  }
  if (depth <= 0) return false;
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (hasOnnxFile(path.join(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

/** True when the repo directory (root or nested under snapshots/<rev>/...) has a cached .onnx artifact. */
export function hubRepoHasArtifact(baseDir: string, repoDir: string): boolean {
  const dir = path.join(baseDir, repoDir);
  if (!existsSync(dir)) return false;
  return hasOnnxFile(dir, MAX_ARTIFACT_SEARCH_DEPTH);
}

/** True when the resource's model weights are cached in any hub candidate dir. */
export function isModelResourceReady(resource: ModelResource): boolean {
  return resolveHubBaseDirs().some((baseDir) =>
    MODEL_RESOURCE_REPOS[resource].some((repo) => hubRepoHasArtifact(baseDir, repo)),
  );
}
