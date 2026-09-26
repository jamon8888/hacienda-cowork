# PII Terms + Redaction Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two-phase PII feature: phase 1 gives users full CRUD over personalized PII terms (Settings + compose-mode editor labels); phase 2 adds a redaction inventory panel fed by detections that safe-sync already computes and discards.

**Architecture:** Phase 1 keeps `basemind.toml` `documents.redaction.custom_terms[]` as the single source of truth, exposes list/update/remove next to the existing add over the `pii` IPC surface, and feeds terms into the `PiiLabel` decoration scan as a third span source. Phase 2 widens the safe-sync redact result to carry `detections`, persists a per-file JSON sidecar under `.basemind/inventory/` at sync time (no original PII in plaintext), and serves a cached snapshot over IPC with live revision broadcasts.

**Tech Stack:** TypeScript, Express IPC router (`/api/ipc/:ns/:method`), Electron preload, Tiptap decorations, Bun test (server), Vitest + jsdom (renderer UI), `smol-toml`, `react-i18next`.

**Spec:** `docs/superpowers/specs/2026-09-26-pii-terms-and-redaction-inventory-spec.md` (amended this session: mirror-relative lines, backfill walks originals).

## Global Constraints

- **Canonical checkout guard:** before the first edit, run `git rev-parse --show-toplevel` and confirm it is `/home/jamin/hacienda`. Never edit or test anything under `Documents/interpreter-workstation` (read-only inspiration).
- **No new dependencies.** Everything needed is already in `package.json`.
- **No plaintext original PII outside the vault.** Sidecars, IPC payloads, and renderer state carry tokens/masked values only; originals resolve per file through the existing vault decrypt.
- **Labeling is decoration-only.** Never rewrite the note file to apply or remove labels.
- **i18n:** flat keys, added to **all 8 locale files** (`en`, `es`, `fr`, `it`, `ja`, `ko`, `ru`, `zh-CN`) — `shared/locales/__tests__/completeness.test.ts` enforces exact key parity in both directions. English copy in non-English locales is accepted for new keys (only `criticalLocalizedKeys` must differ).
- **Every commit is signed off:** `git commit -s`. Never push (branches go to the operations repo; pushing needs explicit authorization).
- **Phase 1 ships with zero phase-2 code.** Phase 2 only extends the already-shipped Privacy tab.
- **Read-only workstation:** UI disables writes via `isWorkstationReadOnly()` (`src/remote/workstationConnection.ts:68`); server-side, write methods stay out of `READ_ONLY_IPC_OPERATIONS` (`server/workstationConnection.ts:148`) so remote read-only connections 403 them; read methods go in that set.
- **Test commands:** Bun single file `bun test <path>`; Vitest single file `pnpm exec vitest run --config vitest.config.ts <path>`; floor `pnpm run precommit`.

## Review Focus

Five inputs/conditions the spec implies but no single task naturally proves — each gets the test named beside it, in the owning task:

1. **A term containing regex metacharacters** (`C++ (prod)`, `a.b`) must match literally, not crash or match everything → Task 5, matcher test.
2. **Mixed case sensitivity in one term list** — an insensitive term matches `jane` in `Jane`, a sensitive term must not → Task 5, matcher test.
3. **A term overlapping a stored redaction token** must not double-label (`[EMAIL_0]` containing the term text) → Task 5, `PiiLabel.test.ts`.
4. **A detection whose text is absent from the rehydration map** must fall back to a placeholder — the sidecar JSON must never contain the original string → Task 7, safeSync sidecar test asserts raw file contents.
5. **Concurrent first opens of the inventory** must run backfill once, not twice → Task 8, single-flight test.

---

## File Structure

**Phase 1**

| File | Responsibility |
|---|---|
| `server/handlers/pii.ts` (modify) | Custom-term read-modify-write core + list/update/remove handlers |
| `server/handlers/pii.test.ts` (modify) | CRUD round trip, validation, workspace-missing errors |
| `server/routes/ipc.ts` (modify) | Thin routes: `listCustomTerms`, `updateCustomTerm`, `removeCustomTerm` |
| `server/workstationConnection.ts` (modify) | `pii.listCustomTerms` added to read-only allowed set |
| `src/ipc.ts` (modify) | `PiiIpc` interface + marketing-demo stubs |
| `src/lib/pii/custom-terms.ts` (create) | Literal term matcher (escaped alternation, per-term case) |
| `src/lib/pii/custom-terms.test.ts` (create) | Matcher behavior (runs in `test:unit` via `src/lib`) |
| `src/extensions/PiiLabel.ts` (modify) | Third span source + storage field |
| `src/extensions/PiiLabel.test.ts` (modify) | Term spans in the merge |
| `src/components/TipTapViewer.tsx` (modify) | Fetch terms, listen for the change event, redecorate |
| `scripts/run-unit-tests.mjs` (modify) | Add `src/extensions` to `ROOT_DIRS` (its tests currently never run) |
| `shared/settingsCatalog.ts` (modify) | `privacy` tab + `piiTerms` section entries |
| `src/components/GlobalSettings.tsx` (modify) | Nav icon, pane render |
| `src/components/settings/PrivacySection.tsx` (create) | Terms panel (list/add/edit/delete, case toggle) |
| `src/components/settings/PrivacySection.ui.test.tsx` (create) | Panel behavior under mocked `ipc` |
| `shared/locales/*.json` (8 files, modify) | Phase-1 flat keys |

**Phase 2**

| File | Responsibility |
|---|---|
| `server/utils/inventorySidecar.ts` (create) | Sidecar path/build/read/write/remove — pure, no imports from safeSync |
| `server/utils/inventorySidecar.test.ts` (create) | Payload shape + no-plaintext guarantee at the builder level |
| `server/utils/safeSync.ts` (modify) | Widen `SafeRedactResult`, write/remove sidecar, notify service |
| `server/utils/safeSync.test.ts` (modify) | Sidecar written on sync, removed on unlink, failure degrades |
| `server/services/piiInventory.ts` (create) | Cache, non-blocking one-shot backfill (walk + flag + single-flight), revision, notify seam |
| `server/services/piiInventory.test.ts` (create) | Backfill once, invalidation, armed/unarmed, notify |
| `server/handlers/pii.ts` (modify) | `getInventory`, `getMirrorRehydrationMap` |
| `server/routes/ipc.ts` (modify) | Routes for both |
| `server/workstationConnection.ts` (modify) | Read methods in read-only allowed set |
| `electron/ipc/registry.ts` (modify) | `PII_INVENTORY_CHANGED: 'pii:inventory-changed'` |
| `electron/preload.ts` (modify) | `pii` namespace (all methods + `onInventoryChanged`) |
| `src/ipc.ts` (modify) | Inventory types + `onInventoryChanged` + demo stubs |
| `src/components/settings/PiiInventoryPanel.tsx` (create) | Chips, grouping, Show Originals, live revision |
| `src/components/settings/PiiInventoryPanel.ui.test.tsx` (create) | Filter/group/empty/unarmed/originals behavior |
| `src/components/GlobalSettings.tsx` (modify) | Second section in the privacy pane |
| `shared/locales/*.json` (8 files, modify) | Phase-2 flat keys |

---

# Phase 1

### Task 1: Custom-term CRUD handlers

**Files:**
- Modify: `server/handlers/pii.ts` (replace lines 86–150 region: `resolveCustomTermsConfigPath` stays, `addCustomTerm` refactored, three handlers added)
- Test: `server/handlers/pii.test.ts`

**Interfaces:**
- Consumes: `getCurrentWorkspace()` (`server/utils/workspace.ts`), `parseToml`/`stringifyToml` (`smol-toml`), existing `resolveCustomTermsConfigPath`.
- Produces (all async, all reject with `Error` on validation failure):
  - `listCustomTerms(): Promise<{ terms: Array<{ label: string; value: string; caseSensitive: boolean }> }>`
  - `addCustomTerm(request: { label: string; value: string; caseSensitive?: boolean }): Promise<{ success: boolean; configPath: string }>` — signature unchanged from today.
  - `updateCustomTerm(request: { originalValue: string; label?: string; value?: string; caseSensitive?: boolean }): Promise<{ success: boolean; configPath: string }>`
  - `removeCustomTerm(request: { value: string }): Promise<{ success: boolean; configPath: string }>` — idempotent (removing an absent value succeeds).
  - Internal: `CustomTermEntry { label: string; value: string; case_sensitive?: boolean }`, `readCustomTermsState(workspace)`, `writeCustomTermsState(state)`, `requireWorkspace()`.

- [ ] **Step 1: Write the failing tests**

Append to `server/handlers/pii.test.ts` (imports at top gain `listCustomTerms, updateCustomTerm, removeCustomTerm` from `./pii`):

```ts
describe('pii custom terms CRUD', () => {
  test('add → list → update → remove round trip persists in basemind.toml', async () => {
    const workspace = useTempWorkspace();

    await addCustomTerm({ label: 'email', value: 'jane@example.com' });
    await addCustomTerm({ label: 'boss', value: 'My Boss', caseSensitive: true });

    const first = await listCustomTerms();
    expect(first.terms).toEqual([
      { label: 'email', value: 'jane@example.com', caseSensitive: false },
      { label: 'boss', value: 'My Boss', caseSensitive: true },
    ]);

    await updateCustomTerm({
      originalValue: 'My Boss',
      label: 'person_full_name',
      value: 'The Boss',
      caseSensitive: false,
    });
    const second = await listCustomTerms();
    expect(second.terms).toEqual([
      { label: 'email', value: 'jane@example.com', caseSensitive: false },
      { label: 'person_full_name', value: 'The Boss', caseSensitive: false },
    ]);

    await removeCustomTerm({ value: 'jane@example.com' });
    expect((await listCustomTerms()).terms).toEqual([
      { label: 'person_full_name', value: 'The Boss', caseSensitive: false },
    ]);

    // Idempotent: a second delete of the same value is a no-op, not an error.
    await removeCustomTerm({ value: 'jane@example.com' });
    expect((await listCustomTerms()).terms).toHaveLength(1);

    const config = parseToml(
      fs.readFileSync(path.join(workspace, 'basemind.toml'), 'utf8'),
    ) as Record<string, any>;
    expect(config.documents.redaction.enabled).toBe(true);
  });

  test('rejects empty value, unknown update target, and duplicate rename', async () => {
    useTempWorkspace();
    await expect(addCustomTerm({ label: 'x', value: '   ' })).rejects.toThrow(
      'value is required',
    );
    await addCustomTerm({ label: 'a', value: 'one' });
    await addCustomTerm({ label: 'b', value: 'two' });
    await expect(
      updateCustomTerm({ originalValue: 'missing', value: 'x' }),
    ).rejects.toThrow('not found');
    await expect(
      updateCustomTerm({ originalValue: 'one', value: 'two' }),
    ).rejects.toThrow('already exists');
    expect((await listCustomTerms()).terms).toHaveLength(2);
  });

  test('every operation requires a workspace', async () => {
    setCurrentWorkspace(null);
    await expect(listCustomTerms()).rejects.toThrow('Open a folder first');
    await expect(removeCustomTerm({ value: 'x' })).rejects.toThrow(
      'Open a folder first',
    );
  });
});
```

Add `parseToml` to the test file's `smol-toml` import (`import { parse as parseToml } from 'smol-toml';`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test server/handlers/pii.test.ts`
Expected: FAIL — `listCustomTerm` is not a function / import error.

- [ ] **Step 3: Implement the handlers**

In `server/handlers/pii.ts`, replace the body from `resolveCustomTermsConfigPath` through end of file with:

```ts
function resolveCustomTermsConfigPath(workspace: string): string {
  const rootConfig = path.join(workspace, 'basemind.toml');
  if (fs.existsSync(rootConfig)) return rootConfig;
  const legacyConfig = path.join(workspace, '.basemind', 'basemind.toml');
  if (fs.existsSync(legacyConfig)) return legacyConfig;
  return rootConfig;
}

interface CustomTermEntry {
  label: string;
  value: string;
  case_sensitive?: boolean;
}

function requireWorkspace(): string {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    throw new Error('No workspace set. Open a folder first.');
  }
  return workspace;
}

interface CustomTermsState {
  configPath: string;
  config: Record<string, unknown>;
  redaction: Record<string, unknown>;
  terms: CustomTermEntry[];
}

/** Read-only parse of documents.redaction.custom_terms; never writes. */
function readCustomTermsState(workspace: string): CustomTermsState {
  const configPath = resolveCustomTermsConfigPath(workspace);
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = parseToml(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }
  const documents = (config.documents ?? {}) as Record<string, unknown>;
  const redaction = (documents.redaction ?? {}) as Record<string, unknown>;
  const terms = Array.isArray(redaction.custom_terms)
    ? (redaction.custom_terms as CustomTermEntry[])
    : [];
  return { configPath, config, redaction, terms };
}

/**
 * Parse-modify-write via smol-toml: basemind.toml is schema-shaped config, so
 * comments are not preserved — acceptable ceiling for a rarely-written file;
 * switch to a targeted text splice if operators start hand-commenting it.
 */
function writeCustomTermsState(state: CustomTermsState): {
  success: boolean;
  configPath: string;
} {
  // A written rule is an intent to redact; leave the master switch to safe/
  // activation (#19 workspace gate) but turn it on when pinning so the term fires.
  state.redaction.enabled = true;
  const documents = (state.config.documents ?? {}) as Record<string, unknown>;
  documents.redaction = state.redaction;
  state.config.documents = documents;
  fs.mkdirSync(path.dirname(state.configPath), { recursive: true });
  fs.writeFileSync(state.configPath, stringifyToml(state.config), 'utf8');
  return { success: true, configPath: state.configPath };
}

function toTermDto(term: CustomTermEntry): {
  label: string;
  value: string;
  caseSensitive: boolean;
} {
  return {
    label: term?.label ?? '',
    value: term?.value ?? '',
    caseSensitive: term?.case_sensitive === true,
  };
}

export async function listCustomTerms(): Promise<{
  terms: Array<{ label: string; value: string; caseSensitive: boolean }>;
}> {
  const state = readCustomTermsState(requireWorkspace());
  return { terms: state.terms.map(toTermDto) };
}

export async function addCustomTerm(request: {
  label: string;
  value: string;
  caseSensitive?: boolean;
}): Promise<{ success: boolean; configPath: string }> {
  const workspace = requireWorkspace();
  const label = (request?.label ?? '').trim();
  const value = (request?.value ?? '').trim();
  if (!value) {
    throw new Error('[pii] Custom term value is required');
  }

  const state = readCustomTermsState(workspace);
  const alreadyPinned = state.terms.some((term) => term?.value === value);
  if (!alreadyPinned) {
    state.redaction.custom_terms = [
      ...state.terms,
      { label: label || 'Custom', value, case_sensitive: request?.caseSensitive === true },
    ];
  }
  return writeCustomTermsState(state);
}

export async function updateCustomTerm(request: {
  originalValue: string;
  label?: string;
  value?: string;
  caseSensitive?: boolean;
}): Promise<{ success: boolean; configPath: string }> {
  const workspace = requireWorkspace();
  const originalValue = (request?.originalValue ?? '').trim();
  if (!originalValue) {
    throw new Error('[pii] updateCustomTerm requires originalValue');
  }
  const state = readCustomTermsState(workspace);
  const index = state.terms.findIndex((term) => term?.value === originalValue);
  if (index === -1) {
    throw new Error(`[pii] custom term not found: ${originalValue}`);
  }
  const nextValue = (request.value ?? originalValue).trim();
  if (!nextValue) {
    throw new Error('[pii] Custom term value is required');
  }
  if (
    nextValue !== originalValue &&
    state.terms.some((term) => term?.value === nextValue)
  ) {
    throw new Error(`[pii] custom term already exists: ${nextValue}`);
  }
  const next = [...state.terms];
  next[index] = {
    label: (request.label ?? next[index].label ?? '').trim() || 'Custom',
    value: nextValue,
    case_sensitive: request.caseSensitive ?? next[index].case_sensitive === true,
  };
  state.redaction.custom_terms = next;
  return writeCustomTermsState(state);
}

export async function removeCustomTerm(request: {
  value: string;
}): Promise<{ success: boolean; configPath: string }> {
  const workspace = requireWorkspace();
  const value = (request?.value ?? '').trim();
  if (!value) {
    throw new Error('[pii] Custom term value is required');
  }
  const state = readCustomTermsState(workspace);
  state.redaction.custom_terms = state.terms.filter((term) => term?.value !== value);
  return writeCustomTermsState(state);
}
```

