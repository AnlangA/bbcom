# xtask

Repository-local maintenance commands. The initial command generates or checks
the TypeScript IPC module from `bbcom-contracts`:

```text
cargo run -p xtask -- bindings
cargo run -p xtask -- bindings --check
cargo run -p xtask -- bindings --output path/to/contracts.ts
```

`bindings --check` performs no writes. It exits non-zero when the target is
missing or differs and prints the generation command needed to repair it.
