import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addCustomTerm, getRehydrationMap, rememberRehydration } from './pii';
import {
  clearRuntimeRehydrationMaps,
  getRuntimeRehydrationMap,
  mergeRuntimeRehydrationMap,
} from '../services/runtimeRedaction';
import { persistThreadRehydrationMap } from '../services/rehydrationPersistence';
import { resolveVaultBlobPath } from '../services/vault';
import { setCurrentWorkspace } from '../utils/workspace';

// Vault MCP is a round trip; the double stands in so these tests exercise the
// handler contract, not basemind.
const encryptingVault = {
  async callTool(_serverId: string, _toolName: string, args: Record<string, any>): Promise<unknown> {
    return {
      structuredContent: {
        result: {
          encrypted_blob: Buffer.from(JSON.stringify(args.map), 'utf8').toString('base64'),
        },
      },
    };
  },
};

const dirs: string[] = [];
const workspaces: string[] = [];

function useTempUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-handler-user-'));
  dirs.push(dir);
  process.env.INTERPRETER_USER_DATA_DIR = dir;
  return dir;
}

function useTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-handler-ws-'));
  workspaces.push(dir);
  setCurrentWorkspace(dir);
  return dir;
}

afterEach(() => {
  clearRuntimeRehydrationMaps();
  delete process.env.INTERPRETER_USER_DATA_DIR;
  setCurrentWorkspace(null);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pii.getRehydrationMap', () => {
  test('merges the in-memory session map with the persisted vault blob', async () => {
    useTempUserData();
    await persistThreadRehydrationMap(
      'thread-reveal',
      { '[EMAIL_0]': 'persisted@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );
    mergeRuntimeRehydrationMap('thread-reveal', { '[PHONE_0]': '+33123456789' });

    const map = await getRehydrationMap(
      { threadKey: 'thread-reveal' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );

    expect(map).toEqual({
      '[EMAIL_0]': 'persisted@example.com',
      '[PHONE_0]': '+33123456789',
    });
  });

  test('returns the session map when no vault blob exists', async () => {
    useTempUserData();
    mergeRuntimeRehydrationMap('thread-session-only', { '[NAME_0]': 'Ada Lovelace' });

    const map = await getRehydrationMap(
      { threadKey: 'thread-session-only' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );

    expect(map).toEqual({ '[NAME_0]': 'Ada Lovelace' });
  });

  test('returns an empty map for an unknown thread', async () => {
    useTempUserData();
    const map = await getRehydrationMap(
      { threadKey: 'thread-unknown' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );
    expect(map).toEqual({});
  });
});

describe('pii.rememberRehydration', () => {
  test('merges into the session store so a later get sees the gesture', async () => {
    useTempUserData();

    const result = await rememberRehydration({
      threadKey: 'noteabc123',
      map: { '[NAME_0]': 'Ada Lovelace' },
    });

    expect(result.success).toBe(true);
    expect(getRuntimeRehydrationMap('noteabc123')).toEqual({ '[NAME_0]': 'Ada Lovelace' });
  });

  test('throws when threadKey is missing', async () => {
    await expect(rememberRehydration({ threadKey: '', map: {} })).rejects.toThrow(/threadKey/);
  });
});

describe('pii.addCustomTerm', () => {
  test('writes a custom term into the workspace basemind.toml', async () => {
    const workspace = useTempWorkspace();

    const result = await addCustomTerm({ label: 'Custom', value: 'Project Hacienda' });

    expect(result.success).toBe(true);
    const configPath = path.join(workspace, 'basemind.toml');
    expect(fs.existsSync(configPath)).toBe(true);
    const written = fs.readFileSync(configPath, 'utf8');
    expect(written).toContain('Project Hacienda');
    expect(written).toContain('[documents.redaction');
  });

  test('appends to an existing custom_terms array without duplicating', async () => {
    const workspace = useTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, 'basemind.toml'),
      [
        '"$schema" = "v1"',
        '',
        '[documents.redaction]',
        'enabled = true',
        'custom_terms = [',
        '  { label = "Custom", value = "Already Here", case_sensitive = false },',
        ']',
        '',
      ].join('\n'),
      'utf8',
    );

    await addCustomTerm({ label: 'Custom', value: 'Already Here' });
    await addCustomTerm({ label: 'Custom', value: 'New Term' });

    const written = fs.readFileSync(path.join(workspace, 'basemind.toml'), 'utf8');
    expect(written.match(/Already Here/g)).toHaveLength(1);
    expect(written.match(/New Term/g)).toHaveLength(1);
  });

  test('falls back to the legacy .basemind config when root has none', async () => {
    const workspace = useTempWorkspace();
    const legacyDir = path.join(workspace, '.basemind');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'basemind.toml'),
      '"$schema" = "v1"\n',
      'utf8',
    );

    const result = await addCustomTerm({ label: 'Custom', value: 'Legacy Path Term' });

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(path.join(legacyDir, 'basemind.toml'));
    expect(fs.readFileSync(path.join(legacyDir, 'basemind.toml'), 'utf8')).toContain(
      'Legacy Path Term',
    );
    expect(fs.existsSync(path.join(workspace, 'basemind.toml'))).toBe(false);
  });

  test('throws when no workspace is open', async () => {
    setCurrentWorkspace(null);
    await expect(addCustomTerm({ label: 'Custom', value: 'x' })).rejects.toThrow(/workspace/i);
  });
});
