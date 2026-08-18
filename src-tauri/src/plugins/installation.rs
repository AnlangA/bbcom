use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use bbcom_plugin_manager::{
    ArtifactSlot, HostFailure, InstallationFailure, InstallationPort, ManualPackageRequest,
    PluginArtifact, PluginArtifactSource, PluginSourceKind, PreparationKind, PreparationToken,
    PreparedInstallation,
};
use bbcom_plugin_repository::{
    DownloadedPackage, LOCAL_INSTALL_ORIGIN, PluginInstaller, PreparedInstallationKind,
    PreparedPluginInstallation,
};
use sha2::{Digest, Sha256};

use super::{ArtifactPathResolver, ResolvedPluginArtifact};

/// A verified package staged outside the active installation.
///
/// The backend owns all filesystem paths. They are deliberately absent here so
/// neither renderer-facing DTOs nor manager snapshots can disclose them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedRepositoryArtifact {
    pub token: PreparationToken,
    pub artifact: PluginArtifact,
    pub kind: PreparationKind,
}

/// Narrow native boundary between the manager and a durable repository.
///
/// Production uses [`NativeRepositoryStagingBackend`]. The trait remains small
/// so manager tests can use an in-memory fake without weakening the native
/// implementation's journal and path-resolution requirements.
pub trait RepositoryStagingBackend {
    type Error;

    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error>;

    fn prepare_rollback(
        &mut self,
        current: &PluginArtifact,
    ) -> Result<Option<PreparedRepositoryArtifact>, Self::Error>;

    /// Atomically activates the package and its staged private data copy.
    fn commit(
        &mut self,
        prepared: &PreparedRepositoryArtifact,
    ) -> Result<PluginArtifact, Self::Error>;

    fn discard(&mut self, prepared: &PreparedRepositoryArtifact) -> Result<(), Self::Error>;
    /// Development-mode local staging (see the manager port doc).
    fn prepare_local(
        &mut self,
        package_root: &std::path::Path,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error>;

    /// Durable installation removal (see the manager port doc).
    fn remove_installed(&mut self, artifact: &PluginArtifact) -> Result<(), Self::Error>;
}

/// Supplies a package only after the repository index, HTTPS origin, declared
/// length and SHA-256 checks have succeeded. Implementations own repository
/// configuration; renderer input never contains a URL or filesystem path.
pub trait VerifiedPackageProvider {
    type Error;

    fn download_verified(
        &mut self,
        request: &ManualPackageRequest,
    ) -> Result<DownloadedPackage, Self::Error>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRepositoryError {
    PackageSource,
    Repository,
    Descriptor,
}

impl fmt::Display for NativeRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PackageSource => formatter.write_str("verified plugin package is unavailable"),
            Self::Repository => formatter.write_str("plugin repository transaction failed"),
            Self::Descriptor => formatter.write_str("plugin repository descriptor mismatch"),
        }
    }
}

impl std::error::Error for NativeRepositoryError {}

/// Production repository adapter used by `PluginService`.
///
/// The source can select a configured HTTPS repository by `repository_id`, but
/// the installer is the sole authority for staging tokens and all native paths.
pub struct NativeRepositoryStagingBackend<S> {
    installer: Arc<PluginInstaller>,
    source: S,
}

impl<S> NativeRepositoryStagingBackend<S> {
    /// Every durable active installation mapped to manager artifacts with
    /// permissions re-read from each active package's manifest.
    pub fn active_installed_artifacts(&self) -> Vec<PluginArtifact> {
        self.installer
            .active_installations()
            .iter()
            .filter_map(|active| {
                let permissions = manifest_permissions(&active.package_directory).ok()?;
                map_active_artifact(active, &permissions).ok()
            })
            .collect()
    }
}

fn manifest_permissions(
    package_directory: &std::path::Path,
) -> std::result::Result<
    std::collections::BTreeSet<bbcom_plugin_contracts::Permission>,
    NativeRepositoryError,
