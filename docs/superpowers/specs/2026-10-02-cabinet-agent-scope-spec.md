# Cabinet mode: confine the agent's tools to `safe/` — design spec (2026-10-02)

Companion to `2026-09-29-cabinet-mode-spec.md`. Cabinet mode today gates the text that
leaves for the provider and the results of the app's own tools. It does not gate what the
agent reads with the engine's **native** tools (shell, file reads). This spec closes that
gap. Status: **design, not implemented**. Three facts must be verified first (see
"Open verifications").

## Destination

In an armed Safe workspace with cabinet mode on, **every tool the agent has can read and
write only under `<workspace>/safe/`**, plus the minimum the system needs to run a process.
Nothing else in the workspace, and nothing elsewhere on the disk. Where a system cannot
enforce this, the agent's native shell and file tools are **withheld** rather than exposed;
if neither can be guaranteed, the turn is **refused**. It applies on macOS, Windows and
Linux.

## Why (observed 2026-10-02, in the app)

1. The agent tried `read_mcp_resource` on `safe/note-fictive-2.txt.md`. basemind answered
   `-32601` (method not found): it does not implement `resources/read`.
2. The agent fell back to the shell and ran `cat note-fictive-2.txt` — the **original** —
   and received the client's name, company, amount, e-mail and phone number in clear. The
   engine's event log holds them. That output goes into the next turn to the provider.
