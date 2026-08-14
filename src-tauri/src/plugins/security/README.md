# Native plugin security persistence

`NativePluginSecurityStore` is the profile-scoped G43 persistence adapter. It
stores no grant in a `.bbcom` workspace or plugin-private directory and exposes
no path to the renderer.

## Integrity and crash policy

- Files live only below `<app-data>/plugin-security-v1`, with `0700`
  directories and `0600` files on Unix.
- Each canonical JSON record has an exact trusted copy in the OS keyring under
  service `com.bbcom.app.plugin-security.v1`. Reads require a byte-for-byte
  match. This supplies integrity protection using the existing keyring without
  inventing a checksum-based authentication scheme or adding a cryptographic
  dependency.
- Writes save the trusted copy, fsync a private staging file, atomically replace
  the destination, and fsync its directory. Deletes remove and fsync the file
  before clearing the keyring entry. Every interrupted intermediate state is a
  mismatch and therefore fails closed.
- A bounded non-cryptographic locator selects a filename/account only. Full
  record identity is rechecked after load, so a collision can cause denial but
  cannot transfer a grant.

## Integration API

The integration owner must add the already-workspace-local
`bbcom-plugin-broker` dependency to `src-tauri`, add `mod security;` to
`plugins/mod.rs`, and then:

1. Construct exactly one store with
   `NativePluginSecurityStore::open(app_data_root)` during native setup.
2. Inject a clone as the `bbcom_plugin_broker::AuthorizationStore` and as both
   `bbcom_plugin_manager::PluginAuthorizationStore` and
   `ArtifactRevocationStore`.
3. Let trusted approval UI call Broker `record_decision`; after the entire
   artifact review is accepted, call `record_reviewed_grant(key, exact_version,
   complete_reviewed_permissions, nonzero_revision)`.
4. Let the verified repository/revocation ingestion path call
   `set_artifact_revoked(&artifact, true)`. Only that trusted path may clear a
   revocation with `false`.
5. Revocation of an approval uses Broker `set_state(..., Missing)` and
   `clear_reviewed_grant` for the exact artifact.

The store binds every reusable decision to plugin ID, verified publisher-key
fingerprint, plugin major, workspace ID, and permission. Manager receipts are
additionally bound to the exact artifact version and complete reviewed set, so
new permissions and new artifact versions never inherit a receipt implicitly.