> {
    let manifest_path = package_directory.join("plugin.toml");
    let text =
        std::fs::read_to_string(manifest_path).map_err(|_| NativeRepositoryError::PackageSource)?;
    let manifest = bbcom_plugin_contracts::PluginManifest::parse(&text)
        .map_err(|_| NativeRepositoryError::Descriptor)?;
    Ok(manifest.permissions().into_iter().flatten().collect())
}

impl<S> NativeRepositoryStagingBackend<S> {
    #[must_use]
    pub fn new(installer: Arc<PluginInstaller>, source: S) -> Self {
        Self { installer, source }
    }

    #[must_use]
    pub fn installer(&self) -> &Arc<PluginInstaller> {
        &self.installer
    }

    #[must_use]
    pub fn source(&self) -> &S {
        &self.source
    }

    pub fn source_mut(&mut self) -> &mut S {
        &mut self.source
    }
}

impl<S: VerifiedPackageProvider> RepositoryStagingBackend for NativeRepositoryStagingBackend<S> {
    type Error = NativeRepositoryError;

    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error> {
        let download = self
            .source
            .download_verified(request)
            .map_err(|_| NativeRepositoryError::PackageSource)?;
        if download.plugin_id() != request.plugin_id
            || download.package().version != request.version
        {
            return Err(NativeRepositoryError::Descriptor);
        }
        let prepared = self
            .installer
            .prepare_install(&download)
            .map_err(|_| NativeRepositoryError::Repository)?;
        let expected = if current.is_some() {
            PreparedInstallationKind::ManualUpgrade
        } else {
            PreparedInstallationKind::InitialInstall
        };
        if prepared.kind() != expected
            || current.is_some_and(|artifact| artifact.plugin_id != prepared.plugin_id())
        {
            let _ = self.installer.discard_prepared(&prepared);
            return Err(NativeRepositoryError::Descriptor);
        }
        map_repository_prepared(&prepared)
    }

    fn prepare_rollback(
        &mut self,
        current: &PluginArtifact,
    ) -> Result<Option<PreparedRepositoryArtifact>, Self::Error> {
        self.installer
            .prepare_rollback(&current.plugin_id, &current.version)
            .map_err(|_| NativeRepositoryError::Repository)?
            .map(|prepared| map_repository_prepared(&prepared))
            .transpose()
    }

    fn commit(
        &mut self,
        prepared: &PreparedRepositoryArtifact,
    ) -> Result<PluginArtifact, Self::Error> {
        let repository_prepared = self.resolve_exact(prepared)?;
        let active = self
            .installer
            .commit_prepared(&repository_prepared)
            .map_err(|_| NativeRepositoryError::Repository)?;
        let artifact = map_active_artifact(&active, repository_prepared.requested_permissions())?;
        if artifact != prepared.artifact {
            return Err(NativeRepositoryError::Descriptor);
        }
        Ok(artifact)
    }

    fn discard(&mut self, prepared: &PreparedRepositoryArtifact) -> Result<(), Self::Error> {
        let repository_prepared = self.resolve_exact(prepared)?;
        self.installer
            .discard_prepared(&repository_prepared)
            .map_err(|_| NativeRepositoryError::Repository)
    }

