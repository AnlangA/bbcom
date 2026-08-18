use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use bbcom_plugin_manager::{
    InstallationPort, ManualPackageRequest, PluginArtifact, PreparationKind, PreparationToken,
};

use super::host_launcher::{
    PluginPersistedState, PluginStatePersistenceKey, PluginStatePersistencePort,
};
use super::{
    ArtifactPathResolver, HostLauncherBuildError, PreparedRepositoryArtifact, PrivateArtifactRoot,
    RepositoryInstallationPort, RepositoryStagingBackend, ResolvedPluginArtifact, SandboxDriver,
    SandboxError, SandboxLaunch, SandboxSelfTest, SidecarHostLauncher,
};

struct RejectingPluginStatePersistence;

impl PluginStatePersistencePort for RejectingPluginStatePersistence {
    fn load_plugin_storage(
        &mut self,
        _key: &PluginStatePersistenceKey,
    ) -> Result<Option<Vec<u8>>, bbcom_plugin_manager::HostFailure> {
        Err(bbcom_plugin_manager::HostFailure::Initialization)
    }

    fn workspace_total_bytes(
        &mut self,
        _workspace_id: &str,
    ) -> Result<usize, bbcom_plugin_manager::HostFailure> {
        Err(bbcom_plugin_manager::HostFailure::Initialization)
    }

    fn persist_state(
        &mut self,
        _key: &PluginStatePersistenceKey,
        _state: &PluginPersistedState,
    ) -> Result<(), bbcom_plugin_manager::HostFailure> {
        Err(bbcom_plugin_manager::HostFailure::Initialization)
    }
}

#[derive(Default)]
struct FakeRepositoryBackend {
    commit_result: Option<PluginArtifact>,
    discarded: usize,
}

impl RepositoryStagingBackend for FakeRepositoryBackend {
    type Error = ();

    fn prepare_manual(
        &mut self,
        request: &ManualPackageRequest,
        current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error> {
        let kind = if current.is_some() {
            PreparationKind::ManualUpgrade
        } else {
            PreparationKind::InitialInstall
        };
        Ok(PreparedRepositoryArtifact {
            token: PreparationToken::new(format!("{}-{}", request.plugin_id, request.version))
                .expect("valid token"),
            artifact: artifact(&request.plugin_id, &request.version),
            kind,
        })
    }

    fn prepare_rollback(
        &mut self,
        current: &PluginArtifact,
    ) -> Result<Option<PreparedRepositoryArtifact>, Self::Error> {
        Ok(Some(PreparedRepositoryArtifact {
            token: PreparationToken::new("rollback-token").expect("valid token"),
            artifact: artifact(&current.plugin_id, "1.0.0"),
            kind: PreparationKind::Rollback,
        }))
    }

    fn commit(
        &mut self,
        prepared: &PreparedRepositoryArtifact,
    ) -> Result<PluginArtifact, Self::Error> {
        Ok(self
            .commit_result
            .clone()
            .unwrap_or_else(|| prepared.artifact.clone()))
    }

    fn discard(&mut self, _prepared: &PreparedRepositoryArtifact) -> Result<(), Self::Error> {
        self.discarded += 1;
        Ok(())
    }

    fn prepare_local(
        &mut self,
        _package_root: &std::path::Path,
        _current: Option<&PluginArtifact>,
    ) -> Result<PreparedRepositoryArtifact, Self::Error> {
        let _ = self;
        Err(())
    }

    fn remove_installed(&mut self, _artifact: &PluginArtifact) -> Result<(), Self::Error> {
        self.discarded += 1;
        Ok(())
    }
}

#[test]
fn repository_adapter_commits_exact_descriptor_once() {
    let request =
        ManualPackageRequest::new("official", "dev.bbcom.fixture", "1.1.0").expect("request");
    let mut port = RepositoryInstallationPort::new(FakeRepositoryBackend::default());
    let prepared = port.prepare_manual(&request, None).expect("prepare");
    assert_eq!(port.commit(&prepared).expect("commit"), prepared.artifact);
    assert!(port.commit(&prepared).is_err(), "token must be single-use");
}

#[test]
fn repository_adapter_rejects_backend_descriptor_substitution() {
    let request =
        ManualPackageRequest::new("official", "dev.bbcom.fixture", "1.1.0").expect("request");
    let backend = FakeRepositoryBackend {
        commit_result: Some(artifact("dev.bbcom.fixture", "1.2.0")),
        discarded: 0,
    };
    let mut port = RepositoryInstallationPort::new(backend);
    let prepared = port.prepare_manual(&request, None).expect("prepare");
    assert!(port.commit(&prepared).is_err());
}

#[derive(Clone, Copy)]
struct IncompleteSandbox;

impl SandboxDriver for IncompleteSandbox {
    fn self_test(&self, _sidecar_executable: &Path) -> Result<SandboxSelfTest, SandboxError> {
        Ok(SandboxSelfTest {
            blocks_network: false,
            blocks_child_processes: true,
            restricts_filesystem: true,
            enforces_memory_limit: true,
            observes_crashed_process: true,
            terminates_hung_process: true,
        })
    }

    fn command(&self, launch: &SandboxLaunch<'_>) -> Result<Command, SandboxError> {
        Ok(Command::new(launch.sidecar_executable))
    }

    fn platform_argument(&self) -> &'static str {
        "linux"
    }
}

struct NeverResolve;

impl ArtifactPathResolver for NeverResolve {
    fn resolve(
        &self,
        _plugin_id: &str,
        _version: &str,
        _slot: &bbcom_plugin_manager::ArtifactSlot,
    ) -> Result<ResolvedPluginArtifact, bbcom_plugin_manager::HostFailure> {
        unreachable!("sandbox construction must fail before resolving an artifact")
    }
}

#[test]
fn host_launcher_refuses_incomplete_os_sandbox_self_test() {
    let root = unique_test_directory();
    std::fs::create_dir_all(&root).expect("private root");
    let private_root = PrivateArtifactRoot::open(&root).expect("safe private root");
    let executable = std::env::current_exe().expect("test executable");
    let result = SidecarHostLauncher::new(
        executable,
        private_root,
        NeverResolve,
        IncompleteSandbox,
        RejectingPluginStatePersistence,
    );
    assert!(matches!(
        result,
        Err(HostLauncherBuildError::SandboxUnavailable(_))
    ));
    std::fs::remove_dir(&root).expect("remove private root");
}

fn artifact(plugin_id: &str, version: &str) -> PluginArtifact {
    PluginArtifact::new(
        plugin_id,
        version,
        "0".repeat(64),
        "1".repeat(64),
        bbcom_plugin_manager::PluginArtifactSource {
            source_id: "test".to_owned(),
            kind: bbcom_plugin_manager::PluginSourceKind::Https,
        },
        BTreeSet::new(),
    )
    .expect("artifact")
}

fn unique_test_directory() -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "bbcom-plugin-service-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}
