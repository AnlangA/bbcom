# bbcom-plugin-trust

Fail-closed native trust state machine for G42. It complements
`bbcom-plugin-repository`: that crate owns staging and activation; this crate
proves that bytes entering staging came from a configured repository and a
verified publisher.

## Fixed security boundary

- Multiple repositories are represented by separate `RepositoryEndpoint` and
  `TrustedRepository` instances. Repository IDs and canonical HTTPS origins
  are immutable after construction.
- `FetchPort` performs one request and never follows redirects. The core caps
  response sizes, permits at most five redirects, rejects relative/malformed
  locations, and rejects every cross-origin redirect.
- Root rotation is sequential and double-signed by the old and new root roles.
  Timestamp, snapshot, and targets metadata each require their independently
  configured role threshold; publishers may choose to reuse a key across roles.
- Every role is checked for expiry and monotonic version. Reusing a version
  with different canonical signed bytes is a freeze/equivocation failure.
  Timestamp-to-snapshot and snapshot-to-targets length, SHA-256, and version
  bindings prevent mix-and-match attacks.
- Stable packages require an Ed25519 publisher signature over the exact package
  bytes. The canonical identity returned upstream is
  `publisher:sha256-<lowercase SHA-256(public-key)>`. HTTPS and a package digest
  alone never create a verified publisher identity.
- Opening or refreshing a repository does not install, enable, or update a
  plugin. There is no scheduler and no concrete network client.

`CanonicalJsonDecoder` rejects duplicate and unknown fields, forbids floating
point metadata, validates the fixed TUF v1 shapes, and returns deterministic
canonical JSON bytes for the `signed` member. `RingEd25519Verifier` uses the
locked, reviewed `ring` Ed25519 implementation. `TrustedStateStore` atomically
stores the trusted root envelope and highest accepted role versions/hashes,
with private permissions and durable rollback/equivocation rejection.

This crate alone is **not** a production `VerifiedPackageProvider`. Until the
application supplies a private-network-aware fetcher, serializes access to each
state store, and wires the result through the native provider adapter, stable
repository installation must remain disabled.

## Main application integration

The workspace owner must add this crate to the root workspace and
`src-tauri/Cargo.toml`, then implement an adapter in
`src-tauri/src/plugins/repository/`:

1. load the pinned root and durable `RepositoryState` from native storage;
2. use `CanonicalJsonDecoder` and `RingEd25519Verifier`;
3. call `refresh_and_download` only for a user-requested stable package;
4. persist the new state atomically before returning package bytes;
5. translate `TrustedPackage` with `DownloadedPackage::from_verified_target`
   so the repository independently rechecks structure, size and digest, then
   expose it solely through `VerifiedPackageProvider`.

No renderer DTO accepts a URL, root key, package path, or publisher identity.
