# Session findings: GLiNER2 PII redaction, Safe workspace pipeline, and native build

Status: **draft for review.** Written from a single verification session on
2026-10-06 against `jamon8888/hacienda-cowork` @ `3b20edb`. Nothing here is a
fix; these are findings to triage, and the P0 in §2 is not yet mitigated.

Everything below was executed, not inferred. Where I could not verify something,
it says so.

---

## 0. Executive summary

The Safe-workspace pipeline works end to end with the real GLiNER2 model:
redact → mirror → token registry → encrypt → search → rehydrate, with every
security assertion passing.

**One finding is P0 and needs attention before this ships on real client
documents:** GLiNER2 silently stops detecting entities past roughly 560–710
characters into a `redact_text` input. Passwords, API keys, and access tokens
beyond that point are returned unredacted, while the tool still reports
`ner_ran: true`. There is no signal to the caller that anything was missed.

---

## 1. Verified environment

| Component | Version / state |
|---|---|
| `main` | `3b20edb`, matches `origin/main`, 34 commits pulled |
| basemind binary | v0.32.3 (`873a357`), pin aligned in `28bfd30` |
| GLiNER2 model | `fastino/gliner2-privacy-filter-PII-multi` @ `36126f61`, 1.24 GB, SHA-verified |
| Embedding model | `multilingual-e5-base` (already cached) |
| GTE reranker | downloaded, **not needed** — `RerankerConfig.enabled` defaults to `false` |
| Native modules | node-pty, uiohook-napi, interpreter-window-pin all build |
| Host | Linux, 3.8 GB RAM, `DISPLAY=:0.0` |

### Native build: `AGENTS.md` package list is incomplete

`AGENTS.md` lists six X11 dev packages. That is enough for the qwen-asr
OpenBLAS build but **not** for `uiohook-napi`, which additionally needs:

```bash
sudo apt-get install -y libxinerama-dev libxrandr-dev libxt-dev
```

Derived from `binding.gyp`, which defines only `USE_XRANDR`, `USE_EVDEV`,
`USE_XT` on Linux. `xf86misc.h` (`USE_XF86MISC`), `XKBrules.h` (`USE_XKB_FILE`)
and `Xlib-xcb.h` (`USE_XKB_COMMON`) sit behind macros that are never defined, so
`libxxf86vm-dev`, `libxkbfile-dev` and `libx11-xcb-dev` are *not* required.

**Action:** add the three packages to `AGENTS.md`.

---

## 2. P0 — GLiNER2 silently truncates; secrets leak past ~700 chars

### Statement

Entities beyond a position-dependent cutoff inside a single `redact_text` input
are not detected. The tool still returns `ner_ran: true`.

### Evidence

A single marked API key swept across a fixed PII-dense body (880 chars):

```
offset  absPos  detected
0       8       CAUGHT as api_key
0.25    228     CAUGHT as api_key
0.5     448     CAUGHT as api_key
0.7     624     LEAK
0.8     712     LEAK
0.85    756     LEAK
0.9     800     LEAK
0.95    844     LEAK
0.99    879     LEAK
```

Binary search for the exact cutoff, varying only entity density:

```
dense PII body   -> leaks once it starts beyond ~558 chars
neutral body     -> leaks once it starts beyond ~706 chars
```

Density shifts the boundary by 148 chars, so this is a **sequence-length
truncation inside the encoder**, not a cap on the number of returned entities.
A total-entity cap is ruled out: with the credential at the *start* of the same
body, all 142 entities are still returned and the credential is caught.

This is not limited to `--text`. Via `--file` on a ~800-char document:

```
LEAKED IN CLEAR:
  CorrectHorseBattery9
  sk-proj-abc123def456ghi789jkl012
  ghp_16C7e42F292c6912E7710c838347Ae178B4a
  2023-06-15
  2028-06-15
  2026-09-30
```

The same credentials in a **short** input are all caught:

```
Password: [PASSWORD_1]. API key [API_KEY_1]. Access token [ACCESS_TOKEN_1].
Secret: [PASSWORD_2]. Document expires [EXPIRATION_DATE_1].
```

### Why it matters here

`redact_text` accepts up to 1 MiB, and `runtimeRedaction.ts` chunks
sequentially under that cap. ~700 chars is three orders of magnitude smaller, so
a single 200 KB client document leaks essentially everything past its first page.
The classes that fall through are the highest-risk ones: credentials.

