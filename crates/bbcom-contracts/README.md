# bbcom-contracts

This crate is the source of truth for JSON values crossing the Tauri IPC or
window-event boundary. Rust owns field names, enum tags, optionality, stable
error codes, and resource limits. TypeScript is generated from these Rust
types with `ts-rs`; generated files must not be edited by hand.

The first contract version deliberately covers only:

- the existing checksum, file-grant, export, auto-log, AI, secure-settings,
  and AI-window boundaries;
- the shared error and captured-frame types; and
- the foundation types for workspace state, operations, serial-send results,
  and port leases.

Feature-specific workspace mutations belong to their later implementation
goals. They must be added here before either side starts using them.

## Generate and check bindings

After this crate and `crates/xtask` are added to the root Cargo workspace:

```text
cargo run -p xtask -- bindings
cargo run -p xtask -- bindings --check
```

The default target is `src/generated/ipc-contracts.ts`. Override it only for
diagnostics with `--output <path>`. Check mode renders entirely in memory and
only reads the target; it never creates or rewrites a file.

## Integration rule

Backend command modules import public request/response types and limits from
this crate. Frontend modules import the generated TypeScript. During the
incremental migration, an old local type may remain only until every caller
has switched; it must not become a second editable definition.
