# NER Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No text reaches the provider, and no file reaches a `safe/` mirror, unless NER has read every character of it.

**Architecture:** A pure module (`nerWindows.ts`) cuts texts into windows the encoder reads whole (short texts packed together, long texts split with overlap) and maps detections back. The runtime batch (`redactTextBatch`) sends one detector call per window instead of one per 1 MiB run. The mirror path cannot be windowed from the app (basemind extracts and redacts a file in one call), so `redactFile` refuses a long file unless basemind proves coverage, and `safeSync` deletes any stale mirror of a refused file. Layer 2 (windowing inside basemind) is a separate plan in `jamon8888/basemind`; this plan already accepts its coverage proof.

**Tech Stack:** TypeScript, Bun test (`*.test.ts`), MCP SDK `@modelcontextprotocol/sdk` 1.31 (measurement script only).

**Spec:** `docs/superpowers/specs/2026-10-07-ner-chunking-spec.md`

## Context: basemind #55 (read before Task 4)

[jamon8888/basemind#55](https://github.com/jamon8888/basemind/pull/55) serves the
`safe/` mirror to the agent through MCP `resources/list` and `resources/read`
(`basemind://safe/<path>`). Its own notes say the app's result filter does
**not** see `resources/read` results: once it is released and pinned, mirror
content reaches the model with no second redaction pass by the app. So:

- A mirror must be complete on its own — Task 3's coverage gate is what makes
  it so for long files.
- A stale mirror of a long file (written before this plan, page two in clear)
  would be served as is — Task 4 deletes it on the next sync.
- A refused file is absent from `safe/`, hence from `resources/list`; the
  agent's shell is confined to `safe/`, so it cannot fall back to the original.
- The release with #55 does not return `ner_windows` / `ner_window_chars`, so
  long files stay refused until Layer 2 ships in a later release.

No file overlap: #55 changes basemind (`src/mcp/**`); this plan changes no
file under `submodules/basemind` and not `scripts/download-basemind.mjs`. The
pin bump to the new release is a separate PR. For Task 5, fix the binary
measured with `BASEMIND_BIN` (do not switch builds mid-run) and record its
version in the spec.

## Global Constraints

- **Do not touch** `src/lib/pii/**` or `tests/fixtures/pii-42/**` (owned by #46). Importing from `src/lib/pii/` is fine.
- `NER_WINDOW_CHARS` = 400 and `NER_WINDOW_OVERLAP_CHARS` = 100 until Task 5 measures; overlap must stay < half the window.
- Overlapping detections from different windows merge to their **union** (over-masking, never a leak).
- Mirror without coverage proof: a file whose original text is longer than `NER_WINDOW_CHARS` is **not mirrored**, and an existing mirror of it is **deleted** with its vault blob.
- Coverage proof = `ner_windows` (number) and `ner_window_chars` (number ≤ `NER_WINDOW_CHARS`) in the `redact_text` result. `ner_truncated: true` is a failure.
- Commits: conventional, `git commit -s`, last line `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Tasks 1-4 run anywhere (`pnpm install` is enough). Task 5 needs the built app, basemind and the NER model on a real machine.

---

### Task 1: The windowing module

**Files:**
- Create: `server/services/nerWindows.ts`
- Test: `server/services/nerWindows.test.ts`

**Interfaces:**
- Consumes: type `PiiDetection` from `src/lib/pii/regex-detector`.
- Produces:
  - `NER_WINDOW_CHARS: number`, `NER_WINDOW_OVERLAP_CHARS: number`, `NER_WINDOW_SEPARATOR: string`
  - `interface NerWindowPiece { entry: number; entryStart: number; windowStart: number; length: number }`
  - `interface NerWindow { text: string; pieces: NerWindowPiece[] }`
  - `splitIntoRanges(text: string, size?: number, overlap?: number): Array<[number, number]>`
  - `planNerWindows(texts: string[], size?: number, overlap?: number): NerWindow[]`
  - `mapWindowDetections(window: NerWindow, found: PiiDetection[], texts: string[]): Array<{ entry: number; detection: PiiDetection }>`
  - `mergeWindowDetections(detections: PiiDetection[], text: string): PiiDetection[]`

- [ ] **Step 1: Write the failing test** — `server/services/nerWindows.test.ts`

```ts
import { describe, expect, test } from 'bun:test';

import {
  mapWindowDetections,
  mergeWindowDetections,
  NER_WINDOW_CHARS,
  NER_WINDOW_OVERLAP_CHARS,
  NER_WINDOW_SEPARATOR,
  planNerWindows,
  splitIntoRanges,
} from './nerWindows';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');

describe('splitIntoRanges', () => {
  test('covers every character, each range within the window', () => {
    const text = words(400); // ~2 600 chars
    const ranges = splitIntoRanges(text);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(text.length);
    for (const [start, end] of ranges) expect(end - start).toBeLessThanOrEqual(NER_WINDOW_CHARS);
    for (let i = 1; i < ranges.length; i++) {
      // consecutive ranges overlap by exactly the overlap
      expect(ranges[i - 1][1] - ranges[i][0]).toBe(NER_WINDOW_OVERLAP_CHARS);
    }
  });

  test('cuts at whitespace when one is in the second half of the window', () => {
    const text = words(400);
    for (const [, end] of splitIntoRanges(text).slice(0, -1)) {
      expect(text[end - 1]).toBe(' ');
    }
  });

  test('cuts a text with no whitespace at the window size', () => {
    const ranges = splitIntoRanges('x'.repeat(1000));
    expect(ranges[0]).toEqual([0, NER_WINDOW_CHARS]);
  });

  test('never splits a surrogate pair', () => {
    const text = '😀'.repeat(600); // 1 200 UTF-16 units, no whitespace
    for (const [start, end] of splitIntoRanges(text)) {
      expect(start % 2).toBe(0);
      expect(end % 2).toBe(0);
    }
  });

  test('refuses an overlap of half the window or more', () => {
    expect(() => splitIntoRanges('abc', 10, 5)).toThrow();
  });

  test('a short text is one range', () => {
    expect(splitIntoRanges('court')).toEqual([[0, 5]]);
  });
});

describe('planNerWindows', () => {
  test('packs short texts into one window with the separator', () => {
    const windows = planNerWindows(['Jane Doe signed', 'nothing here']);
    expect(windows).toHaveLength(1);
    expect(windows[0].text).toBe(`Jane Doe signed${NER_WINDOW_SEPARATOR}nothing here`);
    expect(windows[0].pieces).toEqual([
      { entry: 0, entryStart: 0, windowStart: 0, length: 15 },
      { entry: 1, entryStart: 0, windowStart: 17, length: 12 },
    ]);
  });

  test('starts a new window when the next short text would overflow', () => {
    const a = 'a'.repeat(300);
    const b = 'b'.repeat(300);
    const windows = planNerWindows([a, b]);
    expect(windows.map((w) => w.text)).toEqual([a, b]);
  });

  test('a long text gets windows of its own, never shared', () => {
    const long = words(400);
    const windows = planNerWindows(['avant', long, 'après']);
    expect(windows[0].text).toBe('avant');
    expect(windows[windows.length - 1].text).toBe('après');
    for (const window of windows.slice(1, -1)) {
      expect(window.pieces).toHaveLength(1);
      expect(window.pieces[0].entry).toBe(1);
      expect(window.text.length).toBeLessThanOrEqual(NER_WINDOW_CHARS);
    }
  });

  test('every window is within the size', () => {
    const windows = planNerWindows([words(50), words(400), 'x', words(30)]);
    for (const window of windows) expect(window.text.length).toBeLessThanOrEqual(NER_WINDOW_CHARS);
  });
});

describe('mapWindowDetections', () => {
  test('maps window offsets back onto each text', () => {
    const texts = ['Jane Doe signed', 'Counsel for Jane Doe'];
    const [window] = planNerWindows(texts);
    const at = window.text.lastIndexOf('Jane Doe');
    const found: PiiDetection[] = [
      { category: 'person', start: 0, end: 8, text: 'Jane Doe', confidence: 0.9 },
      { category: 'person', start: at, end: at + 8, text: 'Jane Doe', confidence: 0.9 },
    ];
    const mapped = mapWindowDetections(window, found, texts);
    expect(mapped).toEqual([
      { entry: 0, detection: { category: 'person', start: 0, end: 8, text: 'Jane Doe', confidence: 0.9 } },
      { entry: 1, detection: { category: 'person', start: 12, end: 20, text: 'Jane Doe', confidence: 0.9 } },
    ]);
  });

  test('shifts a split window by its start in the text', () => {
    const text = `${'x '.repeat(300)}Jane Doe`;
    const windows = planNerWindows([text]);
    const last = windows[windows.length - 1];
    const at = last.text.indexOf('Jane Doe');
    const [{ detection }] = mapWindowDetections(last, [
      { category: 'person', start: at, end: at + 8, text: 'Jane Doe', confidence: 0.9 },
    ], [text]);
    expect(text.slice(detection.start, detection.end)).toBe('Jane Doe');
  });

  test('clips a span that crosses the separator', () => {
    const texts = ['Jane', 'Doe'];
    const [window] = planNerWindows(texts);
    const mapped = mapWindowDetections(window, [
      { category: 'person', start: 0, end: window.text.length, text: window.text, confidence: 0.9 },
    ], texts);
    expect(mapped.map((m) => m.detection.text)).toEqual(['Jane', 'Doe']);
  });
});

describe('mergeWindowDetections', () => {
  const text = 'Maître Jane Doe représente Acme SAS';
  const d = (category: string, start: number, end: number, confidence = 0.9): PiiDetection =>
    ({ category, start, end, text: text.slice(start, end), confidence });

  test('drops an identical span found by two windows', () => {
    expect(mergeWindowDetections([d('person', 7, 15), d('person', 7, 15)], text)).toEqual([d('person', 7, 15)]);
  });

  test('merges overlapping spans to their union', () => {
    expect(mergeWindowDetections([d('person', 7, 11), d('person', 9, 15)], text)).toEqual([
      { ...d('person', 7, 15) },
    ]);
  });

  test('overlapping spans of different categories keep the union under the more confident one', () => {
    const merged = mergeWindowDetections([d('person', 7, 15, 0.6), d('organization', 12, 15, 0.8)], text);
    expect(merged).toEqual([{ ...d('organization', 7, 15, 0.8) }]);
  });

  test('keeps touching but separate spans apart', () => {
    expect(mergeWindowDetections([d('person', 7, 15), d('organization', 27, 35)], text)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/services/nerWindows.test.ts`
Expected: FAIL — cannot find module `./nerWindows`.

- [ ] **Step 3: Implement** — `server/services/nerWindows.ts`

```ts
/**
 * NER windowing (spec 2026-10-07). GLiNER2 reads only the first few hundred
 * characters of one redact_text call and still reports ner_ran (#66 P0), so
 * every text goes to the detector in windows the encoder reads whole. Short
 * texts share a window; a long text is split into windows that overlap, so an
 * entity cut at one boundary is whole in the next window.
 */

import type { PiiDetection } from '../../src/lib/pii/regex-detector';

/** At most 70 % of the lowest cutoff measured by scripts/measure-ner-cutoff.mts. */
export const NER_WINDOW_CHARS = 400;
/** Longest entity guaranteed whole in some window; must stay under half a window. */
export const NER_WINDOW_OVERLAP_CHARS = 100;
/** A paragraph break keeps NER from reading two texts as one sentence. */
export const NER_WINDOW_SEPARATOR = '\n\n';

export interface NerWindowPiece {
  /** Index of the text in the planned array. */
  entry: number;
  /** Where the piece starts in that text. */
  entryStart: number;
  /** Where the piece starts in the window text. */
  windowStart: number;
  length: number;
}

export interface NerWindow {
  text: string;
  pieces: NerWindowPiece[];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Overlapping [start, end) ranges over one text, cut at whitespace when one is in the second half. */
export function splitIntoRanges(
  text: string,
  size = NER_WINDOW_CHARS,
  overlap = NER_WINDOW_OVERLAP_CHARS,
): Array<[number, number]> {
  if (overlap * 2 >= size) throw new Error('NER window overlap must be under half the window');
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      for (let at = end - 1; at > start + size / 2; at--) {
        if (/\s/.test(text[at])) {
          end = at + 1;
          break;
        }
      }
      // A lone surrogate becomes U+FFFD in UTF-8 and shifts basemind's byte offsets.
      if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    ranges.push([start, end]);
    if (end >= text.length) break;
    start = end - overlap;
    if (isLowSurrogate(text.charCodeAt(start))) start -= 1;
  }
  return ranges;
}

/** Windows for a batch: short texts packed with the separator, long texts split alone. */
export function planNerWindows(
  texts: string[],
  size = NER_WINDOW_CHARS,
  overlap = NER_WINDOW_OVERLAP_CHARS,
): NerWindow[] {
  const windows: NerWindow[] = [];
  let packing: NerWindow | null = null;
  for (let entry = 0; entry < texts.length; entry++) {
    const text = texts[entry];
    if (text.length > size) {
      if (packing) windows.push(packing);
      packing = null;
      for (const [start, end] of splitIntoRanges(text, size, overlap)) {
        windows.push({
          text: text.slice(start, end),
          pieces: [{ entry, entryStart: start, windowStart: 0, length: end - start }],
        });
      }
      continue;
    }
    if (packing && packing.text.length + NER_WINDOW_SEPARATOR.length + text.length > size) {
      windows.push(packing);
      packing = null;
    }
    if (!packing) packing = { text: '', pieces: [] };
    if (packing.pieces.length > 0) packing.text += NER_WINDOW_SEPARATOR;
    packing.pieces.push({ entry, entryStart: 0, windowStart: packing.text.length, length: text.length });
    packing.text += text;
  }
  if (packing) windows.push(packing);
  return windows;
}

/** Window offsets mapped onto each piece's own text; a span is clipped to its piece. */
export function mapWindowDetections(
  window: NerWindow,
  found: PiiDetection[],
  texts: string[],
): Array<{ entry: number; detection: PiiDetection }> {
  const mapped: Array<{ entry: number; detection: PiiDetection }> = [];
  for (const piece of window.pieces) {
    const from = piece.windowStart;
    const to = from + piece.length;
    for (const detection of found) {
      const start = Math.max(detection.start, from);
      const end = Math.min(detection.end, to);
      if (start >= end) continue;
      const entryStart = start - from + piece.entryStart;
      const entryEnd = end - from + piece.entryStart;
      mapped.push({
        entry: piece.entry,
        detection: {
          ...detection,
          start: entryStart,
          end: entryEnd,
          text: texts[piece.entry].slice(entryStart, entryEnd),
        },
      });
    }
  }
  return mapped;
}

/**
 * Detections of one text gathered from several windows: overlapping spans
 * become their union, labelled by the more confident one (longer on a tie).
 * Over-masking, never a leak.
 */
export function mergeWindowDetections(detections: PiiDetection[], text: string): PiiDetection[] {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: PiiDetection[] = [];
  for (const detection of sorted) {
    const last = merged[merged.length - 1];
    if (last && detection.start < last.end) {
      const winner =
        detection.confidence > last.confidence
        || (detection.confidence === last.confidence && detection.end - detection.start > last.end - last.start)
          ? detection
          : last;
      const end = Math.max(last.end, detection.end);
      merged[merged.length - 1] = {
        ...winner,
        start: last.start,
        end,
        text: text.slice(last.start, end),
      };
      continue;
    }
    merged.push({ ...detection });
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/services/nerWindows.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/nerWindows.ts server/services/nerWindows.test.ts
git commit -s -m "feat(pii): window texts so NER reads every character" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Window the runtime batch

**Files:**
- Modify: `server/services/runtimeRedaction.ts` (remove `BATCH_SEPARATOR`, `DETECTOR_MAX_BYTES`, `chunkForDetector` at l. 238-264; replace the detector loop in `redactTextBatch` at l. 298-321)
- Test: `server/services/runtimeRedaction.test.ts` (describe `one detector call per tool result`, l. 598-)

**Interfaces:**
- Consumes: `planNerWindows`, `mapWindowDetections`, `mergeWindowDetections`, `NER_WINDOW_CHARS` (Task 1).
- Produces: no new export; `redactTextBatch` now calls `detectNer` once per window.

- [ ] **Step 1: Write the failing tests** — in `server/services/runtimeRedaction.test.ts`, add `import { NER_WINDOW_CHARS } from './nerWindows';` and, inside `describe('one detector call per tool result', …)`, **replace** the test `'splits a batch that would exceed the detector input limit'` with:

```ts
  test('never sends the detector more than one window', async () => {
    const lengths: number[] = [];
    const long = Array.from({ length: 600 }, (_, i) => `mot${i}`).join(' ');
    await maybeRedactToolResult({
      serverId: 'builtin-filesystem',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: long }, { type: 'text', text: long }], isError: false },
      workspacePath: workspace(true),
      threadKey: 't-batch-4',
    }, {
      ...stubDeps,
      isNerReady: () => true,
      detectNer: async (text: string) => { lengths.push(text.length); return []; },
    });
    expect(lengths.length).toBeGreaterThan(2);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(NER_WINDOW_CHARS);
  });
```

and add at the end of the same describe block:

```ts
  // Stand-in for GLiNER2's truncation (#66 P0): it only reads the first 558
  // characters it is given, the lowest cutoff #66 measured.
  function truncatingNamesDetector() {
    const read = namesDetector([]);
    return async (text: string) => (await read(text.slice(0, 558)));
  }

  for (const offset of [0, 500, 700, 5_000, 19_000]) {
    test(`catches a name at offset ${offset} of a 20 000-char text`, async () => {
      const filler = 'clause sans donnée personnelle ';
      const body = filler.repeat(Math.ceil(20_000 / filler.length)).slice(0, 20_000);
      const text = `${body.slice(0, offset)} Jane Doe ${body.slice(offset)}`;
      const { text: out } = await maybeRedactOutboundText(text, {
        workspacePath: workspace(true),
        threadKey: `t-sweep-${offset}`,
      }, { ...stubDeps, isNerReady: () => true, detectNer: truncatingNamesDetector() });
      expect(out).not.toContain('Jane Doe');
      expect(out).toContain('[NAME_0]');
    });
  }

  test('masks a name cut by a window boundary', async () => {
    const pad = 'x'.repeat(NER_WINDOW_CHARS - 4); // no whitespace: the cut lands inside the name
    const text = `${pad}Jane Doe and more text after it`;
    const { text: out } = await maybeRedactOutboundText(text, {
      workspacePath: workspace(true),
      threadKey: 't-boundary',
    }, { ...stubDeps, isNerReady: () => true, detectNer: namesDetector([]) });
    expect(out).not.toContain('Jane');
    expect(out).not.toContain('Doe');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/services/runtimeRedaction.test.ts`
Expected: FAIL — `never sends the detector more than one window` (one call of 4 000+ chars) and the sweep tests at offsets 700, 5 000 and 19 000 (`Jane Doe` in clear). The other tests PASS.

- [ ] **Step 3: Implement** — in `server/services/runtimeRedaction.ts`

Add the import next to the other service imports:

```ts
import { mapWindowDetections, mergeWindowDetections, planNerWindows } from './nerWindows';
```

Delete `BATCH_SEPARATOR`, `DETECTOR_MAX_BYTES` and `chunkForDetector` with their comments (l. 238-264).

In `redactTextBatch`, replace the block from `// Sequential chunks under redact_text's input cap; the first refusal` through the end of the `for (const chunk of chunkForDetector(…)) { … }` loop with:

```ts
        // One call per window the encoder reads whole (#66 P0: GLiNER2 stops
        // a few hundred characters into its input and still reports ner_ran).
        // Sequential; the first refusal throws and stops the rest.
        const texts = toScan.map((index) => entries[index].text);
        for (const window of planNerWindows(texts)) {
          const found = await resolved.detectNer(window.text, options.requireFullDetection ? { requireNer: true } : undefined);
          for (const { entry, detection } of mapWindowDetections(window, found, texts)) {
            nerByEntry[toScan[entry]].push(detection);
          }
        }
        for (const index of toScan) {
          nerByEntry[index] = mergeWindowDetections(nerByEntry[index], entries[index].text);
        }
```

Keep `nerRan = true;` right after this block. Update the doc comment of `redactTextBatch` from "as few full-detection calls as the input cap allows" to "as few full-detection calls as whole-read windows allow".

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/services/runtimeRedaction.test.ts server/services/nerWindows.test.ts`
Expected: PASS. `sends every text of a result to the detector in a single call` still passes (its texts fit one window).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — Expected: no errors.

```bash
git add server/services/runtimeRedaction.ts server/services/runtimeRedaction.test.ts
git commit -s -m "fix(pii): send NER one whole-read window at a time on the runtime path" -m "Refs #66 (P0)." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Coverage proof and the mirror gate

**Files:**
- Modify: `server/services/piiDetection.ts` (`RedactTextResult` l. 29-38; `parseRedactTextResult` l. 157-174; `detectPii` after the `requireNer` check ~l. 222; `redactFile` after the `ner_ran` check ~l. 283)
- Test: `server/services/piiDetection.test.ts`

**Interfaces:**
- Consumes: `NER_WINDOW_CHARS` (Task 1).
- Produces:
  - `RedactTextResult` gains `ner_windows?: number`, `ner_window_chars?: number`, `ner_truncated?: boolean`
  - `class NerCoverageError extends Error` (name `'NerCoverageError'`)
  - `originalTextLength(result: RedactTextResult): number`
  - `hasNerCoverageProof(result: RedactTextResult, windowChars?: number): boolean`
  - `assertMirrorCoverage(result: RedactTextResult, windowChars?: number): void`

- [ ] **Step 1: Write the failing tests** — append to `server/services/piiDetection.test.ts` and extend its import with `assertMirrorCoverage, hasNerCoverageProof, NerCoverageError, originalTextLength`:

```ts
describe('NER coverage (spec 2026-10-07)', () => {
  const result = (over: Partial<ReturnType<typeof parseRedactTextResult>> = {}) => ({
    redacted_text: 'Signed by [PERSON_1].',
    rehydration_map: { '[PERSON_1]': 'Hélène Marchand' },
    detections: [],
    ner_ran: true,
    ...over,
  });

  test('parses the coverage fields basemind may return', () => {
    const parsed = parseRedactTextResult({
      structuredContent: { result: { redacted_text: 'x', rehydration_map: {}, detections: [], ner_ran: true, ner_windows: 3, ner_window_chars: 350, ner_truncated: false } },
    });
    expect(parsed.ner_windows).toBe(3);
    expect(parsed.ner_window_chars).toBe(350);
    expect(parsed.ner_truncated).toBe(false);
  });

  test('omits the coverage fields when basemind does not send them', () => {
    const parsed = parseRedactTextResult({ structuredContent: { result: { redacted_text: 'x', rehydration_map: {}, detections: [] } } });
    expect('ner_windows' in parsed).toBe(false);
    expect('ner_window_chars' in parsed).toBe(false);
    expect('ner_truncated' in parsed).toBe(false);
  });

  test('measures the original length through the rehydration map', () => {
    expect(originalTextLength(result())).toBe('Signed by Hélène Marchand.'.length);
  });

  test('coverage proof needs both fields and a window no larger than ours', () => {
    expect(hasNerCoverageProof(result())).toBe(false);
    expect(hasNerCoverageProof(result({ ner_windows: 2, ner_window_chars: 300 }), 400)).toBe(true);
    expect(hasNerCoverageProof(result({ ner_windows: 2, ner_window_chars: 512 }), 400)).toBe(false);
    expect(hasNerCoverageProof(result({ ner_windows: 2 }), 400)).toBe(false);
  });

  test('a short file passes without proof', () => {
    expect(() => assertMirrorCoverage(result(), 400)).not.toThrow();
  });

  test('a long file without proof is refused', () => {
    const long = result({ redacted_text: 'x'.repeat(401) , rehydration_map: {} });
    expect(() => assertMirrorCoverage(long, 400)).toThrow(NerCoverageError);
  });

  test('a long file with proof passes', () => {
    const long = result({ redacted_text: 'x'.repeat(5_000), rehydration_map: {}, ner_windows: 15, ner_window_chars: 380 });
    expect(() => assertMirrorCoverage(long, 400)).not.toThrow();
  });

  test('a truncated pass is refused even when short', () => {
    expect(() => assertMirrorCoverage(result({ ner_truncated: true }), 400)).toThrow(NerCoverageError);
  });

  test('the error is recognisable by name across module boundaries', () => {
    expect(new NerCoverageError('x').name).toBe('NerCoverageError');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/services/piiDetection.test.ts`
Expected: FAIL — `assertMirrorCoverage` / `NerCoverageError` not exported.

- [ ] **Step 3: Implement** — in `server/services/piiDetection.ts`

Add the import:

```ts
import { NER_WINDOW_CHARS } from './nerWindows';
```

In `interface RedactTextResult`, after `ner_ran?: boolean;`:

```ts
  /** Windows NER read (basemind with internal windowing). With ner_window_chars, proves coverage. */
  ner_windows?: number;
  /** Largest window basemind gave NER, in characters. */
  ner_window_chars?: number;
  /** basemind saw NER clip its input. Treated as a failed pass. */
  ner_truncated?: boolean;
```

In `parseRedactTextResult`, after the `ner_ran` spread:

```ts
    ...(typeof payload.ner_windows === 'number' ? { ner_windows: payload.ner_windows } : {}),
    ...(typeof payload.ner_window_chars === 'number' ? { ner_window_chars: payload.ner_window_chars } : {}),
    ...(typeof payload.ner_truncated === 'boolean' ? { ner_truncated: payload.ner_truncated } : {}),
```

After `parseRedactTextResult`, add:

```ts
/** NER ran on part of the input only, or coverage cannot be proven for a long input. */
export class NerCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NerCoverageError';
  }
}

/** Length of the text basemind read, rebuilt from its output and rehydration map. */
export function originalTextLength(result: RedactTextResult): number {
  let length = result.redacted_text.length;
  for (const [token, value] of Object.entries(result.rehydration_map)) {
    const occurrences = result.redacted_text.split(token).length - 1;
    length += occurrences * (value.length - token.length);
  }
  return length;
}

/** basemind vouches that NER read every character, in windows no larger than ours. */
export function hasNerCoverageProof(result: RedactTextResult, windowChars = NER_WINDOW_CHARS): boolean {
  return typeof result.ner_windows === 'number'
    && typeof result.ner_window_chars === 'number'
    && result.ner_window_chars <= windowChars;
}

/**
 * A mirror reaches the agent, so it is only as good as its detection: a file
 * longer than one window is refused unless basemind proves NER read all of it
 * (spec 2026-10-07, decision 1).
 */
export function assertMirrorCoverage(result: RedactTextResult, windowChars = NER_WINDOW_CHARS): void {
  if (result.ner_truncated === true) throw new NerCoverageError('redact_text: NER input was truncated');
  const length = originalTextLength(result);
  if (length > windowChars && !hasNerCoverageProof(result, windowChars)) {
    throw new NerCoverageError(`redact_text: NER coverage not proven for ${length} characters (window ${windowChars})`);
  }
}
```

In `detectPii`, right after the existing `if (options?.requireNer && parsed.ner_ran !== true) { … }`:

```ts
  if (options?.requireNer && parsed.ner_truncated === true) {
    throw new Error('redact_text: NER input was truncated');
  }
```

In `redactFile`, right after `if (parsed.ner_ran !== true) throw …;` and before `return sweepResidualPii(…)`:

```ts
  assertMirrorCoverage(parsed);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/services/piiDetection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/piiDetection.ts server/services/piiDetection.test.ts
git commit -s -m "fix(safe): refuse a long file's mirror unless basemind proves NER read it all" -m "Refs #66 (P0)." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Delete the stale mirror of a refused file

**Files:**
- Modify: `server/utils/safeSync.ts` (`syncSafeMirrorFile`, the final `catch` ~l. 234)
- Test: `server/utils/safeSync.test.ts` (describe `syncSafeMirrorFile (cycle middle …)`, l. 192-)

**Interfaces:**
- Consumes: errors named `'NerCoverageError'` thrown by `redactFile` (Task 3). Matched by name: `safeSync` loads `piiDetection` lazily and must not import it statically.
- Produces: no new export.

- [ ] **Step 1: Write the failing tests** — inside `describe('syncSafeMirrorFile (cycle middle: extract → redact → write → vault)', …)`:

```ts
  test('a file refused for NER coverage loses its old mirror and vault blob', async () => {
    writeFileSync(join(workspace, 'long.txt'), 'body');
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'safe/long.txt.md'), 'OLD MIRROR WITH PAGE TWO IN CLEAR');
    redactMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('redact_text: NER coverage not proven'), { name: 'NerCoverageError' });
    });
    scheduleSafeSync('ws', 'long.txt', workspace);
    await sleep(50);

    expect(existsSync(join(workspace, 'safe/long.txt.md'))).toBe(false);
    expect(vaultRemoveMock).toHaveBeenCalledTimes(1);
    expect(rescanMock.mock.calls[0][0].paths).toEqual(['safe/long.txt.md']);
  });

  test('any other redact failure keeps the previous mirror', async () => {
    writeFileSync(join(workspace, 'doc.txt'), 'body');
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'safe/doc.txt.md'), 'PREVIOUS GOOD MIRROR');
    redactMock.mockImplementationOnce(async () => { throw new Error('daemon restarting'); });
    scheduleSafeSync('ws', 'doc.txt', workspace);
    await sleep(50);

    expect(readFileSync(join(workspace, 'safe/doc.txt.md'), 'utf8')).toBe('PREVIOUS GOOD MIRROR');
    expect(vaultRemoveMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/utils/safeSync.test.ts`
Expected: FAIL — the first new test (old mirror still there). The second PASSES already (locks today's behaviour).

- [ ] **Step 3: Implement** — in `server/utils/safeSync.ts`, replace the final `catch (err) { console.warn(… mirror write failed …) }` of `syncSafeMirrorFile` with:

```ts
  } catch (err) {
    console.warn(
      `[safe-sync] mirror write failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // A file refused because NER could not read all of it must not keep an
    // older mirror written before the check existed: that copy may carry its
    // later pages in clear. Other failures keep the last good mirror.
    if (err instanceof Error && err.name === 'NerCoverageError') {
      try {
        await rm(mirrorAbs, { force: true });
        await vaultRemoveFn(docId);
      } catch (cleanupErr) {
        console.warn(
          `[safe-sync] stale mirror cleanup failed for ${relativePath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        );
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/utils/safeSync.test.ts server/utils/safeArm.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suites and commit**

Run: `pnpm typecheck && pnpm run test:unit && pnpm run test:vitest`
Expected: green, or the same pre-existing failures as on `main` (note them, do not fix them here).

```bash
git add server/utils/safeSync.ts server/utils/safeSync.test.ts
git commit -s -m "fix(safe): drop the stale mirror of a file refused for NER coverage" -m "Refs #66 (P0)." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Measure the cutoff and check live (real machine only)

**Files:**
- Create: `scripts/measure-ner-cutoff.mts`
- Modify (only if the measurement requires it): `server/services/nerWindows.ts` (`NER_WINDOW_CHARS`, `NER_WINDOW_OVERLAP_CHARS`)
- Modify: `docs/superpowers/specs/2026-10-07-ner-chunking-spec.md` (add a "Measured cutoff" section)

**Interfaces:**
- Consumes: the basemind binary and a downloaded NER model (same as the app).

- [ ] **Step 1: Write the measurement script** — `scripts/measure-ner-cutoff.mts`

```ts
/**
 * Where does GLiNER2 stop reading inside one redact_text call? (#66 P0)
 * Sizes NER_WINDOW_CHARS in server/services/nerWindows.ts: the window must be
 * at most 70 % of the lowest cutoff printed here. Drives the real basemind
 * daemon over MCP stdio with require_ner, puts one person name at a given
 * offset of a body, and binary-searches the first offset where it leaks.
 *
 * Usage: BASEMIND_BIN=/path/to/basemind NER_MODEL_DIR=/path/to/snapshot bun scripts/measure-ner-cutoff.mts
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
execFileSync('git', ['init', '-q'], { cwd: root });
const client = new Client({ name: 'measure-ner-cutoff', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: binary,
  args: ['serve', '--no-watch'],
  cwd: root,
  env: { ...process.env, BASEMIND_ALLOW_ANY_ROOT: '1' } as Record<string, string>,
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
await client.close();

console.table(cutoffs);
const measured = Object.values(cutoffs).filter((value): value is number => value !== null);
if (measured.length > 0) {
  console.log(`Lowest cutoff: ${Math.min(...measured)} chars -> NER_WINDOW_CHARS must be <= ${Math.floor(Math.min(...measured) * 0.7)}`);
} else {
  console.log(`No cutoff below ${LENGTH} chars: raise LENGTH and run again before trusting it.`);
}
```

- [ ] **Step 2: Run it**

Run: `BASEMIND_BIN=$(which basemind) NER_MODEL_DIR=<snapshot dir from the app's model cache> bun scripts/measure-ner-cutoff.mts`
Expected: a table of three cutoffs (#66 measured ~558 dense, ~706 neutral) and the window ceiling.

- [ ] **Step 3: Apply and record**

If the printed ceiling is below 400: set `NER_WINDOW_CHARS` to the ceiling and `NER_WINDOW_OVERLAP_CHARS` to `Math.floor(NER_WINDOW_CHARS / 4)` in `server/services/nerWindows.ts`, then rerun `bun test server/services/nerWindows.test.ts server/services/runtimeRedaction.test.ts`.
Append to the spec:

```markdown
## Measured cutoff (<date>, basemind <version>, model <snapshot>)

| Body | First leaking offset |
|---|---|
| fr-dense | <n> |
| fr-neutral | <n> |
| en-neutral | <n> |

Window set to <NER_WINDOW_CHARS> (≤ 70 % of <lowest>), overlap <NER_WINDOW_OVERLAP_CHARS>.
```

- [ ] **Step 4: Live check with the #46 dossier** (fictitious data only)

1. Get the dossier from #46 (`git show origin/feat/cabinet-mode:tests/fixtures/pii-42/workspace/dossier-test-pseudonymisation.md > /tmp/pii42/dossier.md`, or from `main` once #46 is merged), `git init` the folder, open it as a workspace, make it Safe.
2. Expected now (before Layer 2 is pinned): the banner does **not** count the dossier; `safe/dossier.md.md` does not exist; the app log has `mirror write failed … NER coverage not proven`.
3. Paste the dossier's second half into the chat, Hide Originals on: every NER-only value (names, companies, addresses) shows as a token.
4. In `<appData>/audit/cabinet-mode.jsonl`, no new `send_blocked` line for step 3 (the windows ran; nothing was refused).

- [ ] **Step 5: Commit**

```bash
git add scripts/measure-ner-cutoff.mts server/services/nerWindows.ts docs/superpowers/specs/2026-10-07-ner-chunking-spec.md
git commit -s -m "chore(pii): measure the NER cutoff and size the window from it" -m "Refs #66 (P0)." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## After this plan

- **Layer 2 (basemind):** separate plan in `jamon8888/basemind` — window NER inside `redact_text` for `text` and `file_path`, return `ner_windows` and `ner_window_chars`. Once released and pinned here, long files are mirrored again with no change to this repo.
- **#66:** the findings doc can be merged on its own; the implementation PR from this plan says "Fixes the P0 of #66".
