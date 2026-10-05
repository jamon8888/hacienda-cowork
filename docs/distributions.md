# Distribution and release builds

Interpreter Workstation has one open application, one canonical repository, and
one public release implementation. Distribution profiles change public client
configuration and package identity; they do not unlock client capabilities or
replace application code.

## Shipped profiles

### Community source build

The committed `product.json` is the safe default for contributors, downstream
packagers, and organizations:

- no hosted account provider or hosted API
- no telemetry or crash-reporting endpoint
- no vendor update feed or external document-engine source
- direct provider, local-model, local tools, skills, OIX, and CUA support

This is a complete client, not a limited edition. A client feature that exists
only in another profile is an architecture failure.

### Official build

`distribution/product.official.json` is the checked-in profile used for
official Interpreter releases. It adds the public client coordinates for
optional Interpreter-hosted services, the official update feed, and an optional
compatible document engine. Users can still use direct providers or local
models without signing in.

The official profile contains no server authority. Supabase anonymous keys,
Sentry DSNs, service URLs, and update-feed coordinates are visible in every
installed client and are therefore public configuration. Authentication,
authorization, rate limits, billing, and data access must be enforced by the
services, never by hiding a client value.

Build it with:

```bash
pnpm run build:official
pnpm run package:official
```

The official binary is not defined merely by running that command locally. An
official release is a build of protected `main` produced by the checked-in
`Official release` workflow, approved through the `production-release`
environment, signed and notarized with project credentials, accompanied by
checksums and an SPDX SBOM, and covered by GitHub artifact attestations. See
[Official releases](releases.md).

### Internal build

The internal profile uses the same official client configuration and source,
but a separate package name and application identifier so it can be installed
beside production. It is an unsigned review artifact, not a private feature
edition.

```bash
pnpm run package:internal:mac-arm64
pnpm run release:verify:internal
```

The `Internal release` workflow produces an unsigned review build under the
protected `internal-release` environment. It is never an official release and
must not publish to the production update channel.

## Secret boundary

GitHub protected environments and repository secrets should hold only values
whose disclosure grants authority, including:

- signing certificates and passwords
- Apple notarization credentials
- update-storage write credentials
- private-submodule checkout tokens while any release dependency is private
- a scoped token that can write internal artifacts to the designated private
  release repository after this source repository becomes public

Do not put service-role keys, model-provider keys, refresh tokens, or customer
credentials in a product profile. Service secrets belong in the hosted
service's secret manager. Values embedded in a desktop binary cannot be kept
secret even if CI supplied them from a GitHub secret.

## Custom and enterprise profiles

An organization can create a small JSON overlay with its service endpoint,
public auth-client settings, managed update channel, and optional document
engine:

```json
{
  "distribution": {
    "id": "example-enterprise",
    "hostedApiBaseUrl": "https://ai.example.com",
    "auth": {
      "provider": "supabase",
      "url": "https://auth.example.com",
      "anonKey": "public-client-configuration",
      "storageKey": "example-auth-token"
    },
    "telemetry": {
      "sentryDsn": "",
      "eventsUrl": "",
      "eventsAnonKey": ""
    },
    "updates": {
      "provider": "none",
      "bucket": "",
      "endpoint": "",
      "path": "",
      "internalPath": "",
      "region": "",
      "acl": ""
    }
  }
}
```

Build without permanently modifying `product.json`:

```bash
node scripts/with-distribution-config.mjs ./product.example.json -- pnpm run build
```

The wrapper takes an exclusive lock and restores the original product file even
when the child command fails. A private operations repository may retain
internal binary artifacts, organization-specific configuration, credentials,
and deployment policy, or trigger these public workflows. It must not become a
second application or the owner of canonical release logic.

## Vertical packs

A vertical pack adapts the assistant to a regulated profession (law, medicine,
accounting…) without forking application behaviour. It is a folder:

```
my-pack/
  pack.json
  identity.md       # who the assistant is, for whom, in what setting
  deontology.md     # the profession's rules (secrecy, sources, irreversible acts)
  skills/<name>/SKILL.md   # optional
```