Note: `CustomTermEntry` moves up intact; delete the old `resolveCustomTermsConfigPath`/`CustomTermEntry`/`addCustomTerm` block when splicing so nothing is duplicated. Keep the file-header comment accurate by extending it: `...the manual-gesture custom-term write, and Settings term CRUD.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test server/handlers/pii.test.ts`
Expected: PASS, including the pre-existing `pii.addCustomTerm` / `getRehydrationMap` / `rememberRehydration` suites (behavior of add is unchanged: same validation message, same de-dupe, same `enabled = true`).

- [ ] **Step 5: Commit**

```bash
git add server/handlers/pii.ts server/handlers/pii.test.ts
git commit -s -m "feat(pii): list/update/remove for workspace custom terms"
```

---

### Task 2: IPC routes, renderer interface, read-only classification

**Files:**
- Modify: `server/routes/ipc.ts` (in the `pii: { … }` object, after `addCustomTerm` at ~line 183)
- Modify: `server/workstationConnection.ts` (`READ_ONLY_IPC_OPERATIONS` set at line 148)
- Modify: `src/ipc.ts` (`PiiIpc` interface at line 633, demo stubs at line 755)
- Test: `server/routes/pii-ipc.test.ts` (new)

**Interfaces:**
- Consumes: `listCustomTerms`, `updateCustomTerm`, `removeCustomTerm` from Task 1.
- Produces:
  - HTTP: `POST /api/ipc/pii/listCustomTerms` (body `[]`), `POST /api/ipc/pii/updateCustomTerm` (body `[{originalValue, label?, value?, caseSensitive?}]`), `POST /api/ipc/pii/removeCustomTerm` (body `[{value}]`).
  - Renderer: three methods on `PiiIpc` with the same shapes as Task 1's handlers; demo-mode `listCustomTerms` resolves `{ terms: [] }`, the two writes throw `Error('Not available in demo mode')`.
  - `READ_ONLY_IPC_OPERATIONS` gains `'pii.listCustomTerms'` (reads allowed on remote read-only; writes stay blocked → 403).

- [ ] **Step 1: Write the failing route test**

Create `server/routes/pii-ipc.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setCurrentWorkspace } from '../utils/workspace';
import { isReadOnlyWorkstationRequest } from '../workstationConnection';

const ipcRouter = (await import('./ipc')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ipc', ipcRouter);
  return app;
}

const workspaces: string[] = [];

function useTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-ipc-ws-'));
  workspaces.push(dir);
  setCurrentWorkspace(dir);
  return dir;
}

beforeEach(() => {
  setCurrentWorkspace(null);
});

afterAll(() => {
  setCurrentWorkspace(null);
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pii IPC routes', () => {
  test('listCustomTerms answers over HTTP and round-trips a write', async () => {
    const workspace = useTempWorkspace();
    const app = buildApp();

    const add = await request(app)
      .post('/api/ipc/pii/addCustomTerm')
      .send([{ label: 'email', value: 'jane@example.com' }]);
    expect(add.status).toBe(200);

    const list = await request(app).post('/api/ipc/pii/listCustomTerms').send([]);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      terms: [{ label: 'email', value: 'jane@example.com', caseSensitive: false }],
    });

    const remove = await request(app)
      .post('/api/ipc/pii/removeCustomTerm')
      .send([{ value: 'jane@example.com' }]);
    expect(remove.status).toBe(200);
    expect(
      (await request(app).post('/api/ipc/pii/listCustomTerms').send([])).body.terms,
    ).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'basemind.toml'))).toBe(true);
  });

  test('read-only workstation allows term reads but blocks term writes', () => {
    expect(
      isReadOnlyWorkstationRequest({
        method: 'POST',
        path: '/api/ipc/pii/listCustomTerms',
      }),
    ).toBe(true);
    expect(
      isReadOnlyWorkstationRequest({
        method: 'POST',
        path: '/api/ipc/pii/addCustomTerm',
      }),
    ).toBe(false);
    expect(
      isReadOnlyWorkstationRequest({
        method: 'POST',
        path: '/api/ipc/pii/updateCustomTerm',
      }),
    ).toBe(false);
    expect(
      isReadOnlyWorkstationRequest({
        method: 'POST',
        path: '/api/ipc/pii/removeCustomTerm',
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test server/routes/pii-ipc.test.ts`
Expected: FAIL — `pii.listCustomTerms` route undefined (and the read-only assertion fails).

- [ ] **Step 3: Wire routes, read-only set, renderer interface**

`server/routes/ipc.ts` — inside `pii: { … }`, after the `addCustomTerm` entry:

```ts
    listCustomTerms: async () => {
      const { listCustomTerms } = await import('../handlers/pii');
      return listCustomTerms();
    },
    updateCustomTerm: async ([request]: [{
      originalValue: string;
      label?: string;
      value?: string;
      caseSensitive?: boolean;
    }]) => {
      const { updateCustomTerm } = await import('../handlers/pii');
      return updateCustomTerm(request);
    },
    removeCustomTerm: async ([request]: [{ value: string }]) => {
      const { removeCustomTerm } = await import('../handlers/pii');
      return removeCustomTerm(request);
    },
```

`server/workstationConnection.ts` — add to `READ_ONLY_IPC_OPERATIONS` (line 148):

```ts
  // PII term reads (Settings Privacy tab); writes stay blocked read-only.
  'pii.listCustomTerms',
```

`src/ipc.ts` — inside `interface PiiIpc` (after `addCustomTerm`):

```ts
  listCustomTerms(): Promise<{
    terms: Array<{ label: string; value: string; caseSensitive: boolean }>;
  }>;
  updateCustomTerm(request: {
    originalValue: string;
    label?: string;
    value?: string;
    caseSensitive?: boolean;
  }): Promise<{ success: boolean; configPath: string }>;
  removeCustomTerm(request: {
    value: string;
  }): Promise<{ success: boolean; configPath: string }>;
```

Marketing-demo stub block (line 755) gains:

```ts
    listCustomTerms: async () => ({ terms: [] }),
    updateCustomTerm: async () => {
      throw new Error('Not available in demo mode');
    },
    removeCustomTerm: async () => {
      throw new Error('Not available in demo mode');
    },
```

- [ ] **Step 4: Run the test and typecheck**

