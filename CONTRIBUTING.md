# Contributing to bbcom

Use Node `22.23.1`, pnpm `11.5.3`, and Rust `1.88.0` (the repository pins all
three). Install exactly the lockfile with `pnpm install --frozen-lockfile`.

Before opening a pull request, run:

```sh
pnpm check
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
```

Keep serial I/O in the session runtime; Vue components must not own a port,
watcher, or write queue. Never add a renderer API that accepts a filesystem
path or an AI API key. New Tauri commands need a bounded DTO, window-label
check, and a test.

Do not update a dependency range opportunistically. Change an exact version,
refresh its lockfile, and include the audit/test evidence in the PR.
