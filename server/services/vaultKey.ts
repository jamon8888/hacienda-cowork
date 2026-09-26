/**
 * Vault data-protection key — one random 32-byte key per vault directory
 * (workspace-segmented, legacy root when no workspace is active), guarded by
 * the OS credential store via Electron safeStorage.
 *
 * The key file under the vault directory only ever holds OS-encrypted bytes,
 * never plaintext. Where the OS store is unavailable, every entry point throws
 * a clear degraded error instead of silently skipping persistence.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveUserDataDir, resolveVaultDir } from './vault';

export interface OsSecureStore {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

let osSecureStoreForTests: OsSecureStore | null | undefined;

export function __setOsSecureStoreForTests(store: OsSecureStore | null): void {
  osSecureStoreForTests = store;
}

export function __resetOsSecureStoreForTests(): void {
  osSecureStoreForTests = undefined;
}

/** Lazily resolve Electron safeStorage; null when the OS store is unavailable. */
export function getOsSecureStore(): OsSecureStore | null {
  if (osSecureStoreForTests !== undefined) return osSecureStoreForTests;
  if (!process.versions.electron) return null;
  // Lazy load electron so browser mode can still typecheck.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync Electron API in lazy-load guard
  const electron = require('electron') as { safeStorage?: OsSecureStore };
  const store = electron.safeStorage;
  if (!store || typeof store.isEncryptionAvailable !== 'function') return null;
  if (!store.isEncryptionAvailable()) return null;
  return store;
}

export const VAULT_DEGRADED_MESSAGE =
  '[vault] OS credential store is unavailable, so vault persistence is disabled. ' +
  'Nothing was stored or recovered with the vault key; ' +
  'restart with the OS keychain available to enable encrypted persistence.';

export function resolveVaultKeyPath(userDataDir = resolveUserDataDir()): string {
  return path.join(resolveVaultDir(userDataDir), '.vault-key.enc');
}

function requireOsSecureStore(override?: OsSecureStore | null): OsSecureStore {
  const store = override !== undefined ? override : getOsSecureStore();
  if (!store) throw new Error(VAULT_DEGRADED_MESSAGE);
  return store;
}

export function getOrCreateVaultPassphrase(overrides?: {
  osStore?: OsSecureStore | null;
  userDataDir?: string;
}): string {
  const store = requireOsSecureStore(overrides?.osStore);
  const keyPath = resolveVaultKeyPath(overrides?.userDataDir ?? resolveUserDataDir());
  const stored = readVaultKeyFile(keyPath);
  if (stored && stored.length > 0) {
    try {
      return store.decryptString(stored);
    } catch {
      throw new Error(
        '[vault] Stored vault key cannot be unlocked with the OS credential store; ' +
          'it may belong to another user or machine.',
      );
    }
  }
  const passphrase = randomBytes(32).toString('base64');
  const encrypted = store.encryptString(passphrase);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  // An empty file is an interrupted write holding nothing to lose, so it may be
  // truncated. Otherwise `wx` fails rather than overwrite: a key written between
  // the read above and this write must win, or its vaults would be orphaned.
  const exclusive = stored === null;
  try {
    // ponytail: 0600 narrows file access; secrecy itself comes from OS encryption, not the mode bit.
    fs.writeFileSync(keyPath, encrypted, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = readVaultKeyFile(keyPath);
    if (!raced || raced.length === 0) {
      fs.writeFileSync(keyPath, encrypted, { mode: 0o600, flag: 'w' });
      return passphrase;
    }
    return store.decryptString(raced);
  }
  return passphrase;
}

/**
 * Only a missing file means "no key yet". A permission or I/O failure read as
 * absence would send the caller on to mint a replacement and overwrite the real
 * key, leaving every existing vault blob undecryptable.
 */
function readVaultKeyFile(keyPath: string): Buffer | null {
  try {
    return fs.readFileSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
