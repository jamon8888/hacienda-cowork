/**
 * What does windowing cost? (spec 2026-10-07, Layer 1 "Cost")
 * Sends texts through the same windows the app uses (planNerWindows), one
 * redact_text call per window against the real basemind daemon, and prints the
 * wall-clock time. Sizes: the first call (model load), a synthetic ~200 KB
 * document, and optionally a real file (the #46 dossier).
 *
 * Usage: BASEMIND_BIN=/path/to/basemind NER_MODEL_DIR=/path/to/snapshot \
 *   [SAMPLE_FILE=/path/to/dossier.md] [MAX_WINDOWS=60] bun scripts/measure-ner-latency.mts
 *
 * MAX_WINDOWS times only the first N windows of each text and extrapolates the
 * total from the mean per window; unset, every window is sent.
 *
 * Calls go straight to the daemon over MCP stdio, so the app's own overhead
 * (tool manager, thread context, redaction registry) is not included.
 * The daemon gets a private comms dir so it never collides with a user daemon.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { planNerWindows } from '../server/services/nerWindows';

const SYNTHETIC_CHARS = 200_000;
const SEED = 'Maître Paul Lefèvre (paul.lefevre@exemple.fr), associé de Durand & Associés SAS, a reçu 125 000 € de Sophie Martin le 3 mars 2026. '
  + 'La présente clause régit les modalités de résiliation du contrat ainsi que les obligations respectives des parties. ';

const binary = process.env.BASEMIND_BIN;
const modelDir = process.env.NER_MODEL_DIR;
if (!binary || !modelDir) throw new Error('Set BASEMIND_BIN and NER_MODEL_DIR');

const root = mkdtempSync(join(tmpdir(), 'ner-latency-'));
execFileSync('git', ['init', '-q'], { cwd: root });
const client = new Client({ name: 'measure-ner-latency', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: binary,
  args: ['serve', '--no-watch'],
  cwd: root,
  env: { ...process.env, BASEMIND_ALLOW_ANY_ROOT: '1', BASEMIND_COMMS_DIR: join(root, '.comms') } as Record<string, string>,
}));

async function callWindow(text: string): Promise<number> {
  const started = performance.now();
  const raw = await client.callTool({
    name: 'redact_text',
    arguments: { text, require_ner: true, ner_model_dir: modelDir },
  }) as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const structured = raw.structuredContent
    ?? JSON.parse(raw.content?.find((part) => typeof part.text === 'string')?.text ?? '{}');
  const payload = (structured.result ?? structured) as { ner_ran?: boolean };
  if (payload.ner_ran !== true) throw new Error('NER did not run: check NER_MODEL_DIR');
  return performance.now() - started;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const maxWindows = Number(process.env.MAX_WINDOWS) || Infinity;

async function run(label: string, text: string) {
  const all = planNerWindows([text]);
  const windows = all.slice(0, maxWindows);
  const times: number[] = [];
  const started = performance.now();
  for (const [index, window] of windows.entries()) {
    times.push(await callWindow(window.text));
    if ((index + 1) % 50 === 0) console.error(`${label}: ${index + 1}/${windows.length} windows, ${seconds(performance.now() - started)}`);
  }
  const measured = performance.now() - started;
  const total = measured * (all.length / windows.length);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    label,
    chars: text.length,
    windows: all.length,
    timed: windows.length,
    total: `${windows.length < all.length ? "~" : ""}${seconds(total)}`,
    'median ms': Math.round(percentile(sorted, 0.5)),
    'p95 ms': Math.round(percentile(sorted, 0.95)),
    'ms/1000 chars': Math.round((total / text.length) * 1000),
  };
}

try {
  const firstMs = await callWindow('Jane Doe signed the agreement.');
  console.log(`First call (model load): ${seconds(firstMs)}`);
  const rows = [await run('synthetic', SEED.repeat(Math.ceil(SYNTHETIC_CHARS / SEED.length)).slice(0, SYNTHETIC_CHARS))];
  if (process.env.SAMPLE_FILE) rows.push(await run('sample file', readFileSync(process.env.SAMPLE_FILE, 'utf8')));
  console.table(rows);
} catch (error) {
  console.error("measurement failed:", error);
  process.exitCode = 1;
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