    fn prepare_local(
        &mut self,
        package_root: &std::path::Path,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error> {
        let prepared = self
            .installer
            .prepare_local_install(package_root)
            .map_err(|_| NativeRepositoryError::PackageSource)?;
        let expected = if current.is_some() {
            PreparedInstallationKind::ManualUpgrade
        } else {
            PreparedInstallationKind::InitialInstall
        };
        if prepared.kind() != expected {
            let _ = self.installer.discard_prepared(&prepared);
            return Err(NativeRepositoryError::Descriptor);
        }
        map_repository_prepared(&prepared)
    }

    fn remove_installed(&mut self, artifact: &PluginArtifact) -> Result<(), Self::Error> {
        self.installer
            .remove_installation(&artifact.plugin_id)
            .map_err(|_| NativeRepositoryError::Repository)
    }
}

impl<S> NativeRepositoryStagingBackend<S> {
    fn resolve_exact(
        &self,
        prepared: &PreparedRepositoryArtifact,
    ) -> Result<PreparedPluginInstallation, NativeRepositoryError> {
        let repository_prepared = self
            .installer
            .prepared_installation(prepared.token.as_str())
            .map_err(|_| NativeRepositoryError::Repository)?;
        let mapped = map_repository_prepared(&repository_prepared)?;
        if mapped != *prepared {
            return Err(NativeRepositoryError::Descriptor);
        }
        Ok(repository_prepared)
    }
}

/// Host-side resolver sharing the same private installer authority as the
/// installation port. It accepts only durable active state or a prepared token.
#[derive(Clone)]
pub struct RepositoryArtifactPathResolver {
    installer: Arc<PluginInstaller>,
}

impl RepositoryArtifactPathResolver {
    #[must_use]
    pub fn new(installer: Arc<PluginInstaller>) -> Self {
        Self { installer }
    }
}

impl ArtifactPathResolver for RepositoryArtifactPathResolver {
    fn resolve(
        &self,
        plugin_id: &str,
        version: &str,
        slot: &ArtifactSlot,
    ) -> Result<ResolvedPluginArtifact, HostFailure> {
        let path = match slot {
            ArtifactSlot::Active => self
                .installer
                .active_package_directory(plugin_id, version)
                .map_err(|_| HostFailure::Launch)?,
            ArtifactSlot::Prepared(token) => {
                let prepared = self
                    .installer
                    .prepared_installation(token.as_str())
                    .map_err(|_| HostFailure::Launch)?;
                if prepared.plugin_id() != plugin_id || prepared.version() != version {
                    return Err(HostFailure::Launch);
                }
                self.installer
                    .prepared_package_directory(&prepared)
                    .map_err(|_| HostFailure::Launch)?
            }
        };
        Ok(ResolvedPluginArtifact::new(path))
    }
}

fn map_repository_prepared(
    prepared: &PreparedPluginInstallation,
) -> Result<PreparedRepositoryArtifact, NativeRepositoryError> {
    let token =
        PreparationToken::new(prepared.token()).map_err(|_| NativeRepositoryError::Descriptor)?;
    let artifact = PluginArtifact::new(
        prepared.plugin_id(),
        prepared.version(),
        prepared.package_sha256(),
        prepared.component_sha256(),
        artifact_source(prepared.repository_origin()),
        prepared.requested_permissions().iter().copied(),
    )
    .map_err(|_| NativeRepositoryError::Descriptor)?;
    let kind = match prepared.kind() {
        PreparedInstallationKind::InitialInstall => PreparationKind::InitialInstall,
        PreparedInstallationKind::ManualUpgrade => PreparationKind::ManualUpgrade,
        PreparedInstallationKind::Rollback => PreparationKind::Rollback,
    };
    Ok(PreparedRepositoryArtifact {
        token,
        artifact,
        kind,
    })
}

fn map_active_artifact(
    active: &bbcom_plugin_repository::ActiveInstallation,
    permissions: &std::collections::BTreeSet<bbcom_plugin_contracts::Permission>,
) -> Result<PluginArtifact, NativeRepositoryError> {
    PluginArtifact::new(
        &active.plugin_id,
        &active.version,
        &active.package_sha256,
        &active.component_sha256,
        artifact_source(&active.repository_origin),
        permissions.iter().copied(),
    )
    .map_err(|_| NativeRepositoryError::Descriptor)
}

/// Adapts a repository-owned durable staging backend to the manager contract.
///
/// Tokens are single-use and descriptors are compared exactly at commit. A
/// forged, stale, or replayed `PreparedInstallation` is rejected before the
/// backend can touch the active installation.
pub struct RepositoryInstallationPort<B> {
    backend: B,
    prepared: BTreeMap<PreparationToken, PreparedRepositoryArtifact>,
}

impl<B> RepositoryInstallationPort<B> {
    #[must_use]
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            prepared: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }
}

