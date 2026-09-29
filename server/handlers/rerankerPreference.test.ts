import { describe, expect, test } from 'bun:test';
import {
  RERANKER_MIN_TOTAL_MEM_BYTES,
  getRerankerDefault,
  getRerankerEnabled,
  getRerankerState,
  resolveRerankerDefault,
  type RerankerMachineFacts,
} from './rerankerPreference';

const GB = 1024 ** 3;

function facts(over: Partial<RerankerMachineFacts>): RerankerMachineFacts {
  return {
    totalMemBytes: 16 * GB,
    arch: 'x86_64',
    avx2: true,
    noavx2Build: false,
    rerankerReady: true,
    override: null,
    ...over,
  };
}

describe('resolveRerankerDefault', () => {
  test('OFF below 8 GB even with AVX2', () => {
    expect(resolveRerankerDefault({ totalMemBytes: 7 * GB, arch: 'x86_64', avx2: true, noavx2Build: false })).toBe(false);
  });

  test('ON at 8 GB with AVX2', () => {
    expect(resolveRerankerDefault({ totalMemBytes: 8 * GB, arch: 'x86_64', avx2: true, noavx2Build: false })).toBe(true);
  });

  test('OFF without AVX2 on stock build', () => {
    expect(resolveRerankerDefault({ totalMemBytes: 16 * GB, arch: 'x86_64', avx2: false, noavx2Build: false })).toBe(false);
  });

  test('ON with the noavx2 build regardless of flags', () => {
    expect(resolveRerankerDefault({ totalMemBytes: 16 * GB, arch: 'x86_64', avx2: false, noavx2Build: true })).toBe(true);
  });

  test('ON on aarch64', () => {
    expect(resolveRerankerDefault({ totalMemBytes: 16 * GB, arch: 'aarch64', avx2: false, noavx2Build: false })).toBe(true);
  });

  test('OFF on unknown architectures (fail-closed)', () => {
    for (const arch of ['arm', 'riscv64', 'ppc64', 'unknown']) {
      expect(resolveRerankerDefault({ totalMemBytes: 16 * GB, arch, avx2: true, noavx2Build: false })).toBe(false);
    }
  });

  test('RERANKER_MIN_TOTAL_MEM_BYTES is 8 GiB', () => {
    expect(RERANKER_MIN_TOTAL_MEM_BYTES).toBe(8 * GB);
  });
});

describe('getRerankerEnabled', () => {
  test('never without the downloaded model, even on override ON', async () => {
    await expect(getRerankerEnabled(facts({ rerankerReady: false, override: true }))).resolves.toBe(false);
  });

  test('explicit override wins over the machine default', async () => {
    await expect(getRerankerEnabled(facts({ totalMemBytes: 4 * GB, override: true }))).resolves.toBe(true);
    await expect(getRerankerEnabled(facts({ override: false }))).resolves.toBe(false);
  });

  test('falls back to the machine default without override', async () => {
    await expect(getRerankerEnabled(facts({ totalMemBytes: 4 * GB }))).resolves.toBe(false);
    await expect(getRerankerEnabled(facts({}))).resolves.toBe(true);
  });

  test('getRerankerDefault ignores model presence (onboarding pre-check)', async () => {
    await expect(getRerankerDefault(facts({ rerankerReady: false }))).resolves.toBe(true);
    await expect(getRerankerDefault(facts({ rerankerReady: false, totalMemBytes: 4 * GB }))).resolves.toBe(false);
  });

  test('getRerankerState exposes the stored override', async () => {
    await expect(getRerankerState(facts({}))).resolves.toEqual({ enabled: true, override: null });
    await expect(getRerankerState(facts({ rerankerReady: false, override: true }))).resolves.toEqual({ enabled: false, override: true });
  });
});
