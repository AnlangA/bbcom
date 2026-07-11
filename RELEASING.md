# Releasing bbcom

`package.json` is the version source. Run `pnpm run version:sync`, then
`pnpm run version:check`, and finally `pnpm precommit`; Cargo and Tauri
configuration must match it and the local quality gate must pass before tagging.

Only an exact `vX.Y.Z` tag whose commit is on protected `master` can start the
release workflow. It creates a draft release after all three installer builds,
checksums, SBOM, license inventories, Sigstore bundles, and provenance
attestations are present. Windows Authenticode signing and Apple Developer ID
signing/notarization are applied when their complete secret sets are configured;
otherwise the draft and attached status manifests explicitly mark those
installers unsigned. Publish the draft only after the platform smoke tests and
signing-status manifests have been reviewed.

No updater metadata is produced or published.
