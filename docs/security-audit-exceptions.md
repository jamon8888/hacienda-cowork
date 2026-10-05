# Security audit exceptions

CI runs `pnpm audit --audit-level=high`. An advisory with no fixed version cannot be
cleared by upgrading, so each one we accept is listed here and in
`package.json` under `pnpm.auditConfig.ignoreGhsas`. An exception is a decision
about one advisory, not about the package: remove it as soon as a fixed version
exists, and do not add one without an entry below.

## How to read an entry

- **Shipped?** Whether the package is in the production dependency closure. Check with
  `pnpm audit --prod --audit-level=high`: it must stay clean.
- **Reachable?** Whether untrusted input can reach the vulnerable code.
- **Review:** what triggers removing the exception.

## Accepted

### GHSA-ch52-4w7c-c8xp, `http-cache-semantics` <= 4.2.0

`max-stale` handling can disclose cross-user cached responses.

- **Shipped?** No. Reached only through `electron-builder`, `@electron/get`,
  `@electron/rebuild` and `node-gyp` (all `devDependencies`), which use it to cache
  downloads of build tools.
- **Reachable?** No user data goes through it: it caches HTTP responses for
  binaries fetched at build time, on a developer or CI machine.
- **Not a fix:** 4.3.0 (2026-10-04) does not change the `max-stale` code. It changes
  `Vary` matching and adds `status()`, so moving to it would only make the audit
  pass, not remove the defect. Do not pin it for that reason.
- **Review:** when the advisory lists a patched version, upgrade through
  `pnpm.overrides` and drop the exception.

### GHSA-vfj7-8cjw-p6xm, `braces` <= 3.0.3

Stack-exhaustion denial of service through deeply nested brace patterns.

- **Shipped?** No. Reached directly from `chokidar` (under `@sentry/vite-plugin`) and
  through `micromatch` from `fast-glob` (under `shadcn` and `ts-morph`), all
  `devDependencies`.
- **Reachable?** Only with attacker-controlled glob patterns in developer tooling.
  The worst case is a crashed local build.
- **Where it applies:** both projects CI audits, the root project and
  `shadcn-preset/preset-app` (its own `package.json` carries the same exception).
  The preset app is a standalone Next app, not packaged with the desktop app. There
  `braces` comes in through `shadcn` (declared in `dependencies`, but a CLI) and
  `eslint-config-next` (`devDependencies`). I did not check that the Next server never
  calls `shadcn` at runtime; its exposure is assumed nil, not proven.
- **Review:** when `braces` publishes a fixed version (3.0.3 is the latest), or when
  `micromatch` moves to another matcher.

## Removed instead of excepted

- `node-forge` 1.4.0 (GHSA-86w9-cpqp-85rv, high, no fixed version): it was a production
  dependency through `sign-pdf-lib`, and nothing in the repository imports either.
  Both were removed, with `@types/node-forge` and `pdf-lib-incremental-save`, and the
  `node-forge` licence decision and notice went with them. If PDF signing is added
  later, choose and review a library then.
