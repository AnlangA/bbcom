# ADR-0004: Plugin trust and release gate

- Status: Accepted
- Date: 2026-08-13
- Decision owners: bbcom maintainers
- Supersedes: the repository-trust paragraph in ADR-0001

## Context

HTTPS plus a target digest detects transfer corruption but does not authenticate
a plugin publisher. The stable plugin surface also depends on native process
isolation whose guarantees differ by operating system. Treating either boundary
as optional would make the market appear safer than the installed application.

## Decisions

- Stable repository metadata uses the four TUF roles. Root rotation is
  sequential and double-threshold verified; timestamp, snapshot, and targets
  metadata are checked for threshold signatures, expiry, version rollback,
  freeze, and mix-and-match attacks.
- A stable package additionally requires an Ed25519 signature from the publisher
  key named by signed targets metadata. The verified identity is the lowercase
  SHA-256 fingerprint of that public key. HTTPS, repository metadata, or a
  package SHA-256 alone never produces a "verified publisher" label.
- Repository URLs are application-owned configuration. Renderer requests select
  only a catalog identifier. The native fetcher allows HTTPS, fixes each request
  to its already-reviewed public DNS results, disables implicit redirects, and
  gives every redirect back to the TUF trust core for same-origin validation.
- Updates are manual. Opening a project does not fetch, install, enable, or run a
  plugin. Protocol v1 has no plugin network capability.
- Plugin packages contain WebAssembly Components, manifests, and resources only.
  Repository-provided executables, native libraries, scripts, links, and ambient
  host access remain forbidden.
- The native plugin command surface remains fail-closed until its repository,
  authorization, broker, state-persistence, host, and platform-sandbox ports are
  all constructed. A missing port returns a stable unavailable result; no partial
  plugin behavior is exposed.
- Linux, macOS, and Windows each have an independent blocking G45 gate. A real
  reviewed Component must execute through the packaged sidecar and prove the
  typed permission, memory, trap, runaway-code, and oversized-IPC boundaries.
  Protocol v1 deliberately links no WASI/filesystem/network/process/device
  imports, so ambient OS denial is proven separately by the platform driver's
  native sandbox self-test and is never relabelled as a Component action. Both
  evidence scopes are required. A platform without either proof cannot enable
  plugins on that platform.
- The host runtime remains pinned to Wasmtime `47.0.2`. In particular, source
  compilation or an unsigned macOS run is not evidence that Cranelift executable
  memory works under the hardened runtime. G45-M must instantiate a real
  Component through the signed and notarized packaged sidecar. Broad executable
  memory entitlements are not added implicitly; changing that signing boundary
  requires a separate security ADR and a new native proof.
- G46 requires all three G45 gates. Until then, third-party marketplace entry
  points remain absent. First-party preview also remains disabled on any platform
  whose sandbox self-test fails.

## Consequences

- The application may ship plugin contracts, UI, sidecar code, and fail-closed
  commands before G46, but it must not describe that state as an available
  marketplace.
- Trusted metadata state and publisher identity are native private data and never
  project data. Projects retain unknown plugin payloads opaquely without
  installing or executing them.
- Any future automatic update, plugin network access, or additional publisher
  trust model requires a new ADR and protocol version.

## Rejected alternatives

- Calling HTTPS plus SHA-256 publisher authentication.
- Trust-on-first-use publisher keys supplied by the renderer.
- Enabling a plugin when its sandbox self-test is unavailable.
- Falling back to an unsigned stable package or an in-process native extension.
