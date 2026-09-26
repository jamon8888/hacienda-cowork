import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  persistThreadRehydrationMap,
  threadVaultDocId,
} from './rehydrationPersistence';
import {
  clearRuntimeRehydrationMaps,
  deleteRuntimeRehydrationMap,
  getRuntimeRehydrationMap,
} from './runtimeRedaction';
import { resolveVaultBlobPath } from './vault';

// The vault tool is an MCP round trip; the double stands in for it so these
// tests exercise the merge-and-persist contract, not basemind.
const encryptingVault = {
  async callTool(_serverId: string, _toolName: string, args: Record<string, any>): Promise<unknown> {
    return {
      structuredContent: {
        result: { encrypted_blob: Buffer.from(JSON.stringify(args.map), 'utf8').toString('base64') },
      },
    };
  },
};

const dirs: string[] = [];

function useTempUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehydration-persist-'));
  dirs.push(dir);
  process.env.INTERPRETER_USER_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  clearRuntimeRehydrationMaps();
  delete process.env.INTERPRETER_USER_DATA_DIR;
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('persistThreadRehydrationMap', () => {
  test('writes a blob a later reveal can find, keyed by thread', async () => {
    const dir = useTempUserData();

    const result = await persistThreadRehydrationMap(
      'thread-a',
      { '[EMAIL_0]': 'jane@example.com' },
      { passphrase: 'test-passphrase', toolManager: encryptingVault },
    );

    expect(result).toEqual({ persisted: true, tokenCount: 1 });
    expect(fs.existsSync(resolveVaultBlobPath(threadVaultDocId('thread-a'), dir))).toBe(true);
  });

  test('merges the composer map with what the runtime path already redacted', async () => {
    useTempUserData();
    // Stands in for a file-read redaction that already happened this thread.
    await persistThreadRehydrationMap(
      'thread-b',
      { '[EMAIL_0]': 'from-a-file@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    const result = await persistThreadRehydrationMap(
      'thread-b',
      { '[PHONE_0]': '+33123456789' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    // One blob per thread has to hold both, since a reveal cannot know which
    // path produced the token it is asked about.
    expect(result).toEqual({ persisted: true, tokenCount: 2 });
    expect(getRuntimeRehydrationMap('thread-b')).toEqual({
      '[EMAIL_0]': 'from-a-file@example.com',
      '[PHONE_0]': '+33123456789',
    });
  });

  test('reports an unavailable OS store without throwing, so the send is never blocked', async () => {
    useTempUserData();
    const failingVault = {
      async callTool(): Promise<unknown> {
        throw new Error(
          '[vault] OS credential store is unavailable, so vault persistence is disabled. '
          + 'Nothing was stored or recovered with the vault key; '
          + 'restart with the OS keychain available to enable encrypted persistence.',
        );
      },
    };

    const result = await persistThreadRehydrationMap(
      'thread-c',
      { '[EMAIL_0]': 'jane@example.com' },
      { passphrase: 'p', toolManager: failingVault },
    );

    expect(result.persisted).toBe(false);
    expect(result.persisted === false && result.reason).toBe('os-store-unavailable');
    // The map still resolves for the rest of the session.
    expect(getRuntimeRehydrationMap('thread-c')).toEqual({ '[EMAIL_0]': 'jane@example.com' });
  });

  test('separates a write failure from a degraded OS store', async () => {
    useTempUserData();
    const brokenVault = {
      async callTool(): Promise<unknown> {
        throw new Error('basemind vault tool exploded');
      },
    };

    const result = await persistThreadRehydrationMap(
      'thread-d',
      { '[EMAIL_0]': 'jane@example.com' },
      { passphrase: 'p', toolManager: brokenVault },
    );

    expect(result.persisted === false && result.reason).toBe('write-failed');
  });

  test('a send with no thread id yet keeps its map in memory instead of failing', async () => {
    useTempUserData();

    const result = await persistThreadRehydrationMap(
      '',
      { '[EMAIL_0]': 'jane@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    expect(result.persisted).toBe(false);
  });

  test('a token already issued keeps its value when a later send reuses the label', async () => {
    useTempUserData();
    // Turn one, before the thread had an id, lands under the id once assigned.
    await persistThreadRehydrationMap(
      'thread-f',
      { '[EMAIL_0]': 'alice@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    // A later turn that re-minted the same label would overwrite it, and the
    // first message's token would then reveal the wrong address. The composer
    // reserves issued tokens to prevent this; the store keeps whichever value
    // it is given, so this pins the merge direction the composer relies on.
    const result = await persistThreadRehydrationMap(
      'thread-f',
      { '[EMAIL_1]': 'bob@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    expect(result).toEqual({ persisted: true, tokenCount: 2 });
    expect(getRuntimeRehydrationMap('thread-f')).toEqual({
      '[EMAIL_0]': 'alice@example.com',
      '[EMAIL_1]': 'bob@example.com',
    });
  });

  test('honours the tombstone: a thread deleted mid-send is not recreated', async () => {
    useTempUserData();
    deleteRuntimeRehydrationMap('thread-e');

    const result = await persistThreadRehydrationMap(
      'thread-e',
      { '[EMAIL_0]': 'jane@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );

    // Nothing to persist, and nothing left behind for a deleted thread.
    expect(result).toEqual({ persisted: true, tokenCount: 0 });
    expect(getRuntimeRehydrationMap('thread-e')).toEqual({});
  });
});
