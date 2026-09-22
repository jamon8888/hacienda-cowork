# Contributor and agent guidance

These rules are architecture constraints for this repository.

## Canonical checkout guard

This repository is the canonical OSS Workstation application. Before editing
or testing application code, run `git rev-parse --show-toplevel` and verify that
the result is this repository's root. Read every applicable ancestor
`AGENTS.md`; if one marks the checkout as legacy or migration-only, stop. Work
performed or tested in a copied legacy tree is not current Workstation work and
must never be reported as verification of this repository.

The product website is a separate repository. Do not add website source,
website build output, or website release configuration here. This repository
owns the official client configuration, packaging profiles, and client release
workflows as well as all application behavior and tests. A private operations
repository may trigger these workflows or hold deployment credentials,
organization-specific policy, and internal binary artifacts, but it must never
become a second application or owner of canonical client release logic.

## Setup and run

- Toolchain: Node 22 (see `.nvmrc`), pnpm 9, Bun, Rust stable, git with
  submodule support. Fresh Linux installs also need `libx11-dev libxi-dev
  libxtst-dev libxext-dev libwayland-dev libopenblas-dev` (see the
  `package-smoke` job in `.github/workflows/ci.yml`); the qwen-asr runtime
  compiles C against OpenBLAS.
- First-time setup order matters:
  ```bash
  git submodule update --init --recursive
  pnpm install
  pnpm run download:oix -- --current-platform
  pnpm run download:pdfcpu -- --current-platform
  pnpm run download:qwen-asr -- --current-platform
  pnpm run extension:bootstrap
  pnpm run build
  ```
  Skipping `extension:bootstrap` fails the build on missing
  browser-extension-relay assets; the error does not say so.
- Iterate with `pnpm dev` (Vite + Electron, session log in
  `logs/session-<timestamp>.log`). `pnpm start` reuses the last build.
- Renderer URL gotcha: unpackaged Electron loads the first
  `localhost:5173–5193` server answering `/@vite/client`
  (`resolveRendererDevUrl` in `electron/main.ts`), so another checkout's Vite
  on `:5173` hijacks the window. Pin with `VITE_PORT=…`, or force the built
  renderer with `INTERPRETER_USE_BUILT_RENDERER=true`.

## Before changing code

- Read `README.md` and the relevant document under `docs/` before editing that
  subsystem: `docs/agent-testing.md` (tests), `docs/agent-ipc.md`
  (preload/IPC/subscriptions), `docs/agent-tools.md` (tools, permissions, MCP
  bridging, native modules), `docs/agent-frontend.md` (UI), `docs/agent-paths.md`
  plus the helpers in `src/ipc.ts` (frontend paths).
- Verify the canonical checkout guard above before making the first edit or
  running acceptance tests.
- Preserve user work and unrelated changes. Never publish, push, or create a
  public artifact without explicit authorization.

## Product boundaries

- Open Interpreter is the runtime core. Provider/model discovery, harness
  selection, agent execution, and app-server behavior belong there.
- Workstation is a client of the OIX app-server contract. Do not recreate OIX
  provider catalogs or harness logic in the Electron app.
- Model-facing Workstation tools use the `interpreter-app` CLI surface. Do not
  introduce a parallel direct-MCP tool surface for the model.
- File permissions are per agent. Every tool path must enforce the effective
  agent scope, not merely a global workspace setting.
- The community distribution is fully usable without hosted accounts,
  telemetry, or proprietary services.
- Official, internal, community, and enterprise profiles use the same open
  client capabilities. A subscription may authorize operated services; it must
  not unlock a private client feature.
- Distribution-specific endpoints and branding are injected through
  `product.json` overlays. Do not fork application behavior for a distribution.
- Rich document engines are optional external integrations. The default
  document workflow is code execution plus skills.

## Dependencies and provenance

- `apps/interpreter-extension` is the Open Interpreter browser-extension
  submodule and retains its independent release history and Playwriter ancestry.
- `submodules/interpreter-cua` is the Open Interpreter computer-use fork and
  retains its upstream attribution. Workstation consumes its pinned driver
  contract; a local checkout name does not imply cloud-provider compatibility.
- Never commit credentials, token backups, signing material, paid SDKs, or
  proprietary binary licenses.

## Code rules

- Prefer the simplest complete structural fix. Do not add compatibility
  fallbacks for obsolete local formats.
- Use Interpreter branding in user-facing copy.
- Route frontend path handling through the helpers in `src/ipc.ts`.

## Verification

The normal pre-commit floor is `pnpm run precommit` (`typecheck` +
`test:unit`, the Bun suite, + `test:vitest`, the renderer suite).

- `pnpm test` additionally builds the app and runs Electron end-to-end. Never
  invoke `npx playwright` directly; use the `test:e2e:*` scripts and read
  `docs/agent-testing.md` first.
- For app-server or bundled-runtime work, run `pnpm run download:oix --
  --current-platform` then `pnpm run test:interpreter:smoke`.
- Electron e2e runs on macOS and voice e2e on Windows in CI. On Linux, prove
  what you can locally and report platform-dependent steps not run.
- When changing dependencies, also run `pnpm audit --audit-level=high` and
  `pnpm run release:licenses:check`; the CI `verify` job enforces both.
- Sign off every commit (`git commit -s`); PRs cannot merge while any
  non-merge commit lacks a `Signed-off-by` trailer (DCO, see
  `CONTRIBUTING.md`).

Never claim an end-to-end path works from typechecking alone. Prove the actual
boundary and report any platform or credential-dependent step that was not run.

## Agent skills

### Issue tracker

Issues live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, label string equals role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.

### Repo skills

`skills/` holds the workstation-modification skills, installed for agents via
symlinks in `.opencode/skills/`. They resolve through the link, so editing
either path edits the source.
