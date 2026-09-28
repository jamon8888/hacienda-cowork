/**
 * Workspace custom terms (manual PII gesture, #11).
 *
 * basemind's `redact_text` reads custom terms only from its arguments, never
 * from basemind.toml, so terms written there never redacted anything — and
 * sat in cleartext inside the workspace. They now live encrypted in the
 * workspace vault (`{userData}/vaults/<segment>/custom-terms.enc`) and are
 * passed to every redaction call.
 */

import fs from 'node:fs';

import type { CustomTerm } from '../../src/lib/pii/custom-terms';
import { getCurrentWorkspace } from '../utils/workspace';
import { persistEncryptedBlob, resolveVaultBlobPath, vaultManager, type VaultEncryptOptions } from './vault';

export type { CustomTerm };

/** Not `thread-` prefixed, so the orphan GC never considers it. */
export const CUSTOM_TERMS_DOC_ID = 'custom-terms';

let cache: { workspace: string; terms: CustomTerm[] } | null = null;

export function resetCustomTermsCacheForTests(): void {
  cache = null;
}

/** Stored as value → label: one entry per pinned literal. */
async function readStoredTerms(options: VaultEncryptOptions): Promise<CustomTerm[]> {
  if (!fs.existsSync(resolveVaultBlobPath(CUSTOM_TERMS_DOC_ID))) return [];
  const map = await vaultManager.decrypt(CUSTOM_TERMS_DOC_ID, options.passphrase, options.toolManager);
  return Object.entries(map).map(([value, label]) => ({ label, value }));
}

/**
 * Terms pinned for the current workspace; empty without a workspace. A vault
 * that cannot be read yields no terms for this call and is retried next time.
 */
export async function listCustomTerms(options: VaultEncryptOptions = {}): Promise<CustomTerm[]> {
  const workspace = getCurrentWorkspace();
  if (!workspace) return [];
  if (cache?.workspace === workspace) return cache.terms;
  try {
    const terms = await readStoredTerms(options);
    cache = { workspace, terms };
    return terms;
  } catch (error) {
    console.warn(
      `[custom-terms] could not read pinned terms: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Pin a literal for the current workspace. An existing blob that cannot be
 * read throws instead of being overwritten with this term alone.
 */
export async function addCustomTerm(
  term: CustomTerm,
  options: VaultEncryptOptions = {},
): Promise<CustomTerm[]> {
  const workspace = getCurrentWorkspace();
  if (!workspace) throw new Error('No workspace set. Open a folder first.');
  const existing = await readStoredTerms(options);
  if (existing.some((entry) => entry.value === term.value)) {
    cache = { workspace, terms: existing };
    return existing;
  }
  const next = [...existing, term];
  const map = Object.fromEntries(next.map((entry) => [entry.value, entry.label]));
  persistEncryptedBlob(CUSTOM_TERMS_DOC_ID, await vaultManager.encrypt(map, options));
  cache = { workspace, terms: next };
  return next;
}

/** `redact_text` argument shape: `[["label", "value"], …]`. */
export function toRedactTextCustomTerms(terms: readonly CustomTerm[]): string[][] {
  return terms.map((term) => [term.label, term.value]);
}
