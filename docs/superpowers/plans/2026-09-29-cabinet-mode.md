# Cabinet Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Safe workspace, refuse to send anything to the provider when full PII detection (NER) cannot run — on by default, turned off only by an explicit, confirmed and audited gesture.

**Architecture:** One new option (`requireFullDetection`) in the existing single redaction function makes the NER-down fallback throw instead of degrading. The two existing chokepoints (`maybeRedactOutboundText` for every outbound turn, `maybeRedactToolResult` for every tool result) turn that into a localized send refusal and a withheld marker, respectively. A small service owns the setting and writes an append-only JSONL audit log; the Privacy section of Settings exposes a switch with a confirm dialog.

**Tech Stack:** TypeScript, Bun test (`*.test.ts`), Vitest + Testing Library (`*.ui.test.tsx`), React, i18next, electron-store config (`server/configStore.ts`).

**Spec:** `docs/superpowers/specs/2026-09-29-cabinet-mode-spec.md`

## Global Constraints

- Default **on**: config key `cabinetModeEnabled`, absent = on (`config.cabinetModeEnabled !== false`).
- Applies only in armed workspaces (`<workspace>/safe/` exists); unknown workspace path keeps the existing fail-closed rule (treated as armed).
- "Full detection unavailable" = `isNerReady()` is false **or** `detectNer()` throws.
- Audit file: `<getInterpreterAppDataDir()>/audit/cabinet-mode.jsonl`, one JSON object per line, fields `at`, `event`, `osUser`, `hostname`, `appVersion`, plus `surface` for `send_blocked`. **Never** content, file names or detections.
- Events: `cabinet_mode_disabled`, `cabinet_mode_enabled`, `send_blocked` (`surface: 'outbound' | 'tool'`).
- Disabling requires `confirmed === true`; if the audit write fails, the setting is not changed.
- Every visible string in the 8 locales (`en, es, fr, it, ja, ko, ru, zh-CN`) before merge.
- Run `pnpm run precommit` before each commit if it exists in `package.json`; otherwise `pnpm typecheck` + the task's tests.
- Commits signed off (`git commit -s`), conventional format.

---

### Task 1: Setting and audit log

**Files:**
- Modify: `server/configStore.ts` (field next to `codeIndexingEnabled` ~line 214; accessors after the code-indexing block ~line 2568)
- Create: `server/services/cabinetAudit.ts`
- Create: `server/services/cabinetMode.ts`
- Test: `server/services/cabinetMode.test.ts`

**Interfaces:**
- Produces:
  - `getCabinetModeEnabled(): Promise<boolean>` (configStore)
  - `setCabinetModeEnabledInConfig(value: boolean): Promise<void>` (configStore — only `cabinetMode.ts` calls it)
  - `appendCabinetAudit(entry: CabinetAuditEntry): Promise<void>`, `setCabinetAuditFileForTests(path: string | null): void`, type `CabinetAuditEntry` (cabinetAudit)
  - `setCabinetMode(value: boolean, options: { confirmed?: boolean }, deps?: CabinetModeDeps): Promise<{ enabled: boolean }>` (cabinetMode)

- [ ] **Step 1: Write the failing test** — `server/services/cabinetMode.test.ts`

```ts
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getCabinetModeEnabled, setConfigOverride } from '../configStore';
import { appendCabinetAudit, setCabinetAuditFileForTests } from './cabinetAudit';
import { setCabinetMode } from './cabinetMode';

let dir: string;
let auditFile: string;

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cabinet-'));
  auditFile = join(dir, 'audit', 'cabinet-mode.jsonl');
  setCabinetAuditFileForTests(auditFile);
  setConfigOverride({} as never);
});

afterEach(() => {
  setCabinetAuditFileForTests(null);
  setConfigOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('cabinet mode setting', () => {
  test('is on for a fresh config', async () => {
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('refuses to turn off without confirmation and leaves config unchanged', async () => {
    await expect(setCabinetMode(false, {})).rejects.toThrow('confirmation');
    expect(await getCabinetModeEnabled()).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  test('turns off with confirmation and records who and when', async () => {
    const result = await setCabinetMode(false, { confirmed: true });
    expect(result).toEqual({ enabled: false });
    expect(await getCabinetModeEnabled()).toBe(false);
    const [entry] = auditLines();
    expect(entry.event).toBe('cabinet_mode_disabled');
    expect(typeof entry.at).toBe('string');
    expect(typeof entry.osUser).toBe('string');
    expect(typeof entry.hostname).toBe('string');
    expect(typeof entry.appVersion).toBe('string');
  });

  test('keeps cabinet mode on when the audit entry cannot be written', async () => {
    await expect(
      setCabinetMode(false, { confirmed: true }, {
        audit: async () => { throw new Error('disk full'); },
      }),
    ).rejects.toThrow('disk full');
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('turning back on needs no confirmation and is recorded', async () => {
    await setCabinetMode(false, { confirmed: true });
    const result = await setCabinetMode(true, {});
    expect(result).toEqual({ enabled: true });
    expect(auditLines().map((e) => e.event)).toEqual(['cabinet_mode_disabled', 'cabinet_mode_enabled']);
  });

  test('a block entry carries the surface and nothing else from the request', async () => {
    await appendCabinetAudit({ event: 'send_blocked', surface: 'tool' });
    const [entry] = auditLines();
    expect(Object.keys(entry).sort()).toEqual(['appVersion', 'at', 'event', 'hostname', 'osUser', 'surface']);
    expect(entry.surface).toBe('tool');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/services/cabinetMode.test.ts`
