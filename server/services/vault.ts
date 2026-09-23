/**
 * PII vault access — reads the caller-persisted encrypted rehydration blob
 * and decrypts it through basemind's `vault` MCP tool.
 *
 * basemind stays stateless here: the encrypted blob lives at
 * `{userData}/vaults/<workspace-segment>/{docId}.enc` (legacy root when no
 * workspace is active) and only the decrypted map for the requested document
 * is ever returned to the renderer.
 */

import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';

import { ToolManager } from '../tools/toolManager';
import { getOrCreateVaultPassphrase } from './vaultKey';
import { getAppMcpOwnerThreadId } from './appMcpThread';
import { runOrphanBlobGcOnce } from './vaultGc';
import { broadcastEvent } from '../handlers/broadcast';
import { listAllThreadIds } from '../handlers/agentThreads';
import { getCodexService, THREAD_LIST_DEFAULTS } from '../../src/lib/codex/service';
import { getCurrentWorkspace } from '../utils/workspace';
import { workspaceVaultSegment } from '../../src/lib/pii/vaultScope';
export { runOrphanBlobGcOnce, resetGcFlagForTests } from './vaultGc';

let gcTriggered = false;

async function triggerOrphanGcIfFirstAccess(): Promise<void> {
  if (gcTriggered) return;
  gcTriggered = true;
  try {
    const service = getCodexService();
    const threadIds = await listAllThreadIds(service, THREAD_LIST_DEFAULTS);
    const { cleaned } = runOrphanBlobGcOnce({ activeThreadIds: threadIds });
    if (cleaned > 0) {
      broadcastEvent('vault:orphan-blobs-cleaned', { count: cleaned });
    }
  } catch {
    // GC failure is non-fatal; swallow silently
  }
}

export function sanitizeVaultDocId(docId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
    throw new Error('[vault] Invalid document id for rehydration lookup');
  }
  return docId;
}

export function resolveUserDataDir(): string {
  const override = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (override) return override;
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync Electron API in lazy-load guard
    const { app } = require('electron') as { app: { getPath(name: 'userData'): string } };
    return app.getPath('userData');
  }
  return path.join(homedir(), '.interpreter');
}

/**
 * Vault directory for the current workspace: `{userData}/vaults/<segment>/`
 * when a workspace is active, the legacy `{userData}/vaults/` root otherwise.
 * Key and blobs stay together, so switching workspaces never re-reads another
 * workspace's secrets.
 */
export function resolveVaultDir(userDataDir = resolveUserDataDir()): string {
  const workspace = getCurrentWorkspace();
  if (!workspace) return path.join(userDataDir, 'vaults');
  return path.join(userDataDir, 'vaults', workspaceVaultSegment(workspace));
}

export function resolveVaultBlobPath(docId: string, userDataDir = resolveUserDataDir()): string {
  return path.join(resolveVaultDir(userDataDir), `${sanitizeVaultDocId(docId)}.enc`);
}

export function deleteVaultBlob(docId: string, userDataDir?: string): void {
  const safeId = sanitizeVaultDocId(docId);
  const blobPath = resolveVaultBlobPath(safeId, userDataDir);
  if (fs.existsSync(blobPath)) {
    fs.rmSync(blobPath);
  }
}

export function deleteVaultBlobPath(fullPath: string): void {
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath);
  }
}

/** All `*.enc` blobs under the vaults root, one level into workspace segments. */
export function listVaultBlobs(userDataDir?: string): Array<{ docId: string; fullPath: string }> {
  const root = path.join(userDataDir ?? resolveUserDataDir(), 'vaults');
  if (!fs.existsSync(root)) return [];
  const blobs: Array<{ docId: string; fullPath: string }> = [];
  const scan = (dir: string): void => {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.enc') || file === '.vault-key.enc') continue;
      const fullPath = path.join(dir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      blobs.push({ docId: file.slice(0, -4), fullPath });
    }
  };
  scan(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) scan(path.join(root, entry.name));
  }
  return blobs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Extract the decrypted token→original map from a basemind `vault` tool result. */
export function extractRehydrationMap(result: unknown): Record<string, string> {
  const record = asRecord(result) ?? {};
  const structured = asRecord(record.structuredContent) ?? record;
  const payload = asRecord(structured.result) ?? structured;
  const candidates = [payload.map, payload.rehydration_map, payload];
  for (const candidate of candidates) {
    const map = asRecord(candidate);
    if (!map) continue;
    const entries = Object.entries(map).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (entries.length > 0) return Object.fromEntries(entries);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const block of content) {
    const text = asRecord(block)?.text;
    if (typeof text !== 'string') continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const map = asRecord(parsed) ?? asRecord(asRecord(parsed)?.result);
      if (!map) continue;
      const entries = Object.entries(map).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      );
      if (entries.length > 0) return Object.fromEntries(entries);
    } catch {
      continue;
    }
  }
  return {};
}

