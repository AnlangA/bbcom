//! CI gate for the generated MCUmgr Component's complete native startup path.
//!
//! The standalone plugin workspaces intentionally are not members of the root
//! workspace. The protocol-v2 Components job therefore builds and packages the
//! release Component first, then supplies its package and the real release
//! sidecar through the two environment variables below.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bbcom::plugins::{
    NativePluginAuthorizationGateV2, NativePluginAuthorizationStore,
    NativePluginCapabilityGatewayV2, PluginAuthorizationCoordinatorV2,
    PluginAuthorizationResolutionV2, PluginCapabilityEventSinkV2, PluginCapabilitySinkErrorV2,
    PluginDetachedProjectionPortV2, PluginFileDialogPortV2, PluginFileGrantService,
    PluginHostContextStoreV2, PluginHostServicesV2, PluginPersistedState,
    PluginPrivateStatePersistenceV2, PluginProjectStateProviderV2, PluginProjectStateSnapshotV2,
    PluginRuntimeProjectionSnapshotV2, PluginRuntimeProjectionV2, PluginStatePersistenceKey,
    PluginStatePersistencePort, PluginWorkspaceCapabilityPortV2, PrivateArtifactRoot,
    RepositoryArtifactPathResolver, SandboxDriver, SandboxError, SandboxLaunch, SandboxSelfTest,
    SerialCapabilityCorrelationRegistryV2, SidecarHostLauncher,
};
use bbcom_contracts::{
    PluginErrorCodeV2, PluginHostContextUpdateRequestV2, PluginHostLocaleV2, PluginHostThemeV2,
    PluginSerialCapabilityInboundV2, PluginSerialCapabilityOperationV2,
    PluginSerialCapabilityOutboundV2, PluginSerialCapabilityResponseV2,
    PluginSerialCapabilityResultV2, RuntimeInstanceKey,
};
use bbcom_plugin_broker::{
    GatewayContext, GatewayFailure, PluginCapabilityGateway, RuntimeBootstrapState, StreamEvent,
    TaskTerminal,
};
use bbcom_plugin_contracts::generated_v2 as wire;
use bbcom_plugin_manager::{
    ArtifactSlot, HostFailure, HostLaunchMode, HostLaunchRequest, HostLauncher, PluginArtifact,
    PluginArtifactSource, PluginSourceKind,
};
use bbcom_plugin_repository::PluginInstaller;

const MCUMGR_PACKAGE_ENV: &str = "BBCOM_MCUMGR_V2_PACKAGE";
const SIDECAR_ENV: &str = "BBCOM_PLUGIN_HOST_V2_SIDECAR";
const WORKSPACE_ID: &str = "8e7b84cf-35f4-45cd-baf0-55d94ebf0213";
const PLUGIN_ID: &str = "dev.bbcom.mcumgr-client";
const INITIALIZE_DEADLINE: Duration = Duration::from_secs(2);

fn required_path(name: &str) -> PathBuf {
    let configured = std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must point to a generated production artifact"));
    let path = if configured.is_absolute() {
        configured
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(configured)
    };
    path.canonicalize()
        .unwrap_or_else(|error| panic!("{} must be available: {error}", path.display()))
}

/// The platform G45 suite proves the real sandbox separately. This adapter
/// keeps this gate deterministic while still executing the real sidecar
/// process and the production launcher's argument, framing and timeout paths.
#[derive(Clone, Copy)]
struct ProcessSandbox;

