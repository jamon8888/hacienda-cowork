# safe/ mirror pipeline — implementation spec (2026-09-24)

Companion to `2026-09-22-basemind-safe-integration-spec.md` (source spec). That
document is the design contract; this one scopes the **one cycle it describes
but nobody built**: the middle of the §5 pipeline (*extract → redact → write
`safe/*.md` → vault → rescan*) plus arm-on-opt-in. Diagnosis: the app can
download models and flip the banner to "Safe ✓", but nothing ever creates
`<workspace>/safe/`, so every downstream gate (safe-sync, redaction
interception, file count) stays closed and the product reports
"0 files searchable" forever.

## Destination

Opt-in (`basemind.download` success) creates `safe/`, mirrors+redacts the
workspace into it once, and every later watcher event keeps it in sync — so
the banner count, the redaction gate, and the RAG corpus all reflect reality.

## Verified facts (@357f843, re-verified this session)

- Nobody creates `safe/`: no `mkdir` of `safe` anywhere in `server/`, `src/`,
  `electron/`. Arm gate = `existsSync(join(workspaceKey,'safe'))`
  (`server/utils/safeSync.ts:54-56`); `scheduleSafeSync` silently no-ops when
  disarmed (`safeSync.ts:139`).
- `flush()` only maps pending originals → `toSafeMirrorPath` and calls
  `basemindRescan` (`safeSync.ts:96-119`). The comment at `safeSync.ts:36-38`
  marks the mirror layout "provisional until the extract pipeline lands".
- Mirror layout is fixed: `safe/<ext-stripped>.md`
  (`toSafeMirrorPath`, `safeSync.ts:39-43`).