Run: `bun test server/routes/pii-ipc.test.ts && pnpm run typecheck`
Expected: PASS + no type errors. (Browser mode and Electron's HTTP fallback both route through this same `handlers` object, so the route test covers both transports for these methods.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/ipc.ts server/workstationConnection.ts src/ipc.ts server/routes/pii-ipc.test.ts
git commit -s -m "feat(pii): expose term list/update/remove over IPC"
```

---

### Task 3: Privacy tab shell (catalog, nav, pane, empty states)

**Files:**
- Modify: `shared/settingsCatalog.ts` (`SettingsTabId` union line 1, `SETTINGS_TABS` line 63, `SettingsSectionId` line 14, `SETTINGS_SECTIONS` line 132)
- Modify: `src/components/GlobalSettings.tsx` (import block line 17, `TAB_INFO` line 60, pane render near line 560)
- Create: `src/components/settings/PrivacySection.tsx`
- Test: `src/components/settings/PrivacySection.ui.test.tsx` (new)
- Modify: all 8 `shared/locales/*.json`

**Interfaces:**
- Consumes: `pii.listCustomTerms` (Task 2), `SettingsSection`/`SettingsPane`, `Input`, `Button`, a native `<select>` (label-associated — `NativeSelect` is a button-based custom control with no label association, so `getByLabelText` would fail), and a native checkbox.
- Produces: `PrivacySectionContent` export; tab id `'privacy'`; section id `'piiTerms'`; i18n keys `settings.tabs.privacy`, `help.settings.privacy.description`, `settings.privacy.termsSection`, `settings.privacy.termsDescription`, `settings.privacy.termsEmpty`, `settings.privacy.noWorkspace`, `settings.privacy.loading`, `settings.privacy.loadFailed`. Every string in the component comes from `t()` — no hardcoded user-facing text.

- [ ] **Step 1: Write the failing UI test**

Create `src/components/settings/PrivacySection.ui.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const readOnly = vi.hoisted(() => ({ value: false }));
const piiMocks = vi.hoisted(() => ({
  listCustomTerms: vi.fn(async () => ({ terms: [] })),
  addCustomTerm: vi.fn(async () => ({ success: true, configPath: '/tmp/basemind.toml' })),
  updateCustomTerm: vi.fn(async () => ({ success: true, configPath: '/tmp/basemind.toml' })),
  removeCustomTerm: vi.fn(async () => ({ success: true, configPath: '/tmp/basemind.toml' })),
}));

vi.mock('@/ipc', () => ({ pii: piiMocks }));
vi.mock('../../remote/workstationConnection', () => ({
  isWorkstationReadOnly: () => readOnly.value,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'settings.privacy.loading': 'Loading...',
        'settings.privacy.termsSection': 'Personalized terms',
        'settings.privacy.termsDescription':
          'Words and phrases Interpreter should treat as personal information.',
        'settings.privacy.termsEmpty': 'No personalized terms yet.',
        'settings.privacy.noWorkspace': 'Open a folder to manage personalized terms.',
        'settings.privacy.loadFailed': 'Could not load personalized terms.',
        'settings.privacy.caseSensitive': 'Case sensitive',
      };
      return labels[key] ?? key;
    },
  }),
}));

import { PrivacySectionContent } from './PrivacySection';

describe('PrivacySectionContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOnly.value = false;
    piiMocks.listCustomTerms.mockResolvedValue({ terms: [] });
  });

  test('shows loading, then the empty state when no terms exist', async () => {
    render(<PrivacySectionContent />);
    expect(screen.getByText('Loading...')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText('No personalized terms yet.')).toBeDefined();
    });
    expect(piiMocks.listCustomTerms).toHaveBeenCalledTimes(1);
  });

  test('renders one row per stored term with its palette label', async () => {
    piiMocks.listCustomTerms.mockResolvedValue({
      terms: [
        { label: 'email', value: 'jane@example.com', caseSensitive: false },
        { label: 'boss', value: 'My Boss', caseSensitive: true },
      ],
    });
    render(<PrivacySectionContent />);
    await waitFor(() => {
      expect(screen.getByText('jane@example.com')).toBeDefined();
    });
    expect(screen.getByText('My Boss')).toBeDefined();
    // Palette label for the `email` category key, raw label for the unknown one.
    expect(screen.getByText('Email')).toBeDefined();
  });

  test('renders the inline error when the list call fails', async () => {
    piiMocks.listCustomTerms.mockRejectedValue(new Error('boom'));
    render(<PrivacySectionContent />);
    await waitFor(() => {
      expect(screen.getByText('Could not load personalized terms.')).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts src/components/settings/PrivacySection.ui.test.tsx`
Expected: FAIL — `PrivacySection` does not exist.

- [ ] **Step 3: Build the shell**

`shared/settingsCatalog.ts`:

```ts
export type SettingsTabId =
  | 'general'
  | 'models'
  | 'permissions'
  | 'privacy'          // add
  | 'tools'
  // …rest unchanged
```

```ts
export type SettingsSectionId =
  // …existing
  | 'piiTerms';       // add
```

In `SETTINGS_TABS`, insert after the `permissions` entry:

```ts
  {
    id: 'privacy',
    titleKey: 'settings.tabs.privacy',
    defaultLabel: 'Privacy',
    descriptionKey: 'help.settings.privacy.description',
  },
```

In `SETTINGS_SECTIONS`, add:

```ts
  { id: 'piiTerms', tabId: 'privacy', defaultLabel: 'Personalized terms' },
```

`src/components/GlobalSettings.tsx`:

- Add import: `import { PrivacySectionContent } from './settings/PrivacySection';`
- Add `Lock` to the existing `lucide-react` import; add to `TAB_INFO`: `privacy: { icon: Lock },`
- Add the pane next to the other tab panes (e.g. after the `permissions` pane block):

```tsx
                {activeTab === "privacy" && (
                  <SettingsPane>
                    <SettingsSection
                      title={t("settings.privacy.termsSection")}
                      description={t("settings.privacy.termsDescription")}
                      sectionId="piiTerms"
                    >
                      <PrivacySectionContent />
                    </SettingsSection>
                  </SettingsPane>
                )}
```

`src/components/settings/PrivacySection.tsx` (shell — list + empty/error states, no mutations yet):

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { pii } from '@/ipc';
import { PII_COLORS } from '../../lib/pii/colors';

export interface PrivacyTermRow {
  label: string;
  value: string;
  caseSensitive: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; terms: PrivacyTermRow[] };

function categoryLabel(label: string): string {
  return PII_COLORS[label]?.label ?? label;
}

export function PrivacySectionContent() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    pii
      .listCustomTerms()
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', terms: result.terms });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <div className="py-4 text-ui-sm text-muted-foreground">{t('settings.privacy.loading')}</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="py-4 text-ui-sm text-red-600 dark:text-red-400">
        {t('settings.privacy.loadFailed')}
      </div>
    );
  }
  if (state.terms.length === 0) {
    return <div className="py-4 text-ui-sm text-muted-foreground">{t('settings.privacy.termsEmpty')}</div>;
  }

  return (
    <ul className="divide-y" data-testid="privacy-term-rows">
      {state.terms.map((term) => (
        <li key={term.value} className="flex items-center gap-3 py-2 text-sm">
          <span className="rounded-full px-2 py-0.5 text-xs"
            style={{ backgroundColor: `${PII_COLORS[term.label]?.light ?? '#6b7280'}22`,
                     color: PII_COLORS[term.label]?.light ?? '#6b7280' }}>
            {categoryLabel(term.label)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{term.value}</span>
          {term.caseSensitive && (
            <span className="text-xs text-muted-foreground">{t('settings.privacy.caseSensitive')}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

i18n — add these keys to **all 8** `shared/locales/*.json` (flat keys, alphabetical position beside their `settings.` neighbours):

```
"help.settings.privacy.description": "Personalized redaction terms for your notes.",
"settings.privacy.termsSection": "Personalized terms",
"settings.privacy.termsDescription": "Words and phrases Interpreter should treat as personal information in new notes.",
"settings.privacy.termsEmpty": "No personalized terms yet. Right-click text in a note and choose Mark as PII to add one.",
"settings.privacy.noWorkspace": "Open a folder to manage personalized terms.",
"settings.privacy.loading": "Loading...",
"settings.privacy.loadFailed": "Could not load personalized terms.",
"settings.privacy.caseSensitive": "Case sensitive",
"settings.tabs.privacy": "Privacy",
```

(The `settings.privacy.caseSensitive` key is used by the shell already; `noWorkspace` is exercised in Task 4. `common.save` / `common.cancel` / `common.delete` already exist — reuse them.)

- [ ] **Step 4: Run UI test + locale parity + typecheck**

Run:
```bash
pnpm exec vitest run --config vitest.config.ts src/components/settings/PrivacySection.ui.test.tsx
bun test shared/locales/__tests__/completeness.test.ts
pnpm run typecheck
```
Expected: PASS everywhere. `completeness.test.ts` catches any of the 8 files missing a key or carrying an extra one.

- [ ] **Step 5: Commit**

```bash
git add shared/settingsCatalog.ts src/components/GlobalSettings.tsx src/components/settings/PrivacySection.tsx src/components/settings/PrivacySection.ui.test.tsx shared/locales/
git commit -s -m "feat(settings): Privacy tab with personalized-terms shell"
```

---

### Task 4: Terms panel behavior (add / edit / delete)

**Files:**
- Modify: `src/components/settings/PrivacySection.tsx`
- Modify: `src/components/settings/PrivacySection.ui.test.tsx`
- Modify: `shared/locales/*.json` (8 files, new keys below)

**Interfaces:**
- Consumes: `pii.addCustomTerm/updateCustomTerm/removeCustomTerm` (Task 2), `PII_COLORS` for the category select.
- Produces: the window event **`pii:custom-terms-changed`** (dispatched on every successful mutation — Task 5's editor listens for it); form values sent as `label = palette category key` (e.g. `email`), matching what `buildPiiLabelAttributes` colors later.

- [ ] **Step 1: Write the failing behavior tests**

Append to `PrivacySection.ui.test.tsx` (add `userEvent` import from `@testing-library/user-event`, and spy helpers):

```tsx
test('adds a term with a palette category and notifies the editor', async () => {
  const user = userEvent.setup();
  const listener = vi.fn();
  window.addEventListener('pii:custom-terms-changed', listener);
  piiMocks.listCustomTerms.mockResolvedValue({ terms: [] });

  render(<PrivacySectionContent />);
  await waitFor(() => expect(screen.getByText('No personalized terms yet.')).toBeDefined());

  await user.type(screen.getByLabelText('Text'), 'Acme Corp');
  await user.selectOptions(screen.getByLabelText('Category'), 'organization');
  await user.click(screen.getByRole('button', { name: 'Add term' }));

  expect(piiMocks.addCustomTerm).toHaveBeenCalledWith({
    label: 'organization',
    value: 'Acme Corp',
    caseSensitive: false,
  });
  await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  window.removeEventListener('pii:custom-terms-changed', listener);
});

test('edits a term through the inline form (remove-then-add semantics on the server)', async () => {
  const user = userEvent.setup();
  piiMocks.listCustomTerms.mockResolvedValue({
    terms: [{ label: 'boss', value: 'My Boss', caseSensitive: true }],
  });
  render(<PrivacySectionContent />);
  await waitFor(() => expect(screen.getByText('My Boss')).toBeDefined());

  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await user.clear(screen.getByLabelText('Text'));
  await user.type(screen.getByLabelText('Text'), 'The Boss');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(piiMocks.updateCustomTerm).toHaveBeenCalledWith({
    originalValue: 'My Boss',
    label: 'boss',
    value: 'The Boss',
    caseSensitive: true,
  });
});

test('deletes a term after confirmation-free click and notifies', async () => {
  const user = userEvent.setup();
  const listener = vi.fn();
  window.addEventListener('pii:custom-terms-changed', listener);
  piiMocks.listCustomTerms.mockResolvedValue({
    terms: [{ label: 'boss', value: 'My Boss', caseSensitive: false }],
  });
  render(<PrivacySectionContent />);
  await waitFor(() => expect(screen.getByText('My Boss')).toBeDefined());

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(piiMocks.removeCustomTerm).toHaveBeenCalledWith({ value: 'My Boss' });
  await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  window.removeEventListener('pii:custom-terms-changed', listener);
});

test('disables every write control on a read-only workstation', async () => {
  readOnly.value = true;
  piiMocks.listCustomTerms.mockResolvedValue({
    terms: [{ label: 'boss', value: 'My Boss', caseSensitive: false }],
  });
  render(<PrivacySectionContent />);
  await waitFor(() => expect(screen.getByText('My Boss')).toBeDefined());
  expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
});
```

(`readOnly` is the hoisted module-scope object declared in Task 3's mock preamble — `beforeEach` already resets it to `false`.)

Extend the `t` label map with the new keys (Save/Cancel/Delete reuse the existing `common.*` keys):

```ts
'settings.privacy.addTerm': 'Add term',
'settings.privacy.text': 'Text',
'settings.privacy.category': 'Category',
'settings.privacy.edit': 'Edit',
'common.save': 'Save',
'common.cancel': 'Cancel',
'common.delete': 'Delete',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts src/components/settings/PrivacySection.ui.test.tsx`
Expected: FAIL — no form controls on screen.

- [ ] **Step 3: Implement the panel**

Extend `PrivacySection.tsx`. Keep the load effect; add mutation state:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { pii } from '@/ipc';
import { PII_COLORS } from '../../lib/pii/colors';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
```

No `NativeSelect` (button-based control, no label association) and no `Switch` — the case-sensitivity control is a plain `<input type="checkbox">` with an associated `<label>`, so `getByLabelText` and the accessible name work with zero API risk.

State + helpers inside the component:

```tsx
  const readOnly = isWorkstationReadOnly();
  const [terms, setTerms] = useState<PrivacyTermRow[]>([]);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ label: string; value: string; caseSensitive: boolean }>({
    label: 'email',
    value: '',
    caseSensitive: false,
  });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await pii.listCustomTerms();
      setTerms(result.terms);
      setError(null);
    } catch {
      setError(t('settings.privacy.loadFailed'));
    }
  }, [t]);

  const notifyEditor = () => {
    window.dispatchEvent(new CustomEvent('pii:custom-terms-changed'));
  };

  const handleAdd = async () => {
    if (!draft.value.trim()) return;
    try {
      await pii.addCustomTerm({
        label: draft.label,
        value: draft.value.trim(),
        caseSensitive: draft.caseSensitive,
      });
      setDraft((prev) => ({ ...prev, value: '' }));
      notifyEditor();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveEdit = async (originalValue: string) => {
    try {
      await pii.updateCustomTerm({
        originalValue,
        label: draft.label,
        value: draft.value.trim(),
        caseSensitive: draft.caseSensitive,
      });
      setEditingValue(null);
      notifyEditor();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (value: string) => {
    try {
      await pii.removeCustomTerm({ value });
      notifyEditor();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Edit seeds the draft from the row first — category/case are preserved
  // unless the user changes them (the edit test asserts label 'boss' round-trips).
  const startEdit = (term: PrivacyTermRow) => {
    setDraft({ label: term.label, value: term.value, caseSensitive: term.caseSensitive });
    setEditingValue(term.value);
  };
```

Render: rows as in the shell, plus per-row `Edit`/`Delete` buttons (both `disabled={readOnly}`, accessible names from `t('settings.privacy.edit')` / `t('common.delete')`). **Clicking `Edit` first sets `editingValue = term.value` and seeds `draft` from that row** (`{ label: term.label, value: term.value, caseSensitive: term.caseSensitive }`) so Save sends the untouched category/case unless the user changes them. While `editingValue !== null`, that row becomes the three-field form with `Save`/`Cancel` buttons (`t('common.save')` / `t('common.cancel')`), **and the standalone add row is not rendered** — two rows each containing a "Text"/"Category" label would make `getByLabelText` ambiguous. The add row (only when `editingValue === null`): `<label htmlFor="pii-term-text">` + `<Input id="pii-term-text">`, `<label htmlFor="pii-term-category">` + category `<select id="pii-term-category">` whose options are `Object.entries(PII_COLORS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)`, a label-associated `<input type="checkbox">` for case sensitivity, and `<Button disabled={readOnly}>` with `t('settings.privacy.addTerm')` as its accessible name. An `error` paragraph renders above the list in the same error style as the load failure. After every mutation, the list refreshes from `reload()` (optimistic updates skipped: the server is the source of truth and the round trip is local).

i18n — add to all 8 locales:

```
"settings.privacy.addTerm": "Add term",
"settings.privacy.text": "Text",
"settings.privacy.category": "Category",
"settings.privacy.edit": "Edit",
```

(Save/Cancel/Delete button labels reuse the existing `common.save` / `common.cancel` / `common.delete` keys — no new keys for them.)

- [ ] **Step 4: Run tests + typecheck**

Run:
```bash
pnpm exec vitest run --config vitest.config.ts src/components/settings/PrivacySection.ui.test.tsx
bun test shared/locales/__tests__/completeness.test.ts
pnpm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/PrivacySection.tsx src/components/settings/PrivacySection.ui.test.tsx shared/locales/
git commit -s -m "feat(settings): add, edit, and remove personalized terms in the Privacy tab"
```

---

### Task 5: Term matcher + editor labels

**Files:**
- Create: `src/lib/pii/custom-terms.ts`
- Test: `src/lib/pii/custom-terms.test.ts` (new — lives under `src/lib`, so `test:unit` picks it up)
- Modify: `src/extensions/PiiLabel.ts`
- Modify: `src/extensions/PiiLabel.test.ts`
- Modify: `src/components/TipTapViewer.tsx` (storage-sync effect region, ~line 366)
- Modify: `scripts/run-unit-tests.mjs` (`ROOT_DIRS` line 18)

**Interfaces:**
- Consumes: `pii.listCustomTerms()` (Task 2), `normalizePiiCategory` (`src/lib/pii/labels.ts`), `PiiLabelStorage`, `piiSpansForText`.
- Produces:
  - `PiiCustomTerm { label: string; value: string; caseSensitive?: boolean }` from `src/lib/pii/custom-terms.ts`.
  - `findTermSpans(text: string, terms: PiiCustomTerm[]): Array<{ category: string; token: string; from: number; to: number }>`
  - `piiSpansForText(text: string, mode: PiiLabelMode, terms?: PiiCustomTerm[]): PiiSpan[]` — **third parameter added** (defaults `[]`, existing callers unchanged).
  - `PiiLabelStorage.customTerms?: PiiCustomTerm[]`.
  - Window event `pii:custom-terms-changed` (from Task 4) consumed here.

- [ ] **Step 1: Write the failing matcher tests**

Create `src/lib/pii/custom-terms.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { findTermSpans } from './custom-terms';

describe('findTermSpans', () => {
  test('matches a literal term containing regex metacharacters', () => {
    const spans = findTermSpans('deploy C++ (prod) today', [
      { label: 'internal_hostname', value: 'C++ (prod)' },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe('C++ (prod)');
    expect(spans[0].from).toBe('deploy '.length);
    expect(spans[0].category).toBe('internal_hostname');
  });

  test('honors per-term case sensitivity in one list', () => {
    const terms = [
      { label: 'organization', value: 'acme' },            // insensitive
      { label: 'person_last_name', value: 'Smith', caseSensitive: true },
    ];
    const spans = findTermSpans('Acme met Smith and smith', terms);
    expect(spans.map((s) => s.token)).toEqual(['Acme', 'Smith']);
  });

  test('normalizes aliases to the palette category', () => {
    const spans = findTermSpans('ask Jane about it', [
      { label: 'name', value: 'Jane' },
    ]);
    expect(spans[0].category).toBe('person_full_name');
  });

  test('drops overlapping matches, keeping the earlier-longer span', () => {
    const spans = findTermSpans('Acme Corp', [
      { label: 'organization', value: 'Acme Corp' },
      { label: 'organization', value: 'Acme' },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe('Acme Corp');
  });

  test('returns nothing for empty terms or empty text', () => {
    expect(findTermSpans('hello', [])).toEqual([]);
    expect(findTermSpans('', [{ label: 'email', value: 'x' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/lib/pii/custom-terms.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matcher**

`src/lib/pii/custom-terms.ts`:

```ts
import { normalizePiiCategory } from './labels';

export interface PiiCustomTerm {
  label: string;
  value: string;
  caseSensitive?: boolean;
}

export interface TermSpan {
  category: string;
  token: string;
  from: number;
  to: number;
}

interface CompiledTerms {
  key: string;
  sensitive: RegExp | null;
  insensitive: RegExp | null;
}

// ponytail: one cached compilation per term list — the panel rewrites this
// list rarely (Settings), so JSON key equality beats an LRU here.
let compiled: CompiledTerms = { key: '', sensitive: null, insensitive: null };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(terms: PiiCustomTerm[]): CompiledTerms {
  const key = JSON.stringify(terms);
  if (compiled.key === key) return compiled;
  const sensitive = terms.filter((term) => term.caseSensitive && term.value);
  const insensitive = terms.filter((term) => !term.caseSensitive && term.value);
  compiled = {
    key,
    sensitive: sensitive.length
      ? new RegExp(sensitive.map((term) => escapeRegExp(term.value)).join('|'), 'g')
      : null,
    insensitive: insensitive.length
      ? new RegExp(insensitive.map((term) => escapeRegExp(term.value)).join('|'), 'gi')
      : null,
  };
  return compiled;
}

export function findTermSpans(text: string, terms: PiiCustomTerm[]): TermSpan[] {
  if (!terms.length || !text) return [];
  const { sensitive, insensitive } = compile(terms);

  const byValue = new Map<string, PiiCustomTerm>();
  const byLower = new Map<string, PiiCustomTerm>();
  for (const term of terms) {
    if (!term.value) continue;
    byValue.set(term.value, term);
    byLower.set(term.value.toLowerCase(), term);
  }

  const spans: TermSpan[] = [];
  const collect = (
    regex: RegExp | null,
    lookup: (matched: string) => PiiCustomTerm | undefined,
  ) => {
    if (!regex) return;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const term = lookup(match[0]);
      if (!term) continue;
      spans.push({
        category: normalizePiiCategory(term.label),
        token: match[0],
        from: match.index,
        to: match.index + match[0].length,
      });
    }
  };
  collect(sensitive, (matched) => byValue.get(matched));
  collect(insensitive, (matched) => byLower.get(matched.toLowerCase()));

  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: TermSpan[] = [];
  for (const span of spans) {
    const overlaps = kept.some((other) => span.from < other.to && other.from < span.to);
    if (!overlaps) kept.push(span);
  }
  return kept;
}
```

- [ ] **Step 4: Run the matcher tests**

Run: `bun test src/lib/pii/custom-terms.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing PiiLabel tests**

Append to `src/extensions/PiiLabel.test.ts` (this file runs once Step 8 lands; run it directly before then):

```ts
describe('custom term spans', () => {
  test('compose mode labels term matches with the term category', () => {
    const spans = piiSpansForText('Ping the Boss today', 'compose', [
      { label: 'person_full_name', value: 'the Boss' },
    ]);
    const term = spans.find((span) => span.token === 'the Boss');
    expect(term).toBeDefined();
    expect(term!.category).toBe('person_full_name');
    expect(term!.from).toBe('Ping '.length);
  });

  test('a term inside a stored token is not double-labelled', () => {
    const spans = piiSpansForText('[EMAIL_0]', 'compose', [
      { label: 'email', value: 'EMAIL_0' },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe('[EMAIL_0]');
  });

  test('view mode ignores terms entirely', () => {
    const spans = piiSpansForText('the Boss', 'view', [
      { label: 'person_full_name', value: 'the Boss' },
    ]);
    expect(spans).toHaveLength(0);
  });
});
```

Run: `bun test src/extensions/PiiLabel.test.ts`
Expected: FAIL — only the first new test fails: the third argument is ignored by today's 2-arg `piiSpansForText`, so no `the Boss` span is found. (Test files are excluded from `typecheck` — `tsconfig.json` / `tsconfig.electron.json` both exclude `**/*.test.ts` — so the extra argument is never a type error; the failure is assertion-based.)

- [ ] **Step 6: Wire terms into PiiLabel**

`src/extensions/PiiLabel.ts`:

```ts
import { detectRegex } from '../lib/pii/regex-detector';
import { buildPiiLabelAttributes, findRedactedTokens } from '../lib/pii/labels';
import { findTermSpans, type PiiCustomTerm } from '../lib/pii/custom-terms';
```

```ts
export interface PiiLabelStorage {
  mode: PiiLabelMode;
  showOriginals: boolean;
  rehydrationMap: Record<string, string>;
  /** Workspace custom terms, fetched by the viewer; compose mode only. */
  customTerms?: PiiCustomTerm[];
  /** Injected by the viewer from basemind.pii.tokenAriaLabel. */
  tokenAriaLabel?: (categoryLabel: string) => string;
}
```

```ts
export function piiSpansForText(
  text: string,
  mode: PiiLabelMode,
  terms: PiiCustomTerm[] = [],
): PiiSpan[] {
  const tokenSpans = findRedactedTokens(text).map((token) => ({
    category: token.category,
    token: token.token,
    from: token.start,
    to: token.end,
  }));
  if (mode === 'view') return tokenSpans;
  const merged = [...tokenSpans];
  const push = (span: PiiSpan) => {
    const overlaps = merged.some(
      (existing) => span.from < existing.to && existing.from < span.to,
    );
    if (!overlaps) merged.push(span);
  };
  for (const span of findTermSpans(text, terms)) push(span);
  for (const detection of detectRegex(text)) {
    push({
      category: detection.category,
      token: detection.text,
      from: detection.start,
      to: detection.end,
    });
  }
  return merged.sort((a, b) => a.from - b.from);
}
```

And in `scanRange`, pass storage terms (line ~102):

```ts
    for (const span of piiSpansForText(node.text, storage.mode, storage.customTerms ?? [])) {
```

Also add `customTerms: []` to `addStorage()`.

- [ ] **Step 7: Fetch terms in the viewer**

`src/components/TipTapViewer.tsx` — after the existing PiiLabel storage-sync `useEffect` (~line 376), add:

```tsx
  // Personalized terms: fetch once per mount, refresh when Settings mutates
  // them (Settings dispatches pii:custom-terms-changed after every write).
  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    const applyTerms = (terms: Array<{ label: string; value: string; caseSensitive?: boolean }>) => {
      if (cancelled) return;
      const storage = (viewer.storage as { piiLabel?: PiiLabelStorage }).piiLabel;
      if (!storage) return;
      storage.customTerms = terms;
      viewer.commands.updateDecorations('piiLabel');
    };
    const refresh = () => {
      pii.listCustomTerms()
        .then((result) => applyTerms(result.terms))
        .catch(() => applyTerms([])); // demo mode / no workspace: no labels, no breakage
    };
    refresh();
    window.addEventListener('pii:custom-terms-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('pii:custom-terms-changed', refresh);
    };
  }, [viewer]);