Expected: FAIL — `getCabinetModeEnabled` is not exported / `./cabinetAudit` not found.

- [ ] **Step 3: Implement**

In `server/configStore.ts`, inside `interface AppConfig`, right after `codeIndexingEnabled?: boolean;`:

```ts
  /** Cabinet mode (spec 2026-09-29): absent = on. Written only by services/cabinetMode. */
  cabinetModeEnabled?: boolean;
```

After the code-indexing accessors block:

```ts
// =============================================================================
// Cabinet mode (spec 2026-09-29)
// =============================================================================

/** On unless explicitly turned off. */
export async function getCabinetModeEnabled(): Promise<boolean> {
  const config = await loadConfig();
  return config.cabinetModeEnabled !== false;
}

/** Raw write. Callers go through services/cabinetMode, which audits first. */
export async function setCabinetModeEnabledInConfig(value: boolean): Promise<void> {
  const config = await loadConfig();
  config.cabinetModeEnabled = value;
  await saveConfig(config);
}
```

Create `server/services/cabinetAudit.ts`:

```ts
/**
 * Append-only audit log for cabinet mode (spec 2026-09-29): who turned it
 * off or on, and when a send was blocked. Never content, file names or
 * detections — the log must be safe to hand over as it is.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export type CabinetAuditEntry =
  | { event: 'cabinet_mode_disabled' }
  | { event: 'cabinet_mode_enabled' }
  | { event: 'send_blocked'; surface: 'outbound' | 'tool' };

let auditFileOverride: string | null = null;

export function setCabinetAuditFileForTests(path: string | null): void {
  auditFileOverride = path;
}

async function resolveAuditFile(): Promise<string> {
  if (auditFileOverride) return auditFileOverride;
  const { getInterpreterAppDataDir } = await import('../configStore');
  return join(getInterpreterAppDataDir(), 'audit', 'cabinet-mode.jsonl');
}

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function appVersion(): string {
  if (process.versions.electron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron');
      return app.getVersion() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'dev';
}

export async function appendCabinetAudit(entry: CabinetAuditEntry): Promise<void> {
  const file = await resolveAuditFile();
  await mkdir(dirname(file), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
    osUser: osUser(),
    hostname: hostname(),
    appVersion: appVersion(),
  });
  await appendFile(file, `${line}\n`, 'utf8');
}
```

Create `server/services/cabinetMode.ts`:

```ts
/**
 * Cabinet mode switch (spec 2026-09-29). Turning it off transfers
 * responsibility to the person who does it, so the gesture must be confirmed
 * and recorded — and if it cannot be recorded, it does not happen.
 */

import { getCabinetModeEnabled, setCabinetModeEnabledInConfig } from '../configStore';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';

export interface CabinetModeDeps {
  audit?: (entry: CabinetAuditEntry) => Promise<void>;
}

export async function setCabinetMode(
  value: boolean,
  options: { confirmed?: boolean },
  deps: CabinetModeDeps = {},
): Promise<{ enabled: boolean }> {
  const audit = deps.audit ?? appendCabinetAudit;
  if (!value && options.confirmed !== true) {
    throw new Error('Turning off cabinet mode requires explicit confirmation.');
  }
  if (value === (await getCabinetModeEnabled())) return { enabled: value };
  // Audit first: no trace, no change.
  await audit({ event: value ? 'cabinet_mode_enabled' : 'cabinet_mode_disabled' });
  await setCabinetModeEnabledInConfig(value);
  return { enabled: value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/services/cabinetMode.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/configStore.ts server/services/cabinetAudit.ts server/services/cabinetMode.ts server/services/cabinetMode.test.ts
git commit -s -m "feat(cabinet): setting on by default, confirmed and audited switch"
```

