# Contributing to bbcom

Use Node `24.13.0`, pnpm `11.11.0`, and Rust `1.97.0` (the repository pins all
three). The local commit gate also requires ShellCheck, `cargo-llvm-cov`
`0.8.7`, and `cargo-audit` `0.22.2`; install them using the commands in the
README. Install exactly the lockfile with `pnpm install --frozen-lockfile`.
That install provisions the repository-pinned Node runtime for every project
script.

`pnpm install --frozen-lockfile` installs the versioned pre-commit hook. The
pre-commit hook runs the fast local gate (lint, format, architecture, build,
bundle check). The pre-push hook runs the full gate including all frontend and
Rust tests plus browser E2E.

Before opening a pull request, run:

```sh
pnpm precommit:full
```

CI runs static checks only (lint, build, architecture boundaries, Rust fmt and
clippy). Full test suites are enforced locally via the pre-push hook.

Stage the complete change before committing: the hook rejects unstaged or
non-ignored untracked files so its result always applies to the staged snapshot.

Keep serial I/O in the session runtime; Vue components must not own a port,
watcher, or write queue. Never add a renderer API that accepts a filesystem
path or an AI API key. New Tauri commands need a bounded DTO, window-label
check, and a test.

Do not update a dependency range opportunistically. Change an exact version,
refresh its lockfile, and include the local pre-commit evidence in the PR.
