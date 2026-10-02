import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSafeWorkspaceForCwd,
  getSafeRoots,
  isInsideSafeMirror,
  isSafeWorkspace,
  resolveSafeRuntimeConfinement,
} from './safeWorkspace';

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

  test('finds the Safe workspace from its root or its mirror, never from an unrelated ancestor', () => {
    const ws = tmp();
    mkdirSync(join(ws, 'safe'));
    mkdirSync(join(ws, 'sub'));
    expect(findSafeWorkspaceForCwd(ws)).toBe(ws);
    expect(findSafeWorkspaceForCwd(join(ws, 'safe'))).toBe(ws);
    // A project under a folder that happens to hold safe/ is not armed.
    expect(findSafeWorkspaceForCwd(join(ws, 'sub'))).toBeNull();
    expect(findSafeWorkspaceForCwd(tmp())).toBeNull();
    expect(findSafeWorkspaceForCwd(null)).toBeNull();
  });

  test('resolves the confinement and creates the drafts directory', () => {
    const ws = tmp();
    mkdirSync(join(ws, 'safe'));
    const confinement = resolveSafeRuntimeConfinement(ws, ['/skills']);
    expect(confinement).toEqual({
      root: ws,
      safeRoot: join(ws, 'safe'),
      draftsRoot: join(ws, 'safe', '_drafts'),
      readableRoots: ['/skills'],
    });
    expect(existsSync(join(ws, 'safe', '_drafts'))).toBe(true);
    expect(resolveSafeRuntimeConfinement(tmp())).toBeNull();
  });

  test('tells mirror paths from originals', () => {
    const ws = tmp();
    expect(isInsideSafeMirror(ws, 'safe/a.md')).toBe(true);
    expect(isInsideSafeMirror(ws, join(ws, 'safe', 'b', 'c.md'))).toBe(true);
    expect(isInsideSafeMirror(ws, 'a.docx')).toBe(false);
    expect(isInsideSafeMirror(ws, 'safe/../a.docx')).toBe(false);
    expect(isInsideSafeMirror(ws, join(ws, 'safety', 'x.md'))).toBe(false);
  });
});