3. The cabinet description already states the limit ("the output of the agent's own shell
   and file commands is never scanned"), but the test shows it is the agent's natural
   fallback, not a rare case. Read access defaults to the whole disk
   (`codexReadAccessMode = 'full-system'`).

## Facts established while exploring

- The engine's native commands run under the engine's own policy (`SandboxPolicy`:
  `dangerFullAccess | readOnly | externalSandbox | workspaceWrite`), which the app sets per
  turn in `turn/start`. The app's result filter never sees them.
- The engine also has **named permission profiles**: `default_permissions` refers to a
  profile in a `[permissions]` table (or to `:workspace` / `:read-only`). Its filesystem
  entries are a path, a glob or a special root (`project_roots`, `tmpdir`, …) with access
  `read | write | deny`. `ThreadStartParams.config` accepts config overrides.
- Setting `sandbox_mode` and `default_permissions` together is rejected by the engine, and a
  profile that cannot be expressed as a legacy sandbox policy falls back to `read-only`.
- **On macOS 13.7.8 the engine's sandbox cannot start:** `interpreter sandbox -- /bin/echo x`
  fails with `sandbox-exec: unbound variable: TIOCSTI`. In the same session the agent's
  `cat` succeeded: the engine classed it as a read (`type: read`, 0 ms) and appears to have
  run it outside the sandbox. OS-enforced confinement therefore cannot be assumed.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Scope | An armed Safe workspace (as for the cabinet gate) with cabinet mode on. Outside it, nothing changes. |
| 2 | Where the agent may write | **Only `safe/`** (owner decision, 2026-10-02). |
| 3 | Read scope | Only `safe/`, plus what a process needs to run. Not the rest of the workspace, not the rest of the disk. |
| 4 | Systems | macOS, Windows and Linux (owner decision, 2026-10-02). |
| 5 | When confinement cannot be enforced | Withhold the native shell and file tools; the agent reads through basemind and writes into `safe/` through an app tool. If neither is possible, refuse the turn. Fail closed. |
| 6 | Coverage | Chat turns, steer, headless tasks, subagents and hidden agents: every path that starts an engine turn. |

## Design: four layers

1. **Engine permission profile (OS-enforced).** A profile `cabinet` is passed in the thread's
   `config` (`default_permissions = "cabinet"` plus `[permissions.cabinet.filesystem]`):
   deny the workspace root, allow `safe/` read and write, allow the minimal system read.
   For these threads the app stops sending a per-turn `sandboxPolicy` and `sandbox_mode`.
2. **Capability probe.** Before layer 1 is trusted, the app checks that the engine's sandbox
   works on this machine: a real command is run under the `cabinet` profile and its denial
   of an outside path and its access to `safe/` are both observed. The result is cached per
   engine version and re-checked when the engine changes.
3. **Fallback when the probe fails.** The native shell and file tools are withheld from the
   turn. The agent has basemind (reads) and an app write tool restricted to `safe/`.
4. **Existing layer.** The outbound-text gate and the result filter for the app's tools stay.

If layer 2 fails **and** layer 3 cannot be applied, the turn is refused with the cabinet
error and one `send_blocked` entry is recorded.

## Design: basemind reads (complement A)

basemind implements `resources/list` and `resources/read` (read-only) for files under
`safe/**`:

- The path is resolved and must stay under `<root>/safe/` after resolving `..` and symlinks;
  anything else is refused.
- A size cap applies, as for `redact_text`.
- Results go through the app's existing result filter like any other basemind result.

This is the agent's natural first read. Without it, layer 3 leaves the agent no way to read.

## Components (app)

- `server/services/cabinetAgentScope.ts`: pure builder, `(workspace path) → profile config`.
  It handles Windows paths, drive letters, case-insensitivity and symlinks, and refuses a
  workspace it cannot express exactly.
- A capability probe next to it, with a cache.
- Integration at thread start in `codexRuntime.ts`, and in `codexSubagentRunner.ts` and the
  hidden-agent runner, which also pass `sandboxPolicy` today.
- Audit: `fs_scope_applied`, `fs_scope_degraded` (layer 3 used) and `send_blocked` for a
  refusal. As before, the audit log never holds message content, file names or paths.
- UI: the cabinet description's limit sentence is rewritten once this ships.

## Non-goals

Per-agent scope settings; network confinement; scanning the content of what the agent
legitimately reads from `safe/` (the filter already does); images; confining agents when
cabinet mode is off.

## Open verifications (before the implementation plan)

None of these can be run on the owner's Mac (macOS 13), so they run as a throwaway CI job on
Ubuntu, a recent macOS and Windows runners, downloading the engine binary:

- **V1.** The exact syntax of a profile, and whether `deny` wins over a broader allow. The
  minimal system read needed for a process to start on each OS.
- **V2.** Whether the engine lets the app withhold its native shell and file tools by
  configuration (layer 3). If it does not, layer 3 needs another mechanism.
- **V3.** A reliable capability probe on each OS, including Windows (the engine has a
  sandbox readiness request).

- **V4.** Layer 3 assumes an app tool that writes files and can be limited to `safe/`
  through the agent file policy (`customPaths`), with its arguments and results passing the
  existing filter. The app's `builtin-filesystem` tools are the candidate; this is not yet
  confirmed. This one can be checked on the owner's machine, in the code.

If V1 fails on an OS, that OS runs on layer 3 only. If V2 also fails, that OS is refused.
If V4 fails, layer 3 is read-only until a write path is built.

## Risks

- A system with no working sandbox and no way to withhold native tools would refuse every
  turn in an armed workspace. That is the intended failure, but it is a visible one.
- Withholding the shell removes scripting (Python, conversions) from the agent in those
  workspaces.
- A profile that silently falls back to `read-only` would look enforced but not be: the
  probe must observe denial, not trust the configuration.

## Acceptance criteria

1. Armed workspace, cabinet on, working sandbox: the agent's `cat <workspace>/original`
   fails, `cat <workspace>/safe/x.md` succeeds, and the same for writes.
2. The agent cannot read outside the workspace (home, other client folders), beyond the
   minimal system read.
3. Probe fails (for example macOS 13): the native shell and file tools are absent from the
   turn, `resources/read` on a `safe/` file works through basemind, and one
   `fs_scope_degraded` entry is recorded.
4. Neither layer possible: the turn is refused with the cabinet error.
5. basemind `resources/read` returns a `safe/` file and refuses `../`, an absolute path
   outside `safe/`, and a symlink pointing out.
6. Cabinet off, or a workspace that is not armed: behaviour is unchanged.
7. Subagents, headless tasks and hidden agents are confined like chat turns.
8. An integration test with the real engine runs on the CI legs where the sandbox works;
   `pnpm typecheck`, `pnpm run test:unit` and `pnpm run test:vitest` stay green.
