# Reviewed security backports

These are minimal source copies of transitive crates required while the pinned
Tauri 2.11.5 Linux backend still resolves the affected release line. Cargo
builds it through the `[patch.crates-io]` entry in the repository-root
`Cargo.toml`.
They are source fixes, not cargo-audit exceptions; do not add advisory ignores
for their replaced advisories.

| Directory | Pinned upstream source | Remediation | Provenance |
| --- | --- | --- | --- |
| `glib-0.18.5` | crates.io `glib` 0.18.5, checksum `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5` | Backports the mutable out-parameter fix in `VariantStrIter::impl_get`. | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429), [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) |

The directory deliberately contains only the crate's build manifest, required
library source, and its license/copyright/readme material. Remove the backport
only after updating the Tauri dependency graph and verifying strict cargo-audit
again.
