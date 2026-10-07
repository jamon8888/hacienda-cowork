/**
 * Where does GLiNER2 stop reading inside one redact_text call? (#66 P0)
 * Sizes NER_WINDOW_CHARS in server/services/nerWindows.ts: the window must be
 * at most 70 % of the lowest cutoff printed here. Drives the real basemind
 * daemon over MCP stdio with require_ner, puts one person name at a given
 * offset of a body, and binary-searches the first offset where it leaks.
 *
 * Usage: BASEMIND_BIN=/path/to/basemind NER_MODEL_DIR=/path/to/snapshot bun scripts/measure-ner-cutoff.mts
 *
 * The daemon gets a private comms dir (as the app's warmup does), so it never
 * collides with a daemon the user already runs. Set XBERG_ORT_EP=cpu on an
 * Intel Mac, where the auto-selected CoreML provider fails.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROBE = 'Hélène Marchand';
const LENGTH = 2_000;
const BODIES: Record<string, string> = {
  'fr-dense': 'Maître Paul Lefèvre (paul.lefevre@exemple.fr), associé de Durand & Associés SAS, 12 rue de la Paix 75002 Paris, a reçu 125 000 € de Sophie Martin le 3 mars 2026. ',
  'fr-neutral': 'La présente clause régit les modalités de résiliation du contrat ainsi que les obligations respectives des parties. ',
  'en-neutral': 'This clause governs the termination of the agreement and the respective obligations of the parties. ',
};

const binary = process.env.BASEMIND_BIN;
const modelDir = process.env.NER_MODEL_DIR;
if (!binary || !modelDir) throw new Error('Set BASEMIND_BIN and NER_MODEL_DIR');

const root = mkdtempSync(join(tmpdir(), 'ner-cutoff-'));
const commsDir = join(root, '.comms');
execFileSync('git', ['init', '-q'], { cwd: root });
const client = new Client({ name: 'measure-ner-cutoff', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: binary,
  args: ['serve', '--no-watch'],
  cwd: root,
  env: { ...process.env, BASEMIND_ALLOW_ANY_ROOT: '1', BASEMIND_COMMS_DIR: commsDir } as Record<string, string>,
}));

function bodyOf(seed: string): string {
  return seed.repeat(Math.ceil(LENGTH / seed.length)).slice(0, LENGTH);
}

async function leaks(seed: string, offset: number): Promise<boolean> {
  const body = bodyOf(seed);
  const text = `${body.slice(0, offset)} ${PROBE} ${body.slice(offset)}`;
  const raw = await client.callTool({
    name: 'redact_text',
    arguments: { text, require_ner: true, ner_model_dir: modelDir },
  }) as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  const structured = raw.structuredContent
    ?? JSON.parse(raw.content?.find((part) => typeof part.text === 'string')?.text ?? '{}');
  const payload = (structured.result ?? structured) as { redacted_text?: string; ner_ran?: boolean };
  if (payload.ner_ran !== true) throw new Error('NER did not run: check NER_MODEL_DIR');
  return String(payload.redacted_text).includes(PROBE);
}

const cutoffs: Record<string, number | null> = {};
try {
  for (const [name, seed] of Object.entries(BODIES)) {
    if (await leaks(seed, 0)) throw new Error(`${name}: probe missed at offset 0, the probe is not detectable`);
    if (!(await leaks(seed, LENGTH))) {
      cutoffs[name] = null;
      continue;
    }
    let caught = 0;
    let leaked = LENGTH;
    while (leaked - caught > 4) {
      const mid = Math.floor((caught + leaked) / 2);
      if (await leaks(seed, mid)) leaked = mid;
      else caught = mid;
    }
    cutoffs[name] = leaked;
  }
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}

console.table(cutoffs);
const measured = Object.values(cutoffs).filter((value): value is number => value !== null);
if (measured.length > 0) {
  console.log(`Lowest cutoff: ${Math.min(...measured)} chars -> NER_WINDOW_CHARS must be <= ${Math.floor(Math.min(...measured) * 0.7)}`);
} else {
  console.log(`No cutoff below ${LENGTH} chars: raise LENGTH and run again before trusting it.`);
}
