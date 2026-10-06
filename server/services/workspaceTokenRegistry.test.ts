import { afterEach, describe, expect, test } from 'bun:test';

import {
  clearWorkspaceTokenRegistriesForTests,
  loadWorkspaceTokenRegistry,
  renumberTokens,
  workspaceRegistryDocId,
  WorkspaceTokenRegistry,
  type WorkspaceTokenRegistryDeps,
} from './workspaceTokenRegistry';

function memoryVault(): WorkspaceTokenRegistryDeps & { blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  return {
    blobs,
    exists: (docId) => blobs.has(docId),
    decrypt: async (docId) => JSON.parse(blobs.get(docId) ?? '{}'),
    encrypt: async (map) => JSON.stringify(map),
    write: (docId, blob) => {
      blobs.set(docId, blob);
    },
  };
}

afterEach(() => clearWorkspaceTokenRegistriesForTests());

describe('WorkspaceTokenRegistry', () => {
  test('adopt reuses the token of a known value and numbers new values past every issued one', () => {
    const registry = new WorkspaceTokenRegistry('/ws', { '[PERSON_0]': 'Jean Dupont' }, memoryVault());
    const renumber = registry.adopt({ '[PERSON_0]': 'Paul Martin', '[PERSON_1]': 'Jean Dupont', '[EMAIL_0]': 'a@b.fr' });
    expect(renumber).toEqual({ '[PERSON_0]': '[PERSON_1]', '[PERSON_1]': '[PERSON_0]', '[EMAIL_0]': '[EMAIL_0]' });
    expect(registry.tokens()).toEqual({ '[PERSON_0]': 'Jean Dupont', '[PERSON_1]': 'Paul Martin', '[EMAIL_0]': 'a@b.fr' });
  });

  test('the same value under another category is another token', () => {
    const registry = new WorkspaceTokenRegistry('/ws', {}, memoryVault());
    registry.adopt({ '[PERSON_0]': 'Paris' });
    expect(registry.adopt({ '[LOCATION_0]': 'Paris' })).toEqual({ '[LOCATION_0]': '[LOCATION_0]' });
    expect(Object.keys(registry.tokens())).toHaveLength(2);
  });

  test('record refuses a token already issued for another value', () => {
    const registry = new WorkspaceTokenRegistry('/ws', { '[PERSON_0]': 'Jean Dupont' }, memoryVault());
    registry.record({ '[PERSON_0]': 'Jean Dupont', '[PERSON_1]': 'Marie Curie' });
    expect(registry.valueOf('[PERSON_1]')).toBe('Marie Curie');
    expect(() => registry.record({ '[PERSON_0]': 'Paul Martin' })).toThrow('already stands for another value');
  });

  test('renumberTokens rewrites mapped tokens at once and leaves the rest', () => {
    // A swap must not chain ([PERSON_0] → [PERSON_1] → [PERSON_0]).
    expect(renumberTokens('[PERSON_0] met [PERSON_1] and [EMAIL_3].', { '[PERSON_0]': '[PERSON_1]', '[PERSON_1]': '[PERSON_0]' }))
      .toBe('[PERSON_1] met [PERSON_0] and [EMAIL_3].');
  });

  test('persists to the vault and reloads the same numbering', async () => {
    const vault = memoryVault();
    const first = await loadWorkspaceTokenRegistry('/ws', vault);
    first.adopt({ '[PERSON_0]': 'Jean Dupont' });
    await first.persist();
    expect(vault.blobs.has(workspaceRegistryDocId('/ws'))).toBe(true);
    clearWorkspaceTokenRegistriesForTests();
    const reloaded = await loadWorkspaceTokenRegistry('/ws', vault);
    expect(reloaded.tokens()).toEqual({ '[PERSON_0]': 'Jean Dupont' });
    expect(workspaceRegistryDocId('/ws')).toMatch(/^ws_[0-9a-f]{64}$/);
  });

  test('an unreadable registry rejects instead of starting empty, and is retried', async () => {
    const vault = memoryVault();
    vault.blobs.set(workspaceRegistryDocId('/ws'), 'x');
    let failing = true;
    const deps = { ...vault, decrypt: async (docId: string) => {
      if (failing) throw new Error('key unavailable');
      return vault.decrypt(docId);
    } };
    vault.blobs.set(workspaceRegistryDocId('/ws'), JSON.stringify({ '[PERSON_0]': 'Jean' }));
    await expect(loadWorkspaceTokenRegistry('/ws', deps)).rejects.toThrow('key unavailable');
    failing = false;
    expect((await loadWorkspaceTokenRegistry('/ws', deps)).tokens()).toEqual({ '[PERSON_0]': 'Jean' });
  });

  test('a failed write keeps the changes pending for the next persist', async () => {
    const vault = memoryVault();
    let fail = true;
    const registry = new WorkspaceTokenRegistry('/ws', {}, {
      ...vault,
      encrypt: async (map) => {
        if (fail) throw new Error('vault down');
        return JSON.stringify(map);
      },
    });
    registry.adopt({ '[PERSON_0]': 'Jean' });
    await expect(registry.persist()).rejects.toThrow('vault down');
    fail = false;
    await registry.persist();
    expect(JSON.parse(vault.blobs.get(workspaceRegistryDocId('/ws'))!)).toEqual({ '[PERSON_0]': 'Jean' });
  });
});