`require_ner` does not help — it only asserts the model *ran*, not that it saw
the whole input.

### Suggested direction

The truncation is inside `xberg`'s GLiNER2 backend
(`xberg = { git = "https://github.com/xberg-io/xberg.git", rev = "71297af8…" }`),
not in this repo — its source was not available locally, so the exact limit is
unconfirmed. Three things worth doing:

1. Find the encoder's max sequence length in xberg and either raise it or make
   the backend **chunk internally**, re-offsetting spans.
2. Until then, have `redact_text` chunk well below 1 MiB and run NER per chunk.
3. Make truncation observable: if the backend clips input, surface it (e.g.
   `ner_truncated: true`) so callers can refuse to release the text rather than
   treat a partial pass as complete.

### Repro

`/tmp/opencode/cutoff.ts` (binary search), `/tmp/opencode/tail-probe.ts`
(position sweep), `/tmp/opencode/bisect2.ts` (density vs position). All drive
`redact_text` over MCP with `require_ner: true`.

---

## 3. P1 — pattern-only degradation is silent by default

Without a model on disk, `redact_text` degrades to regex and returns
`ner_ran: false`. The app passes `ner_model_dir: resolveNerModelDir() ?? undefined`,
so on a fresh machine every redaction is pattern-only and names, companies,
cities, CVVs, passport and licence numbers pass through in clear.

This is the state I found the machine in before downloading the model.

**Suggested:** surface detection readiness in the UI before any workspace is made
Safe, and consider defaulting `require_ner: true` for Safe workspaces, where
releasing partially-redacted text is the worse failure.

Note `require_ner` exists on the MCP tool but is **not** exposed on the CLI, so
`basemind redact` can only ever degrade silently.

---

## 4. P2 — national IDs and financial identifiers mislabelled as `phone`

These are redacted (no leak), but the regex layer reports them as phone numbers:

```
national insurance number  2 75 04 75 123 456 42  -> phone
tax_id (SIREN)             552 100 554             -> phone
bank account number        12345678901             -> phone
recovery_code              1234-5678-9012          -> phone
account_id                 ACCT-998-776-655         -> phone
```

`risk_for_label` (`src/pii/pipeline.rs`) buckets by label string, so a national
ID or recovery code is scored as contact data rather than as a high-risk
identifier. Anything downstream that groups or reports by category will
misclassify them.

**Suggested:** extend the regex taxonomy with the identifier shapes GLiNER2 is
asked for (`national_id_number`, `tax_id`, `bank_account`, `account_id`,
`recovery_code`) so the pattern pass agrees with the NER label set.

---

## 5. P3 — CLI output truncation is a diagnostic trap

`basemind redact` clips `rehydration_map` and the `detections` table with a
trailing `…` past a fixed length. Not width-dependent (`COLUMNS=4000` does not
help), and `--json` is explicitly ignored on this subcommand.

This cost me two wrong conclusions in this session: an empty regex match read as
"zero tokens found" (which made every leak check pass vacuously), and a gap in a
truncated table read as "these entities were missed" when they were not.

The MCP path returns everything untruncated — 27/27 detections — so the app is
unaffected. Only ad-hoc CLI inspection is.

**Suggested:** print a machine-readable form for `redact` (honour `--json`), or at
minimum mark truncation explicitly instead of ending in `…`.

---

## 6. P3 — no e2e coverage for the Safe/RAG path

`safeSync`, `safeExport/rehydrate`, `workspaceTokenRegistry` and
`runtimeRedaction` have unit tests, but there is no Playwright spec and no
integration test that runs the pipeline end to end. The session probe in
§7 does, ad hoc.

**Suggested:** promote the probe to a committed integration test with the
fixtures inline, so a regression in the mirror/registry/rehydrate contract fails
CI rather than being found in production.

---

## 7. What is verified working

Probe: `/tmp/opencode/pipeline-probe.ts` (MCP client: `mcp-client.ts`).
Workspace: `/tmp/opencode/ws`. All checks pass.