impl<B: RepositoryStagingBackend> InstallationPort for RepositoryInstallationPort<B> {
    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedInstallation, InstallationFailure> {
        let staged = self
            .backend
            .prepare_manual(request, current)
            .map_err(|_| InstallationFailure)?;
        let expected_kind = if current.is_some() {
            PreparationKind::ManualUpgrade
        } else {
            PreparationKind::InitialInstall
        };
        if self.prepared.contains_key(&staged.token) {
            // A duplicate token may designate the already tracked staging
            // directory, so discarding it here could destroy another pending
            // transaction. Reject and leave recovery to the backend journal.
            return Err(InstallationFailure);
        }
        if staged.kind != expected_kind
            || staged.artifact.plugin_id != request.plugin_id
            || staged.artifact.version != request.version
        {
            let _ = self.backend.discard(&staged);
            return Err(InstallationFailure);
        }
        let descriptor = match PreparedInstallation::new(
            staged.token.clone(),
            staged.artifact.clone(),
            staged.kind,
        ) {
            Ok(descriptor) => descriptor,
            Err(_) => {
                let _ = self.backend.discard(&staged);
                return Err(InstallationFailure);
            }
        };
        self.prepared.insert(staged.token.clone(), staged);
        Ok(descriptor)
    }

    fn prepare_rollback(
        &mut self,
        current: &PluginArtifact,
    ) -> Result<Option<PreparedInstallation>, InstallationFailure> {
        let Some(staged) = self
            .backend
            .prepare_rollback(current)
            .map_err(|_| InstallationFailure)?
        else {
            return Ok(None);
        };
        if self.prepared.contains_key(&staged.token) {
            return Err(InstallationFailure);
        }
        if staged.kind != PreparationKind::Rollback
            || staged.artifact.plugin_id != current.plugin_id
            || staged.artifact.version == current.version
        {
            let _ = self.backend.discard(&staged);
            return Err(InstallationFailure);
        }
        let descriptor = match PreparedInstallation::new(
            staged.token.clone(),
            staged.artifact.clone(),
            staged.kind,
        ) {
            Ok(descriptor) => descriptor,
            Err(_) => {
                let _ = self.backend.discard(&staged);
                return Err(InstallationFailure);
            }
        };
        self.prepared.insert(staged.token.clone(), staged);
        Ok(Some(descriptor))
    }

    fn commit(
        &mut self,
        prepared: &PreparedInstallation,
    ) -> Result<PluginArtifact, InstallationFailure> {
        let staged = self
            .prepared
            .get(&prepared.token)
            .filter(|staged| staged.artifact == prepared.artifact && staged.kind == prepared.kind)
            .cloned()
            .ok_or(InstallationFailure)?;
        let activated = self
            .backend
            .commit(&staged)
            .map_err(|_| InstallationFailure)?;
        if activated != prepared.artifact {
            return Err(InstallationFailure);
        }
        self.prepared.remove(&prepared.token);
        Ok(activated)
    }