export interface VaultToolCaller {
  callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<unknown>;
}

/**
 * The owner thread exists to satisfy the approval gate in
 * `ToolManager.callTool`, which refuses an MCP call with no thread context.
 * An injected double has no gate, and resolving the thread anyway reaches for
 * the real app-server — which is why tests that pass a double must not pay for
 * it. Production never passes one, so the gate is never skipped in the app.
 */
async function callVaultTool(
  args: Record<string, unknown>,
  toolManager?: VaultToolCaller,
): Promise<unknown> {
  if (toolManager) {
    return toolManager.callTool('basemind', 'vault', args);
  }
  return new ToolManager().callTool(
    'basemind',
    'vault',
    args,
    undefined,
    undefined,
    { threadId: await getAppMcpOwnerThreadId() },
  );
}

/**
 * `encrypt` defaults to the OS-guarded vault key, so a blob written through the
 * default path can only be reopened with that same key. Requiring the caller to
 * supply a passphrase made those blobs undecryptable from the renderer, which
 * has no access to the OS-protected secret. Decryption now mirrors encryption:
 * an explicit passphrase when one was used, the OS key otherwise.
 */
async function decrypt(
  docId: string,
  explicitPassphrase?: string,
  toolManager?: VaultToolCaller,
): Promise<Record<string, string>> {
  await triggerOrphanGcIfFirstAccess();
  const passphrase = explicitPassphrase || getOrCreateVaultPassphrase();
  if (!passphrase) throw new Error('[vault] No vault key available to decrypt a rehydration map');
  const blobPath = resolveVaultBlobPath(docId);
  let encryptedBlob: string;
  try {
    encryptedBlob = fs.readFileSync(blobPath, 'utf8').trim();
  } catch {
    throw new Error('[vault] No stored rehydration map for this document');
  }
  if (!encryptedBlob) throw new Error('[vault] Stored rehydration map is empty');
  const raw = await callVaultTool(
    { mode: 'decrypt', encrypted_blob: encryptedBlob, passphrase },
    toolManager,
  );
  const map = extractRehydrationMap(raw);
  if (Object.keys(map).length === 0) {
    throw new Error('[vault] Decryption returned no entries; check the passphrase');
  }
  return map;
}

/** Extract the base64 encrypted blob from a basemind `vault` encrypt result. */
export function extractEncryptedBlob(result: unknown): string {
  const record = asRecord(result) ?? {};
  const structured = asRecord(record.structuredContent) ?? record;
  const payload = asRecord(structured.result) ?? structured;
  const candidates = [payload.encrypted_blob, payload.encryptedBlob, payload.blob, payload.data];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const block of content) {
    const text = asRecord(block)?.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return trimmed;
    try {
      const blob = extractEncryptedBlob(JSON.parse(trimmed) as unknown);
      if (blob) return blob;
    } catch {
      continue;
    }
  }
  return '';
}

export interface VaultEncryptOptions {
  /** Explicit passphrase; defaults to the OS-guarded vault data-protection key. */
  passphrase?: string;
  /** Injectable ToolManager double for tests. */
  toolManager?: VaultToolCaller;
}

async function encrypt(
  map: Record<string, string>,
  options: VaultEncryptOptions = {},
): Promise<string> {
  const passphrase = options.passphrase ?? getOrCreateVaultPassphrase();
  if (!passphrase) throw new Error('[vault] Passphrase is required to encrypt a rehydration map');
  const raw = await callVaultTool({ mode: 'encrypt', map, passphrase }, options.toolManager);
  const blob = extractEncryptedBlob(raw);
  if (!blob) throw new Error('[vault] Encryption returned no blob');
  return blob;
}

/** Write an encrypted blob to the current vault directory; returns the path. */
export function persistEncryptedBlob(docId: string, blob: string, userDataDir = resolveUserDataDir()): string {
  if (!blob) throw new Error('[vault] Cannot persist an empty encrypted blob');
  // Fire-and-forget: GC is async but this method is sync.
  // The gcTriggered flag ensures it runs at most once per session.
  triggerOrphanGcIfFirstAccess();
  const blobPath = resolveVaultBlobPath(docId, userDataDir);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, blob, 'utf8');
  return blobPath;
}

export const vaultManager = { decrypt, encrypt, persistEncryptedBlob };
