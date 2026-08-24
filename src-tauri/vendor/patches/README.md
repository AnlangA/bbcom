# Reviewed dependency patches

These source copies temporarily replace pinned crates whose released behavior
is not safe for bbcom's generic serial data path. Cargo selects them through
the repository-root `[patch.crates-io]` table.

| Directory                         | Pinned upstream source                                                                                                                                  | Local correction                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tauri-plugin-serialplugin-3.0.0` | crates.io 3.0.0, checksum `2906d2f6ded5c4da55d9451be5fb720d5ec26c5aafbec998929ed33e437f2cf6`, tag `v3.0.0` (`4f04cea7a4243af1a539ba5ba45b50fec79c4309`) | Preserves the exact bytes read by the native `watch` path. Upstream 3.0.0 removed CR/LF and empty lines while classifying URCs, and could decode binary input lossily. URC notifications remain available as parallel events. |

The vendored directory contains only the crate manifest, build inputs, Rust
source, permissions, and license/readme material. Remove the patch after a
released upstream version preserves raw watch data and its replacement is
verified with bbcom's serial-plugin regression test.
