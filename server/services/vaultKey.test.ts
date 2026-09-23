import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  __resetOsSecureStoreForTests,
  __setOsSecureStoreForTests,
  getOrCreateVaultPassphrase,
  resolveVaultKeyPath,
  type OsSecureStore,
} from './vaultKey';

// Reversible stand-in for safeStorage: the tests care about which bytes reach
// the file, not about the OS encryption itself.
const fakeStore: OsSecureStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not encrypted by this store');
    return text.slice(4);
  },
};

const dirs: string[] = [];

function makeUserDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-key-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  __resetOsSecureStoreForTests();
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(path.join(dir, 'vaults'), 0o700);
    } catch {
      // intentionally empty
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getOrCreateVaultPassphrase', () => {
  test('creates a key when none exists and reuses it afterwards', () => {
    __setOsSecureStoreForTests(fakeStore);
    const userDataDir = makeUserDataDir();

    const first = getOrCreateVaultPassphrase({ osStore: fakeStore, userDataDir });
    const second = getOrCreateVaultPassphrase({ osStore: fakeStore, userDataDir });

    expect(first).toBe(second);
    expect(readFileSync(resolveVaultKeyPath(userDataDir), 'utf8')).toBe(`enc:${first}`);
  });

  // chmod cannot revoke the owner's read access on Windows, nor anyone's as
  // root, so the unreadable-directory setup would not actually fail there.
  const canRevokeRead = process.platform !== 'win32' && process.getuid?.() !== 0;
  test.skipIf(!canRevokeRead)('refuses to replace a key it could not read', () => {
    __setOsSecureStoreForTests(fakeStore);
    const userDataDir = makeUserDataDir();
    const keyPath = resolveVaultKeyPath(userDataDir);
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, fakeStore.encryptString('the-existing-key'));
    const before = readFileSync(keyPath);

    // An unreadable directory makes the read fail with EACCES rather than
    // ENOENT; treating that as "no key yet" would overwrite the real key and
    // orphan every vault blob encrypted under it.
    chmodSync(path.dirname(keyPath), 0o000);
    let threw = false;
    try {
      getOrCreateVaultPassphrase({ osStore: fakeStore, userDataDir });
    } catch {
      threw = true;
    }
    chmodSync(path.dirname(keyPath), 0o700);

    expect(threw).toBe(true);
    expect(readFileSync(keyPath)).toEqual(before);
  });

  test('replaces an empty key file left by an interrupted write', () => {
    __setOsSecureStoreForTests(fakeStore);
    const userDataDir = makeUserDataDir();
    const keyPath = resolveVaultKeyPath(userDataDir);
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, Buffer.alloc(0));

    const passphrase = getOrCreateVaultPassphrase({ osStore: fakeStore, userDataDir });

    expect(passphrase.length).toBeGreaterThan(0);
    expect(readFileSync(keyPath, 'utf8')).toBe(`enc:${passphrase}`);
  });
});