- Anti-loop predicate already excludes `safe/` (`IGNORED_SEGMENTS`,
  `safeSync.ts:10`); no extension pre-filter (#21, spec row 20).
- Redaction engine: MCP tool `redact_text` — input `{text, categories,
  strategy, custom_terms, custom_patterns}`, output `{redacted_text,
  rehydration_map, detections}`, max input **1 MiB** (pin `10cc546`
  `src/mcp/tools_redact.rs:83`). App call pattern:
  `ToolManager.callTool('basemind','redact_text',…,{threadId:
  await getAppMcpOwnerThreadId()})` + `parseRedactTextResult`
  (`server/services/piiDetection.ts:110-130, 89-108`).
- Extraction helpers already in repo: `readDocxText` (mammoth,
  `server/utils/documentText.ts`, tested with
  `resources/sample-workspace/Demos/Fill PDF Form/Vendor Information.docx`),
  `getPdfDependencies` (pdfjs + canvas, `server/utils/pdfLoader.ts`, PDF
  fixtures under `tests/fixtures/workspace-template/pdfs/`).
- Vault: `vaultManager.encrypt(map)` → `persistEncryptedBlob(docId, blob)` →
  `deleteVaultBlobPath` (`server/services/vault.ts:235-270`);
  `sanitizeVaultDocId` allows only `[A-Za-z0-9_-]{1,128}` (`vault.ts:43-48`).
- Rescan requires the comms daemon (`basemindManager.ts:198`); redact via
  ToolManager spawns `basemind serve --no-watch` on demand. Whether that
  spawned server also binds `comms.sock` is an open question for live
  verification (see Verification).
- The pinned daemon has no `safe/` concept (grepped `10cc546:src`), so the
  mirror write is unavoidably app-side.

## The cycle (v1)

Shared per-file unit `syncSafeMirrorFile(workspacePath, relativePath)` in
`server/utils/safeSync.ts`:

1. Original missing (`unlink` or vanished) → best-effort `rm` of the mirror +
   best-effort vault blob delete → done.
2. `redactFile(absOriginalPath)` → `{redacted_text, rehydration_map}` via the
   `redact_text` MCP tool with its new `file_path` param (daemon extracts with
   `xberg::extract` — all 90+ formats incl. images via OCR — then redacts).
   `null`/throw/empty → nothing to mirror (unsupported file, oversized, engine
   error) → skip.
3. Write `safe/<ext>.md` (utf8, parent dirs recursive).
4. Best-effort: `vaultManager.encrypt(rehydration_map)` +
   `persistEncryptedBlob(mirrorDocId(workspacePath, relativePath), blob)`.
   Failure logs a warning and the mirror still lands — PII never leaves the
   machine un-redacted; only Show-Originals for that file degrades.
5. Collect the mirror path for the batch `basemindRescan({paths})`.

`flush()` (2 s trailing debounce, unchanged) now runs step 1–5 per pending
path before the existing rescan tail. Rescan receives the mirror path for
every pending event regardless of write outcome (no-op rescan is a documented
safe failure, #21); per-file failures are logged and never abort the batch.

`mirrorDocId(workspacePath, relativePath)` — `sf_` + sha256 of
`workspacePath \0 normalizedRelPath` — keys on the **real path**, not the
case-folded workspaceKey, so initial population and watcher events agree on
case-insensitive platforms (defined in `safeSync.ts`; `safeArm.ts` consumes
it via `syncSafeMirrorFile`).

`scheduleSafeSync(workspaceKey, relativePath, workspacePath?)` gains the real
workspace path as an optional third argument (workspaceKey is lowercased on
case-insensitive platforms and cannot be used for FS reads);
`workspaceWatchRegistry.handleWorkspaceWatchEvent` passes
`entry.workspacePath`. Two-argument calls fall back to `workspaceKey`
(Linux-correct; keeps existing tests and callers valid).

## Extraction: xberg in the daemon (decision 2026-09-24, user override)

Original plan had app-side mammoth/pdfjs extraction. User direction: **xberg
parses all documents incl. image OCR** — one engine, daemon-side. Constraint
verified: at pin `10cc546` no surface exposes per-file extraction
(`redact --file` = `fs::read_to_string`; `redact_text` takes plain text;
`extract_doc()` internal; no admin/memory extract mode). So:

- **Fork change** in `jamon8888/basemind` (user's repo, override of the
  wayfinder "no submodule changes" preference): `RedactTextParams` gains
  optional `file_path` → `ExtractInput::from_uri(abs)` → existing
  `xberg::extract` + redact pipeline → same `{redacted_text,
  rehydration_map, detections}` response. CLI `redact --file` routes through
  the same path (fixes plain-UTF8-only behavior). New branch off `10cc546`.
- No extension sniffing / byte cap app-side (spec row 20 satisfied — content
  selection is entirely basemind's); the daemon's 1 MiB `redact_text` cap
  applies to the *extracted* text — oversized files surface as tool errors
  and are skipped like any per-file failure.
- Binary: installed `~/.local/bin/basemind` is stale 0.29.0 (no `redact`
  command). Build the fork locally → stage at
  `resources/basemind/<platform>-<arch>/basemind` (preferred by
  `resolveBasemindBinary` before PATH); release/pin bump is a follow-up,
  not part of this PR.

## Arm + initial population

`server/utils/safeArm.ts` (new):

- `armSafeWorkspace(workspacePath)` — `mkdirSync(workspacePath/safe,
  {recursive:true})`, idempotent.
- `runInitialPopulation(workspacePath)` — enumerate files (depth-first
  `readdirSync` walk, skip `IGNORED_SEGMENTS` — shared with `safeSync` — +
  directories + non-files), cap **2000 files** (`ponytail:` comment — raise
  or make adaptive if workspaces outgrow it), run `syncSafeMirrorFile`
  sequentially, one batch rescan at the end. Counts `written` from the
  result's `written` flag (never a re-stat — a stale mirror from a prior run
  must not count as fresh). Returns `{written, skipped}`.
- `mirrorDocId` lives in `safeSync.ts` (see §cycle).

`runBasemindDownload` (`server/handlers/basemindDownload.ts`) after
`success === true`: resolve current workspace, `armSafeWorkspace` +
`await runInitialPopulation`, all wrapped in try/catch (warn on failure,
download still succeeds — models did download). This keeps the banner's
single post-download `workspaceScan.status()` honest: `fileCount` now counts
real mirrored files. No renderer changes.

## Seams & tests (TDD order)

| # | Seam | Test |
|---|------|------|
| S1 | basemind fork `redact_text {file_path}` | Rust unit tests in the fork: file path → extracted+redacted text (docx/pdf/image fixture), missing file → tool error, `text` param behavior unchanged; CLI `redact --file` parity via `--json` |
| S2 | `syncSafeMirrorFile` + `flush` write-step | extend `server/utils/safeSync.test.ts` (bun): injected redact/vault — write lands with redacted content; unlink removes mirror + vault blob; redact failure skips write not batch; **existing coalescing tests stay green** (missing originals → write skipped, mirror path still collected) |
| S3 | `safeArm` | new `server/utils/safeArm.test.ts` (bun): mkdir idempotent; enumeration honors predicate + cap; population writes + one rescan; per-file failure isolation |
| S4 | handler integration | extend `server/handlers/basemindDownload.vitest.test.ts` (vitest): stages success → arm+populate called (mocked `safeArm` + `workspace`); stage failure → not called |

Injection follows the established pattern (`setSafeSyncRescanForTests`-style
module setters: redact/vault deps default to production impls — production
redact = `ToolManager.callTool('basemind','redact_text',{file_path})`).

## Failure policy

- Per-file (extract/redact/write/vault): warn, count as skipped, continue.
- Batch rescan: existing swallow (`safeSync.flush`).
- Population/arming throw: warn, download result unchanged.
- Daemon not running at rescan: existing `success:false` path. Open question
  (Verification): if ToolManager's spawned `serve` does not bind
  `comms.sock`, add a minimal ensure-daemon step in the same PR.

## Non-goals

- Live per-file progress events, code-lane indexing (#18 default off),
  `.redacted/` migration, multi-workspace concurrent flushes, renderer/UI
  changes, full re-scan of large workspaces beyond the 2000-file cap.
- Submodule changes remain a boundary **except** the authorized basemind fork
  surface (S1); no changes to `interpreter-cua` or OIX core.

## Verification

1. Fork S1 tests (cargo test) + staged binary smoke: `basemind redact --file
   <fixture.pdf|docx|png> --json` returns redacted text.
2. Typecheck (tsc1 + tsc2) after each module; targeted tests after each seam.
3. Full `pnpm run test:unit` + `pnpm run test:vitest` once at the end
   (baselines: 4354 pass / 3 fail bun; vitest all-green @382).
4. Live app check (running debug session): click "Make Safe" on a fresh
   workspace → `safe/` populated incl. docx/pdf/image, banner shows N>0,
   watcher event (touch a file) → mirror updates; confirm whether rescan
   indexed (daemon question) and whether `fileCount` matches
   `find safe/ -type f | wc -l`.
5. `/code-review` on the diff before commit; signed-off commit to
   `feat/basemind-channel`; separate signed-off commit in the basemind fork.
