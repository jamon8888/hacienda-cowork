import { totalmem } from 'node:os';
import { cpuFeatures } from './cpuFeatures';
import { isNoAvx2BasemindBinary, resolveBasemindBinary } from '../utils/basemindManager';
import { isModelResourceReady } from '../utils/hubCache';
import { getRerankerEnabledOverride, setRerankerEnabledOverride } from '../configStore';

/** Below this the reranker costs more (9 s/pair measured on 2011 CPU) than it returns. */
export const RERANKER_MIN_TOTAL_MEM_BYTES = 8 * 1024 ** 3;

export interface RerankerMachineFacts {
  totalMemBytes: number;
  arch: string;
  avx2: boolean;
  noavx2Build: boolean;
  rerankerReady: boolean;
  override: boolean | null;
}

/** One shared guard: every caller (search, onboarding, settings) routes through here. */
export async function getRerankerMachineFacts(
  facts?: Partial<RerankerMachineFacts>,
): Promise<RerankerMachineFacts> {
  // Fully specified (tests): skip every async/environment read.
  const keys = ['totalMemBytes', 'arch', 'avx2', 'noavx2Build', 'rerankerReady', 'override'] as const;
  if (facts && keys.every((k) => facts[k] !== undefined)) return facts as RerankerMachineFacts;
  const [features, override] = await Promise.all([cpuFeatures(), getRerankerEnabledOverride()]);
  return {
    totalMemBytes: facts?.totalMemBytes ?? totalmem(),
    arch: facts?.arch ?? features.arch,
    avx2: facts?.avx2 ?? features.avx2,
    noavx2Build: facts?.noavx2Build ?? isNoAvx2BasemindBinary(resolveBasemindBinary()),
    rerankerReady: facts?.rerankerReady ?? isModelResourceReady('reranker'),
    override: facts?.override ?? override,
  };
}

/** Machine default: enough RAM and a CPU/build that can run the model. */
export function resolveRerankerDefault(facts: Pick<RerankerMachineFacts, 'totalMemBytes' | 'arch' | 'avx2' | 'noavx2Build'>): boolean {
  if (facts.totalMemBytes < RERANKER_MIN_TOTAL_MEM_BYTES) return false;
  // ponytail: noavx2-build ORT proof pending (#229 follow-up); gate stays until proven.
  if (facts.noavx2Build) return true;
  if (facts.arch === 'aarch64') return true;
  if (facts.arch === 'x86_64') return facts.avx2;
  // Fail closed on untested architectures (arm, riscv64, …): the ONNX model
  // is only proven on aarch64 and x86_64.
  return false;
}

/** Effective state: explicit override wins, otherwise the machine default — and never without the model. */
export async function getRerankerEnabled(facts?: Partial<RerankerMachineFacts>): Promise<boolean> {
  return (await getRerankerState(facts)).enabled;
}

/** Effective state plus the stored override (null = automatic), for settings UI. */
export async function getRerankerState(
  facts?: Partial<RerankerMachineFacts>,
): Promise<{ enabled: boolean; override: boolean | null }> {
  const full = await getRerankerMachineFacts(facts);
  if (!full.rerankerReady) return { enabled: false, override: full.override };
  const enabled = full.override ?? resolveRerankerDefault(full);
  return { enabled, override: full.override };
}

/** Machine default without the model gate (onboarding pre-check: the model is absent by definition there). */
export async function getRerankerDefault(facts?: Partial<RerankerMachineFacts>): Promise<boolean> {
  const full = await getRerankerMachineFacts(facts);
  return full.override ?? resolveRerankerDefault(full);
}

export async function setRerankerEnabled(value: boolean | null): Promise<{ enabled: boolean }> {
  await setRerankerEnabledOverride(value);
  return { enabled: await getRerankerEnabled() };
}
