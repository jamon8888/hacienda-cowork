/**
 * PII IPC handlers — Show Originals rehydration, selection NER, and the
 * manual-gesture custom-term write. No reveal audit log in v1 (#19).
 */

import { piiDetectionService, type PiiDetectionResult } from '../services/piiDetection';
import {
  getRuntimeRehydrationMap,
  mergeRuntimeRehydrationMap,
} from '../services/runtimeRedaction';
import { persistThreadRehydrationMap } from '../services/rehydrationPersistence';
import { vaultManager, type VaultToolCaller } from '../services/vault';
import { threadVaultDocId } from '../services/rehydrationPersistence';
import { addCustomTerm as addStoredCustomTerm } from '../services/customTerms';

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
export async function rememberRehydration(
  request: {
    threadKey: string;
    map: Record<string, string>;
  },
  deps: PiiGetRehydrationMapDeps = {},
): Promise<{ success: boolean }> {
  const threadKey = request?.threadKey;
  const map = request?.map ?? {};
  if (!threadKey) {
    throw new Error('[pii] threadKey is required');
  }
  mergeRuntimeRehydrationMap(threadKey, map);
  // The gesture writes its token into the saved note, so an original that is
  // only in memory would be lost on restart: report the failure so the
  // caller keeps the cleartext instead of inserting the token.
  try {
    const result = await persistThreadRehydrationMap(threadKey, map, {
      passphrase: deps.passphrase,
      toolManager: deps.toolManager,
    });
    return { success: result.persisted };
  } catch {
    return { success: false };
  }
}

/**
 * Pin a gesture literal for the current workspace. It is stored encrypted in
 * the workspace vault and applied to every later redaction (see
 * services/customTerms.ts) — never written into the workspace itself.
 */
export async function addCustomTerm(
  request: { label: string; value: string },
  deps: PiiGetRehydrationMapDeps = {},
): Promise<{ success: boolean }> {
  const value = (request?.value ?? '').trim();
  if (!value) {
    throw new Error('[pii] Custom term value is required');
  }
  const label = (request?.label ?? '').trim() || 'Custom';
  await addStoredCustomTerm(
    { label, value },
    { passphrase: deps.passphrase, toolManager: deps.toolManager },
  );
  return { success: true };
}
