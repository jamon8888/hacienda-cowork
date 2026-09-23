/**
 * PII IPC handlers — Show Originals rehydration, selection NER, and the
 * manual-gesture custom-term write. No reveal audit log in v1 (#19).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { piiDetectionService, type PiiDetectionResult } from '../services/piiDetection';
import {
  getRuntimeRehydrationMap,
  mergeRuntimeRehydrationMap,
} from '../services/runtimeRedaction';
import { persistThreadRehydrationMap } from '../services/rehydrationPersistence';
import { vaultManager, type VaultToolCaller } from '../services/vault';
import { threadVaultDocId } from '../services/rehydrationPersistence';
import { getCurrentWorkspace } from '../utils/workspace';

export interface PiiGetRehydrationMapDeps {
  toolManager?: VaultToolCaller;
  passphrase?: string;
}

/**
 * Token→original map for Show Originals: the session store plus whatever the
 * vault persisted across restarts. Session wins on conflict (it is newer).
 * A missing blob is not an error — the toggle simply has less to show.
 */
export async function getRehydrationMap(
  request: { threadKey: string },
  deps: PiiGetRehydrationMapDeps = {},
): Promise<Record<string, string>> {
  const threadKey = request?.threadKey;
  if (!threadKey) return {};
  const session = getRuntimeRehydrationMap(threadKey);
  let persisted: Record<string, string> = {};
  try {
    persisted = await vaultManager.decrypt(
      threadVaultDocId(threadKey),
      deps.passphrase,
      deps.toolManager,
    );
  } catch {
    // No blob, or decryption unavailable — session map alone is still useful.
  }
  return { ...persisted, ...session };
}

/** NER detections for a selection the user asked to tokenize by hand. */
export async function detectSelection(request: {
  text: string;
  categories?: string[];
}): Promise<{ detections: PiiDetectionResult[] }> {
  const text = request?.text ?? '';
  if (!text) return { detections: [] };
  const detections = await piiDetectionService.detectPii(text, {
    categories: request.categories,
  });
  return { detections };
}

/**
 * Persist a gesture's token→original pairs for Show Originals. Session store
 * first so a vault failure still reveals this turn; vault is best-effort
 * (same ceiling as the send seam).
 */
export async function rememberRehydration(request: {
  threadKey: string;
  map: Record<string, string>;
}): Promise<{ success: boolean }> {
  const threadKey = request?.threadKey;
  const map = request?.map ?? {};
  if (!threadKey) {
    throw new Error('[pii] threadKey is required');
  }
  mergeRuntimeRehydrationMap(threadKey, map);
  try {
    await persistThreadRehydrationMap(threadKey, map);
  } catch {
    // Session-only reveal — sessionOnlyRehydration copy covers the gap.
  }
  return { success: true };
}

function resolveCustomTermsConfigPath(workspace: string): string {
  const rootConfig = path.join(workspace, 'basemind.toml');
  if (fs.existsSync(rootConfig)) return rootConfig;
  const legacyConfig = path.join(workspace, '.basemind', 'basemind.toml');
  if (fs.existsSync(legacyConfig)) return legacyConfig;
  return rootConfig;
}

interface CustomTermEntry {
  label: string;
  value: string;
  case_sensitive?: boolean;
}

/**
 * Pin a gesture literal into workspace `documents.redaction.custom_terms`.
 * Parse-modify-write via smol-toml: basemind.toml is schema-shaped config, so
 * comments are not preserved — acceptable ceiling for a rarely-written file;
 * switch to a targeted text splice if operators start hand-commenting it.
 */
export async function addCustomTerm(request: {
  label: string;
  value: string;
  caseSensitive?: boolean;
}): Promise<{ success: boolean; configPath: string }> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error('No workspace set. Open a folder first.');
  }
  const label = (request?.label ?? '').trim();
  const value = (request?.value ?? '').trim();
  if (!value) {
    throw new Error('[pii] Custom term value is required');
  }
  const safeLabel = label || 'Custom';

  const configPath = resolveCustomTermsConfigPath(workspace);
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = parseToml(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }

  const documents = (config.documents ?? {}) as Record<string, unknown>;
  const redaction = (documents.redaction ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(redaction.custom_terms)
    ? (redaction.custom_terms as CustomTermEntry[])
    : [];

  const alreadyPinned = existing.some((term) => term?.value === value);
  if (!alreadyPinned) {
    redaction.custom_terms = [
      ...existing,
      { label: safeLabel, value, case_sensitive: request?.caseSensitive === true },
    ];
  }
  // A written rule is an intent to redact; leave the master switch to safe/
  // activation (#19 workspace gate) but turn it on when pinning so the term fires.
  redaction.enabled = true;
  documents.redaction = redaction;
  config.documents = documents;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringifyToml(config), 'utf8');
  return { success: true, configPath };
}
