import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PreseedFile } from './basemindPreseed';

interface FakeHeaders {
  get(name: string): string | null;
}
interface FakeResponse {
  ok: boolean;
  status: number;
  headers: FakeHeaders;
  body: AsyncIterable<Uint8Array> | null;
}
type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FakeResponse>;

function headers(map: Record<string, string>): FakeHeaders {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

async function* chunks(data: Uint8Array, size = 4): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function fixtureFiles(): { files: PreseedFile[]; contents: Map<string, Uint8Array> } {
  const a = new TextEncoder().encode('model-bytes-0123456789');
  const b = new TextEncoder().encode('{"tokenizer":true}');
  const files: PreseedFile[] = [
    { path: 'models/m/span/fp32/model.onnx', sha256: sha256(a), size: a.length },
    { path: 'models/m/span/fp32/tokenizer.json', sha256: sha256(b), size: b.length },
  ];
  return { files, contents: new Map([[files[0].path, a], [files[1].path, b]]) };
}

let tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'preseed-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

async function loadModule() {
  return await import('./basemindPreseed');
}

const REPO = 'xberg-io/gliner-models';
const REV = 'abc123def456';

describe('preseedNerModel', () => {
  it('downloads missing files into the hf-hub layout', async () => {
    const { preseedNerModel } = await loadModule();
    const baseDir = makeTmp();
    const { files, contents } = fixtureFiles();
    const seen: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      seen.push(url);
      const file = files.find((f) => url.endsWith(f.path));
      if (!file) return { ok: false, status: 404, headers: headers({}), body: null };
      const data = contents.get(file.path)!;
      return { ok: true, status: 200, headers: headers({ 'content-length': String(data.length) }), body: chunks(data) };
    };

    const result = await preseedNerModel({ baseDir, fetchFn, repo: REPO, rev: REV, files });
    expect(result).toEqual({ ok: true });

    const repoDir = path.join(baseDir, 'models--xberg-io--gliner-models');
    for (const file of files) {
      // Blob content lands under blobs/<sha256>.
      const blob = path.join(repoDir, 'blobs', file.sha256);
      expect(readFileSync(blob).toString()).toBe(Buffer.from(contents.get(file.path)!).toString());
      // Snapshot path symlinks to the blob.
      const snap = path.join(repoDir, 'snapshots', REV, file.path);
      expect(readFileSync(snap).toString()).toBe(Buffer.from(contents.get(file.path)!).toString());
    }
    expect(readFileSync(path.join(repoDir, 'refs', 'main'), 'utf8')).toBe(REV);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain(REPO);
    expect(seen[0]).toContain(REV);
  });

  it('resumes partial downloads with a Range header and skips complete files', async () => {
    const { preseedNerModel } = await loadModule();
    const baseDir = makeTmp();
    const { files, contents } = fixtureFiles();
    const repoDir = path.join(baseDir, 'models--xberg-io--gliner-models');
    mkdirSync(path.join(repoDir, 'blobs'), { recursive: true });
    // Seed a partial .incomplete (first 6 bytes) for the model file.
    const first = files[0];
    const full = contents.get(first.path)!;
    writeFileSync(path.join(repoDir, 'blobs', `${first.sha256}.incomplete`), full.subarray(0, 6));
    // Seed the complete tokenizer blob (must not be fetched).
    const second = files[1];
    writeFileSync(path.join(repoDir, 'blobs', second.sha256), contents.get(second.path)!);

    const ranges: (string | undefined)[] = [];
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      urls.push(url);
      ranges.push(init?.headers?.['Range']);
      return { ok: true, status: 206, headers: headers({ 'content-length': String(full.length - 6) }), body: chunks(full.subarray(6)) };
    };

    const result = await preseedNerModel({ baseDir, fetchFn, repo: REPO, rev: REV, files });
    expect(result).toEqual({ ok: true });
    // Only the partial file was fetched, resuming at byte 6.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(first.path);
    expect(ranges[0]).toBe('bytes=6-');
    // Completed blob verifies and links.
    const snap = path.join(repoDir, 'snapshots', REV, first.path);
    expect(statSync(path.join(repoDir, 'blobs', first.sha256)).size).toBe(full.length);
    expect(readFileSync(snap).toString()).toBe(Buffer.from(full).toString());
  });

  it('rejects tampered bytes with a sha256 mismatch and removes the blob', async () => {
    const { preseedNerModel } = await loadModule();
    const baseDir = makeTmp();
    const { files } = fixtureFiles();
    const fetchFn: FetchFn = async () => {
      const data = new TextEncoder().encode('tampered-not-the-model');
      return { ok: true, status: 200, headers: headers({ 'content-length': String(data.length) }), body: chunks(data) };
    };

    const result = await preseedNerModel({ baseDir, fetchFn, repo: REPO, rev: REV, files });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sha256 mismatch/);
    const repoDir = path.join(baseDir, 'models--xberg-io--gliner-models');
    expect(existsSync(path.join(repoDir, 'blobs', files[0].sha256))).toBe(false);
  });

  it('surfaces HTTP errors without writing partial layout', async () => {
    const { preseedNerModel } = await loadModule();
    const baseDir = makeTmp();
    const { files } = fixtureFiles();
    const fetchFn: FetchFn = async () => ({ ok: false, status: 403, headers: headers({}), body: null });

    const result = await preseedNerModel({ baseDir, fetchFn, repo: REPO, rev: REV, files });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403/);
  });
});

describe('pinned weight manifests (EDGE/GTE decisions #231/#228)', () => {
  it('edge engine files carry sha256/size and an onnx entry (hubCache readiness)', async () => {
    const { EDGE_REPO, EDGE_REV, EDGE_FILES } = await loadModule();
    expect(EDGE_REPO).toBe('knowledgator/gliner-pii-edge-v1.0');
    expect(EDGE_REV).toBe('main');
    expect(EDGE_FILES.length).toBeGreaterThan(0);
    for (const f of EDGE_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
    }
    expect(EDGE_FILES.some((f) => f.path.endsWith('.onnx'))).toBe(true);
  });

  it('GTE reranker files carry sha256/size and the int8 onnx entry', async () => {
    const { GTE_REPO, GTE_REV, GTE_FILES } = await loadModule();
    expect(GTE_REPO).toBe('onnx-community/gte-multilingual-reranker-base');
    expect(GTE_REV).toBe('main');
    const onnx = GTE_FILES.find((f) => f.path === 'onnx/model_int8.onnx');
    expect(onnx?.size).toBe(340_858_200);
    expect(onnx?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pinned weight totals (#22)', () => {
  it('EDGE + GTE pinned bytes match the locked ~542.6 MB total', async () => {
    const { EDGE_FILES, GTE_FILES } = await loadModule();
    const edge = EDGE_FILES.reduce((n, f) => n + f.size, 0);
    const gte = GTE_FILES.reduce((n, f) => n + f.size, 0);
    expect(edge).toBe(184_666_875);
    expect(gte).toBe(357_942_777);
    expect(edge + gte).toBe(542_609_652);
  });
});
