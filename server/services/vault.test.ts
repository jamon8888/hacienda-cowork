import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteVaultBlob,
  extractRehydrationMap,
  listVaultBlobs,
  resolveVaultBlobPath,
  sanitizeVaultDocId,
  vaultManager,
} from './vault';
import { setCurrentWorkspace } from '../utils/workspace';
import { workspaceVaultSegment } from '../../src/lib/pii/vaultScope';

describe('sanitizeVaultDocId', () => {
  test('accepts safe document ids', () => {
    expect(sanitizeVaultDocId('doc-123_ABC')).toBe('doc-123_ABC');
  });

  test('rejects traversal and empty ids', () => {
    expect(() => sanitizeVaultDocId('../vaults/other')).toThrow();
    expect(() => sanitizeVaultDocId('')).toThrow();
  });
});

describe('resolveVaultBlobPath', () => {
  test('keeps blobs inside the vaults directory when no workspace is active', () => {
    expect(resolveVaultBlobPath('doc-1', '/data/user')).toBe('/data/user/vaults/doc-1.enc');
  });

  test('scopes blobs under the active workspace segment', () => {
    setCurrentWorkspace('/ws/alpha');
    try {
      const segment = workspaceVaultSegment('/ws/alpha');
      expect(resolveVaultBlobPath('doc-1', '/data/user')).toBe(
        `/data/user/vaults/${segment}/doc-1.enc`,
      );
    } finally {
      setCurrentWorkspace(null);
    }
  });
});

describe('extractRehydrationMap', () => {
  test('reads the decrypted map from structured results', () => {
    expect(
      extractRehydrationMap({ structuredContent: { result: { map: { '[EMAIL_0]': 'a@b.c' } } } }),
    ).toEqual({ '[EMAIL_0]': 'a@b.c' });
  });

  test('returns empty map when nothing decrypted', () => {
    expect(extractRehydrationMap(null)).toEqual({});
  });
});

// #114: session rehydration maps persist to the encrypted vault gated on an
// explicit passphrase. These tests pin the vault-service seam contract:
// encrypt under a passphrase, reload from disk, decrypt to the same map —
// and every failure mode throws (fail closed) so callers degrade to
// tokens-without-reveal instead of resending raw PII. Nothing here wires
// persistence into the send path: that waits on the passphrase UX decision,
// and the composer handoff plus session-lifetime notice ride with the v1
// composer work (#102–#104).

/** In-test basemind `vault` tool double: base64(JSON) stands in for ciphertext. */
function stubBasemindVault() {
  return {
    async callTool(_serverId: string, toolName: string, args: Record<string, any>): Promise<unknown> {
      if (toolName !== 'vault') throw new Error(`unexpected tool ${toolName}`);
      if (args.mode === 'encrypt') {
        return {
          structuredContent: {
            result: { encrypted_blob: Buffer.from(JSON.stringify(args.map), 'utf8').toString('base64') },
          },
        };
      }
      if (args.mode === 'decrypt') {
        const json = Buffer.from(String(args.encrypted_blob), 'base64').toString('utf8');
        return { structuredContent: { result: { map: JSON.parse(json) as unknown } } };
      }
      throw new Error(`unexpected mode ${String(args.mode)}`);
    },
  };
}