    fn prepare_local(
        &mut self,
        package_root: &std::path::Path,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedInstallation, InstallationFailure> {
        let staged = self
            .backend
            .prepare_local(package_root, current)
            .map_err(|_| InstallationFailure)?;
        let expected_kind = if current.is_some() {
            PreparationKind::ManualUpgrade
        } else {
            PreparationKind::InitialInstall
        };
        if self.prepared.contains_key(&staged.token) {
            return Err(InstallationFailure);
        }
        if staged.kind != expected_kind {
            let _ = self.backend.discard(&staged);
            return Err(InstallationFailure);
        }
        let descriptor = match PreparedInstallation::new(
            staged.token.clone(),
            staged.artifact.clone(),
            staged.kind,
        ) {
            Ok(descriptor) => descriptor,
            Err(_) => {
                let _ = self.backend.discard(&staged);
                return Err(InstallationFailure);
            }
        };
        self.prepared.insert(staged.token.clone(), staged);
        Ok(descriptor)
    }

    fn remove_installed(&mut self, artifact: &PluginArtifact) -> Result<(), InstallationFailure> {
        self.backend
            .remove_installed(artifact)
            .map_err(|_| InstallationFailure)
    }

    fn discard(&mut self, prepared: &PreparedInstallation) -> Result<(), InstallationFailure> {
        let staged = self
            .prepared
            .get(&prepared.token)
            .filter(|staged| staged.artifact == prepared.artifact && staged.kind == prepared.kind)
            .cloned()
            .ok_or(InstallationFailure)?;
        self.backend
            .discard(&staged)
            .map_err(|_| InstallationFailure)?;
        self.prepared.remove(&prepared.token);
        Ok(())
    }
}

pub(crate) fn artifact_source(origin: &str) -> PluginArtifactSource {
    if origin == LOCAL_INSTALL_ORIGIN {
        return PluginArtifactSource {
            source_id: "local".to_owned(),
            kind: PluginSourceKind::LocalPackage,
        };
    }
    PluginArtifactSource {
        source_id: format!("https-{:x}", Sha256::digest(origin.as_bytes())),
        kind: PluginSourceKind::Https,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use bbcom_plugin_contracts::Permission;

    use super::*;

    fn artifact(version: &str) -> PluginArtifact {
        PluginArtifact::new(
            "dev.bbcom.coverage",
            version,
            "a".repeat(64),
            "b".repeat(64),
            PluginArtifactSource {
                source_id: "test".to_owned(),
                kind: PluginSourceKind::Https,
            },
            [Permission::SessionMetadataRead],
        )
        .unwrap()
    }

    fn staged(token: &str, version: &str, kind: PreparationKind) -> PreparedRepositoryArtifact {
        PreparedRepositoryArtifact {
            token: PreparationToken::new(token).unwrap(),
            artifact: artifact(version),
            kind,
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        manual: VecDeque<PreparedRepositoryArtifact>,
        rollback: VecDeque<Option<PreparedRepositoryArtifact>>,
        committed: Vec<String>,
        discarded: Vec<String>,
        activation_override: Option<PluginArtifact>,
    }

    impl RepositoryStagingBackend for FakeBackend {
        type Error = ();

        fn prepare_manual(
            &mut self,
            _request: &ManualPackageRequest,
            _current: Option<&PluginArtifact>,
        ) -> Result<PreparedRepositoryArtifact, Self::Error> {
            self.manual.pop_front().ok_or(())
        }

        fn prepare_rollback(
            &mut self,
            _current: &PluginArtifact,
        ) -> Result<Option<PreparedRepositoryArtifact>, Self::Error> {
            self.rollback.pop_front().ok_or(())
        }

        fn commit(
            &mut self,
            prepared: &PreparedRepositoryArtifact,
        ) -> Result<PluginArtifact, Self::Error> {
            self.committed.push(prepared.token.as_str().to_owned());
            Ok(self
                .activation_override
                .take()
                .unwrap_or_else(|| prepared.artifact.clone()))
        }

        fn discard(&mut self, prepared: &PreparedRepositoryArtifact) -> Result<(), Self::Error> {
            self.discarded.push(prepared.token.as_str().to_owned());
            Ok(())
        }

        fn prepare_local(
            &mut self,
            _package_root: &std::path::Path,
            _current: Option<&PluginArtifact>,
        ) -> std::result::Result<PreparedRepositoryArtifact, Self::Error> {
            Err(())
        }

        fn remove_installed(
            &mut self,
            _artifact: &PluginArtifact,
        ) -> std::result::Result<(), Self::Error> {
            Err(())
        }
    }

    #[test]
    fn repository_port_requires_exact_single_use_descriptors() {
        let request =
            ManualPackageRequest::new("first-party", "dev.bbcom.coverage", "1.0.0").unwrap();
        let mut backend = FakeBackend::default();
        backend.manual.push_back(staged(
            "initial-token",
            "1.0.0",
            PreparationKind::InitialInstall,
        ));
        let mut port = RepositoryInstallationPort::new(backend);
        assert!(port.backend().committed.is_empty());
        port.backend_mut().discarded.clear();

        let prepared = port.prepare_manual(&request, None).unwrap();
        assert_eq!(port.commit(&prepared).unwrap(), artifact("1.0.0"));
        assert!(
            port.commit(&prepared).is_err(),
            "a committed token is consumed"
        );

        let current = artifact("2.0.0");
        port.backend_mut().rollback.push_back(Some(staged(
            "rollback-token",
            "1.0.0",
            PreparationKind::Rollback,
        )));
        let rollback = port.prepare_rollback(&current).unwrap().unwrap();
        port.discard(&rollback).unwrap();
        assert_eq!(port.backend().discarded, ["rollback-token"]);
        assert!(
            port.discard(&rollback).is_err(),
            "a discarded token is consumed"
        );
        port.backend_mut().rollback.push_back(None);
        assert!(port.prepare_rollback(&current).unwrap().is_none());
    }

    #[test]
    fn repository_port_discards_mismatches_and_rejects_duplicate_tokens() {
        let request =
            ManualPackageRequest::new("first-party", "dev.bbcom.coverage", "1.0.0").unwrap();
        let duplicate = staged("duplicate-token", "1.0.0", PreparationKind::InitialInstall);
        let mut backend = FakeBackend::default();
        backend.manual.push_back(duplicate.clone());
        backend.manual.push_back(duplicate);
        backend.manual.push_back(staged(
            "wrong-version",
            "2.0.0",
            PreparationKind::InitialInstall,
        ));
        let mut port = RepositoryInstallationPort::new(backend);
        let first = port.prepare_manual(&request, None).unwrap();
        assert!(port.prepare_manual(&request, None).is_err());
        assert!(port.prepare_manual(&request, None).is_err());
        assert_eq!(port.backend().discarded, ["wrong-version"]);

        port.backend_mut().activation_override = Some(artifact("2.0.0"));
        assert!(port.commit(&first).is_err());
    }

    #[test]
    fn native_repository_accessors_and_public_errors_are_bounded() {
        struct UnusedSource(u8);
        impl VerifiedPackageProvider for UnusedSource {
            type Error = ();

            fn download_verified(
                &mut self,
                _request: &ManualPackageRequest,
            ) -> Result<DownloadedPackage, Self::Error> {
                Err(())
            }
        }

        let temporary = tempfile::tempdir().unwrap();
        let packages = temporary.path().join("packages");
        let data = temporary.path().join("data");
        std::fs::create_dir_all(&packages).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let installer = Arc::new(PluginInstaller::new(&packages, &data).unwrap());
        let mut backend =
            NativeRepositoryStagingBackend::new(Arc::clone(&installer), UnusedSource(1));
        assert!(Arc::ptr_eq(backend.installer(), &installer));
        assert_eq!(backend.source().0, 1);
        backend.source_mut().0 = 2;
        assert_eq!(backend.source().0, 2);

        let resolver = RepositoryArtifactPathResolver::new(installer);
        assert_eq!(
            resolver.resolve("dev.bbcom.coverage", "1.0.0", &ArtifactSlot::Active),
            Err(HostFailure::Launch)
        );
        for error in [
            NativeRepositoryError::PackageSource,
            NativeRepositoryError::Repository,
            NativeRepositoryError::Descriptor,
        ] {
            assert!(!error.to_string().is_empty());
        }
    }

    #[test]
    fn repository_origins_map_to_manager_safe_source_ids() {
        assert_eq!(artifact_source(LOCAL_INSTALL_ORIGIN).source_id, "local");
        let remote = artifact_source("https://plugins.example.com");
        assert_eq!(remote.kind, PluginSourceKind::Https);
        assert!(
            PluginArtifact::new(
                "dev.bbcom.source-id",
                "1.0.0",
                "a".repeat(64),
                "b".repeat(64),
                remote,
                [],
            )
            .is_ok()
        );
    }
}