| Stage | Result |
|---|---|
| Arm workspace (`safe/` + `basemind.toml`) | PASS |
| Redact 2 documents via GLiNER2 (`ner_ran=true`) | PASS — 8 + 5 tokens |
| No raw card/IBAN/passport/SSN in mirror | PASS |
| One token per value workspace-wide | PASS — 12 tokens, no duplicates |
| Rescan mirror into LanceDB | PASS |
| Search reaches the mirror; Safe filter drops the original | PASS |
| Mirror body is tokenised | PASS |
| Rehydrate a tokenised draft | PASS — `[FULL_NAME_1]` → `Alice Smith` |
| Conflict detection (two sources disagree) | PASS |

Vault round-trip (`/tmp/opencode/vault-roundtrip.ts`):

- 12 tokens → 564-char base64 blob
- **no plaintext inside the blob**
- wrong passphrase rejected
- correct passphrase returns all 12
- fresh registry resolves `Alice Smith` → `[FULL_NAME_1]` → `Alice Smith`

Real GLiNER2 labels observed, all high confidence:

```
full_name, street_address, postal_code, city, state_or_region, country,
date_of_birth, email, phone, passport_number, drivers_license_number,
organization, iban, credit_card, card_expiry, card_cvv, username, ip_address
```

It selects the specific label (`full_name`, `city`) over the generic
`person`/`location`, as `redact_file_tests.rs` asserts.

### Security boundary worth noting

An unscoped `code` search returns hits on **both** `safe/contracts/lease.md.md`
and the original `contracts/lease.md`. `keepMirrorHitsInSafeWorkspace` drops the
original; my test asserts the filter had work to do, so it cannot silently
become a no-op. That filter is load-bearing — basemind indexes the whole
workspace.

Also worth recording: Safe workspaces are searched through the `code` tool
(`interpreter_workspace_search` → `basemindSearchCode` → `tools/call
name="code"`), **not** `memory documents`. Mirrors are `.md` and are indexed as
code, so LanceDB document RAG is not part of the Safe search path. Do not write
tests expecting otherwise.

---

## 8. Environment gaps (not code defects)

| Gap | Impact |
|---|---|
| No `basemind-x86_64-unknown-linux-gnu-noavx2.tar.gz` on the v0.32.3 release | CPUs without AVX2 have no binary. Script warns and skips. Needs publishing upstream. |
| Document RAG OOM-kills below ~4 GB | `global_oom`, basemind at ~1.9 GB RSS on 3.8 GB. Caused by the embedding model, **not** the reranker (disabled by default). |

---

## 9. Corrections made during this session

Recorded so they are not mistaken for findings:

- The `config.json` "SHA mismatch" was **my** transcription typo (63-char
  digest). The repo's pin in `server/handlers/basemindPreseed.ts` is a correct
  64-char SHA. Re-fetched using the pin read from the module; all five files
  verified.
- "Secrets are never detected" was wrong — it came from reading a truncated CLI
  detections table. Short inputs catch all of them.
- The reranker download was unnecessary; `RerankerConfig.enabled` defaults to
  `false`.
- `memory documents` returning nothing was correct behaviour, not a bug.

---

## 10. Open questions for the team

1. Does xberg's GLiNER2 backend document a max sequence length? Is chunking
   internal to it, or is truncation expected of callers?
2. Should `redact_text` chunk below its 1 MiB cap regardless, as defence in
   depth against the above?
3. Is `require_ner` meant to be CLI-exposed, or is the CLI intentionally a
   best-effort inspection tool?
4. Should `risk_for_label` and the regex taxonomy be unified so pattern and NER
   passes cannot disagree on category?
5. Who owns publishing the `noavx2` asset for v0.32.3?

---

## 11. Reproducing

The probe scripts are ad hoc and are **not committed**, so the paths below only
exist on the machine that ran the session. Re-create them from the method in
§2 before trusting a number here; the §7 probe drives `redact_text` over MCP
with `require_ner: true` and the §2 repro sweeps a marked credential across a
fixed body.

```bash
# models
cd /home/jamin/Documents/hacienda-cowork
bun -e "const m=await import('./server/handlers/basemindPreseed.ts');
  for (const f of [...m.GLINER_FILES, ...m.FASTINO_FILES])
    console.log(m.FASTINO_REPO, f.sha256, f.path)"

# readiness
bun -e "const {isFullDetectionReady}=await import('./server/services/piiDetection.ts');
  console.log(isFullDetectionReady())"

# pipeline
bun /tmp/opencode/pipeline-probe.ts
bun /tmp/opencode/vault-roundtrip.ts

# P0 repro
bun /tmp/opencode/cutoff.ts
```