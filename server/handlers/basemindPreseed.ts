import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveHubBaseDirs } from '../utils/hubCache';

export interface PreseedFile {
  /** Repo-relative path, e.g. `models/gliner_small-v2.5/span/fp32/model.onnx`. */
  path: string;
  /** Expected SHA-256 of the complete file (xberg verifies the same manifest). */
  sha256: string;
  /** Expected size in bytes (resume + completeness check without hashing). */
  size: number;
}

interface PreseedHeaders {
  get(name: string): string | null;
}

interface PreseedResponse {
  ok: boolean;
  status: number;
  headers: PreseedHeaders;
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}

export type PreseedFetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<PreseedResponse>;

/** Hugging Face repository holding xberg-managed GLiNER ONNX exports. */
export const GLINER_REPO = 'xberg-io/gliner-models';
/** Pinned revision xberg resolves (see xberg GlineBackend GLINER_MODELS_REVISION). */
export const GLINER_REV = 'afb0faaa3c8e7d0de7796bd37e625026ff635fe0';
/**
 * gliner_small-v2.5 artifacts (legacy onboarding model, ~673 MB).
 * Kept for reference; the NER engine decision (#231) is gliner-pii-edge,
 * see EDGE_* below. SHAs mirror xberg's checked-in gliner-models.sha256
 * manifest.
 */
export const GLINER_FILES: PreseedFile[] = [
  {
    path: 'models/gliner_small-v2.5/span/fp32/model.onnx',
    sha256: '4b137f355fe2fc1d7b359934eeb26f9b3bf3810afcb2bfd86d39b24e167309d5',
    size: 664_780_382,
  },
  {
    path: 'models/gliner_small-v2.5/span/fp32/tokenizer.json',
    sha256: '91cf35efa9ec3549c6c52a415cdd7531fd172858d7d9eecef720bc4a3f1f8699',
    size: 8_649_232,
  },
];

/** Knowledgator GLiNER-PII edge repo (NER engine decision #231). */
export const EDGE_REPO = 'knowledgator/gliner-pii-edge-v1.0';
/** Floating `main` (Knowledgator ships no pinned rev; SHAs pin the bytes). */
export const EDGE_REV = 'main';
/** Edge artifacts (~181 MB ONNX). SHAs verified 2026-09-18 (LFS oids match). */
export const EDGE_FILES: PreseedFile[] = [
  {
    path: 'onnx/model.onnx',
    sha256: '4ca588722e6d79447ad4c9c230eeba3d9d472c672a9598184a34e9f77fc35836',
    size: 181_078_966,
  },
  {
    path: 'tokenizer.json',
    sha256: '84b3a9b18f04a0ccd03b72d9f871b7e0bec40fd7021ef50bc30a7c3693c11205',
    size: 3_583_593,
  },
  {
    path: 'gliner_config.json',
    sha256: '77e6b57335c4bfd461e9041682196dd6c373a0b09bbd9269ef9e95b807915340',
    size: 4_316,
  },
];

/** GTE-multilingual reranker int8 repo (reranker decision #228). */
export const GTE_REPO = 'onnx-community/gte-multilingual-reranker-base';
/** Floating `main` (SHAs pin the bytes; LFS oid match verified 2026-09-18). */
export const GTE_REV = 'main';
/** GTE int8 artifacts (~341 MB ONNX). */
export const GTE_FILES: PreseedFile[] = [
  {
    path: 'onnx/model_int8.onnx',
    sha256: 'ccf51dba7f8aa9205753761cfaa68c55f741792501463a3bf25d7e5bcdac7c35',
    size: 340_858_200,
  },
  {
    path: 'tokenizer.json',
    sha256: '3ffb37461c391f096759f4a9bbbc329da0f36952f88bab061fcf84940c022e98',
    size: 17_082_999,
  },
  {
    path: 'config.json',
    sha256: 'dfa5713436ecb4616eaa576795c8d3efd1f03122031a1ad4973d0b6b7e7edfd3',
    size: 1_578,
  },
];

const DEFAULT_FILE_TIMEOUT_MS = 120 * 60_000;

/** Download attempts per file: resume continues the partial, so retries are cheap. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Global-fetch adapter: shapes the native Response into PreseedFetchFn without casts. */
async function nodeFetch(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<PreseedResponse> {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, headers: res.headers, body: res.body };
}

function repoDirName(repo: string): string {
  return `models--${repo.replace('/', '--')}`;
}

function fileUrl(repo: string, rev: string, filePath: string): string {
  return `https://huggingface.co/${repo}/resolve/${rev}/${filePath}`;
}