```

(`pii` is already imported in this file; `PiiLabelStorage` is already imported — verify both and add only what's missing.)

- [ ] **Step 8: Activate extension tests in `test:unit`**

`scripts/run-unit-tests.mjs` — add to `ROOT_DIRS` (line 18):

```js
  join('src', 'extensions'),
```

Why: `src/extensions/*.test.ts` currently run in **neither** `test:unit` (dir not walked) nor `test:vitest` (wrong suffix) — they are dead in CI. All three files pass today (verified: `bun test src/extensions/` → 10 pass, 0 fail), so this only activates them.

- [ ] **Step 9: Run tests**

Run:
```bash
bun test src/lib/pii/custom-terms.test.ts src/extensions/PiiLabel.test.ts
pnpm test:unit
pnpm run typecheck
```
Expected: PASS (unit floor includes the newly activated `src/extensions` tests).

- [ ] **Step 10: Commit**

```bash
git add src/lib/pii/custom-terms.ts src/lib/pii/custom-terms.test.ts src/extensions/PiiLabel.ts src/extensions/PiiLabel.test.ts src/components/TipTapViewer.tsx scripts/run-unit-tests.mjs
git commit -s -m "feat(pii): label personalized terms in compose mode"
```

---

**Phase 1 gate:** run `pnpm run precommit`. It must pass with zero phase-2 code present. This is the shippable increment.

---

# Phase 2

### Task 6: Inventory sidecar helper

**Files:**
- Create: `server/utils/inventorySidecar.ts`
- Test: `server/utils/inventorySidecar.test.ts` (new)

**Interfaces:**
- Consumes: nothing from safeSync (by design — avoids the import cycle; callers pass `docId`).
- Produces:
  - `interface InventorySidecarEntry { category: string; line: number; masked: string; confidence: number }`
  - `interface InventorySidecar { version: 1; relativePath: string; origin: 'sync' | 'mirror-backfill'; updatedAt: string; entries: InventorySidecarEntry[] }`
  - `inventoryDir(workspacePath: string): string`
  - `sidecarPath(workspacePath: string, docId: string): string`
  - `buildSidecar(input: { relativePath: string; origin: 'sync' | 'mirror-backfill'; redactedText: string; detections: Array<{ category: string; start: number; end: number; text: string; confidence: number }>; rehydrationMap: Record<string, string> }): InventorySidecar`
  - `writeSidecar(workspacePath: string, docId: string, sidecar: InventorySidecar): void`
  - `readSidecar(workspacePath: string, docId: string): InventorySidecar | null` — returns null for missing/unparsable/wrong-version
  - `removeSidecar(workspacePath: string, docId: string): void`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/inventorySidecar.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSidecar,
  readSidecar,
  removeSidecar,
  sidecarPath,
  writeSidecar,
} from './inventorySidecar';

const dirs: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-sidecar-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('inventorySidecar', () => {
  test('builds entries with mirror-relative lines resolved through token positions', () => {
    const redactedText = 'line one\nmail [EMAIL_1] here\n[ORG_1] again [EMAIL_1]';
    const sidecar = buildSidecar({
      relativePath: 'notes/meeting.md',
      origin: 'sync',
      redactedText,
      detections: [
        { category: 'email', start: 0, end: 0, text: 'jane@example.com', confidence: 0.9 },
        { category: 'organization', start: 0, end: 0, text: 'Acme', confidence: 0.7 },
      ],
      rehydrationMap: { '[EMAIL_1]': 'jane@example.com', '[ORG_1]': 'Acme' },
    });

    expect(sidecar.version).toBe(1);
    expect(sidecar.relativePath).toBe('notes/meeting.md');
    expect(sidecar.origin).toBe('sync');
    expect(sidecar.entries).toEqual([
      { category: 'email', line: 2, masked: '[EMAIL_1]', confidence: 0.9 },
      { category: 'organization', line: 3, masked: '[ORG_1]', confidence: 0.7 },
    ]);
    // Repeated token resolves to its next occurrence, not the first again.
    const secondEmail = buildSidecar({
      relativePath: 'notes/meeting.md',
      origin: 'sync',
      redactedText,
      detections: [
        { category: 'email', start: 0, end: 0, text: 'jane@example.com', confidence: 0.9 },
        { category: 'email', start: 1, end: 2, text: 'jane@example.com', confidence: 0.8 },
      ],
      rehydrationMap: { '[EMAIL_1]': 'jane@example.com' },
    });
    expect(secondEmail.entries.map((entry) => entry.line)).toEqual([2, 3]);
  });

  test('falls back to a category placeholder when the map has no match — never the original text', () => {
    const sidecar = buildSidecar({
      relativePath: 'a.md',
      origin: 'sync',
      redactedText: 'x [CUSTOM_1] y',
      detections: [
        { category: 'secret', start: 0, end: 0, text: 'hunter2-ORIGINAL-PII', confidence: 0.5 },
      ],
      rehydrationMap: {},
    });
    expect(sidecar.entries[0].masked).toBe('[secret]');
    expect(JSON.stringify(sidecar)).not.toContain('hunter2-ORIGINAL-PII');
  });

  test('round-trips through the filesystem and removes cleanly', () => {
    const workspace = tempWorkspace();
    const docId = 'sf_abc123';
    const sidecar = buildSidecar({
      relativePath: 'a.md',
      origin: 'sync',
      redactedText: '[EMAIL_1]',
      detections: [
        { category: 'email', start: 0, end: 1, text: 'x@y.z', confidence: 0.99 },
      ],
      rehydrationMap: { '[EMAIL_1]': 'x@y.z' },
    });

    writeSidecar(workspace, docId, sidecar);
    expect(readSidecar(workspace, docId)).toEqual(sidecar);
    expect(readFileSync(sidecarPath(workspace, docId), 'utf8')).toContain('[EMAIL_1]');

    removeSidecar(workspace, docId);
    expect(readSidecar(workspace, docId)).toBeNull();
    removeSidecar(workspace, docId); // idempotent
    expect(readSidecar(workspace, docId)).toBeNull();
  });

  test('returns null for corrupt or wrong-version sidecars', () => {
    const workspace = tempWorkspace();
    const docId = 'sf_bad';
    writeSidecar(workspace, docId, buildSidecar({
      relativePath: 'a.md', origin: 'sync', redactedText: '',
      detections: [], rehydrationMap: {},
    }));
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(sidecarPath(workspace, docId), 'not json', 'utf8');
    expect(readSidecar(workspace, docId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test server/utils/inventorySidecar.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`server/utils/inventorySidecar.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface InventorySidecarEntry {
  category: string;
  /** Line in the safe/ mirror text (see spec: extraction happens before redaction, so original-relative lines are not computable). */
  line: number;
  masked: string;
  confidence: number;
}