impl SandboxDriver for ProcessSandbox {
    fn self_test(&self, _: &Path) -> Result<SandboxSelfTest, SandboxError> {
        Ok(SandboxSelfTest {
            blocks_network: true,
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
        if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
    }
}

#[derive(Default)]
struct MemoryPrivateState {
    persisted: Arc<Mutex<Vec<PluginPersistedState>>>,
}

impl PluginStatePersistencePort for MemoryPrivateState {
    fn load_plugin_storage(
        &mut self,
        _: &PluginStatePersistenceKey,
    ) -> Result<Option<Vec<u8>>, HostFailure> {
        Ok(None)
    }

    fn workspace_total_bytes(&mut self, _: &str) -> Result<usize, HostFailure> {
        Ok(0)
    }

    fn persist_state(
        &mut self,
        _: &PluginStatePersistenceKey,
        state: &PluginPersistedState,
    ) -> Result<(), HostFailure> {
        self.persisted
            .lock()
            .map_err(|_| HostFailure::Initialization)?
            .push(state.clone());
        Ok(())
    }
}

struct EmptyProjectState;

impl PluginProjectStateProviderV2 for EmptyProjectState {
    fn current_project_state(
        &self,
        workspace_id: &str,
        plugin_id: &str,
    ) -> Result<Option<PluginProjectStateSnapshotV2>, HostFailure> {
        if workspace_id != WORKSPACE_ID || plugin_id != PLUGIN_ID {
            return Err(HostFailure::Initialization);
        }
        Ok(None)
    }
}

struct RecordingSink {
    serial: Arc<SerialCapabilityCorrelationRegistryV2>,
    serial_calls: AtomicUsize,
    projection_changes: AtomicUsize,
}

impl PluginCapabilityEventSinkV2 for RecordingSink {
    fn emit_serial(
        &self,
        event: &PluginSerialCapabilityInboundV2,
    ) -> Result<(), PluginCapabilitySinkErrorV2> {
        self.serial_calls.fetch_add(1, Ordering::Relaxed);
        let PluginSerialCapabilityInboundV2::Request {
            context,
            message_id,
            operation: PluginSerialCapabilityOperationV2::ListSessions,
        } = event
        else {
            return Err(PluginCapabilitySinkErrorV2);
        };
        self.serial
            .complete(PluginSerialCapabilityOutboundV2::Response {
                response: PluginSerialCapabilityResponseV2 {
                    context: context.clone(),
                    reply_to: *message_id,
                    ok: true,
                    result: Some(PluginSerialCapabilityResultV2::ListSessions {
                        sessions: Vec::new(),
                    }),
                    error_code: None,
                },
            })
            .map_err(|_| PluginCapabilitySinkErrorV2)
    }

    fn projection_changed(&self) -> Result<(), PluginCapabilitySinkErrorV2> {
        self.projection_changes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

struct ClosedFileDialog;

impl PluginFileDialogPortV2 for ClosedFileDialog {
    fn open_read(&self, _: &[String]) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }

    fn create_save(&self, _: &str) -> Result<Option<PathBuf>, PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }
}

#[derive(Default)]
struct RecordingPrivateState {
    writes: AtomicUsize,
}

impl PluginPrivateStatePersistenceV2 for RecordingPrivateState {
    fn persist_plugin_storage(
        &self,
        _: &GatewayContext,
        _: &str,
        _: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Default)]
struct RecordingWorkspace {
    project_states: Mutex<Vec<(u32, Vec<u8>)>>,
    unexpected_contributions: AtomicUsize,
}

impl PluginWorkspaceCapabilityPortV2 for RecordingWorkspace {
    fn set_project_state(
        &self,
        context: &GatewayContext,
        schema_version: u32,
        value: &[u8],
    ) -> Result<(), PluginErrorCodeV2> {
        if context.workspace_id != WORKSPACE_ID || context.plugin_id != PLUGIN_ID {
            return Err(PluginErrorCodeV2::StaleHandle);
        }
        self.project_states
            .lock()
            .map_err(|_| PluginErrorCodeV2::IoError)?
            .push((schema_version, value.to_vec()));
        Ok(())
    }

    fn upsert_quick_command(
        &self,
        _: &GatewayContext,
        _: &wire::QuickCommand,
    ) -> Result<String, PluginErrorCodeV2> {
        self.unexpected_contributions
            .fetch_add(1, Ordering::Relaxed);
        Err(PluginErrorCodeV2::Unavailable)
    }

    fn delete_quick_command(
        &self,
        _: &GatewayContext,
        _: &str,
        _: &str,
    ) -> Result<(), PluginErrorCodeV2> {
        self.unexpected_contributions
            .fetch_add(1, Ordering::Relaxed);
        Err(PluginErrorCodeV2::Unavailable)
    }

    fn upsert_macro(
        &self,
        _: &GatewayContext,
        _: &wire::MacroContribution,
    ) -> Result<String, PluginErrorCodeV2> {
        self.unexpected_contributions
            .fetch_add(1, Ordering::Relaxed);
        Err(PluginErrorCodeV2::Unavailable)
    }

    fn delete_macro(&self, _: &GatewayContext, _: &str, _: &str) -> Result<(), PluginErrorCodeV2> {
        self.unexpected_contributions
            .fetch_add(1, Ordering::Relaxed);
        Err(PluginErrorCodeV2::Unavailable)
    }
}

struct ClosedDetachedProjection;

impl PluginDetachedProjectionPortV2 for ClosedDetachedProjection {
    fn sync(&self, _: u64, _: &PluginRuntimeProjectionSnapshotV2) -> Result<(), PluginErrorCodeV2> {
        Ok(())
    }

    fn open(
        &self,
        _: u64,
        _: &RuntimeInstanceKey,
        _: &str,
        _: &PluginRuntimeProjectionSnapshotV2,
    ) -> Result<(), PluginErrorCodeV2> {
        Err(PluginErrorCodeV2::Unavailable)
    }

    fn revoke_surface(&self, _: &RuntimeInstanceKey, _: &str) {}

    fn revoke_runtime(&self, _: &RuntimeInstanceKey) {}
}

/// Thin observer around the production gateway. It does not synthesize any
/// response: every request and lifecycle hook is delegated unchanged.
struct RecordingGateway {
    inner: Arc<NativePluginCapabilityGatewayV2>,
    operations: Mutex<Vec<String>>,
}

impl RecordingGateway {
    fn new(inner: Arc<NativePluginCapabilityGatewayV2>) -> Self {
        Self {
            inner,
            operations: Mutex::new(Vec::new()),
        }
    }

    fn operations(&self) -> Vec<String> {
        self.operations
            .lock()
            .map(|values| values.clone())
            .unwrap_or_else(|_| vec!["poisoned".to_owned()])
    }
}

impl PluginCapabilityGateway for RecordingGateway {
    fn register_runtime(
        &self,
        context: &GatewayContext,
        state: RuntimeBootstrapState,
    ) -> Result<(), GatewayFailure> {
        self.inner.register_runtime(context, state)
    }

    fn stage_migrated_project_state(
        &self,
        context: &GatewayContext,
        schema_version: u32,
        state: Vec<u8>,
    ) -> Result<(), GatewayFailure> {
        self.inner
            .stage_migrated_project_state(context, schema_version, state)
    }

    fn finalize_initial_model(
        &self,
        context: &GatewayContext,
        model: &wire::PluginModel,
    ) -> Result<(), GatewayFailure> {
        self.inner.finalize_initial_model(context, model)
    }

    fn invoke(
        &self,
        context: &GatewayContext,
        message_id: u64,
        operation: wire::request::Operation,
    ) -> Result<wire::response::Result, GatewayFailure> {
        let debug = format!("{operation:?}");
        let name = debug
            .split(['(', '{'])
            .next()
            .unwrap_or("Unknown")
            .to_owned();
        let result = self.inner.invoke(context, message_id, operation);
        let outcome = result
            .as_ref()
            .map(|_| "ok".to_owned())
            .unwrap_or_else(|error| format!("error:{:?}", error.code));
        let detail = result
            .is_err()
            .then(|| debug.chars().take(20_000).collect::<String>());
        if let Ok(mut operations) = self.operations.lock() {
            operations.push(format!("{name}:{outcome}"));
            if let Some(detail) = detail {
                operations.push(detail);
            }
        }
        result
    }

    fn cancel(
        &self,
        context: &GatewayContext,
        target_message_id: u64,
    ) -> Result<(), GatewayFailure> {
        self.inner.cancel(context, target_message_id)
    }

    fn discard_cancelled_result(
        &self,
        context: &GatewayContext,
        operation: &wire::request::Operation,
        result: &wire::response::Result,
    ) {
        self.inner
            .discard_cancelled_result(context, operation, result);
    }

    fn revoke_runtime(&self, context: &GatewayContext) {
        self.inner.revoke_runtime(context);
    }

    fn complete_task(&self, context: &GatewayContext, task_id: &str, terminal: TaskTerminal) {
        self.inner.complete_task(context, task_id, terminal);
    }

    fn stream(&self, context: &GatewayContext, event: StreamEvent) -> Result<(), GatewayFailure> {
        self.inner.stream(context, event)
    }
}

fn artifact(
    active: &bbcom_plugin_repository::ActiveInstallation,
    capabilities: &std::collections::BTreeSet<wire::Capability>,
) -> PluginArtifact {
    PluginArtifact::new(
        &active.plugin_id,
        &active.version,
        &active.package_sha256,
        &active.component_sha256,
        PluginArtifactSource {
            source_id: "mcumgr-production-gate".to_owned(),
            kind: PluginSourceKind::LocalPackage,
        },
        capabilities.iter().copied(),
    )
    .expect("the production installer descriptor must map to a manager artifact")
}

#[test]
#[ignore = "requires release MCUmgr package and release bbcom-plugin-host from CI"]
fn generated_mcumgr_initializes_through_real_sidecar_within_two_seconds() {
    let source_package = required_path(MCUMGR_PACKAGE_ENV);
    let sidecar = required_path(SIDECAR_ENV);
    let root = tempfile::tempdir().expect("production-chain root");
    let package_root = root.path().join("packages");
    let data_root = root.path().join("data");
    let installer = Arc::new(
        PluginInstaller::new(&package_root, data_root).expect("production plugin installer"),
    );

    let install_started = Instant::now();
    let prepared = installer
        .prepare_local_install(&source_package)
        .expect("release MCUmgr package must pass production prepare validation");
    assert_eq!(prepared.plugin_id(), PLUGIN_ID);
    assert_eq!(prepared.requested_capabilities().len(), 12);
    let capabilities = prepared.requested_capabilities().clone();
    let active = installer
        .commit_prepared(&prepared)
        .expect("release MCUmgr package must commit atomically");
    let install_elapsed = install_started.elapsed();
    assert_ne!(active.package_directory, source_package);

    let projection = Arc::new(PluginRuntimeProjectionV2::default());
    let serial = Arc::new(SerialCapabilityCorrelationRegistryV2::default());
    let sink = Arc::new(RecordingSink {
        serial: Arc::clone(&serial),
        serial_calls: AtomicUsize::new(0),
        projection_changes: AtomicUsize::new(0),
    });
    let private_state = Arc::new(RecordingPrivateState::default());
    let workspace = Arc::new(RecordingWorkspace::default());
    let native_gateway = Arc::new(NativePluginCapabilityGatewayV2::new_with_ports(
        sink.clone(),
        serial,
        Arc::clone(&projection),
        Arc::new(PluginFileGrantService::default()),
        Arc::new(ClosedFileDialog),
        private_state.clone(),
        workspace.clone(),
        Arc::new(ClosedDetachedProjection),
    ));
    let gateway = Arc::new(RecordingGateway::new(native_gateway));

    let host_context = Arc::new(PluginHostContextStoreV2::default());
    host_context
        .update(PluginHostContextUpdateRequestV2 {
            workspace_id: Some(WORKSPACE_ID.to_owned()),
            locale: PluginHostLocaleV2::En,
            theme: PluginHostThemeV2::Dark,
            sessions: Vec::new(),
        })
        .expect("hydrated production host context");

    let authorization_store = Arc::new(
        NativePluginAuthorizationStore::open(root.path().join("authorizations.json"))
            .expect("authorization store"),
    );
    let authorization_coordinator = Arc::new(PluginAuthorizationCoordinatorV2::default());
    let authorization = Arc::new(NativePluginAuthorizationGateV2::new(
        Arc::clone(&authorization_store),
        Arc::clone(&authorization_coordinator),
    ));
    let gateway_service: Arc<dyn PluginCapabilityGateway> = gateway.clone();
    let services = PluginHostServicesV2::new(
        authorization,
        gateway_service,
        host_context,
        Arc::new(EmptyProjectState),
    );
    let private_root = PrivateArtifactRoot::open(&package_root).expect("private package root");
    let resolver = RepositoryArtifactPathResolver::new(Arc::clone(&installer));
    let (mut launcher, _) = SidecarHostLauncher::new_with_v2_services(
        sidecar,
        private_root,
        resolver,
        ProcessSandbox,
        MemoryPrivateState::default(),
        services,
    )
    .expect("production sidecar launcher");
    let plugin_artifact = artifact(&active, &capabilities);
    let request = HostLaunchRequest {
        artifact: plugin_artifact.clone(),
        artifact_slot: ArtifactSlot::Active,
        workspace_id: WORKSPACE_ID.to_owned(),
        requested_capabilities: capabilities,
        mode: HostLaunchMode::Active,
    };

    // The first attempt uses the real authorization gate and must stop before
    // process creation. Resolving its exact immutable request models the one
    // explicit user consent required on first enable.
    assert_eq!(launcher.launch(&request), Err(HostFailure::Initialization));
    let pending = authorization_coordinator.requests();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].plugin_id, PLUGIN_ID);
    authorization_coordinator
        .resolve(
            &authorization_store,
            &pending[0],
            PluginAuthorizationResolutionV2::Approve,
        )
        .expect("exact capability consent");