---

### Task 2: Locale strings (8 locales)

**Files:**
- Modify: `shared/locales/{en,es,fr,it,ja,ko,ru,zh-CN}.json` (insert after `basemind.attachmentBlockedInSafe`, line ~1811)
- Test: existing `shared/locales/__tests__/completeness.test.ts`

**Interfaces:**
- Produces keys: `basemind.cabinet.title`, `basemind.cabinet.description`, `basemind.cabinet.disableTitle`, `basemind.cabinet.disableBody`, `basemind.cabinet.disableConfirm`, `basemind.cabinet.blockedSend`.

- [ ] **Step 1: Insert the keys** — save as `/tmp/add-cabinet-keys.mjs` and run `node /tmp/add-cabinet-keys.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const ANCHOR = 'basemind.attachmentBlockedInSafe';
const T = {
  en: ['Cabinet mode', "In a Safe folder, if full detection can't run, nothing is sent to the AI provider.", 'Turn off cabinet mode?', 'When full detection is unavailable, text will leave with pattern-only redaction: names, companies and amounts may be sent in clear. You take responsibility for this choice. It is recorded on this computer.', 'Turn off — I take responsibility', 'Cabinet mode: full detection is unavailable, so nothing was sent. Start the Safe engine and try again.'],
  fr: ['Mode cabinet', "Dans un dossier Safe, si la détection complète ne peut pas tourner, rien n'est envoyé au fournisseur d'IA.", 'Désactiver le mode cabinet ?', "Quand la détection complète est indisponible, le texte partira avec un masquage par motifs seulement : noms, sociétés et montants pourront être envoyés en clair. Vous prenez la responsabilité de ce choix. Il est enregistré sur cet ordinateur.", "Désactiver — j'en prends la responsabilité", "Mode cabinet : la détection complète est indisponible, rien n'a été envoyé. Démarrez le moteur Safe et réessayez."],
  es: ['Modo despacho', 'En una carpeta Safe, si la detección completa no puede ejecutarse, no se envía nada al proveedor de IA.', '¿Desactivar el modo despacho?', 'Cuando la detección completa no esté disponible, el texto saldrá solo con enmascaramiento por patrones: nombres, empresas e importes podrían enviarse sin ocultar. Usted asume la responsabilidad de esta elección. Queda registrada en este ordenador.', 'Desactivar — asumo la responsabilidad', 'Modo despacho: la detección completa no está disponible, no se ha enviado nada. Inicie el motor Safe e inténtelo de nuevo.'],
  it: ['Modalità studio legale', 'In una cartella Safe, se il rilevamento completo non può essere eseguito, non viene inviato nulla al fornitore di IA.', 'Disattivare la modalità studio legale?', 'Quando il rilevamento completo non è disponibile, il testo partirà con il solo mascheramento tramite modelli: nomi, società e importi potrebbero essere inviati in chiaro. Ti assumi la responsabilità di questa scelta. Viene registrata su questo computer.', 'Disattiva — me ne assumo la responsabilità', 'Modalità studio legale: il rilevamento completo non è disponibile, non è stato inviato nulla. Avvia il motore Safe e riprova.'],
  ja: ['事務所モード', 'Safe フォルダーでは、完全な検出を実行できない場合、AI プロバイダーには何も送信されません。', '事務所モードをオフにしますか？', '完全な検出が利用できない場合、テキストはパターンによるマスキングのみで送信されます。氏名、会社名、金額が伏せられずに送信される可能性があります。この選択の責任はあなたにあります。この操作はこのコンピューターに記録されます。', 'オフにする — 責任を負います', '事務所モード：完全な検出が利用できないため、何も送信されませんでした。Safe エンジンを起動して、もう一度お試しください。'],
  ko: ['사무소 모드', 'Safe 폴더에서 전체 탐지를 실행할 수 없으면 AI 제공업체로 아무것도 전송되지 않습니다.', '사무소 모드를 끄시겠습니까?', '전체 탐지를 사용할 수 없을 때 텍스트는 패턴 기반 마스킹만 적용된 채 전송됩니다. 이름, 회사명, 금액이 가려지지 않은 채 전송될 수 있습니다. 이 선택에 대한 책임은 사용자에게 있습니다. 이 작업은 이 컴퓨터에 기록됩니다.', '끄기 — 책임을 지겠습니다', '사무소 모드: 전체 탐지를 사용할 수 없어 아무것도 전송되지 않았습니다. Safe 엔진을 시작한 후 다시 시도하세요.'],
  ru: ['Режим юридической фирмы', 'В папке Safe, если полное обнаружение недоступно, провайдеру ИИ ничего не отправляется.', 'Отключить режим юридической фирмы?', 'Когда полное обнаружение недоступно, текст будет отправлен только с маскированием по шаблонам: имена, названия компаний и суммы могут уйти в открытом виде. Вы берёте на себя ответственность за этот выбор. Он записывается на этом компьютере.', 'Отключить — беру ответственность на себя', 'Режим юридической фирмы: полное обнаружение недоступно, ничего не отправлено. Запустите движок Safe и повторите попытку.'],
  'zh-CN': ['律所模式', '在 Safe 文件夹中，如果无法运行完整检测，则不会向 AI 提供商发送任何内容。', '要关闭律所模式吗？', '当完整检测不可用时，文本将仅经过基于模式的遮蔽后发送：姓名、公司名称和金额可能以明文发送。您将对此选择承担责任。此操作会记录在这台电脑上。', '关闭 — 我承担责任', '律所模式：完整检测不可用，未发送任何内容。请启动 Safe 引擎后重试。'],
};
const KEYS = ['title', 'description', 'disableTitle', 'disableBody', 'disableConfirm', 'blockedSend'].map((k) => `basemind.cabinet.${k}`);

for (const [locale, values] of Object.entries(T)) {
  const path = `shared/locales/${locale}.json`;
  const source = JSON.parse(readFileSync(path, 'utf8'));
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value;
    if (key === ANCHOR) KEYS.forEach((k, i) => { out[k] = values[i]; });
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 2: Check the diff is additions only**

Run: `git diff --stat shared/locales && git diff shared/locales | grep '^-[^-]' | head`
Expected: 8 files, `48 insertions(+)`, and **no** removed lines printed. If lines were removed (formatting drift), `git checkout shared/locales` and insert the 6 lines by hand after the anchor in each file.

- [ ] **Step 3: Run the locale tests**

Run: `bun test shared/locales/__tests__/completeness.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add shared/locales
git commit -s -m "feat(cabinet): localize cabinet mode strings in 8 locales"
```

---

### Task 3: Block outbound text, withhold tool results

**Files:**
- Modify: `server/services/runtimeRedaction.ts` (deps ~33-67; `redactFileReadOutputText` ~150-182; `applyFileReadRedaction`; `maybeRedactToolResult`; `maybeRedactOutboundText`)
- Test: `server/services/runtimeRedaction.test.ts`

**Interfaces:**
- Consumes: `getCabinetModeEnabled` (Task 1), `appendCabinetAudit` (Task 1), key `basemind.cabinet.blockedSend` (Task 2).
- Produces: `CABINET_WITHHELD_MARKER: string`, `class DetectionUnavailableError extends Error`, deps `isCabinetMode`, `recordBlock`, `blockedSendMessage` on `RuntimeRedactionDeps`, option `requireFullDetection?: boolean` on `RedactTextOptions`.

- [ ] **Step 1: Keep existing tests on today's behaviour**

In `server/services/runtimeRedaction.test.ts`, add to `stubDeps`:

```ts
  isCabinetMode: () => false,
  recordBlock: async () => {},
  blockedSendMessage: async () => 'blocked',
