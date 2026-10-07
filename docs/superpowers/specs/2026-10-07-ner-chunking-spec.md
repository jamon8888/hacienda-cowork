# NER windowing — design spec (2026-10-07)

Fixes the P0 recorded in #66 (`docs/ner-pii-session-findings.md` §2): GLiNER2
stops detecting past a few hundred characters inside one `redact_text` call and
still answers `ner_ran: true`. This document is the design contract; a plan
is `docs/superpowers/plans/2026-10-07-ner-chunking.md`.

Related: cabinet mode (`2026-09-29-cabinet-mode-spec.md`), whose guarantee this
P0 breaks on long inputs; #46, whose `tests/fixtures/pii-42/` dossier is the
verification instrument here. **This work touches no file under `src/lib/pii/`
or `tests/fixtures/pii-42/`** (owned by #46).

## Destination

No value is released to the provider, nor written to a `safe/` mirror, unless
NER has read **every character** of the text it came from. Long inputs are cut
into windows the encoder reads whole; when coverage cannot be proven, the text
is not released.

## Verified facts (@`d089eea`, this session)

- **Truncation (from #66, not re-measured here):** a credential is caught at
  offsets 8, 228, 448 and leaks from 624 on, in an 880-char body. Cutoff
  ~558 chars in PII-dense text, ~706 in neutral text: a sequence-length limit
  in the encoder (token-based, so it moves with density and, untested, with
  accents/language). `require_ner` only proves the model ran.
- **Runtime path** (`server/services/runtimeRedaction.ts`): `redactTextBatch`
  (l. 273) joins every text of a turn or tool result with `\n\n` into runs of up
  to `DETECTOR_MAX_BYTES` = 1 MiB − 1 KiB (`chunkForDetector`, l. 244-264) and
  makes **one** `detectNer` call per run. With truncation, only the first
  ~560-700 chars of each run are read by NER; the regex and pinned-term passes
  still read everything.
- **Mirror path** (`server/services/piiDetection.ts` `redactFile`, l. 259,
  called by `server/utils/safeSync.ts:86`): one `redact_text {file_path}` call;
  basemind extracts **and** redacts in the daemon. The app never sees the
  extracted text before redaction, so it cannot window it. A throw there skips
  the file (existing per-file failure policy).
- `RedactTextResult` (`piiDetection.ts:29-38`) carries `ner_ran?` only; nothing
  reports how much of the input NER covered.
- `sweepResidualPii` re-runs the app's regex + pinned terms over basemind's
  output: it catches pattern classes past the cutoff, never NER-only classes
  (names, companies, addresses, amounts — 36 of the 42 labels in #46).

## Approach

Two layers, because the mirror cannot be fixed from the app alone.

### Layer 1 — app (this repo): window the runtime path

- Replace the 1 MiB byte runs with **character windows**: `NER_WINDOW_CHARS`
  (default **400**) with `NER_WINDOW_OVERLAP_CHARS` (default **100**).
  - Short texts are still packed together up to one window (keeps the "one call
    per tool result, not hundreds" property of `redactTextBatch`).
  - A text longer than a window is split; consecutive windows overlap by 100
    chars so an entity cut at a boundary is whole in one of them. Prefer to cut
    at the last whitespace before the limit.
  - Detections are mapped back to text offsets, then merged: identical spans
    dedupe; overlapping spans merge to their union, labelled by the more
    confident detection (over-masking, never a leak).
- Window size is a named constant, not a guess: Task 0 of the plan measures the
  cutoff on French legal text (accents, long words) with the #66 method, and
  the default must be **≤ 70 % of the lowest measured cutoff**.
- Cost: a 200 KB text becomes ~670 sequential calls. The plan records measured
  latency on the #46 dossier and on a 200 KB document; if it is unacceptable,
  Layer 2 removes it.

### Layer 2 — basemind (`jamon8888/basemind`): window inside `redact_text`

- `redact_text` windows NER internally (same rule as Layer 1, in-process, so no
  per-window MCP round trip) for both `text` and `file_path` inputs, and
  re-offsets spans.
- It reports coverage: `ner_windows` (count) and `ner_window_chars` (size
  used). A daemon that returns them vouches that every character was read.
- Released as a basemind version, then pinned here (`submodules/basemind` +
  `PINNED_VERSION` in `scripts/download-basemind.mjs`).

### The gate (app, both paths)

- **Coverage proof** = `ner_windows` and `ner_window_chars` present, with
  `ner_window_chars` ≤ the app's `NER_WINDOW_CHARS`.
- **Runtime path:** with proof, the app may send larger runs (basemind windows
  them); without proof, the app windows itself (Layer 1). Either way, every
  character is read.
- **Mirror path:** without proof, a file whose extracted text is longer than
  `NER_WINDOW_CHARS` (known from `redacted_text`) is **not mirrored**: the
  call is treated as a failure and the file is skipped, as for any per-file
  failure. Short files are unaffected.
- **Cabinet mode:** nothing new to switch; the windowed runtime path and the
  mirror gate already keep it honest. `ner_truncated`, if basemind ever
  returns it, is treated as `ner_ran: false`.

## Decisions (Candy, owner of the privacy scope)

| # | Question | Recommendation |
|---|---|---|
| 1 | Mirror files longer than one window, before Layer 2 ships | **Confirmed 2026-10-07: skip them**, and delete any older mirror of them with its vault blob (not mirrored, counted as failed in the banner). Writing a copy whose second page was never read contradicts `redactFile`'s own rule ("a copy that reaches the agent is only as good as its detection"). Consequence: long documents are not searchable in Safe until basemind is released. |
| 2 | Order | Layer 1 + mirror gate first (closes the runtime leak now, stops the mirror leak now), Layer 2 next. |
| 3 | Window defaults | 400 / 100 until Task 0 measures; then ≤ 70 % of the lowest cutoff. |
| 4 | Who does Layer 2 | Open: basemind is Candy's fork; the truncation itself may also deserve an upstream issue in xberg (#66 §10 Q1). |

## Non-goals

Raising the encoder's limit in xberg; changes to regex patterns, labels or the
#46 fixture; image OCR; the P1-P3 findings of #66 (separate work).

## Acceptance criteria

1. Runtime: the #66 sweep (one credential moved from offset 0 to the end of an
   880-char body, then of a 20 000-char body) is caught at **every** offset,
   with NER on.
2. Same sweep with a person name and a company name (NER-only classes).
3. An entity placed across a window boundary is masked whole.
4. Many short texts in one tool result still cost one call per window, not one
   per text (existing batching test stays green, adapted to windows).
5. Mirror without coverage proof: a file longer than one window is not written
   to `safe/`; a short file is.
6. Mirror with coverage proof (mocked daemon response): the long file is
   written.
7. The #46 dossier, built app, cabinet mode on: the sentinel `grep` of the
   #46 guide §0 on the `safe/` mirror returns nothing **once Layer 2 is
   pinned**; before that, the dossier is skipped, not leaked.
8. `pnpm typecheck`, `pnpm run test:unit`, `pnpm run test:vitest` green.