export interface InventorySidecar {
  version: 1;
  relativePath: string;
  origin: 'sync' | 'mirror-backfill';
  updatedAt: string;
  entries: InventorySidecarEntry[];
}

export function inventoryDir(workspacePath: string): string {
  return join(workspacePath, '.basemind', 'inventory');
}

export function sidecarPath(workspacePath: string, docId: string): string {
  return join(inventoryDir(workspacePath), `${docId}.json`);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function maskedFor(
  category: string,
  detectionText: string,
  rehydrationMap: Record<string, string>,
): string {
  // ponytail: O(map) per detection — maps are per-file and small; a reverse
  // index only pays off if a file ever carries thousands of spans.
  for (const [token, original] of Object.entries(rehydrationMap)) {
    if (original === detectionText) return token;
  }
  return `[${category}]`;
}

export function buildSidecar(input: {
  relativePath: string;
  origin: 'sync' | 'mirror-backfill';
  redactedText: string;
  detections: Array<{
    category: string;
    start: number;
    end: number;
    text: string;
    confidence: number;
  }>;
  rehydrationMap: Record<string, string>;
}): InventorySidecar {
  let cursor = 0;
  const entries: InventorySidecarEntry[] = [];
  for (const detection of input.detections) {
    const masked = maskedFor(detection.category, detection.text, input.rehydrationMap);
    const at = input.redactedText.indexOf(masked, cursor);
    entries.push({
      category: detection.category,
      line: at === -1 ? 0 : lineAt(input.redactedText, at),
      masked,
      confidence: detection.confidence,
    });
    if (at !== -1) cursor = at + masked.length;
  }
  return {
    version: 1,
    relativePath: input.relativePath,
    origin: input.origin,
    updatedAt: new Date().toISOString(),
    entries,
  };
}

export function writeSidecar(
  workspacePath: string,
  docId: string,
  sidecar: InventorySidecar,
): void {
  const target = sidecarPath(workspacePath, docId);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(sidecar), 'utf8');
}

export function readSidecar(workspacePath: string, docId: string): InventorySidecar | null {
  const target = sidecarPath(workspacePath, docId);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<InventorySidecar>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed as InventorySidecar;
  } catch {
    return null;
  }
}

export function removeSidecar(workspacePath: string, docId: string): void {
  rmSync(sidecarPath(workspacePath, docId), { force: true });
}
```

(`line: 0` means "token not found in redacted text" — the panel renders `—`; Review Focus #4's no-plaintext guarantee lives in `maskedFor`'s fallback.)

- [ ] **Step 4: Run the tests**

Run: `bun test server/utils/inventorySidecar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/inventorySidecar.ts server/utils/inventorySidecar.test.ts
git commit -s -m "feat(safe): per-file inventory sidecar builder"
```

---

### Task 7: safe-sync piggyback (write + remove sidecars, notify)

**Files:**
- Modify: `server/utils/safeSync.ts` (`SafeRedactResult` line 71, `defaultRedactFile` line 80, `syncSafeMirrorFile` line 168)
- Test: `server/utils/safeSync.test.ts`

**Interfaces:**
- Consumes: `buildSidecar`/`writeSidecar`/`removeSidecar` (Task 6), `mirrorDocId` (existing), `redactFn` (existing injection seam).
- Produces:
  - `SafeRedactResult` gains `detections?: Array<{ category; start; end; text; confidence }>` — `defaultRedactFile` passes `piiDetectionService.redactFile()` through unchanged (it already returns detections).
  - After a successful mirror write: best-effort sidecar write + `notifyInventory(workspacePath, relativePath)` (dynamic import of `../services/piiInventory`, whose `noteInventoryUpdate` lands in Task 8 — dynamic import means this task compiles and tests green *before* Task 8 exists).
  - After mirror/vault cleanup on the original-missing path: best-effort `removeSidecar` + same notify.
  - Test seam: `setSafeSyncInventoryNotifyForTests(fn: ((workspacePath: string, relativePath: string) => void) | null)` so tests capture notifications without importing the service.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/safeSync.test.ts`. The file already imports everything from `node:fs` the tests need (`readFileSync`, `mkdirSync`, `existsSync`, …) — the only import changes are: add `mirrorDocId`, `setSafeSyncInventoryNotifyForTests`, and `syncSafeMirrorFile` to the `./safeSync` import list, and add `import { sidecarPath as sidecarPathFor } from './inventorySidecar';` below it. (Sidecar paths are keyed by `mirrorDocId(workspace, rel)` — a `sf_<sha256>` hash, not the plain relative path):

```ts
describe('inventory sidecar piggyback', () => {
  afterEach(() => {
    setSafeSyncInventoryNotifyForTests(null);
    clearAllSafeSync();
  });

  test('writes a sidecar with detections after a mirror write and notifies', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'safesync-sidecar-'));
    const notifications: Array<{ workspace: string; rel: string }> = [];
    setSafeSyncInventoryNotifyForTests((ws, rel) => notifications.push({ workspace: ws, rel }));
    setSafeSyncRedactForTests(async () => ({
      redacted_text: 'hello [EMAIL_1]',
      rehydration_map: { '[EMAIL_1]': 'jane@example.com' },
      detections: [
        { category: 'email', start: 6, end: 22, text: 'jane@example.com', confidence: 0.95 },
      ],
    }));
    setSafeSyncVaultPersistForTests(() => {});
    setSafeSyncVaultRemoveForTests(() => {});

    writeFileSync(join(workspace, 'note.md'), 'hello jane@example.com', 'utf8');
    const result = await syncSafeMirrorFile(workspace, 'note.md');
    expect(result.written).toBe(true);

    const sidecarAbs = sidecarPathFor(workspace, mirrorDocId(workspace, 'note.md'));
    const parsed = JSON.parse(readFileSync(sidecarAbs, 'utf8'));
    expect(parsed.relativePath).toBe('note.md');
    expect(parsed.entries).toEqual([
      { category: 'email', line: 1, masked: '[EMAIL_1]', confidence: 0.95 },
    ]);
    expect(notifications).toEqual([{ workspace, rel: 'note.md' }]);

    rmSync(workspace, { recursive: true, force: true });
  });

  test('removes the sidecar when the original disappears', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'safesync-unlink-'));
    setSafeSyncInventoryNotifyForTests(() => {});
    setSafeSyncRedactForTests(async () => ({
      redacted_text: '[EMAIL_1]',
      rehydration_map: { '[EMAIL_1]': 'x@y.z' },
      detections: [{ category: 'email', start: 0, end: 10, text: 'x@y.z', confidence: 0.9 }],
    }));
    setSafeSyncVaultPersistForTests(() => {});
    setSafeSyncVaultRemoveForTests(() => {});

    writeFileSync(join(workspace, 'note.md'), 'x@y.z', 'utf8');
    await syncSafeMirrorFile(workspace, 'note.md');
    const sidecarAbs = sidecarPathFor(workspace, mirrorDocId(workspace, 'note.md'));
    expect(existsSync(sidecarAbs)).toBe(true);

    rmSync(join(workspace, 'note.md'), { force: true });
    await syncSafeMirrorFile(workspace, 'note.md');
    expect(existsSync(sidecarAbs)).toBe(false);

    rmSync(workspace, { recursive: true, force: true });
  });

  test('a sidecar write failure degrades silently — the mirror still lands', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'safesync-sidecar-fail-'));
    setSafeSyncInventoryNotifyForTests(() => {});
    setSafeSyncRedactForTests(async () => ({
      redacted_text: 'kept',
      rehydration_map: {},
      detections: [{ category: 'email', start: 0, end: 4, text: 'jane@example.com', confidence: 0.9 }],
    }));
    setSafeSyncVaultPersistForTests(() => {});
    setSafeSyncVaultRemoveForTests(() => {});

    writeFileSync(join(workspace, 'note.md'), 'kept', 'utf8');
    // Point the sidecar dir at an unwritable path by pre-creating it as a file.
    mkdirSync(join(workspace, '.basemind'), { recursive: true });
    writeFileSync(join(workspace, '.basemind', 'inventory'), 'blocker', 'utf8');

    const result = await syncSafeMirrorFile(workspace, 'note.md');
    expect(result.written).toBe(true);
    expect(existsSync(join(workspace, 'safe', 'note.md'))).toBe(true);

    rmSync(workspace, { recursive: true, force: true });
  });
});
```

Note: no `setSafeSyncArmedForTests` stub is needed — `syncSafeMirrorFile` never consults the armed gate (that lives in `scheduleSafeSync`, `safeSync.ts:276`), and these tests call `syncSafeMirrorFile` directly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test server/utils/safeSync.test.ts`
Expected: FAIL — sidecar files never created (`existsSync(...)` false), `setSafeSyncInventoryNotifyForTests` not exported.

- [ ] **Step 3: Implement the piggyback**

`server/utils/safeSync.ts`:

- Import at top: `import { buildSidecar, removeSidecar, writeSidecar } from './inventorySidecar';` and `import { readFile } from 'node:fs/promises';`
- Widen the result type:

```ts
export interface SafeRedactResult {
  redacted_text: string;
  rehydration_map: Record<string, string>;
  detections?: Array<{
    category: string;
    start: number;
    end: number;
    text: string;
    confidence: number;
  }>;
}
```

(`defaultRedactFile` needs no change — `piiDetectionService.redactFile` already returns detections; the structural type now just accepts them.)

- Add the notify seam beside the other seams (~line 145):

```ts
type InventoryNotifyFn = (workspacePath: string, relativePath: string) => void;

