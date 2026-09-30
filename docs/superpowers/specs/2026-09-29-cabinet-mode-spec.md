# Cabinet mode — design spec (2026-09-29)

Companion to `2026-09-22-basemind-safe-integration-spec.md` (§7, couture B).
This document is the design contract; the plan
`docs/superpowers/plans/2026-09-29-cabinet-mode.md` implements it.

## Destination

In a Safe workspace, when full detection (NER) cannot run, **nothing leaves
for the provider**: outbound text is refused and tool results are withheld.
Cabinet mode is **on by default**. Turning it off is an explicit, warned,
confirmed gesture, and every change and every block is **recorded** in a local
audit log. Responsibility for turning it off rests with the lawyer who does it.

## Why (user decision, 2026-09-28)

Today (`a4b1475`), `redactFileReadOutputText` falls back to regex + pinned
terms when NER is not ready or throws
(`server/services/runtimeRedaction.ts:169-176`). Names, companies and amounts
are NER-only categories: in that fallback they reach the provider in clear.
The code states the trade-off on purpose (a redaction outage degrades instead
of blocking chat). For a law firm the trade-off is inverted: a stopped
conversation costs little, a client name sent in clear cannot be recalled.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Default | On. Config key `cabinetModeEnabled`; absent = on. |
| 2 | Scope | Device-level, like `rerankerEnabledOverride` (not per workspace in v1). Applies only in armed (Safe) workspaces — outside `safe/` nothing changes. |
| 3 | What blocks | Full detection unavailable = `isNerReady()` false, or `detectNer()` throws. |
| 4 | Outbound text (chat, steer, goal objective, headless tasks/subagents) | Throw a localized error; the message is not sent. Covered at the single chokepoint `maybeRedactOutboundText`. |
| 5 | Tool results | Each text part replaced by `CABINET_WITHHELD_MARKER`; the agent loop continues but the model sees no content. Fail closed without breaking the tool contract. |
| 6 | Turning off | Requires `confirmed: true` over IPC (set only by the confirm dialog). If the audit entry cannot be written, the setting is **not** changed. |
| 7 | Audit | Append-only JSONL at `<appData>/audit/cabinet-mode.jsonl`: `at`, `event`, `osUser`, `hostname`, `appVersion`, and `surface` for blocks. **Never** message content, file names or detections. **Hash-chained** (added 2026-09-29): each line carries `prev` (previous line's hash) and `hash` = sha256(prev + line without hash); genesis = 64 zeros; `verifyCabinetAuditChain` reports the first broken line. |
| 8 | Events | `cabinet_mode_disabled`, `cabinet_mode_enabled`, `send_blocked` (`surface: outbound | tool`). |
| 9 | UI | Privacy section of Settings: a switch; switching off opens an AlertDialog stating the consequence and the responsibility; confirm button "Turn off — I take responsibility". |
| 10 | i18n | Every visible string in the 8 locales before merge (repo rule). |

## Non-goals (v1)

Per-workspace setting; user identity beyond the OS account; audit viewer UI;
audit export or signing; anchoring the chain off the machine; retention policy; blocking outside Safe workspaces.

## Decided after review (2026-09-29, Candy — owner of the privacy scope)

1. **Who:** the OS account is enough for v1; each lawyer's computer has a
   named user account, recorded as `osUser`.
2. **Anchoring:** the hash chain ships in v1; anchoring it off the machine
   (head hash sent to a server, or qualified eIDAS timestamp) is a separate
   project, out of scope here.
3. **Retention (2026-09-30):** no automatic purge in v1. The log is append-only
   and holds no content, file names or detections, so nothing deletes it until
   the firm (or its DPO) sets a retention period; a purge or per-period
   archive, keeping the chain verifiable, is added then. The hash chain makes
   any manual deletion visible.

## Open question

None.

## Acceptance criteria

1. Cabinet on, NER not ready, Safe workspace: chat send throws the localized
   `basemind.cabinet.blockedSend`; provider receives nothing; one
   `send_blocked` (`outbound`) line in the audit log.
2. Same with `detectNer` throwing.
3. Cabinet on, NER not ready: a tool result's text parts become
   `CABINET_WITHHELD_MARKER`; one `send_blocked` (`tool`) line.
4. Cabinet on, NER ready: behaviour identical to today (existing tests green).
5. Cabinet off: regex fallback as today.
6. Outside a Safe workspace: unchanged in both modes.
7. `setCabinetModeEnabled(false)` without `confirmed: true` throws; config unchanged.
8. Audit write failure on disable: config unchanged, error surfaced.
9. Fresh config: `getCabinetModeEnabled()` is `true`.
10. Editing or deleting a line makes `verifyCabinetAuditChain` fail at that line (or the next one for a deletion); concurrent appends form one valid chain.
11. `pnpm typecheck`, `pnpm run test:unit`, `pnpm run test:vitest` green.
