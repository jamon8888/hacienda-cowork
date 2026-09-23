import { describe, expect, test } from 'bun:test';

import { noteRehydrationKey, threadVaultDocId } from './vaultScope';

describe('noteRehydrationKey', () => {
  test('is stable for the same path', () => {
    expect(noteRehydrationKey('/workspace/note.md')).toBe(noteRehydrationKey('/workspace/note.md'));
  });

  test('differs for different paths', () => {
    expect(noteRehydrationKey('/workspace/a.md')).not.toBe(noteRehydrationKey('/workspace/b.md'));
  });

  test('produces a sanitizeVaultDocId-safe key', () => {
    const key = noteRehydrationKey('/workspace/My Folder/note with spaces.md');
    expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(key.startsWith('note')).toBe(true);
  });

  test('threadVaultDocId wraps the note key for the vault blob', () => {
    const key = noteRehydrationKey('/workspace/note.md');
    expect(threadVaultDocId(key)).toBe(`thread-${key}`);
    expect(threadVaultDocId(key)).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});
