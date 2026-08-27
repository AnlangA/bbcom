# Contributing to bbcom

Use Node `24.13.0`, pnpm `11.11.0`, and Rust `1.97.0` (the repository pins all
three). The local commit gate also requires ShellCheck, `cargo-llvm-cov`
`0.8.7`, and `cargo-audit` `0.22.2`; install them using the commands in the
README. Install exactly the lockfile with `pnpm install --frozen-lockfile`.
That install provisions the repository-pinned Node runtime for every project
script.

`pnpm install --frozen-lockfile` installs the versioned pre-commit hook. The
pre-commit hook runs the fast local gate (lint, format, architecture, build).
The pre-push hook runs the full gate including all frontend and
Rust tests plus browser E2E.

Before opening a pull request, run:

```sh
pnpm precommit:full
```

CI (`quality.yml`) runs static checks only: frontend lint/format/architecture/
build, plus Rust IPC-binding check, `cargo fmt --check`, and Clippy
`-D warnings`. Full test suites are enforced locally via the pre-push hook.

Stage the complete change before committing: the hook rejects unstaged or
non-ignored untracked files so its result always applies to the staged snapshot.

Keep serial I/O in the session runtime; Vue components must not own a port,
watcher, or write queue. Never add a renderer API that accepts a filesystem
path or an AI API key. New Tauri commands need a bounded DTO, window-label
check, and a test.

Do not update a dependency range opportunistically. Change an exact version,
refresh its lockfile, and include the local pre-commit evidence in the PR.

Please use Conventional Commits, keep TypeScript strict, keep Rust warnings
clean, and include focused tests for behavior changes. For persisted session
shape changes, bump `SESSION_STORAGE_VERSION`, add a migration step, and cover
legacy data with a regression test.

## Quality gate

The versioned Git pre-commit hook runs the fast local gate: toolchain pin
check, frontend lint/format, architecture, and frontend build. The pre-push
hook then runs frontend and Rust tests plus browser-mock E2E. Neither hook
currently enforces coverage percentages, `cargo-llvm-cov`, `cargo-audit`, or
frontend benchmarks. CI additionally runs architecture self-tests and CSS
token checks. To ensure it validates exactly the index Git will commit,
pre-commit rejects unstaged or non-ignored untracked files. Do not use
`--no-verify` to bypass it.

GitHub Actions `quality.yml` runs on pull requests and `master` pushes (and
is reused by the tagged release workflow). Tags matching `vX.Y.Z` start
`release.yml`, which repeats those static checks, then builds three-platform
installers and smoke-tests them. Windows and macOS platform signing is
enabled when the corresponding complete secret set is configured.

Tags matching `vX.Y.Z` produce a draft release containing Windows NSIS, macOS
arm64 DMG, Linux AppImage/deb packages, explicit signing-status manifests,
SHA-256 checksums, a CycloneDX SBOM, license inventories, Sigstore bundles, and
GitHub build provenance. No automatic updater is shipped in v0.5.0.

`pnpm install` installs the hook automatically. Before opening a pull request,
run the exact same gate manually if it has not already run during commit:

```bash
pnpm precommit
```

## IPC contracts

`crates/bbcom-contracts` is the source of truth for JSON values crossing the
Tauri IPC or window-event boundary. Rust owns field names, enum tags,
optionality, stable error codes, and resource limits. TypeScript is generated
from these Rust types with `ts-rs`; generated files must not be edited by hand.

The first contract version deliberately covers only:

- the existing checksum, file-grant, export, auto-log, AI, secure-settings,
  and AI-window boundaries;
- the shared error and captured-frame types; and
- the foundation types for workspace state, operations, serial-send results,
  and port leases.

Feature-specific workspace mutations belong to their later implementation
goals. They must be added here before either side starts using them.

Backend command modules import public request/response types and limits from
this crate. Frontend modules import the generated TypeScript. During the
incremental migration, an old local type may remain only until every caller
has switched; it must not become a second editable definition.

### Generate and check bindings

`crates/xtask` hosts repository-local maintenance commands. After changing
contract types, regenerate or verify the TypeScript IPC module:

```text
cargo run -p xtask -- bindings
cargo run -p xtask -- bindings --check
cargo run -p xtask -- bindings --output path/to/contracts.ts
```

The default target is `src/generated/ipc-contracts.ts`. Override it only for
diagnostics with `--output <path>`. `bindings --check` performs no writes. It
exits non-zero when the target is missing or differs and prints the generation
command needed to repair it. Check mode renders entirely in memory and only
reads the target; it never creates or rewrites a file.

## Release process

`package.json` is the version source of truth.

### Checklist

1. Land the release commit on `master` (version, changelog, and product changes).
2. Sync and verify versions:

   ```bash
   pnpm run version:sync
   pnpm run version:check
   ```

3. Confirm the changelog has a `## [X.Y.Z]` section for that version.
4. Push an exact SemVer tag from the `master` tip:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Only `vX.Y.Z` tags whose commit is an ancestor of protected `master` start the
release workflow.

### What the workflow produces

The release workflow:

1. Runs the shared quality gate (lint, format, architecture, frontend build,
   Rust fmt/Clippy).
2. Builds Windows NSIS, macOS DMG, and Linux AppImage/deb installers.
3. Runs installer install/launch/uninstall smoke checks.
4. Attaches SBOM, license inventories, checksums, Sigstore bundles (Linux), and
   provenance attestations.
5. Opens a **draft** GitHub release for manual review.

Windows Authenticode and Apple Developer ID signing/notarization are applied
when their complete secret sets are configured. Otherwise the draft still
publishes and the signing-status manifests mark those installers as unsigned.

Publish the draft only after reviewing smoke results and signing status.

No updater metadata is produced or published.
