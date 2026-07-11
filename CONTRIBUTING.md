# Contributing to bbcom

Use Node `24.13.0`, pnpm `11.11.0`, and Rust `1.97.0` (the repository pins all
three). The local commit gate also requires ShellCheck, `cargo-llvm-cov`
`0.8.7`, and `cargo-audit` `0.22.2`; install them using the commands in the
README. Install exactly the lockfile with `pnpm install --frozen-lockfile`.

`pnpm install --frozen-lockfile` installs the versioned pre-commit hook. The
hook runs the complete local quality gate for every commit. Before opening a
pull request, run the same command manually if needed:

```sh
pnpm precommit
```

Stage the complete change before committing: the hook rejects unstaged or
non-ignored untracked files so its result always applies to the staged snapshot.

Keep serial I/O in the session runtime; Vue components must not own a port,
watcher, or write queue. Never add a renderer API that accepts a filesystem
path or an AI API key. New Tauri commands need a bounded DTO, window-label
check, and a test.

Do not update a dependency range opportunistically. Change an exact version,
refresh its lockfile, and include the local pre-commit evidence in the PR.