    let launch_started = Instant::now();
    let handle = launcher
        .launch(&request)
        .expect("real sidecar handshake must succeed");
    let launch_elapsed = launch_started.elapsed();
    let initialize_started = Instant::now();
    if let Err(error) = launcher.initialize(&handle) {
        let partial = projection.snapshot();
        let project_state_writes = workspace
            .project_states
            .lock()
            .map(|values| values.len())
            .unwrap_or(usize::MAX);
        panic!(
            "MCUmgr initialize failed through typed host RPC: {error:?}; surfaces={}, commands={}, projection_changes={}, project_state_writes={project_state_writes}, operations={:?}",
            partial.surfaces.len(),
            partial.command_contributions.len(),
            sink.projection_changes.load(Ordering::Relaxed),
            gateway.operations(),
        );
    }
    let initialize_elapsed = initialize_started.elapsed();
    assert!(
        initialize_elapsed < INITIALIZE_DEADLINE,
        "initialize took {initialize_elapsed:?}, exceeding the ordinary two-second deadline"
    );

    let snapshot = projection.snapshot();
    assert_eq!(snapshot.surfaces.len(), 9);
    assert_eq!(snapshot.command_contributions.len(), 44);
    assert!(snapshot.tasks.is_empty());
    assert!(
        snapshot
            .surfaces
            .iter()
            .all(|surface| surface.runtime.plugin_id == PLUGIN_ID)
    );
    assert!(
        snapshot
            .command_contributions
            .iter()
            .all(|command| command.runtime.plugin_id == PLUGIN_ID)
    );
    let project_states = workspace.project_states.lock().expect("project states");
    assert_eq!(project_states.len(), 1);
    assert_eq!(project_states[0].0, 1);
    assert!(project_states[0].1.starts_with(b"BMC2"));
    drop(project_states);
    assert_eq!(
        workspace.unexpected_contributions.load(Ordering::Relaxed),
        0
    );
    assert_eq!(private_state.writes.load(Ordering::Relaxed), 0);
    assert_eq!(sink.serial_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sink.projection_changes.load(Ordering::Relaxed), 62);
    let operations = gateway.operations();
    assert_eq!(operations.len(), 65);
    assert!(
        operations
            .iter()
            .all(|operation| !operation.contains("error:"))
    );
    for (name, expected) in [
        ("ProjectStateGet:ok", 1),
        ("ProjectStateSet:ok", 1),
        ("RegisterSurface:ok", 9),
        ("RegisterCommand:ok", 44),
        ("ListSessions:ok", 1),
        ("PublishSurfaceSnapshot:ok", 9),
    ] {
        assert_eq!(
            operations
                .iter()
                .filter(|operation| operation.as_str() == name)
                .count(),
            expected,
            "unexpected typed RPC count for {name}"
        );
    }

    launcher
        .shutdown(&handle)
        .expect("real sidecar must shut down cleanly");
    assert!(projection.snapshot().surfaces.is_empty());
    eprintln!(
        "MCUmgr production chain: install={install_elapsed:?}, launch+handshake={launch_elapsed:?}, initialize={initialize_elapsed:?}, surfaces=9, commands=44"
    );
}