async function defaultInventoryNotify(workspacePath: string, relativePath: string): Promise<void> {
  try {
    const mod = await import('../services/piiInventory');
    mod.noteInventoryUpdate(workspacePath, relativePath);
  } catch (err) {
    // Inventory is derived data; missing service (or task-order) never blocks sync.
    console.warn(
      `[safe-sync] inventory notify failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let inventoryNotify: (workspacePath: string, relativePath: string) => void =
  (workspacePath, relativePath) => {
    void defaultInventoryNotify(workspacePath, relativePath);
  };

export function setSafeSyncInventoryNotifyForTests(
  fn: ((workspacePath: string, relativePath: string) => void) | null,
): void {
  inventoryNotify = fn ?? ((workspacePath, relativePath) => {
    void defaultInventoryNotify(workspacePath, relativePath);
  });
}
```

- In `syncSafeMirrorFile`, on the original-missing path (after the vault cleanup try/catch, before `return`):

```ts
    try {
      removeSidecar(workspacePath, docId);
    } catch (err) {
      console.warn(
        `[safe-sync] inventory cleanup failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    inventoryNotify(workspacePath, relativePath);
    return { mirrorRel, written: false };
```

- In `syncSafeMirrorFile`, the destructure at the top of the try block becomes:

```ts
    const { redacted_text, rehydration_map, detections } = await redactFn(originalAbs);
```

- In the success path, after the vault-persist try/catch, before `return { mirrorRel, written: true }`:

```ts
    try {
      const redactedText = await readFile(mirrorAbs, 'utf8');
      writeSidecar(
        workspacePath,
        docId,
        buildSidecar({
          relativePath,
          origin: 'sync',
          redactedText,
          detections: detections ?? [],
          rehydrationMap: rehydration_map,
        }),
      );
    } catch (err) {
      // Inventory is derived — a failed sidecar (unwritable .basemind, etc.)
      // must never fail the mirror write itself.
      console.warn(
        `[safe-sync] inventory sidecar failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    inventoryNotify(workspacePath, relativePath);
```

The mirror file we just wrote **is** the redacted text — reading it back avoids a second read of the original and guarantees lines match the mirror byte-for-byte.

- [ ] **Step 4: Run the tests**

Run: `bun test server/utils/safeSync.test.ts`
Expected: PASS (all pre-existing safeSync tests still pass — the seam defaults keep old behavior when no service exists yet).

- [ ] **Step 5: Commit**

```bash
git add server/utils/safeSync.ts server/utils/safeSync.test.ts
git commit -s -m "feat(safe): persist redaction detections as per-file sidecars at sync time"
```

---

### Task 8: Inventory service (cache, backfill, revision, notify)

**Files:**
- Create: `server/services/piiInventory.ts`
- Test: `server/services/piiInventory.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 helpers, `mirrorDocId`/`toSafeMirrorPath`/`shouldSafeSyncForWorkspaceEvent` (`server/utils/safeSync.ts`), `getCurrentWorkspace` (`server/utils/workspace.ts`), `IPC_CHANNELS.PII_INVENTORY_CHANGED` (added in Task 9 — to keep this task independently green, define the channel **string literal** `'pii:inventory-changed'` locally in Task 8 and switch to `IPC_CHANNELS` in Task 9), `broadcastEvent` (`server/handlers/broadcast.ts`).
- Produces:
  - `interface PiiInventoryEntry { category: string; line: number; masked: string; confidence: number }`
  - `interface PiiInventoryFile { relativePath: string; mirrorRel: string; origin: 'sync' | 'mirror-backfill'; updatedAt: string; entries: PiiInventoryEntry[] }`
  - `interface PiiInventorySnapshot { revision: number; armed: boolean; backfilling: boolean; updatedAt: string | null; files: PiiInventoryFile[] }`
  - `getInventorySnapshot(): Promise<PiiInventorySnapshot>`
  - `noteInventoryUpdate(workspacePath: string, relativePath: string): void` — called by safe-sync (Task 7)
  - Test seams: `setInventoryRedactForTests(fn | null)`, `setInventoryNotifyForTests(fn | null)`, `resetInventoryForTests()`, `awaitBackfillForTests(): Promise<void>` (no-op when idle — the walk runs in the background, this is the deterministic wait for tests)

- [ ] **Step 1: Write the failing tests**

Create `server/services/piiInventory.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  awaitBackfillForTests,
  getInventorySnapshot,
  noteInventoryUpdate,
  resetInventoryForTests,
  setInventoryNotifyForTests,
  setInventoryRedactForTests,
} from './piiInventory';
import { mirrorDocId } from '../utils/safeSync';
import { readSidecar } from '../utils/inventorySidecar';
import { setCurrentWorkspace } from '../utils/workspace';

const dirs: string[] = [];
const notifications: number[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pii-inventory-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  notifications.length = 0;
  resetInventoryForTests();
  setInventoryNotifyForTests((revision) => notifications.push(revision));
});

afterEach(() => {
  resetInventoryForTests();
  setInventoryRedactForTests(null);
  setInventoryNotifyForTests(null);
  setCurrentWorkspace(null);
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fakeRedact = (fileContents: Record<string, string>) => async (absolutePath: string) => {
  const rel = absolutePath.split('/').slice(-1)[0];
  const text = fileContents[rel] ?? '';
  return {
    redacted_text: text.includes('jane@example.com')
      ? text.replace('jane@example.com', '[EMAIL_1]')
      : text,
    rehydration_map: text.includes('jane@example.com')
      ? { '[EMAIL_1]': 'jane@example.com' }
      : {},
    detections: text.includes('jane@example.com')
      ? [{ category: 'email', start: 0, end: 0, text: 'jane@example.com', confidence: 0.9 }]
      : [],
  };
};

describe('piiInventory', () => {
  test('reports unarmed with no files when safe/ is absent', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    writeFileSync(join(workspace, 'note.md'), 'jane@example.com', 'utf8');

    const snapshot = await getInventorySnapshot();
    expect(snapshot.armed).toBe(false);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.backfilling).toBe(false);
  });

  test('backfills once, short-circuits later, and skips node_modules', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    mkdirSync(join(workspace, 'safe'), { recursive: true }); // armed
    writeFileSync(join(workspace, 'note.md'), 'jane@example.com', 'utf8');
    mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules', 'pkg', 'x.md'), 'jane@example.com', 'utf8');

    let redactCalls = 0;
    setInventoryRedactForTests(async (absolutePath: string) => {
      redactCalls += 1;
      return fakeRedact({ 'note.md': 'jane@example.com', 'x.md': 'jane@example.com' })(absolutePath);
    });

    const first = await getInventorySnapshot();
    expect(first.armed).toBe(true);
    expect(first.backfilling).toBe(true); // walk started, not awaited (spec: findings arrive)
    expect(redactCalls).toBe(1); // node_modules never reached the redactor
    expect(first.files).toEqual([]); // nothing cached until the walk yields

    await awaitBackfillForTests();

    const done = await getInventorySnapshot();
    expect(done.backfilling).toBe(false);
    expect(done.files).toHaveLength(1);
    expect(done.files[0].relativePath).toBe('note.md');
    expect(done.files[0].mirrorRel).toBe('safe/note.md');
    expect(done.files[0].entries).toEqual([
      { category: 'email', line: 1, masked: '[EMAIL_1]', confidence: 0.9 },
    ]);
    expect(existsSync(join(workspace, '.basemind', 'inventory', '.backfilled'))).toBe(true);

    await getInventorySnapshot();
    expect(redactCalls).toBe(1); // flag short-circuits the walk
  });

  test('single-flight: two concurrent snapshots share one backfill (Review Focus #5)', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'note.md'), 'jane@example.com', 'utf8');

    let redactCalls = 0;
    setInventoryRedactForTests(async () => {
      redactCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fakeRedact({ 'note.md': 'jane@example.com' })('/x/note.md');
    });

    const [a, b] = await Promise.all([getInventorySnapshot(), getInventorySnapshot()]);
    expect(redactCalls).toBe(1); // second call joined the in-flight walk
    expect(a.backfilling).toBe(true);
    expect(b.backfilling).toBe(true);
    await awaitBackfillForTests();
    const snapshot = await getInventorySnapshot();
    expect(snapshot.files).toHaveLength(1);
  });

  test('unsupported files get an empty sidecar so backfill never retries them', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'weird.bin'), 'binary', 'utf8');

    let redactCalls = 0;
    setInventoryRedactForTests(async () => {
      redactCalls += 1;
      return { redacted_text: '', rehydration_map: {}, detections: [] };
    });

    await getInventorySnapshot();
    await awaitBackfillForTests();
    expect(readSidecar(workspace, mirrorDocId(workspace, 'weird.bin'))?.entries).toEqual([]);
    expect(redactCalls).toBe(1);

    resetInventoryForTests(); // drop in-process cache + backfillDone, keep disk (flag + sidecar)
    setCurrentWorkspace(workspace);
    await getInventorySnapshot();
    expect(redactCalls).toBe(1); // the on-disk flag short-circuits the walk
  });

  test('noteInventoryUpdate invalidates one file, bumps revision, and notifies', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    mkdirSync(join(workspace, '.basemind', 'inventory'), { recursive: true });
    writeFileSync(join(workspace, '.basemind', 'inventory', '.backfilled'), '', 'utf8');

    const before = await getInventorySnapshot();
    expect(before.revision).toBe(0);

    // Simulate safe-sync writing a sidecar, then notifying.
    const { buildSidecar, writeSidecar } = await import('../utils/inventorySidecar');
    writeSidecar(workspace, mirrorDocId(workspace, 'note.md'), buildSidecar({
      relativePath: 'note.md',
      origin: 'sync',
      redactedText: '[EMAIL_1]',
      detections: [{ category: 'email', start: 0, end: 10, text: 'jane@example.com', confidence: 0.9 }],
      rehydrationMap: { '[EMAIL_1]': 'jane@example.com' },
    }));
    noteInventoryUpdate(workspace, 'note.md');

    const after = await getInventorySnapshot();
    expect(after.revision).toBe(1);
    expect(after.files.map((f) => f.relativePath)).toEqual(['note.md']);
    expect(notifications).toEqual([1]);

    // Unlink path: remove the sidecar + notify → entry gone, revision bumps again.
    const { removeSidecar } = await import('../utils/inventorySidecar');
    removeSidecar(workspace, mirrorDocId(workspace, 'note.md'));
    noteInventoryUpdate(workspace, 'note.md');
    const final = await getInventorySnapshot();
    expect(final.files).toEqual([]);
    expect(final.revision).toBe(2);
    expect(notifications).toEqual([1, 2]);
  });

  test('backfill marks origin mirror-backfill', async () => {
    const workspace = tempWorkspace();
    setCurrentWorkspace(workspace);
    mkdirSync(join(workspace, 'safe'), { recursive: true });
    writeFileSync(join(workspace, 'note.md'), 'jane@example.com', 'utf8');
    setInventoryRedactForTests(fakeRedact({ 'note.md': 'jane@example.com' }));

    await getInventorySnapshot();
    await awaitBackfillForTests();
    const snapshot = await getInventorySnapshot();
    expect(snapshot.files[0].origin).toBe('mirror-backfill');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test server/services/piiInventory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

`server/services/piiInventory.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { broadcastEvent } from '../handlers/broadcast';
import {
  shouldSafeSyncForWorkspaceEvent,
  mirrorDocId,
  toSafeMirrorPath,
} from '../utils/safeSync';
import {
  buildSidecar,
  inventoryDir,
  readSidecar,
  writeSidecar,
  type InventorySidecar,
} from '../utils/inventorySidecar';
import { getCurrentWorkspace } from '../utils/workspace';

// Kept in sync with electron/ipc/registry.ts IPC_CHANNELS.PII_INVENTORY_CHANGED
// (Task 9 swaps to the import; literal here so this task is independently green).
const CHANNEL = 'pii:inventory-changed';

/** Same directory skips as the vault indexer (server/utils/vaultIndex.ts), plus the safe-sync ignore set. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.obsidian', 'dist', 'build', '.trash',
  'safe', '.redacted', '.basemind',
]);

/** ponytail: one-shot backfill cap — beyond this, split the walk before raising it. */
const MAX_BACKFILL_FILES = 5000;

export interface PiiInventoryEntry {
  category: string;
  line: number;
  masked: string;
  confidence: number;
}

export interface PiiInventoryFile {
  relativePath: string;
  mirrorRel: string;
  origin: 'sync' | 'mirror-backfill';
  updatedAt: string;
  entries: PiiInventoryEntry[];
}

export interface PiiInventorySnapshot {
  revision: number;
  armed: boolean;
  backfilling: boolean;
  updatedAt: string | null;
  files: PiiInventoryFile[];
}

type RedactFn = (absolutePath: string) => Promise<{
  redacted_text: string;
  rehydration_map: Record<string, string>;
  detections?: Array<{ category: string; start: number; end: number; text: string; confidence: number }>;
}>;
type NotifyFn = (revision: number) => void;

let redactFn: RedactFn | null = null;
let notifyFn: NotifyFn = (nextRevision) => broadcastEvent(CHANNEL, { revision: nextRevision });

let revision = 0;
let lastUpdatedAt: string | null = null;
let cacheWorkspace: string | null = null;
const cache = new Map<string, PiiInventoryFile>(); // key: relativePath
let backfillInFlight: Promise<void> | null = null;
const backfillDone = new Set<string>(); // workspace paths completed this process

export function setInventoryRedactForTests(fn: RedactFn | null): void {
  redactFn = fn;
}

export function setInventoryNotifyForTests(fn: NotifyFn | null): void {
  notifyFn = fn ?? ((nextRevision) => broadcastEvent(CHANNEL, { revision: nextRevision }));
}

export function resetInventoryForTests(): void {
  revision = 0;
  lastUpdatedAt = null;
  cacheWorkspace = null;
  cache.clear();
  backfillInFlight = null;
  backfillDone.clear();
}

function ensureWorkspace(workspace: string): void {
  if (cacheWorkspace !== workspace) {
    cacheWorkspace = workspace;
    cache.clear();
  }
}

function flagPath(workspace: string): string {
  return join(inventoryDir(workspace), '.backfilled');
}

function toInventoryFile(sidecar: InventorySidecar): PiiInventoryFile {
  return {
    relativePath: sidecar.relativePath,
    mirrorRel: toSafeMirrorPath(sidecar.relativePath),
    origin: sidecar.origin,
    updatedAt: sidecar.updatedAt,
    entries: sidecar.entries.map((entry) => ({
      category: entry.category,
      line: entry.line,
      masked: entry.masked,
      confidence: entry.confidence,
    })),
  };
}

/** Safe-sync calls this after every sidecar write/removal. */
export function noteInventoryUpdate(workspacePath: string, relativePath: string): void {
  ensureWorkspace(workspacePath);
  const sidecar = readSidecar(workspacePath, mirrorDocId(workspacePath, relativePath));
  if (sidecar) cache.set(sidecar.relativePath, toInventoryFile(sidecar));
  else cache.delete(relativePath);
  revision += 1;
  lastUpdatedAt = new Date().toISOString();
  notifyFn(revision);
}

function listWorkspaceFiles(workspace: string): string[] {
  const out: string[] = [];
  const walk = (dirAbs: string) => {
    if (out.length >= MAX_BACKFILL_FILES) return;
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_BACKFILL_FILES) return;
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(workspace, abs).split(sep).join('/');
      if (shouldSafeSyncForWorkspaceEvent('add', rel)) out.push(rel);
    }
  };
  walk(workspace);
  return out;
}

async function defaultRedact(absolutePath: string) {
  const { piiDetectionService } = await import('./piiDetection');
  return piiDetectionService.redactFile(absolutePath);
}

async function backfillOne(workspace: string, relativePath: string): Promise<void> {
  const docId = mirrorDocId(workspace, relativePath);
  try {
    const redact = redactFn ?? defaultRedact;
    const result = await redact(join(workspace, relativePath));
    writeSidecar(
      workspace,
      docId,
      buildSidecar({
        relativePath,
        origin: 'mirror-backfill',
        redactedText: result.redacted_text,
        detections: result.detections ?? [],
        rehydrationMap: result.rehydration_map,
      }),
    );
    noteInventoryUpdate(workspace, relativePath);
  } catch (err) {
    // No sidecar written → the file stays out of the inventory; the one-shot
    // flag means no retry (safe-sync re-examines it on its next change event).
    // Never aborts the walk.
    console.warn(
      `[pii-inventory] backfill failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Starts the one-shot backfill in the background; never awaits it.
 * Returns true while a walk is in flight (or queued for this call).
 */
function ensureBackfillStarted(workspace: string): boolean {
  if (backfillDone.has(workspace) || existsSync(flagPath(workspace))) return false;
  if (backfillInFlight) return true;

  const walk = (async () => {
    try {
      const files = listWorkspaceFiles(workspace);
      for (const relativePath of files) {
        if (readSidecar(workspace, mirrorDocId(workspace, relativePath))) continue;
        await backfillOne(workspace, relativePath);
      }
      mkdirSync(inventoryDir(workspace), { recursive: true });
      writeFileSync(flagPath(workspace), '', 'utf8');
      backfillDone.add(workspace);
    } catch (err) {
      // e.g. inventory dir unwritable — no flag written, so the next start
      // retries (already-sidecar'd files are skipped cheaply).
      console.warn(
        `[pii-inventory] backfill aborted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  backfillInFlight = walk;
  void walk.then(() => {
    if (backfillInFlight === walk) backfillInFlight = null;
  });
  return true;
}

export async function getInventorySnapshot(): Promise<PiiInventorySnapshot> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return { revision, armed: false, backfilling: false, updatedAt: lastUpdatedAt, files: [] };
  }
  ensureWorkspace(workspace);
  const armed = existsSync(join(workspace, 'safe'));

  const backfilling = armed ? ensureBackfillStarted(workspace) : false;

  // Refresh from disk once per snapshot so sidecars written before this
  // process's cache existed still show up.
  for (const file of listCachedSidecars(workspace)) {
    cache.set(file.relativePath, file);
  }

  return {
    revision,
    armed,
    backfilling,
    updatedAt: lastUpdatedAt,
    files: Array.from(cache.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

/** Test seam: resolves when the in-flight backfill walk finishes (no-op when idle). */
export async function awaitBackfillForTests(): Promise<void> {
  const walk = backfillInFlight;
  if (walk) await walk;
}

function listCachedSidecars(workspace: string): PiiInventoryFile[] {
  const dir = inventoryDir(workspace);
  if (!existsSync(dir)) return [];
  const out: PiiInventoryFile[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const docId = entry.slice(0, -'.json'.length);
      const sidecar = readSidecar(workspace, docId);
      if (sidecar) out.push(toInventoryFile(sidecar));
    } catch {
      // unreadable entry — skip
    }
  }
  return out;
}
```

Notes for the implementer:
- The backfill runs in the background: `getInventorySnapshot` returns immediately with `backfilling: true` while the walk is in flight (spec: "findings arrive instead of blocking on the whole walk"). Tests wait with `awaitBackfillForTests()` before asserting files/flags; `backfilling` flips to `false` once the one-shot flag lands.
- `resetInventoryForTests` drops `backfillInFlight`/`backfillDone` without cancelling a running walk — always `await awaitBackfillForTests()` before `resetInventoryForTests()` or a second walk can start alongside the first.
- `readdirSync` of the inventory dir per snapshot is cheap (one entry per redacted file) and makes the cache self-healing after restarts.

- [ ] **Step 4: Run the tests**

Run: `bun test server/services/piiInventory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/piiInventory.ts server/services/piiInventory.test.ts
git commit -s -m "feat(safe): cached redaction inventory with one-shot backfill"
```

---

### Task 9: Inventory IPC (handlers, routes, preload, channel)

**Files:**
- Modify: `server/handlers/pii.ts` (add `getInventory`, `getMirrorRehydrationMap`)
- Modify: `server/routes/ipc.ts` (routes)
- Modify: `server/workstationConnection.ts` (read-only set)
- Modify: `electron/ipc/registry.ts` (channel + event type)
- Modify: `electron/preload.ts` (`ElectronAPI` interface + `pii` namespace implementation)
- Modify: `src/ipc.ts` (types, `onInventoryChanged`, demo stubs)
- Modify: `server/services/piiInventory.ts` (switch local `CHANNEL` literal → `IPC_CHANNELS.PII_INVENTORY_CHANGED`)
- Test: extend `server/routes/pii-ipc.test.ts`

**Interfaces:**
- Consumes: `getInventorySnapshot` (Task 8), `mirrorDocId` + `vaultManager.decrypt` (existing), `IPC_CHANNELS.API_REQUEST` pattern in preload.
- Produces:
  - `getInventory(): Promise<PiiInventorySnapshot>` (Task 8's shape).
  - `getMirrorRehydrationMap(request: { relativePath: string }): Promise<Record<string, string>>` — `{}` on missing workspace or decrypt failure.
  - HTTP: `POST /api/ipc/pii/getInventory`, `POST /api/ipc/pii/getMirrorRehydrationMap`.
  - Renderer: `PiiIpc.getInventory()`, `PiiIpc.getMirrorRehydrationMap(req)`, `PiiIpc.onInventoryChanged(cb: (event: { revision: number }) => void): () => void`.
  - Channel: `PII_INVENTORY_CHANGED: 'pii:inventory-changed'` in `IPC_CHANNELS` (must equal `methodToChannel('pii', 'onInventoryChanged')` — verify: strips `on`, kebab-cases `InventoryChanged` → `pii:inventory-changed` ✓).
  - Preload: a **complete** `pii` namespace — once `window.electron.pii` exists, `createElectronClient` returns it wholesale (`src/ipc.ts:464`), so every `PiiIpc` method must be present or Electron callers get `undefined is not a function`.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/pii-ipc.test.ts`:

```ts
describe('inventory IPC routes', () => {
  test('getInventory answers over HTTP (unarmed workspace)', async () => {
    useTempWorkspace();
    const app = buildApp();
    const response = await request(app).post('/api/ipc/pii/getInventory').send([]);
    expect(response.status).toBe(200);
    expect(response.body.armed).toBe(false);
    expect(response.body.files).toEqual([]);
    expect(typeof response.body.revision).toBe('number');
  });

  test('getMirrorRehydrationMap degrades to {} without a vault blob', async () => {
    useTempWorkspace();
    const app = buildApp();
    const response = await request(app)
      .post('/api/ipc/pii/getMirrorRehydrationMap')
      .send([{ relativePath: 'note.md' }]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  test('read-only workstation allows inventory reads, still blocks writes', () => {
    expect(
      isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/pii/getInventory' }),
    ).toBe(true);
    expect(
      isReadOnlyWorkstationRequest({
        method: 'POST',
        path: '/api/ipc/pii/getMirrorRehydrationMap',
      }),
    ).toBe(true);
    expect(
      isReadOnlyWorkstationRequest({ method: 'POST', path: '/api/ipc/pii/removeCustomTerm' }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test server/routes/pii-ipc.test.ts`
Expected: FAIL — unknown route.

- [ ] **Step 3: Implement server side**

`server/handlers/pii.ts` — add (import `getInventorySnapshot` from `../services/piiInventory`, and `mirrorDocId` from `../utils/safeSync`; `vaultManager` is already imported):

```ts
/** Workspace redaction inventory (safe-sync sidecars), backfilled on first read. */
export async function getInventory(): Promise<
  import('../services/piiInventory').PiiInventorySnapshot
> {
  return getInventorySnapshot();
}

/**
 * Token→original map for one safe mirror — Show Originals in the inventory
 * panel. Same best-effort contract as getRehydrationMap: no blob → {}.
 */
export async function getMirrorRehydrationMap(
  request: { relativePath: string },
  deps: PiiGetRehydrationMapDeps = {},
): Promise<Record<string, string>> {
  const workspace = getCurrentWorkspace();
  const relativePath = request?.relativePath;
  if (!workspace || !relativePath) return {};
  try {
    return await vaultManager.decrypt(
      mirrorDocId(workspace, relativePath),
      deps.passphrase,
      deps.toolManager,
    );
  } catch {
    return {};
  }
}
```

`server/routes/ipc.ts` — inside `pii: { … }`:

```ts
    getInventory: async () => {
      const { getInventory } = await import('../handlers/pii');
      return getInventory();
    },
    getMirrorRehydrationMap: async ([request]: [{ relativePath: string }]) => {
      const { getMirrorRehydrationMap } = await import('../handlers/pii');
      return getMirrorRehydrationMap(request);
    },
```

`server/workstationConnection.ts` — add to `READ_ONLY_IPC_OPERATIONS`:

```ts
  'pii.getInventory',
  'pii.getMirrorRehydrationMap',
```

`server/services/piiInventory.ts` — replace both local channel literals with:

```ts
import { IPC_CHANNELS } from '../../electron/ipc/registry';
const CHANNEL = IPC_CHANNELS.PII_INVENTORY_CHANGED;
```

`electron/ipc/registry.ts` — add to `IPC_CHANNELS` (near the PII/workspace group) and export the event type:

```ts
  PII_INVENTORY_CHANGED: 'pii:inventory-changed',
```

```ts
export interface PiiInventoryChangedEvent {
  revision: number;
}
```

- [ ] **Step 4: Implement preload + renderer interface**

`electron/preload.ts` — add `PiiInventoryChangedEvent` to the existing `./registry` type import; in `export interface ElectronAPI`, add the namespace (place it after the existing `workspace` block):

```ts
  /** #19 PII: rehydration, selection NER, custom terms, redaction inventory. */
  pii: {
    getRehydrationMap(request: { threadKey: string }): Promise<Record<string, string>>;
    detectSelection(request: { text: string; categories?: string[] }): Promise<{
      detections: Array<{ category: string; start: number; end: number; text: string; confidence: number }>;
    }>;
    addCustomTerm(request: { label: string; value: string; caseSensitive?: boolean }): Promise<{
      success: boolean;
      configPath: string;
    }>;
    listCustomTerms(): Promise<{
      terms: Array<{ label: string; value: string; caseSensitive: boolean }>;
    }>;
    updateCustomTerm(request: {
      originalValue: string;
      label?: string;
      value?: string;
      caseSensitive?: boolean;
    }): Promise<{ success: boolean; configPath: string }>;
    removeCustomTerm(request: { value: string }): Promise<{ success: boolean; configPath: string }>;
    rememberRehydration(request: {
      threadKey: string;
      map: Record<string, string>;
    }): Promise<{ success: boolean }>;
    getInventory(): Promise<unknown>;
    getMirrorRehydrationMap(request: { relativePath: string }): Promise<Record<string, string>>;
    onInventoryChanged(callback: (event: PiiInventoryChangedEvent) => void): () => void;
  };
```

In the implementation object (same file), add the matching block. All method calls route through the same HTTP fallback the renderer uses today:

```ts
  pii: (() => {
    const call = async (method: string, body: unknown[] = []) => {
      const response = (await ipcRenderer.invoke(IPC_CHANNELS.API_REQUEST, {
        method: 'POST',
        path: `/api/ipc/pii/${method}`,
        body,
      })) as { ok: boolean; data?: unknown };
      if (!response.ok) throw new Error(String((response.data as { error?: string })?.error ?? 'Request failed'));
      return response.data;
    };
    return {
      getRehydrationMap: (request: { threadKey: string }) => call('getRehydrationMap', [request]),
      detectSelection: (request: { text: string; categories?: string[] }) => call('detectSelection', [request]),
      addCustomTerm: (request: { label: string; value: string; caseSensitive?: boolean }) =>
        call('addCustomTerm', [request]),
      listCustomTerms: () => call('listCustomTerms'),
      updateCustomTerm: (request: { originalValue: string; label?: string; value?: string; caseSensitive?: boolean }) =>
        call('updateCustomTerm', [request]),
      removeCustomTerm: (request: { value: string }) => call('removeCustomTerm', [request]),
      rememberRehydration: (request: { threadKey: string; map: Record<string, string> }) =>
        call('rememberRehydration', [request]),
      getInventory: () => call('getInventory'),
      getMirrorRehydrationMap: (request: { relativePath: string }) =>
        call('getMirrorRehydrationMap', [request]),
      onInventoryChanged: (callback: (event: PiiInventoryChangedEvent) => void) => {
        const listener = (_: unknown, event: PiiInventoryChangedEvent) => callback(event);
        ipcRenderer.on(IPC_CHANNELS.PII_INVENTORY_CHANGED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PII_INVENTORY_CHANGED, listener);
      },
    };
  })(),
```

Verify the exact `ok`/`data`/`error` unwrapping shape against `createElectronFallbackProxy` (`src/ipc.ts:426-455`): it reads `(response.data as any).error` **inside** `data`, so the throw line above must match that (adjust if the invoke response nests differently — copy the fallback's three lines verbatim).

`src/ipc.ts` — in `interface PiiIpc` add:

```ts
  getInventory(): Promise<{
    revision: number;
    armed: boolean;
    backfilling: boolean;
    updatedAt: string | null;
    files: Array<{
      relativePath: string;
      mirrorRel: string;
      origin: 'sync' | 'mirror-backfill';
      updatedAt: string;
      entries: Array<{ category: string; line: number; masked: string; confidence: number }>;
    }>;
  }>;
  getMirrorRehydrationMap(request: { relativePath: string }): Promise<Record<string, string>>;
  onInventoryChanged?(callback: (event: { revision: number }) => void): () => void;
```

Add `PiiInventoryChangedEvent` to the existing `../electron/ipc/registry` type import (line ~33) and use it in the callback signature. In the marketing-demo stub block add:

```ts
    getInventory: async () => ({ revision: 0, armed: false, backfilling: false, updatedAt: null, files: [] }),
    getMirrorRehydrationMap: async () => ({}),
    onInventoryChanged: () => () => {},
```

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
bun test server/routes/pii-ipc.test.ts server/services/piiInventory.test.ts
pnpm run typecheck
```
Expected: PASS. Typecheck covers preload's `ElectronAPI` shape, the registry channel, and the renderer interface against the demo stub.

- [ ] **Step 6: Commit**

```bash
git add server/handlers/pii.ts server/routes/ipc.ts server/workstationConnection.ts server/services/piiInventory.ts electron/ipc/registry.ts electron/preload.ts src/ipc.ts
git commit -s -m "feat(safe): expose the redaction inventory over IPC with live revision events"
```

---

### Task 10: Inventory panel UI

**Files:**
- Create: `src/components/settings/PiiInventoryPanel.tsx`
- Test: `src/components/settings/PiiInventoryPanel.ui.test.tsx` (new)
- Modify: `src/components/GlobalSettings.tsx` (privacy pane gains a second section)
- Modify: `src/components/settings/PrivacySection.tsx` (only if the panel needs a shared row — default: keep them separate)
- Modify: `shared/locales/*.json` (8 files)

**Interfaces:**
- Consumes: `pii.getInventory`, `pii.onInventoryChanged`, `pii.getMirrorRehydrationMap`, `PII_COLORS`/`getPiiColor`, `basemind.pii.showExisting` key `basemind.pii.showOriginals`, `SettingsSection` (rendered by GlobalSettings).
- Produces: exported `PiiInventoryPanel`; i18n keys listed below.

- [ ] **Step 1: Write the failing UI test**

Create `src/components/settings/PiiInventoryPanel.ui.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const piiMocks = vi.hoisted(() => ({
  getInventory: vi.fn(async () => ({
    revision: 1,
    armed: true,
    backfilling: false,
    updatedAt: '2026-09-26T10:00:00.000Z',
    files: [
      {
        relativePath: 'notes/meeting.md',
        mirrorRel: 'safe/notes/meeting.md',
        origin: 'sync',
        updatedAt: '2026-09-26T10:00:00.000Z',
        entries: [
          { category: 'email', line: 3, masked: '[EMAIL_1]', confidence: 0.95 },
          { category: 'organization', line: 7, masked: '[ORG_1]', confidence: 0.7 },
        ],
      },
      {
        relativePath: 'notes/other.md',
        mirrorRel: 'safe/notes/other.md',
        origin: 'sync',
        updatedAt: '2026-09-26T09:00:00.000Z',
        entries: [{ category: 'email', line: 1, masked: '[EMAIL_2]', confidence: 0.9 }],
      },
    ],
  })),
  getMirrorRehydrationMap: vi.fn(async () => ({ '[EMAIL_1]': 'jane@example.com' })),
  onInventoryChanged: vi.fn(() => () => {}),
}));

vi.mock('../../ipc', () => ({ pii: piiMocks }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'settings.privacy.inventoryEmpty': 'No redacted content yet.',
        'settings.privacy.inventoryUnarmed': 'Safe sync is not on for this workspace yet.',
        'settings.privacy.backfilling': 'Preparing inventory…',
        'settings.privacy.allCategories': 'All',
        'settings.privacy.updatedAt': 'Updated {{time}}',
        'common.loading': 'Loading...',
      };
      if (key === 'settings.privacy.findings') return `${String(options?.count ?? 0)} redactions`;
      if (key === 'basemind.pii.showOriginals') return 'Show Originals';
      if (key === 'settings.privacy.updatedAt') return `Updated ${String(options?.time ?? '')}`;
      return labels[key] ?? key;
    },
  }),
}));

import { PiiInventoryPanel } from './PiiInventoryPanel';

beforeEach(() => {
  vi.clearAllMocks();
  piiMocks.getInventory.mockResolvedValue({
    revision: 1,
    armed: true,
    backfilling: false,
    updatedAt: '2026-09-26T10:00:00.000Z',
    files: [
      {
        relativePath: 'notes/meeting.md',
        mirrorRel: 'safe/notes/meeting.md',
        origin: 'sync',
        updatedAt: '2026-09-26T10:00:00.000Z',
        entries: [
          { category: 'email', line: 3, masked: '[EMAIL_1]', confidence: 0.95 },
          { category: 'organization', line: 7, masked: '[ORG_1]', confidence: 0.7 },
        ],
      },
      {
        relativePath: 'notes/other.md',
        mirrorRel: 'safe/notes/other.md',
        origin: 'sync',
        updatedAt: '2026-09-26T09:00:00.000Z',
        entries: [{ category: 'email', line: 1, masked: '[EMAIL_2]', confidence: 0.9 }],
      },
    ],
  });
});

describe('PiiInventoryPanel', () => {
  test('renders header, category chips with counts, and file groups', async () => {
    render(<PiiInventoryPanel />);
    await waitFor(() => expect(screen.getByText('3 redactions')).toBeDefined());

    expect(screen.getByRole('button', { name: /All \(3\)/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Email \(2\)/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Org \(1\)/ })).toBeDefined();
    expect(screen.getByText('notes/meeting.md')).toBeDefined();
    expect(screen.getByText('notes/other.md')).toBeDefined();
    expect(screen.getAllByText(/\[EMAIL_1\]|\[EMAIL_2\]/).length).toBeGreaterThanOrEqual(2);
  });

  test('filters rows by category chip; second click clears the filter', async () => {
    const user = userEvent.setup();
    render(<PiiInventoryPanel />);
    await waitFor(() => expect(screen.getByText('3 redactions')).toBeDefined());

    await user.click(screen.getByRole('button', { name: /Org \(1\)/ }));
    expect(screen.queryByText('notes/other.md')).toBeNull();
    expect(screen.getByText('notes/meeting.md')).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Org \(1\)/ }));
    expect(screen.getByText('notes/other.md')).toBeDefined();
  });

  test('Show Originals resolves tokens per file through the vault map', async () => {
    const user = userEvent.setup();
    render(<PiiInventoryPanel />);
    await waitFor(() => expect(screen.getByText('3 redactions')).toBeDefined());

    await user.click(screen.getByLabelText('Show Originals'));
    await waitFor(() => expect(screen.getByText('jane@example.com')).toBeDefined());
    expect(piiMocks.getMirrorRehydrationMap).toHaveBeenCalledWith({
      relativePath: 'notes/meeting.md',
    });
    // Unmapped token still renders masked (other.md never fetched → masked stays).
    expect(screen.getAllByText(/\[EMAIL_2\]/).length).toBeGreaterThanOrEqual(1);
  });

  test('shows the unarmed empty state', async () => {
    piiMocks.getInventory.mockResolvedValue({
      revision: 0, armed: false, backfilling: false, updatedAt: null, files: [],
    });
    render(<PiiInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Safe sync is not on for this workspace yet.')).toBeDefined();
    });
  });

  test('shows a preparing hint while the backfill walk is running', async () => {
    piiMocks.getInventory.mockResolvedValue({
      revision: 0, armed: true, backfilling: true, updatedAt: null, files: [],
    });
    render(<PiiInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Preparing inventory…')).toBeDefined();
    });
  });

  test('subscribes to live revisions and unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    piiMocks.onInventoryChanged.mockReturnValue(unsubscribe);
    const { unmount } = render(<PiiInventoryPanel />);
    await waitFor(() => expect(piiMocks.onInventoryChanged).toHaveBeenCalledTimes(1));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts src/components/settings/PiiInventoryPanel.ui.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the panel**

`src/components/settings/PiiInventoryPanel.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { pii } from '../../ipc';
import { PII_COLORS } from '../../lib/pii/colors';
import { normalizePiiCategory } from '../../lib/pii/labels';

interface InventoryEntry {
  category: string;
  line: number;
  masked: string;
  confidence: number;
}

interface InventoryFile {
  relativePath: string;
  mirrorRel: string;
  origin: 'sync' | 'mirror-backfill';
  updatedAt: string;
  entries: InventoryEntry[];
}

interface InventorySnapshot {
  revision: number;
  armed: boolean;
  backfilling: boolean;
  updatedAt: string | null;
  files: InventoryFile[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: InventorySnapshot };

function categoryMeta(category: string) {
  const normalized = normalizePiiCategory(category);
  const palette = PII_COLORS[normalized];
  return {
    key: normalized,
    label: palette?.label ?? normalized,
    color: palette?.light ?? '#6b7280',
  };
}

export function PiiInventoryPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [filter, setFilter] = useState<string | null>(null);
  const [showOriginals, setShowOriginals] = useState(false);
  const [originals, setOriginals] = useState<Record<string, Record<string, string>>>({});

  const refresh = async () => {
    try {
      const snapshot = await pii.getInventory();
      setState({ status: 'ready', snapshot });
    } catch {
      setState({
        status: 'ready',
        snapshot: { revision: 0, armed: false, backfilling: false, updatedAt: null, files: [] },
      });
    }
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = pii.onInventoryChanged?.(() => {
      void refresh();
    });
    return () => {
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve originals lazily per file once the toggle is on.
  useEffect(() => {
    if (state.status !== 'ready' || !showOriginals) return;
    let cancelled = false;
    for (const file of state.snapshot.files) {
      if (originals[file.relativePath]) continue;
      pii
        .getMirrorRehydrationMap({ relativePath: file.relativePath })
        .then((map) => {
          if (cancelled) return;
          setOriginals((prev) => ({ ...prev, [file.relativePath]: map }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, showOriginals]);

  const { allFiles, allCount, categoryCounts } = useMemo(() => {
    if (state.status !== 'ready') {
      return { allFiles: [] as InventoryFile[], allCount: 0, categoryCounts: new Map<string, number>() };
    }
    const counts = new Map<string, number>();
    let total = 0;
    for (const file of state.snapshot.files) {
      for (const entry of file.entries) {
        total += 1;
        const key = categoryMeta(entry.category).key;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return { allFiles: state.snapshot.files, allCount: total, categoryCounts: counts };
  }, [state]);

  if (state.status === 'loading') {
    return <div className="py-4 text-ui-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  const snapshot = state.snapshot;
  if (!snapshot.armed) {
    return (
      <div className="py-4 text-ui-sm text-muted-foreground" data-testid="inventory-unarmed">
        {t('settings.privacy.inventoryUnarmed')}
      </div>
    );
  }

  const visible = filter
    ? allFiles
        .map((file) => ({
          ...file,
          entries: file.entries.filter(
            (entry) => categoryMeta(entry.category).key === filter,
          ),
        }))
        .filter((file) => file.entries.length > 0)
    : allFiles;

  if (allCount === 0) {
    return (
      <div className="py-4 text-ui-sm text-muted-foreground" data-testid="inventory-empty">
        {snapshot.backfilling
          ? t('settings.privacy.backfilling')
          : t('settings.privacy.inventoryEmpty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2" data-testid="inventory-panel">
      {snapshot.backfilling && (
        <div className="text-xs text-muted-foreground">{t('settings.privacy.backfilling')}</div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {t('settings.privacy.findings', { count: allCount })}
        </span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {t('settings.privacy.updatedAt', {
              time: snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : '—',
            })}
          </span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showOriginals}
              onChange={(event) => setShowOriginals(event.target.checked)}
              className="rounded"
            />
            {t('basemind.pii.showOriginals')}
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group">
        <button
          type="button"
          onClick={() => setFilter(null)}
          className={`rounded-full px-2 py-0.5 text-xs ${!filter ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
        >
          {t('settings.privacy.allCategories')} ({allCount})
        </button>
        {Array.from(categoryCounts.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([key, count]) => {
            const palette = PII_COLORS[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(filter === key ? null : key)}
                className="rounded-full px-2 py-0.5 text-xs"
                style={
                  filter === key
                    ? { backgroundColor: `${palette?.light ?? '#6b7280'}33`, color: palette?.light ?? '#6b7280' }
                    : { backgroundColor: 'transparent', color: palette?.light ?? '#6b7280', border: '1px solid' }
                }
              >
                {palette?.label ?? key} ({count})
              </button>
            );
          })}
      </div>

      <div className="flex flex-col gap-2">
        {visible.map((file) => (
          <div key={file.relativePath} className="rounded-[12px] border">
            <div className="rounded-t-[12px] bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
              {file.relativePath}
            </div>
            {file.entries.map((entry, index) => {
              const meta = categoryMeta(entry.category);
              const original = showOriginals
                ? originals[file.relativePath]?.[entry.masked]
                : undefined;
              return (
                <div
                  key={`${file.relativePath}:${entry.line}:${index}`}
                  className="flex items-center gap-3 px-3 py-1.5 text-xs"
                >
                  <span className="w-10 text-right text-muted-foreground">
                    {entry.line > 0 ? entry.line : '—'}
                  </span>
                  <span
                    className="rounded-full px-2 py-0.5"
                    style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                  >
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{original ?? entry.masked}</span>
                  <span className="text-muted-foreground">{Math.round(entry.confidence * 100)}%</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

`src/components/GlobalSettings.tsx` — inside the existing privacy pane (Task 3), add:

```tsx
                    <SettingsSection
                      title={t("settings.privacy.inventorySection")}
                      description={t("settings.privacy.inventoryDescription")}
                      sectionId="piiInventory"
                    >
                      <PiiInventoryPanel />
                    </SettingsSection>
```

plus the import `import { PiiInventoryPanel } from './settings/PiiInventoryPanel';`.

i18n — add to all 8 locales:

```
"settings.privacy.inventorySection": "Redaction inventory",
"settings.privacy.inventoryDescription": "What has been redacted in this workspace, as safe/ mirrors are updated.",
"settings.privacy.inventoryEmpty": "No redacted content yet.",
"settings.privacy.inventoryUnarmed": "Safe sync is not on for this workspace yet.",
"settings.privacy.backfilling": "Preparing inventory…",
"settings.privacy.allCategories": "All",
"settings.privacy.findings": "{{count}} redactions",
"settings.privacy.updatedAt": "Updated {{time}}",
```

Also add the section to `SETTINGS_SECTIONS` in `shared/settingsCatalog.ts`: `{ id: 'piiInventory', tabId: 'privacy', defaultLabel: 'Redaction inventory' },`

- [ ] **Step 4: Run tests + typecheck**

Run:
```bash
pnpm exec vitest run --config vitest.config.ts src/components/settings/PiiInventoryPanel.ui.test.tsx src/components/settings/PrivacySection.ui.test.tsx
bun test shared/locales/__tests__/completeness.test.ts
pnpm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/PiiInventoryPanel.tsx src/components/settings/PiiInventoryPanel.ui.test.tsx src/components/GlobalSettings.tsx shared/settingsCatalog.ts shared/locales/
git commit -s -m "feat(settings): redaction inventory panel with category filters"
```

---

## Final verification (both phases)

Run and record the output:

```bash
pnpm run precommit
```

Must pass: `typecheck` + `test:unit` (Bun: server, shared incl. locale parity, `src/lib`, `src/extensions` newly active) + `test:vitest` (all `*.ui.test.tsx`).

Then report honestly:
- No dependency changes were made, so `pnpm audit` / `release:licenses:check` are not required by this plan (CI runs them anyway).
- No e2e was run — Electron e2e is macOS/CI-gated; nothing here is claimed to be proven by it.
- Manual smoke (optional, Linux): `pnpm dev` → Settings → Privacy → add a term → open a note in compose mode → confirm the label; edit `safe/`-armed workspace file → refresh inventory panel.

## Self-review notes

- Spec coverage: term storage/handlers/IPC/Settings/editor labels → Tasks 1–5; sidecar piggyback/backfill/IPC/panel → Tasks 6–10; spec's ameded mirror-relative line semantics → Task 6's `buildSidecar` + tests; spec's read-only gate → Tasks 2/9 (server) + Task 4 (UI).
- Types: `PiiCustomTerm` (renderer) and the inline `CustomTermDto` shapes are structurally identical by construction; `PiiInventorySnapshot` defined in Task 8 and mirrored verbatim in Task 9's `src/ipc.ts` interface — implementer must copy, not paraphrase.
- The plan deliberately keeps Task 7's notify as a dynamic import so phase-2 task order is resilient (Task 7 compiles before Task 8 exists); Task 8's own notify default uses the static `broadcastEvent` import (precedented by `server/services/vault.ts` — no cycle, since only safe-sync dynamically imports piiInventory).
- The backfill is non-blocking per spec: `getInventorySnapshot` never awaits the walk; tests synchronize with `awaitBackfillForTests()`.
- `.test.ts` files are excluded from `typecheck` (both tsconfigs) but `.ui.test.tsx` files are typechecked — unused imports in UI tests fail `pnpm run typecheck`.