```json
{
  "id": "droit-des-affaires",
  "version": "1.0.0",
  "name": "Droit des affaires",
  "requiresSafe": true,
  "identityFile": "identity.md",
  "deontologyFile": "deontology.md",
  "suggestionPills": [{ "label": "Relire un contrat", "prompt": "Relis ce contrat." }]
}
```

`id` uses lowercase letters, digits and dashes. Files named by the manifest
must sit inside the pack folder (no `..`, no link leaving it) and stay under
16 000 characters. A pack that fails validation is listed with its reason and
never used; it cannot stop the app or a turn from starting.

What a pack does: its identity and rules are added to the prompt as a
`Practice pack` section, after the core prompt and before the user's own custom
instructions, and its `skills/` folder is registered with the runtime. The text
is not run through the Safe redaction (it is written by the firm and holds no
client data). Its `suggestionPills` appear on the new-tab screen as a first category named after the pack; picking one fills the composer with its prompt. Without pills nothing is added.

What a pack never does: unlock a client feature, change a
permission, or reach a hosted service. Skills are read-only to the agent in a
Safe workspace like any other skill.

`requires.app` (optional, `">=MAJOR[.MINOR[.PATCH]]"`) is the oldest app version
the pack works with. An older app lists the pack with the reason ("needs
Interpreter 0.2.0 or later") and never uses it; a newer app loads it.

**Working on a pack on its own.** A pack lives in its own repository and does
not need an app build to change:

- `pnpm run pack:validate <pack folder> [--app-version 1.2.3]` runs the app's
  loader plus author checks: every `skills/<name>/SKILL.md` has a `name` and a
  `description`, and in a pack that `requiresSafe`, warns about skills that never
  mention `safe/`, `_drafts` or `interpreter_safe_export`. It exits 1 on errors,
  so the pack's CI can run it against the app tag it targets (bun only, no
  `pnpm install` needed).
- To try edits live, replace the installed copy with a link to your checkout:
  `ln -s ~/src/my-pack "<app data>/packs/<id>"`. The pack is read again at every
  turn, so a new message picks up changed rules and skills without a restart.

**Installing.** Anyone can install a pack from Settings > General > Privacy >
Professional pack. It is copied to `<app data>/packs/<id>/`; replacing another
version asks first. The user's pick is stored as `activeVerticalPackId`.

**Shipping one in a distribution.** Package the folder under `resources/` with
`extraResources` and name it in the overlay:

```json
{ "distribution": { "verticalPack": { "id": "droit-des-affaires", "resourcePath": "vertical-pack" } } }
```

`resourcePath` is relative to the packaged `resources/` folder and may not
leave it. With no pick from the user, the distribution's pack is the active
one; the user can switch to another or go back to it. The community profile
ships none.

## Product repositories

A vertical product (for example a build for law firms) is three things with
their own lifecycles, never a copy of this repository:

| Part | Lives in | Holds |
|---|---|---|
| Engine | this repository | the application, generic (Safe, packs, export) |
| Pack | its own repository | `pack.json`, identity, rules, skills |
| Product | a thin private repository | product overlay, `electron-builder` profile that `extends` this one, branding, pinned engine and pack versions, signing secrets, release trigger |

The product repository holds no application code. Its CI checks out the
engine and the pack at their pinned tags, puts the pack under `resources/`,
and builds with `scripts/with-distribution-config.mjs`. A capability that
needs application code is generic and belongs here; text, skills and settings
belong in the pack; name, versions and release belong in the product.

To keep this fork close to Interpreter Workstation, track it as `upstream`
(`git remote add upstream https://github.com/openinterpreter/interpreter-workstation`)
and merge it regularly; keep Hacienda changes in their own modules with short
hooks into upstream files.

## Privacy contract

The community profile has no vendor telemetry destination. Providing a
telemetry endpoint in another profile does not grant consent: JavaScript events,
analytics, and native crash reports remain disabled unless the user explicitly
opts in. If consent state cannot be read, reporting fails closed.