```

Then make every deps object passed to `maybeRedactToolResult`, `maybeRedactOutboundText` or `redactOutboundTurnInput` in that file spread `...stubDeps` first (inline objects such as the NER-ready one become `{ ...stubDeps, isNerReady: () => true, detectNer: … }`). Otherwise the default `isCabinetMode` would read the real config store.

- [ ] **Step 2: Write the failing tests** — append to `server/services/runtimeRedaction.test.ts` (add `CABINET_WITHHELD_MARKER` and `DetectionUnavailableError` to the import list):

```ts
describe('cabinet mode', () => {
  const blocks: string[] = [];
  const cabinetDeps = {
    ...stubDeps,
    isCabinetMode: () => true,
    recordBlock: async (surface: 'outbound' | 'tool') => { blocks.push(surface); },
    blockedSendMessage: async () => 'Cabinet mode: nothing was sent.',
  };

  test('refuses outbound text when NER is not ready', async () => {
    blocks.length = 0;
    const ws = workspace(true);
    const call = maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c1' }, cabinetDeps);
    await expect(call).rejects.toBeInstanceOf(DetectionUnavailableError);
    await expect(
      maybeRedactOutboundText('x', { workspacePath: ws, threadKey: 't-c1' }, cabinetDeps),
    ).rejects.toThrow('Cabinet mode: nothing was sent.');
    expect(blocks).toEqual(['outbound', 'outbound']);
  });

  test('refuses outbound text when NER throws', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe', { workspacePath: ws, threadKey: 't-c2' }, {
        ...cabinetDeps,
        isNerReady: () => true,
        detectNer: async () => { throw new Error('daemon down'); },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });

  test('refuses even text with no regex match (names are NER-only)', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe signs for Acme', { workspacePath: ws }, cabinetDeps),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });

  test('withholds tool result text parts when NER is not ready', async () => {
    blocks.length = 0;
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'builtin-filesystem',
      toolName: 'read_file',
      result: { content: [{ type: 'text', text: 'Jane Doe owes 10 000 €' }, { type: 'image', data: 'x' }], isError: false },
      workspacePath: ws,
      threadKey: 't-c3',
    }, cabinetDeps);
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0].text).toBe(CABINET_WITHHELD_MARKER);
    expect(content[1].type).toBe('image');
    expect(blocks).toEqual(['tool']);
  });

  test('withholds a plain string tool result', async () => {
    const ws = workspace(true);
    const result = await maybeRedactToolResult({
      serverId: 'builtin-filesystem', toolName: 'read_file', result: 'Jane Doe', workspacePath: ws, threadKey: 't-c4',
    }, cabinetDeps);
    expect(result).toBe(CABINET_WITHHELD_MARKER);
  });

  test('behaves as today when NER is ready', async () => {
    const ws = workspace(true);
    const { text } = await maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c5' }, {
      ...cabinetDeps,
      isNerReady: () => true,
      detectNer: async () => [],
    });
    expect(text).toBe('Mail [EMAIL_0]');
  });

  test('does nothing outside a Safe workspace', async () => {
    const ws = workspace(false);
    const { text } = await maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, cabinetDeps);
    expect(text).toBe('Jane Doe');
  });

  test('cabinet off keeps the regex fallback', async () => {
    const ws = workspace(true);
    const { text } = await maybeRedactOutboundText(`Mail ${PROBE_EMAIL}`, { workspacePath: ws, threadKey: 't-c6' }, stubDeps);
    expect(text).toBe('Mail [EMAIL_0]');
  });

  test('a failing audit write never unblocks', async () => {
    const ws = workspace(true);
    await expect(
      maybeRedactOutboundText('Jane Doe', { workspacePath: ws }, {
        ...cabinetDeps,
        recordBlock: async () => { throw new Error('disk full'); },
      }),
    ).rejects.toBeInstanceOf(DetectionUnavailableError);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test server/services/runtimeRedaction.test.ts`
Expected: the new `cabinet mode` tests FAIL (`CABINET_WITHHELD_MARKER` / `DetectionUnavailableError` not exported); all older tests PASS.

- [ ] **Step 4: Implement** in `server/services/runtimeRedaction.ts`

Below `RUNTIME_REDACTION_DEFERRED_MARKER`:

```ts
export const CABINET_WITHHELD_MARKER =
  '[withheld: cabinet mode — full PII detection unavailable, content not sent]';

/** Full detection (NER) could not run and cabinet mode forbids the fallback. */
export class DetectionUnavailableError extends Error {
  constructor(message = 'Full PII detection is unavailable (cabinet mode).') {
    super(message);
    this.name = 'DetectionUnavailableError';
  }
}
```

Extend `RuntimeRedactionDeps`:

```ts
  isCabinetMode?: () => boolean | Promise<boolean>;
  recordBlock?: (surface: 'outbound' | 'tool') => Promise<void>;
  blockedSendMessage?: () => Promise<string>;
```

Add the defaults next to the other `default*` functions:

```ts
async function defaultIsCabinetMode(): Promise<boolean> {
  const { getCabinetModeEnabled } = await import('../configStore');
  return getCabinetModeEnabled();
}

async function defaultRecordBlock(surface: 'outbound' | 'tool'): Promise<void> {
  const { appendCabinetAudit } = await import('./cabinetAudit');
  await appendCabinetAudit({ event: 'send_blocked', surface });
}

async function defaultBlockedSendMessage(): Promise<string> {
  // ChatView surfaces send errors as raw err.message, so the sentence is
  // localized here (same rule as attachmentBlockedInSafe in routes/agent.ts).
  const { getLanguage } = await import('../configStore');
  const { resources, supportedLanguages } = await import('../../shared/locales');
  const language = await getLanguage();
  const locale = language && (supportedLanguages as readonly string[]).includes(language)
    ? (language as keyof typeof resources)
    : 'en';
  return resources[locale].translation['basemind.cabinet.blockedSend'];
}
```

Replace `resolveDeps` with:

```ts
function resolveDeps(deps: RuntimeRedactionDeps = {}): {
  isNerReady: () => boolean | Promise<boolean>;
  detectNer: (text: string) => Promise<PiiDetection[]>;
  listCustomTerms: () => Promise<CustomTerm[]>;
  isCabinetMode: () => boolean | Promise<boolean>;
  recordBlock: (surface: 'outbound' | 'tool') => Promise<void>;
  blockedSendMessage: () => Promise<string>;
} {
  return {
    isNerReady: deps.isNerReady ?? defaultIsNerReady,
    detectNer: deps.detectNer ?? defaultDetectNer,
    listCustomTerms: deps.listCustomTerms ?? defaultListCustomTerms,
    isCabinetMode: deps.isCabinetMode ?? defaultIsCabinetMode,
    recordBlock: deps.recordBlock ?? defaultRecordBlock,
    blockedSendMessage: deps.blockedSendMessage ?? defaultBlockedSendMessage,
  };
}

async function recordBlockQuietly(
  resolved: ReturnType<typeof resolveDeps>,
  surface: 'outbound' | 'tool',
): Promise<void> {
  // The block stands whether or not it could be logged.
  try {
    await resolved.recordBlock(surface);
  } catch (error) {
    console.warn('[cabinet] could not record a blocked send', error);
  }
}
```

In `RedactTextOptions` add:

```ts
  /** Cabinet mode: throw DetectionUnavailableError instead of the regex-only fallback. */
  requireFullDetection?: boolean;
```

In `redactFileReadOutputText`, replace the NER block (from `let detections` through the `catch`) with:

```ts
  let detections: PiiDetection[] = regexDetections;
  let nerRan = false;
  try {
    if (await resolved.isNerReady()) {
      detections = mergeDetections(await resolved.detectNer(text), regexDetections);
      nerRan = true;
    }
  } catch {
    detections = regexDetections;
  }
  if (options.requireFullDetection && !nerRan) throw new DetectionUnavailableError();
```

In `applyFileReadRedaction`, add a parameter-free withheld signal through options and catch per part. Replace the function body's two redaction calls:

```ts
export async function applyFileReadRedaction(
  result: unknown,
  options: RedactTextOptions & { onWithheld?: () => void } = {},
  deps: RuntimeRedactionDeps = {},
): Promise<unknown> {
  const redactOrWithhold = async (text: string) => {
    try {
      return await redactFileReadOutputText(text, options, deps);
    } catch (error) {
      if (!(error instanceof DetectionUnavailableError)) throw error;
      options.onWithheld?.();
      return { text: CABINET_WITHHELD_MARKER, redacted: false, deferred: true };
    }
  };
  if (typeof result === 'string') {
    return (await redactOrWithhold(result)).text;
  }
  if (isMcpContentResult(result)) {
    const content: McpContentPart[] = [];
    let changed = false;
    for (const part of result.content) {
      if (part?.type !== 'text' || typeof part.text !== 'string') {
        content.push(part);
        continue;
      }
      const redacted = await redactOrWithhold(part.text);
      if (redacted.redacted || redacted.deferred) {
        content.push({ ...part, text: redacted.text });
        changed = true;
      } else {
        content.push(part);
      }
    }
    if (!changed) return result;
    return { ...result, content };
  }
  return result;
}
```

Keep the existing comments (error-text redaction, sequential parts) above the corresponding lines.

In `maybeRedactToolResult`, replace the final `return applyFileReadRedaction(...)` with:

```ts
  const resolved = resolveDeps(deps);
  const requireFullDetection = await resolved.isCabinetMode();
  let withheld = false;
  const redacted = await applyFileReadRedaction(result, {
    ...(threadKey ? { threadKey } : {}),
    requireFullDetection,
    onWithheld: () => { withheld = true; },
  }, deps);
  if (withheld) await recordBlockQuietly(resolved, 'tool');
  return redacted;
```

In `maybeRedactOutboundText`, replace the `redactFileReadOutputText` call and return with:

```ts
  const resolved = resolveDeps(deps);
  const requireFullDetection = await resolved.isCabinetMode();
  try {
    const result = await redactFileReadOutputText(
      text,
      { ...(options.threadKey ? { threadKey: options.threadKey } : {}), requireFullDetection },
      deps,
    );
    return { text: result.text, redacted: result.redacted || result.deferred };
  } catch (error) {
    if (!(error instanceof DetectionUnavailableError)) throw error;
    await recordBlockQuietly(resolved, 'outbound');
    throw new DetectionUnavailableError(await resolved.blockedSendMessage());
  }
```

`redactOutboundTurnInput` needs no change: it goes through `maybeRedactOutboundText`, so headless tasks and subagents (`server/agentTaskService.ts:289`) are covered; so are chat (`server/routes/agent.ts:1033-1048`), steer (`:1212-1215`) and goal objective (`:832`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test server/services/runtimeRedaction.test.ts server/handlers/pii.test.ts server/services/rehydrationPersistence.test.ts`
Expected: PASS, including the 9 `cabinet mode` tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/services/runtimeRedaction.ts server/services/runtimeRedaction.test.ts
git commit -s -m "feat(cabinet): refuse outbound text and withhold tool results when NER is down"
```

---

### Task 4: IPC

**Files:**
- Modify: `server/routes/ipc.ts` (inside `workspaceScan: { … }`, after `setCodeIndexingEnabled` ~line 207)
- Modify: `src/ipc.ts` (`interface WorkspaceScanIpc` ~line 667; demo stub ~line 774)

**Interfaces:**
- Consumes: `getCabinetModeEnabled` (Task 1), `setCabinetMode` (Task 1).
- Produces (renderer): `workspaceScan.getCabinetMode(): Promise<{ enabled: boolean }>`, `workspaceScan.setCabinetMode(value: boolean, confirmed: boolean): Promise<{ enabled: boolean }>`.

- [ ] **Step 1: Server handlers** — in `server/routes/ipc.ts`, after `setCodeIndexingEnabled`:

```ts
    getCabinetMode: async () => {
      const { getCabinetModeEnabled } = await import('../configStore');
      return { enabled: await getCabinetModeEnabled() };
    },
    setCabinetMode: async ([value, confirmed]: [boolean, boolean]) => {
      const { setCabinetMode } = await import('../services/cabinetMode');
      return setCabinetMode(value, { confirmed });
    },
```

- [ ] **Step 2: Renderer types** — in `src/ipc.ts`, `interface WorkspaceScanIpc`:

```ts
  /** Cabinet mode (spec 2026-09-29): on by default; turning off needs confirmed=true. */
  getCabinetMode(): Promise<{ enabled: boolean }>;
  setCabinetMode(value: boolean, confirmed: boolean): Promise<{ enabled: boolean }>;
```

and in the demo-mode stub next to `setCodeIndexingEnabled`:

```ts
    getCabinetMode: async () => { throw new Error('Not available in demo mode'); },
    setCabinetMode: async () => { throw new Error('Not available in demo mode'); },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/ipc.ts src/ipc.ts
git commit -s -m "feat(cabinet): expose cabinet mode over IPC"
```

---

### Task 5: Settings switch with confirm dialog

**Files:**
- Create: `src/components/settings/CabinetModeSection.tsx`
- Create: `src/components/settings/CabinetModeSection.ui.test.tsx`
- Modify: `src/components/GlobalSettings.tsx` (Privacy section ~line 425, before `data-settings-section="safe-repropose"`)

**Interfaces:**
- Consumes: `workspaceScan.getCabinetMode`, `workspaceScan.setCabinetMode` (Task 4); keys from Task 2.
- Produces: `CabinetModeSectionContent` (React component, no props).

- [ ] **Step 1: Write the failing test** — `src/components/settings/CabinetModeSection.ui.test.tsx`

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CabinetModeSectionContent } from './CabinetModeSection';

const scanMocks = vi.hoisted(() => ({
  getCabinetMode: vi.fn(async () => ({ enabled: true })),
  setCabinetMode: vi.fn(async (value: boolean) => ({ enabled: value })),
}));

vi.mock('@/ipc', () => ({ workspaceScan: scanMocks }));

beforeEach(() => {
  scanMocks.getCabinetMode.mockClear();
  scanMocks.setCabinetMode.mockClear();
});

describe('CabinetModeSectionContent', () => {
  test('shows cabinet mode on by default', async () => {
    render(<CabinetModeSectionContent />);
    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  test('switching off asks for confirmation and does nothing on cancel', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel|annuler/i }));
    expect(scanMocks.setCabinetMode).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('confirming turns it off with confirmed=true', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await screen.findByRole('switch'));
    await userEvent.click(await screen.findByTestId('cabinet-disable-confirm'));
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(false, true));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  test('switching back on needs no dialog', async () => {
    scanMocks.getCabinetMode.mockResolvedValueOnce({ enabled: false });
    render(<CabinetModeSectionContent />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(true, false));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts src/components/settings/CabinetModeSection.ui.test.tsx`
Expected: FAIL — module `./CabinetModeSection` not found.

- [ ] **Step 3: Implement** — `src/components/settings/CabinetModeSection.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { workspaceScan } from '@/ipc';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';

export function CabinetModeSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    workspaceScan.getCabinetMode()
      .then((response) => setEnabled(response.enabled))
      .catch((error) => console.error('Failed to load cabinet mode:', error));
  }, []);

  async function apply(value: boolean, confirmed: boolean) {
    try {
      const response = await workspaceScan.setCabinetMode(value, confirmed);
      setEnabled(response.enabled);
    } catch (error) {
      console.error('Failed to change cabinet mode:', error);
    }
  }

  function handleChange(value: boolean) {
    if (value) {
      void apply(true, false);
      return;
    }
    setConfirmOpen(true);
  }

  return (
    <>
      <SettingsRow
        label={t('basemind.cabinet.title')}
        description={t('basemind.cabinet.description')}
      >
        <Switch size="sm" checked={enabled} onCheckedChange={handleChange} />
      </SettingsRow>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('basemind.cabinet.disableTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('basemind.cabinet.disableBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cabinet-disable-confirm"
              onClick={() => { void apply(false, true); }}
            >
              {t('basemind.cabinet.disableConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

In `src/components/GlobalSettings.tsx`, import `CabinetModeSectionContent` from `./settings/CabinetModeSection` and, inside the Privacy `SettingsSection`, right after the telemetry `div`:

```tsx
                      <div data-settings-section="cabinet-mode">
                        <CabinetModeSectionContent />
                      </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts src/components/settings/CabinetModeSection.ui.test.tsx`
Expected: PASS (4 tests). If the dialog role is `dialog` rather than `alertdialog` in this Radix version, change the two queries to `findByRole('dialog')` / `queryByRole('dialog')`.

Run: `bun test shared/locales/__tests__/uiHardcodedStrings.test.ts`
Expected: PASS (no hard-coded strings in the new component).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/CabinetModeSection.tsx src/components/settings/CabinetModeSection.ui.test.tsx src/components/GlobalSettings.tsx
git commit -s -m "feat(cabinet): Privacy settings switch with responsibility confirmation"
```

---

### Task 6: Full verification and live check

**Files:** none (verification only).

- [ ] **Step 1: Full suites**

Run: `pnpm typecheck && pnpm run test:unit && pnpm run test:vitest`
Expected: green (compare with the baseline noted in `2026-09-24-safe-mirror-pipeline-impl-spec.md` — any pre-existing failures must be the same ones).

- [ ] **Step 2: Live check with a fake case** (never a real client file)

1. `pnpm dev`, open a test workspace, make it Safe (banner).
2. Write in chat: `Jean Dupont (Acme SAS) doit 125 000 € — 06 12 34 56 78`. In the `[AGENT]` logs, the provider payload must show tokens for all four.
3. Stop basemind (`basemind` process / daemon), send the same message. Expected: the localized `basemind.cabinet.blockedSend` error, nothing in the provider payload, and a `send_blocked` / `outbound` line in `<appData>/audit/cabinet-mode.jsonl`.
4. Settings → Privacy → switch off → dialog → confirm. Expected: a `cabinet_mode_disabled` line with `osUser`, `hostname`, `appVersion`.
5. With basemind still stopped, send again: the message leaves with regex-only redaction (today's behaviour). Switch back on.

- [ ] **Step 3: Review before merge**

Run `/code-review` on the branch; open the PR against `main` only after the review with Jamin on the spec's open questions.
