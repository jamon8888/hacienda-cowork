/**
 * One token per value across a Safe workspace.
 *
 * Two producers number tokens: safe-sync redacts each mirror file on its own
 * (basemind `redact_text`), and runtime redaction tokenizes the conversation
 * per thread. Numbered independently, `[PERSON_0]` in one contract and
 * `[PERSON_0]` in another — or in the lawyer's message — could be different
 * people, and rehydrating a draft that cites both would put the wrong name in
 * a deed. The registry is the single numbering both draw from (integration
 * spec §3 row 23: PII scope is the workspace): a value keeps one token
 * everywhere in the workspace, and different values never share one.
 *
 * Token → value pairs are encrypted in the vault like every rehydration map
 * (`ws_<sha256>` blob, never touched by the thread GC). Assignment is
 * synchronous on the in-memory copy, so callers that allocate between two
 * awaits cannot interleave; persistence is serialized per workspace.
 */

import { createHash } from 'node:crypto';

const TOKEN_SHAPE = /^\[([A-Z_]+)_(\d+)\]$/;
const TOKEN_IN_TEXT = /\[[A-Z_]+_\d+\]/g;

export interface WorkspaceTokenRegistryDeps {
  exists: (docId: string) => boolean;
  decrypt: (docId: string) => Promise<Record<string, string>>;
  encrypt: (map: Record<string, string>) => Promise<string>;
  write: (docId: string, blob: string) => void;
}

async function defaultDeps(): Promise<WorkspaceTokenRegistryDeps> {
  // Lazy: the vault reaches ToolManager, which loads runtime redaction.
  const { persistEncryptedBlob, resolveVaultBlobPath, vaultManager } = await import('./vault');
  const { existsSync } = await import('node:fs');
  return {
    exists: (docId) => existsSync(resolveVaultBlobPath(docId)),
    decrypt: (docId) => vaultManager.decrypt(docId),
    encrypt: (map) => vaultManager.encrypt(map),
    write: (docId, blob) => {
      persistEncryptedBlob(docId, blob);
    },
  };
}

/** Vault blob id for a workspace's registry; fits `sanitizeVaultDocId`. */
export function workspaceRegistryDocId(workspacePath: string): string {
  return `ws_${createHash('sha256').update(workspacePath).digest('hex')}`;
}

function labelOf(token: string): string | null {
  return TOKEN_SHAPE.exec(token)?.[1] ?? null;
}

export class WorkspaceTokenRegistry {
  private readonly byToken = new Map<string, string>();
  private readonly byLabelValue = new Map<string, string>();
  private persistChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    readonly workspacePath: string,
    entries: Record<string, string>,
    private readonly deps: WorkspaceTokenRegistryDeps,
  ) {
    for (const [token, value] of Object.entries(entries)) this.set(token, value);
  }

  private set(token: string, value: string): void {
    const label = labelOf(token);
    if (!label) return;
    this.byToken.set(token, value);
    const key = `${label}\u0000${value}`;
    if (!this.byLabelValue.has(key)) this.byLabelValue.set(key, token);
  }

  /** Token → value for every token the workspace has issued. */
  tokens(): Record<string, string> {
    return Object.fromEntries(this.byToken);
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token);
  }

  private allocate(label: string): string {
    for (let index = 0; ; index += 1) {
      const token = `[${label}_${index}]`;
      if (!this.byToken.has(token)) return token;
    }
  }

  /**
   * Map tokens a source numbered on its own (one mirror file) onto workspace
   * tokens: a known value takes its existing token, a new value the next free
   * one. Returns source token → workspace token.
   */
  adopt(sourceMap: Record<string, string>): Record<string, string> {
    const renumber: Record<string, string> = {};
    for (const [sourceToken, value] of Object.entries(sourceMap)) {
      const label = labelOf(sourceToken);
      if (!label) continue;
      let token = this.byLabelValue.get(`${label}\u0000${value}`);
      if (!token) {
        token = this.allocate(label);
        this.set(token, value);
        this.dirty = true;
      }
      renumber[sourceToken] = token;
    }
    return renumber;
  }

  /**
   * Record tokens allocated against this registry's tokens (passed as
   * reserved), so they are new by construction. A token already issued for
   * another value is a numbering bug and refuses rather than corrupt the map.
   */
  record(map: Record<string, string>): void {
    for (const [token, value] of Object.entries(map)) {
      const existing = this.byToken.get(token);
      if (existing === value) continue;
      if (existing !== undefined) {
        throw new Error(`[token-registry] ${token} already stands for another value`);
      }
      this.set(token, value);
      this.dirty = true;
    }
  }

  /** Write the registry to the vault; serialized, and a no-op when unchanged. */
  persist(options: { force?: boolean } = {}): Promise<void> {
    const run = this.persistChain.then(async () => {
      if (!this.dirty && !options.force) return;
      this.dirty = false;
      try {
        const blob = await this.deps.encrypt(this.tokens());
        this.deps.write(workspaceRegistryDocId(this.workspacePath), blob);
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    this.persistChain = run.catch(() => {});
    return run;
  }
}

/** Rewrite every token of `text` that `renumber` maps; other text is untouched. */
export function renumberTokens(text: string, renumber: Record<string, string>): string {
  return text.replace(TOKEN_IN_TEXT, (token) => renumber[token] ?? token);
}

const registries = new Map<string, Promise<WorkspaceTokenRegistry>>();

/**
 * The workspace's registry, loaded once per process. A blob that exists but
 * cannot be read rejects (and is retried on the next call): starting from an
 * empty registry would reissue tokens the mirrors already use.
 */
export function loadWorkspaceTokenRegistry(
  workspacePath: string,
  deps?: WorkspaceTokenRegistryDeps,
): Promise<WorkspaceTokenRegistry> {
  const docId = workspaceRegistryDocId(workspacePath);
  const cached = registries.get(docId);
  if (cached) return cached;
  const loading = (async () => {
    const resolved = deps ?? await defaultDeps();
    const entries = resolved.exists(docId) ? await resolved.decrypt(docId) : {};
    return new WorkspaceTokenRegistry(workspacePath, entries, resolved);
  })();
  registries.set(docId, loading);
  loading.catch(() => {
    if (registries.get(docId) === loading) registries.delete(docId);
  });
  return loading;
}

/** True once the workspace has a registry on disk (mirrors were numbered on it). */
export async function hasPersistedWorkspaceTokenRegistry(
  workspacePath: string,
  deps?: WorkspaceTokenRegistryDeps,
): Promise<boolean> {
  const resolved = deps ?? await defaultDeps();
  return resolved.exists(workspaceRegistryDocId(workspacePath));
}

export function clearWorkspaceTokenRegistriesForTests(): void {
  registries.clear();
}
