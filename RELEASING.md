# Releasing bbcom

`package.json` is the version source of truth.

## Checklist

1. Land the release commit on `master` (version, changelog, and product changes).
2. Sync and verify versions:

   ```bash
   pnpm run version:sync
   pnpm run version:check
   ```

3. Confirm the changelog has a `## [X.Y.Z]` section for that version.
4. Push an exact SemVer tag from the `master` tip:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Only `vX.Y.Z` tags whose commit is an ancestor of protected `master` start the
release workflow.

## What the workflow produces

The release workflow:

1. Runs the shared quality gate (lint, architecture, frontend/Rust tests, browser E2E).
2. Builds Windows NSIS, macOS DMG, and Linux AppImage/deb installers.
3. Runs installer install/launch/uninstall smoke checks.
4. Attaches SBOM, license inventories, checksums, Sigstore bundles (Linux), and
   provenance attestations.
5. Opens a **draft** GitHub release for manual review.

Windows Authenticode and Apple Developer ID signing/notarization are applied
when their complete secret sets are configured. Otherwise the draft still
publishes and the signing-status manifests mark those installers as unsigned.

Publish the draft only after reviewing smoke results and signing status.

No updater metadata is produced or published.