describe('vault rehydration round-trip', () => {
  let userDataDir = '';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.INTERPRETER_USER_DATA_DIR;
    userDataDir = mkdtempSync(join(tmpdir(), 'vault-roundtrip-'));
    process.env.INTERPRETER_USER_DATA_DIR = userDataDir;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
    else process.env.INTERPRETER_USER_DATA_DIR = savedEnv;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('encrypt under a test passphrase, reload, decrypt to the same map', async () => {
    const map = { '[EMAIL_0]': 'john@example.com', '[NAME_0]': 'Jane Doe' };
    const blob = await vaultManager.encrypt(map, {
      passphrase: 'test-passphrase',
      toolManager: stubBasemindVault(),
    });
    vaultManager.persistEncryptedBlob('doc-1', blob);
    // "Reload": a fresh decrypt re-reads the blob from disk.
    const roundTripped = await vaultManager.decrypt('doc-1', 'test-passphrase', stubBasemindVault());
    expect(roundTripped).toEqual(map);
  });

  test('missing blob fails closed', async () => {
    await expect(vaultManager.decrypt('no-such-doc', 'test-passphrase', stubBasemindVault())).rejects.toThrow(
      'No stored rehydration map',
    );
  });

  test('corrupt blob fails closed (throws; caller keeps tokens-without-reveal)', async () => {
    vaultManager.persistEncryptedBlob('doc-corrupt', '!!!not-a-ciphertext!!!');
    const undecryptableVault = {
      async callTool(_serverId: string, _toolName: string, _args: Record<string, any>): Promise<unknown> {
        return { structuredContent: { result: { map: {} } } };
      },
    };
    await expect(vaultManager.decrypt('doc-corrupt', 'test-passphrase', undecryptableVault)).rejects.toThrow(
      'no entries',
    );
  });

  test('wrong passphrase yields no entries (caller keeps tokens-without-reveal)', async () => {
    const blob = await vaultManager.encrypt(
      { '[EMAIL_0]': 'john@example.com' },
      { passphrase: 'test-passphrase', toolManager: stubBasemindVault() },
    );
    vaultManager.persistEncryptedBlob('doc-2', blob);
    const wrongKeyVault = {
      async callTool(_serverId: string, _toolName: string, _args: Record<string, any>): Promise<unknown> {
        return { structuredContent: { result: { map: {} } } };
      },
    };
    await expect(vaultManager.decrypt('doc-2', 'wrong-passphrase', wrongKeyVault)).rejects.toThrow(
      'no entries',
    );
  });

  test('persist refuses an empty blob', () => {
    expect(() => vaultManager.persistEncryptedBlob('doc-3', '')).toThrow('empty encrypted blob');
  });

  test('encrypt surfaces an empty-blob tool result as a throw', async () => {
    const emptyVault = {
      async callTool(): Promise<unknown> {
        return { structuredContent: { result: {} } };
      },
    };
    await expect(
      vaultManager.encrypt({ '[EMAIL_0]': 'a@b.c' }, { passphrase: 'test-passphrase', toolManager: emptyVault }),
    ).rejects.toThrow('no blob');
  });
});

describe('deleteVaultBlob', () => {
  test('removes the .enc file for a valid doc id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-gc-'));
    const blobPath = join(dir, 'vaults', 'thread-abc.enc');
    mkdirSync(join(dir, 'vaults'), { recursive: true });
    writeFileSync(blobPath, 'encrypted');
    deleteVaultBlob('thread-abc', dir);
    expect(existsSync(blobPath)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test('is a no-op when the blob does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-gc-'));
    mkdirSync(join(dir, 'vaults'), { recursive: true });
    expect(() => deleteVaultBlob('thread-nonexistent', dir)).not.toThrow();
    rmSync(dir, { recursive: true });
  });

  test('rejects invalid doc ids', () => {
    expect(() => deleteVaultBlob('../escape', '/tmp')).toThrow();
  });
});

describe('listVaultBlobs', () => {
  test('returns blobs from the root and each workspace segment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-gc-'));
    const vaultsDir = join(dir, 'vaults');
    mkdirSync(join(vaultsDir, 'deadbeef'), { recursive: true });
    writeFileSync(join(vaultsDir, 'thread-aaa.enc'), 'a');
    writeFileSync(join(vaultsDir, '.vault-key.enc'), 'k');
    writeFileSync(join(vaultsDir, 'deadbeef', 'thread-ccc.enc'), 'c');
    writeFileSync(join(vaultsDir, 'deadbeef', '.vault-key.enc'), 'k2');
    writeFileSync(join(vaultsDir, 'not-a-blob.txt'), 'x');
    const blobs = listVaultBlobs(dir);
    expect(blobs.map((b) => b.docId).sort()).toEqual(['thread-aaa', 'thread-ccc']);
    expect(blobs.find((b) => b.docId === 'thread-ccc')?.fullPath).toBe(
      join(vaultsDir, 'deadbeef', 'thread-ccc.enc'),
    );
    rmSync(dir, { recursive: true });
  });

  test('returns empty array when vaults directory does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-gc-'));
    expect(listVaultBlobs(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});
