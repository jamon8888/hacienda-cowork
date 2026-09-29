import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

// writeFileTreeCache resolves its destination from homedir() at module load,
// so HOME has to point somewhere disposable before the import happens.
const home = mkdtempSync(join(tmpdir(), 'file-tree-cache-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const { writeFileTreeCache } = await import('./fileTreeCache');

const tree = [
  { name: 'a.txt', path: 'a.txt', type: 'file' as const },
  { name: 'src', path: 'src', type: 'directory' as const },
];

let saved: string[] = [];
let originalLog: typeof console.log;

beforeAll(() => {
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.includes('[FileTreeCache] Saved cache for:')) saved.push(first);
  };
});

afterAll(() => {
  console.log = originalLog;
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test('an unchanged tree is written once, a changed tree is written again', () => {
  saved = [];

  writeFileTreeCache('/w', tree);
  writeFileTreeCache('/w', tree);
  expect(saved).toHaveLength(1);

  writeFileTreeCache('/w', [...tree, { name: 'b.txt', path: 'b.txt', type: 'file' as const }]);
  expect(saved).toHaveLength(2);
});
