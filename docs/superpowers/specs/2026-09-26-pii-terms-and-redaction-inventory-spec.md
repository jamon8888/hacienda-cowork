# PII: personalized terms + redaction inventory — design spec (2026-09-26)

Scope chosen by the user: **one spec, two phases.** Phase 1 ships independently
(terms + editor labels); phase 2 extends the same Settings section (redaction
inventory over the `safe/` mirror). This document is the design contract; the
plan that follows implements it.

## Destination

- **Phase 1:** a user can see, add, edit, and remove personalized PII terms in
  Settings, and compose-mode notes label those terms with palette colors the
  same way they already label redaction categories.
- **Phase 2:** the same Settings section shows an inventory of what has
  actually been redacted across the workspace (file, line, category, masked
  value), updated incrementally as the safe-sync watcher mirrors files.

## Decisions (user-confirmed)

| # | Question | Decision |
|---|---|---|
| 1 | Where do terms live in the UI? | New **Privacy** tab in Settings (not gesture-only). |
| 2 | Category for a term? | Required pick from the existing palette (chip + editor label color). |
| 3 | Editor labeling mode? | Compose mode only; view/read-only mode stays token-only. |
| 4 | Scope? | Terms + full findings panel (not terms alone). |
| 5 | Findings surface? | Inline in the same Privacy section. Originally a Scan button + progress (as in the reference); approach A removed the trigger entirely — the inventory is maintained by safe-sync and backfills on first open, so there is nothing to press. |
| 6 | Scan scope? | `safe/` mirror only — corrected mid-brainstorm: the mirror holds *redacted* text (see below), so findings are a **redaction inventory**, refreshed **per changed file**. |
| 7 | Inventory implementation? | **A: piggyback detections on safe-sync** (persist what the redact call already returns and the code discards). |

## Verified facts (@HEAD this session)

- Custom terms already persist: `addCustomTerm`
  (`server/handlers/pii.ts:101-136`) parses workspace `basemind.toml`, writes
  `documents.redaction.custom_terms[]` `{label, value, case_sensitive}` and
  forces `documents.redaction.enabled = true`. De-dupes on `value`
  (`pii.ts:134`). **Add is the only CRUD operation** — no list/update/remove.
- IPC surface: `PiiIpc` (`src/ipc.ts:633-645`) = `detectSelection`,
  `addCustomTerm`, `getRehydrationMap`, `rememberRehydration`; demo-mode stub
  at `src/ipc.ts:755-766`. Registered in `server/routes/ipc.ts:178-191`.
- Editor labels: `PiiLabel` decoration-only extension; `piiSpansForText`
  (`src/extensions/PiiLabel.ts:34`) merges stored redaction tokens + compose
  regex spans; `scanRange` walks text nodes (`PiiLabel.ts:89-109`); rebuild via
  `editor.commands.updateDecorations('piiLabel')` (`PiiLabel.ts:133`).
- Compose detection is renderer-only: `detectRegex`
  (`src/lib/pii/regex-detector.ts:38`), five hard-coded patterns built at
  module load. **Custom terms never reach in-editor decoration** — they only
  reach basemind's redaction pipeline. This is the core gap for phase 1.
- Gesture path: `TipTapViewer.tsx:806` (add term), `:892-895` (category action
  → `window.prompt` for a custom label). Unchanged by this design.
- Palette: `src/lib/pii/colors.ts` (~30 categories, light/dark), labels via
  `buildPiiLabelAttributes` (`src/lib/pii/labels.ts`), `findRedactedTokens`
  parses `[CATEGORY_N]` markers out of redacted text.
