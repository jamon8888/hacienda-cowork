import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveBinary = vi.fn(() => '');
const mockIsReady = vi.fn((_resource?: string) => false);
const mockCurrentWorkspace = vi.fn((): string | null => null);
const mockPopulation = vi.fn(async (_workspacePath: string) => ({ written: 0, skipped: 0 }));
const mockRegister = vi.fn(async () => 'basemind');

vi.mock('../utils/basemindManager', () => ({
  resolveBasemindBinary: () => mockResolveBinary(),
  registerBasemindServer: () => mockRegister(),
}));
vi.mock('../utils/hubCache', () => ({
  isModelResourceReady: (resource: string) => mockIsReady(resource),
}));
vi.mock('../utils/workspace', () => ({
  getCurrentWorkspace: () => mockCurrentWorkspace(),
}));
vi.mock('../utils/safeArm', () => ({
  runInitialPopulation: (workspacePath: string) => mockPopulation(workspacePath),
}));

async function load() {
  return await import('./basemindDownload');
}

describe('basemindDownload stages', () => {
  beforeEach(() => {
    mockResolveBinary.mockReturnValue('');
    mockIsReady.mockReturnValue(false);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('yields ready stages as done without a binary', async () => {
    mockIsReady.mockReturnValue(true);
    const { basemindDownload } = await load();
    const updates = [];
    for await (const u of basemindDownload()) updates.push(u);
    // Ready stages yield done immediately (no start progress since no work needed)
    expect(updates.map((u) => u.stage)).toEqual([
      'nerModel', 'reranker', 'embeddings',
    ]);
    const done = updates.filter((u) => u.done);
    expect(done).toHaveLength(3);
    expect(done.every((u) => u.progress === 100)).toBe(true);
  });

  it('reports missing binary when a stage is not ready', async () => {
    mockResolveBinary.mockReturnValue('');
    mockIsReady.mockReturnValue(false);
    const { basemindDownload } = await load();
    const updates = [];
    for await (const u of basemindDownload('embeddings')) updates.push(u);
    // Embeddings stage yields one error update (no binary, not ready)
    expect(updates.map((u) => u.stage)).toEqual(['embeddings']);
    expect(updates[0]).toMatchObject({ stage: 'embeddings', progress: 0, done: false });
    expect(updates[0].error).toMatch(/basemind binary not found/);
  });

  it('filters to a single onlyStage', async () => {
    mockIsReady.mockReturnValue(true);
    const { basemindDownload } = await load();
    const updates = [];
    for await (const u of basemindDownload('reranker')) updates.push(u);
    // Ready reranker yields done immediately
    expect(updates.map((u) => u.stage)).toEqual(['reranker']);
    expect(updates[0]).toMatchObject({ done: true, progress: 100 });
  });
});

describe('runBasemindDownload safe population', () => {
  beforeEach(() => {
    mockResolveBinary.mockReturnValue('/usr/bin/basemind');
    mockIsReady.mockReturnValue(true);
    mockCurrentWorkspace.mockReturnValue('/ws');
    mockPopulation.mockResolvedValue({ written: 1, skipped: 0 });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('populates safe/ after every stage succeeds', async () => {
    const { runBasemindDownload } = await load();
    const result = await runBasemindDownload();
    expect(result.success).toBe(true);
    expect(mockPopulation).toHaveBeenCalledTimes(1);
    expect(mockPopulation).toHaveBeenCalledWith('/ws');
  });

  it('registers basemind before populating safe/', async () => {
    // Population redacts through basemind's redact_text; on a fresh install
    // nothing had registered the server, so the call waited on an approval
    // no one could answer and the banner stayed on "In progress" forever.
    const order: string[] = [];
    mockRegister.mockImplementationOnce(async () => { order.push('register'); return 'basemind'; });
    mockPopulation.mockImplementationOnce(async () => { order.push('populate'); return { written: 1, skipped: 0 }; });
    const { runBasemindDownload } = await load();
    await runBasemindDownload();
    expect(order).toEqual(['register', 'populate']);
  });

  it('skips population when any stage fails', async () => {
    mockResolveBinary.mockReturnValue('');
    mockIsReady.mockReturnValue(false);
    const { runBasemindDownload } = await load();
    const result = await runBasemindDownload();
    expect(result.success).toBe(false);
    expect(mockPopulation).not.toHaveBeenCalled();
  });

  it('population failure does not fail the download (models did download)', async () => {
    mockPopulation.mockRejectedValueOnce(new Error('disk full'));
    const { runBasemindDownload } = await load();
    const result = await runBasemindDownload();
    expect(result.success).toBe(true);
  });

  it('no current workspace → population skipped without error', async () => {
    mockCurrentWorkspace.mockReturnValue(null);
    const { runBasemindDownload } = await load();
    const result = await runBasemindDownload();
    expect(result.success).toBe(true);
    expect(mockPopulation).not.toHaveBeenCalled();
  });
});