async function* streamBody(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in Object(body)) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadFile(
  url: string,
  destIncomplete: string,
  startByte: number,
  fetchFn: PreseedFetchFn,
  timeoutMs: number,
): Promise<void> {
  const attempt = async (from: number): Promise<void> => {
    const headers: Record<string, string> = {};
    if (from > 0) headers['Range'] = `bytes=${from}-`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { headers, signal: controller.signal });
      // A 200 to a ranged request means the server ignored Range: this body
      // already starts at byte zero, so overwrite the partial file with it
      // instead of abandoning the response for a second download.
      const writeFrom = from > 0 && res.status === 200 ? 0 : from;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (!res.body) throw new Error(`empty body for ${url}`);
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(destIncomplete, { flags: writeFrom > 0 ? 'a' : 'w' });
        out.on('error', reject);
        out.on('finish', resolve);
        (async () => {
          try {
            for await (const chunk of streamBody(res.body!)) {
              if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
            }
            out.end();
          } catch (err) {
            out.destroy();
            reject(err);
          }
        })();
      });
    } finally {
      clearTimeout(timer);
    }
  };
  await attempt(startByte);
}

export interface PreseedOptions {
  baseDir?: string;
  fetchFn?: PreseedFetchFn;
  repo?: string;
  rev?: string;
  files?: PreseedFile[];
  fileTimeoutMs?: number;
  maxAttempts?: number;
}

/**
 * Pre-seed pinned HF weights (GLiNER NER / EDGE / GTE as passed in opts) into the hub cache layout
 * (blobs/<sha256> + refs/main + snapshots/<rev>/<path> symlinks) that
 * xberg's lazy loader resolves. Needed because no basemind one-shot CLI
 * command exercises the NER backend — `scan` never initializes it and
 * `redact` uses the pattern engine — so the scan-based warmup can never
 * trigger the download; NER otherwise only arrives via the persistent
 * daemon's document lane on first real use.
 */
export async function preseedNerModel(opts: PreseedOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const baseDir = opts.baseDir ?? resolveHubBaseDirs()[0];
  const repo = opts.repo ?? GLINER_REPO;
  const rev = opts.rev ?? GLINER_REV;
  // Default to EDGE (engine #231); legacy GLINER_FILES is reference-only and must never be the default.
  const files = opts.files ?? EDGE_FILES;
  const fetchFn = opts.fetchFn ?? nodeFetch;
  const timeoutMs = opts.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const repoDir = path.join(baseDir, repoDirName(repo));
  mkdirSync(path.join(repoDir, 'blobs'), { recursive: true });
  mkdirSync(path.join(repoDir, 'refs'), { recursive: true });

  for (const file of files) {
    const blobPath = path.join(repoDir, 'blobs', file.sha256);
    const incompletePath = `${blobPath}.incomplete`;
    try {
      let complete = false;
      if (existsSync(blobPath)) {
        try {
          complete = statSync(blobPath).size === file.size && (await sha256File(blobPath)) === file.sha256;
        } catch {
          complete = false;
        }
        if (!complete) rmSync(blobPath, { force: true });
      }
      if (!complete) {
        // Retry transient failures (reset connections, timeouts): resume
        // continues the partial file, so retries are cheap. A sha mismatch
        // is terminal — redownloading the same bytes would fail identically.
        let lastError = '';
        for (let attempt = 1; attempt <= maxAttempts && !complete; attempt++) {
          let startByte = 0;
          if (existsSync(incompletePath)) {
            try {
              const size = statSync(incompletePath).size;
              startByte = size < file.size ? size : 0;
              if (startByte === 0) rmSync(incompletePath, { force: true });
            } catch {
              startByte = 0;
            }
          }
          try {
            await downloadFile(fileUrl(repo, rev, file.path), incompletePath, startByte, fetchFn, timeoutMs);
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            continue;
          }
          try {
            complete = (await sha256File(incompletePath)) === file.sha256;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            continue;
          }
          if (!complete) {
            rmSync(incompletePath, { force: true });
            return { ok: false, error: `sha256 mismatch for ${file.path} (xberg would reject these weights)` };
          }
          renameSync(incompletePath, blobPath);
        }
        if (!complete) {
          return { ok: false, error: `${file.path}: ${lastError || 'download failed'} (after ${maxAttempts} attempts)` };
        }
      }
      // refs/main pins the revision; snapshot entries symlink to the blob,
      // mirroring exactly what hf-hub clients write. Windows without symlink
      // privileges raises EPERM: fall back to a hardlink, then a plain copy —
      // content is identical either way, only space efficiency differs.
      mkdirSync(path.join(repoDir, 'snapshots', rev, path.dirname(file.path)), { recursive: true });
      const snapshotFile = path.join(repoDir, 'snapshots', rev, file.path);
      try {
        rmSync(snapshotFile, { force: true });
      } catch {
        // intentionally empty
      }
      try {
        symlinkSync(path.relative(path.dirname(snapshotFile), blobPath), snapshotFile);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EPERM' && code !== 'EACCES') throw err;
        try {
          linkSync(blobPath, snapshotFile);
        } catch {
          copyFileSync(blobPath, snapshotFile);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `${file.path}: ${message}` };
    }
  }
  // refs/main pins the revision once, after all files land — not per file.
  writeFileSync(path.join(repoDir, 'refs', 'main'), rev);
  return { ok: true };
}
