import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSafeRoots, isSafeWorkspace } from './safeWorkspace';

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-ws-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('safeWorkspace', () => {
  test('a workspace is Safe only once safe/ exists', () => {
    const ws = tmp();
    expect(isSafeWorkspace(ws)).toBe(false);
    mkdirSync(join(ws, 'safe'));
    expect(isSafeWorkspace(ws)).toBe(true);
  });

  test('a missing workspace path is not Safe', () => {
    expect(isSafeWorkspace(null)).toBe(false);
    expect(isSafeWorkspace(undefined)).toBe(false);
    expect(isSafeWorkspace('')).toBe(false);
  });

  test('derives the mirror and drafts roots', () => {
    expect(getSafeRoots('/w')).toEqual({
      root: '/w',
      safeRoot: join('/w', 'safe'),
      draftsRoot: join('/w', 'safe', '_drafts'),
    });
  });
});
