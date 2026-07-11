# Reviewed security backports

These are minimal source copies of transitive crates required while the pinned
Tauri 2.11.5 Linux backend still resolves the affected release lines. Cargo
builds them through the two `[patch.crates-io]` entries in the repository-root
`Cargo.toml`.
They are source fixes, not cargo-audit exceptions; do not add advisory ignores
for their replaced advisories.

| Directory | Pinned upstream source | Remediation | Provenance |
| --- | --- | --- | --- |
| `glib-0.18.5` | crates.io `glib` 0.18.5, checksum `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5` | Backports the mutable out-parameter fix in `VariantStrIter::impl_get`. | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429), [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) |
| `phf-generator-0.8.0` | crates.io `phf_generator` 0.8.0, checksum `17367f0cc86f2d25802b2c26ee58a7b23faeccf78a396094c13dced0d0182526` | Pins its compatible random generator dependency to patched `rand` 0.8.6. | [RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097) |

The directories deliberately contain only each crate's build manifest, required
library source, and its license/copyright/readme material. Remove a backport
only after updating the Tauri dependency graph and verifying strict cargo-audit
again.