- `safe/` is the **redacted** mirror: `syncSafeMirrorFile`
  (`server/utils/safeSync.ts:168-215`) calls `redactFn(originalAbs)` → writes
  `redacted_text` to the mirror → `vaultPersistFn(docId, rehydration_map)`.
  The redact response's `detections` (`category, start, end, text,
  confidence`, offsets into the **original**) are dropped on the floor.
- `piiDetectionService.redactFile` (`server/services/piiDetection.ts:133-144`)
  → `parseRedactTextResult` (`:90-106`) already returns
  `{redacted_text, rehydration_map, detections}`; widening the local
  `SafeRedactResult` (`safeSync.ts:71-74`) is the only contract change needed.
- Test seams already exist: `setSafeSyncRedactForTests` / `VaultPersist` /
  `VaultRemove` / `Armed` / `Rescan` / `DebounceMs`
  (`safeSync.ts:123-145`); tests in `server/utils/safeSync.test.ts`,
  `server/handlers/pii.test.ts`, `src/extensions/PiiLabel.test.ts`,
  `src/components/settings/*Section.ui.test.tsx`.
- Settings is tabbed nav: nav buttons + `activeTab` content panes in
  `src/components/GlobalSettings.tsx` (section imports `:17-38`, panes
  `:400-610`). New section = import + nav button + pane.
- Server may import `src/` (`server/tools/toolManager.ts:21` and siblings) —
  reuse of renderer PII helpers is established practice.
- Reference checkout (`Documents/interpreter-workstation`, **read-only
  inspiration, never edited**) has `PiiResultsPanel.tsx` (category chips with
  counts, file grouping, show-originals), `ScanBanner.tsx`,
  `ScanProgressPanel.tsx`. Its backend path is dead on arrival: `basemind
  --json` is ignored on `scan/rescan/watch/hook/lang`, so
  `parseRescanFindings` always yields `[]`. Do not port its scan wiring; port
  only the panel's presentation.
- Renderer `WorkspaceScanIpc` (`src/ipc.ts`) exposes only `status()` +
  code-indexing getters — no findings API exists anywhere.

## Phase 1 — terms CRUD + editor labels

### Storage (unchanged)

Single source of truth: workspace `basemind.toml`
`documents.redaction.custom_terms[]`, because basemind's own redaction reads
the same file. No second store (a renderer-side mirror would drift).

### Handlers

Refactor the add path into one internal read-modify-write helper over the
existing config resolution; expose four operations: **list, add (signature
unchanged), update, remove**. Identity is `value` (add already de-dupes on it,
`pii.ts:134`); updating `value` = remove-then-add so an edit never leaves a
stale duplicate. Writes keep forcing `redaction.enabled = true`.

### IPC

Three methods on the existing `pii` surface: `listCustomTerms`,
`updateCustomTerm`, `removeCustomTerm` (`src/ipc.ts` interface +
`server/routes/ipc.ts` route object). Demo-mode stubs throw like
`addCustomTerm` already does.

### Settings surface

New **Privacy** tab in `GlobalSettings` nav → `PrivacySectionContent`, two
stacked panels:

1. **Personalized terms** (phase 1): row per term — palette category chip,
   literal value, case-sensitivity toggle, edit + delete actions. Add row —
   value input, category select from palette, case toggle. Empty state points
   back at the right-click gesture that also creates terms. Missing-workspace
   renders inline, not as a toast. Writes disabled on read-only workstation
   sessions (same gate the editor uses).

### Editor labels

- Terms fetched once per editor session into `PiiLabel` storage (beside
  `showOriginals` / `rehydrationMap`), refreshed by storage update +
  `updateDecorations('piiLabel')`.
- Compose-mode span sources become three: stored tokens, regex detections,
  **literal term matches** — one alternation pass per text node over escaped
  term literals (rebuilt only when the term list changes), per-term case
  sensitivity, category from the term's palette pick through the existing
  normalizer. Same merge/sort and overlap suppression: a term inside an
  already-labelled token, a link, or a code span is skipped (existing rules).
- After a Settings write, the panel dispatches an in-app window event; open
  editors refetch and redecorate. Demo mode fetches as empty (labels absent,
  editor not broken).
- View/read-only mode stays token-only; chat renderer untouched.

### Phase 1 non-goals

No change to basemind redaction behavior, to the gesture flow
(`TipTapViewer.tsx:806/:892-895`), or to already-redacted notes — removing a
term does not retroactively un-redact anything. Labeling stays decoration-only
(file never rewritten by it).

## Phase 2 — redaction inventory (approach A)

### Semantics

Findings = **what safe-sync has already redacted, where**. Coverage is the
`safe/` mirror (workspace must be armed). Each changed file refreshes only its
own entry — incremental for free, because the watcher already re-redacts only
changed files.

### Piggyback

`safeSync`'s redact call already returns `detections`; widen
`SafeRedactResult` (`safeSync.ts:71`) to carry them and persist a per-file
sidecar alongside the mirror write (`safeSync.ts:196-212`).

**Sidecar:** `.basemind/inventory/<mirrorDocId hash>.json` (`.basemind` is in
`IGNORED_SEGMENTS`, `safeSync.ts:12`, and basemind gitignores its cache).
Per-file, not one aggregate index — one changed file rewrites one small file.

```
{ version: 1, relativePath, sourceMtime, origin: 'sync' | 'mirror-backfill',
  findings: [{ category, start, end, line, masked, confidence }] }
```

- **No original PII in plaintext.** `masked` is the rehydration token (matched
  by comparing the detection's `text` against the rehydration map the same
  call produced; falls back to a category-derived placeholder). Originals
  resolve only through the vault, per file, behind Show Originals.
- `start/end/line` are **original-relative**: line numbers computed at sync
  time while the original content is in hand.
- Sidecar write failure logs and degrades exactly like today's vault-persist
  failure (`safeSync.ts:205-211`) — the mirror still lands; the entry is
  absent until backfill.
- Unlink: remove the sidecar on the same path that removes the mirror +
  vault blob.

### Inventory service (server)

Owns an in-memory cache of sidecars: first request runs backfill, later
requests read cache; every safe-sync write/unlink invalidates that file's
entry and bumps a revision. Exposes over the `pii` IPC surface:

- `getInventory()` → grouped findings + revision.
- `onInventoryChanged(cb)` → subscription (existing `onChanged` callback
  pattern used by other evented IPC interfaces; no polling).
- `getMirrorRehydrationMap({ relativePath })` → originals for one file via
  `mirrorDocId`, sibling of the existing `getRehydrationMap`; decrypt failure
  degrades to opaque tokens with the existing unrestorable marker copy.

### Backfill

Mirrors predating the feature have no sidecar. On first inventory request:
find sidecar-less mirrors, re-redact their originals through the same `redactFn`
(bounded, one-shot, never repeats). If an original is gone (mirror only),
parse the mirror's own tokens with `findRedactedTokens` instead and mark the
entry `origin: 'mirror-backfill'` so redacted-relative precision isn't implied.

### Panel (phase-2 slot of the Privacy section)

Presentation borrowed from the reference's `PiiResultsPanel`, wiring is ours:

- Header: total count, Show Originals checkbox, last-sync freshness.
- Category filter chips: "All (N)" + one chip per palette category (color,
  count); click toggles, second click clears.
- Findings grouped by file; rows: line, category chip, masked value,
  confidence %.
- Empty states distinguish "nothing redacted yet" from "workspace not
  armed / no mirrors" (fresh install must not read as a bug).
- Live updates via the change subscription while the panel is open.

### Phase 2 non-goals (v1)

Click-row-to-open-at-line (scroll-to machinery exists, unneeded), background
scan banner/progress UI (approach A has no scan to report — updates arrive via
the change subscription), virtualization (redaction-scale counts don't need
it), and any port of the reference's `workspaceRescan` JSON path (provably
dead — `--json` ignored on rescan).

## Testing

| Layer | Seam | Proves |
|---|---|---|
| Term handlers | `server/handlers/pii.test.ts` (Bun) | list/add/update/remove round trip, de-dupe on `value`, empty value + missing workspace errors |
| safe-sync piggyback | `server/utils/safeSync.test.ts` + `setSafeSync*ForTests` | detections land in sidecar; unlink removes it; sidecar write failure degrades without failing sync |
| Inventory service | new Bun test | backfill runs once, per-file invalidation, revision bump |
| Editor spans | `src/extensions/PiiLabel.test.ts` (vitest) | term spans (case on/off), overlap suppression, category color/aria, refresh after event |
| Settings UI | `PrivacySection.ui.test.tsx` (vitest), prior art `CustomInstructionsSection.ui.test.tsx` | add/edit/remove round trip; inventory chips + grouping from fixtures; empty vs unarmed states |

All external behavior; redact fn and vault stay behind injection seams — no
daemon, no crypto, no fixtures containing real PII.

## Verification

- Both phases: `pnpm run precommit` (typecheck + `test:unit` + `test:vitest`).
- Dependency changes: none planned; if any, also `pnpm audit
  --audit-level=high` + `pnpm run release:licenses:check`.
- No e2e claims (Electron e2e is macOS/CI); anything not runnable on Linux is
  reported as not-run.
- Phase 1 must pass with zero phase-2 code present; phase 2 is an addition to
  the already-shipped Privacy section.
