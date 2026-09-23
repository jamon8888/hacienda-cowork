import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveBinary = vi.fn(() => '');
const mockIsReady = vi.fn(() => false);

vi.mock('../utils/basemindManager', () => ({
  resolveBasemindBinary: () => mockResolveBinary(),
}));
vi.mock('../utils/hubCache', () => ({
  isModelResourceReady: (resource: string) => mockIsReady(resource),
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
    expect(updates.map((u) => u.stage)).toEqual([
      'nerModel', 'nerModel',
      'reranker', 'reranker',
      'embeddings', 'embeddings',
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
    expect(updates.map((u) => u.stage)).toEqual(['embeddings', 'embeddings']);
    expect(updates[0]).toMatchObject({ stage: 'embeddings', progress: 0, done: false });
    expect(updates[1].error).toMatch(/basemind binary not found/);
  });

  it('filters to a single onlyStage', async () => {
    mockIsReady.mockReturnValue(true);
    const { basemindDownload } = await load();
    const updates = [];
    for await (const u of basemindDownload('reranker')) updates.push(u);
    expect(updates.map((u) => u.stage)).toEqual(['reranker', 'reranker']);
    expect(updates[1]).toMatchObject({ done: true, progress: 100 });
  });
});
