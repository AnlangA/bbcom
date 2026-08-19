//! Installed-application G45 probe for the packaged plugin sidecar.
//!
//! This entry point deliberately reports Component observations separately
//! from native sandbox self-test observations. The v2 WIT surface exposes no
//! WASI or ambient OS authority, so a Component cannot honestly claim it tried
//! a socket, child process, filesystem path, serial device, or keyring.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bbcom_plugin_contracts::generated_v2::{
    self as wire, Envelope, Handshake, HostContext, HostHello, InitializeRequest, PluginIdentity,
    Request, envelope, handshake, request, response,
};
use bbcom_plugin_contracts::v2::{
    HOST_PROCESS_MEMORY_LIMIT_BYTES, MAX_FRAME_BYTES, MAX_PROTOCOL_MINOR, MIN_PROTOCOL_MINOR,
    PROTOCOL_MAJOR, WIT_PACKAGE, default_resource_limits,
};
use bbcom_plugin_host::transport::{FrameReader, FrameWriter};
use bbcom_plugin_host::{
    AuthorizationRequest, CapabilityRpc, MessageIdSequence, PluginAuthorizationGate,
    PluginEngineFactory, PluginLaunchContext, TrustedPluginArtifact, authorization_ticket,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::host_launcher::SandboxedChild;
use super::{PlatformSandboxDriver, SandboxDriver, SandboxLaunch};

const PROBE_FLAG: &str = "--plugin-g45-host-probe";
const COMPONENT_PACKAGE: &str = "bbcom:g45-malicious-fixture@2.0.0";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_FIXTURE_SOURCE_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub struct PluginG45ProbeError {
    detail: String,
}

impl PluginG45ProbeError {
    fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
    }
}

impl fmt::Display for PluginG45ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for PluginG45ProbeError {}

/// Returns `None` for a normal desktop launch and consumes the process only
/// when the first argument is the private G45 probe flag.
pub fn run_plugin_g45_probe_from_environment() -> Option<Result<(), PluginG45ProbeError>> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let first = arguments.next()?;
    if first != OsStr::new(PROBE_FLAG) {
        return None;
    }
    Some(run_probe(arguments.collect()))
}

fn run_probe(arguments: Vec<OsString>) -> Result<(), PluginG45ProbeError> {
    let arguments = ProbeArguments::parse(arguments)?;
    let platform = NativePlatform::current();
    platform.validate(&arguments)?;

    let fixture_sources = FixtureSources::load(&arguments.fixture)?;
    let temporary_root = ProbeRoot::create()?;
    let packages = fixture_sources.materialize(temporary_root.path())?;
    let sidecar_path = packaged_sidecar_path(platform)?;
    let sidecar = file_evidence(&sidecar_path)?;
    let ambient_classification = classify_unlinked_ambient_import(&packages.ambient)?;

    let sandbox = PlatformSandboxDriver::system();
    run_initialization_probe(
        &sandbox,
        &sidecar_path,
        &packages.primary,
        InitializationExpectation::Success,
    )?;
    run_initialization_probe(
        &sandbox,
        &sidecar_path,
        &packages.trap,
        InitializationExpectation::ExactError("PLUGIN_TRAP"),
    )?;
    let runaway_classification = run_initialization_probe(
        &sandbox,
        &sidecar_path,
        &packages.runaway,
        InitializationExpectation::OneOf(&["PLUGIN_FUEL_EXHAUSTED", "PLUGIN_TIMEOUT"]),
    )?
    .ok_or_else(|| PluginG45ProbeError::new("runaway Component returned no classification"))?;
    run_initialization_probe(
        &sandbox,
        &sidecar_path,
        &packages.memory,
        InitializationExpectation::ExactError("PLUGIN_MEMORY_LIMIT"),
    )?;
    run_unlinked_ambient_import_probe(&sandbox, &sidecar_path, &packages.ambient)?;
    run_oversized_ipc_probe(&sandbox, &sidecar_path, &packages.primary)?;

    let evidence = HostEvidence {
        schema_version: 1,
        evidence_kind: "bbcom-packaged-host-malicious-component",
        probe_protocol: "bbcom-plugin-host-g45/v2",
        commit_sha: &arguments.commit,
        platform: platform.name,
        target: platform.target,
        execution: "real-wasm-component",
        host_executable: "packaged-bbcom-plugin-host",
        market_ready: false,
        fixture: FixtureEvidence {
            component_package: COMPONENT_PACKAGE,
            sha256: &fixture_sources.suite_sha256,
            digest_algorithm: "sha256(length-prefixed-name-and-source-v2)",
            artifacts: &packages.artifacts,
        },
        sidecar: SidecarEvidence {
            relative_path: platform.relative_path,
            format: platform.format,
            bytes: sidecar.bytes,
            sha256: &sidecar.sha256,
        },
        controls: &[
            "component-instantiated",
            "component-memory-limit-enforced",
            "component-unlinked-wasi-rejected",
            "component-runaway-bounded",
            "component-trap-observed",
            "oversized-ipc-rejected",
        ],
        classifications: Classifications {
            ambient: ambient_classification,
            trap: "PLUGIN_TRAP",
            runaway: &runaway_classification,
            memory: "PLUGIN_MEMORY_LIMIT",
        },
        platform_self_test: PlatformSelfTestEvidence {
            evidence_scope: "not-executed-by-component-probe",
            required_evidence: "separate-native-platform-sandbox-self-test",
        },
        limitations: &[
            "v2 Component links no WASI, socket, process, filesystem, device, environment, WebView, DOM or Tauri import",
            "native sandbox observations are not relabelled as Component resource attempts",
            "this probe never self-authorizes market release; only the aggregate G45/G46 gate may promote evidence",
        ],
    };
    serde_json::to_writer(std::io::stdout().lock(), &evidence)
        .map_err(|_| PluginG45ProbeError::new("evidence JSON could not be serialized"))?;
    println!();
    Ok(())
}

struct ProbeArguments {
    fixture: PathBuf,
    commit: String,
    platform: String,
    target: String,
}

impl ProbeArguments {
    fn parse(arguments: Vec<OsString>) -> Result<Self, PluginG45ProbeError> {
        if arguments.len() != 10 {
            return Err(PluginG45ProbeError::new(
                "expected exactly --format, --fixture, --commit, --platform and --target",
            ));
        }
        let mut format = None;
        let mut fixture = None;
        let mut commit = None;
        let mut platform = None;
        let mut target = None;
        for pair in arguments.chunks_exact(2) {
            let key = pair[0]
                .to_str()
                .ok_or_else(|| PluginG45ProbeError::new("probe option name is not UTF-8"))?;
            let destination = match key {
                "--format" => &mut format,
                "--fixture" => &mut fixture,
                "--commit" => &mut commit,
                "--platform" => &mut platform,
                "--target" => &mut target,
                _ => return Err(PluginG45ProbeError::new("unknown G45 probe option")),
            };
            if destination.replace(pair[1].clone()).is_some() {
                return Err(PluginG45ProbeError::new("duplicate G45 probe option"));
            }
        }
        if format.as_deref() != Some(OsStr::new("json")) {
            return Err(PluginG45ProbeError::new(
                "G45 probe format must be exactly json",
            ));
        }
        let text = |value: Option<OsString>, label: &str| {
            value
                .ok_or_else(|| PluginG45ProbeError::new(format!("missing {label}")))?
                .into_string()
                .map_err(|_| PluginG45ProbeError::new(format!("{label} is not UTF-8")))
        };
        let commit = text(commit, "commit")?;
        if commit.len() != 40
            || !commit
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginG45ProbeError::new(
                "commit must be a lowercase 40-byte Git SHA",
            ));
        }
        Ok(Self {
            fixture: PathBuf::from(
                fixture.ok_or_else(|| PluginG45ProbeError::new("missing fixture"))?,
            ),
            commit,
            platform: text(platform, "platform")?,
            target: text(target, "target")?,
        })
    }
}

#[derive(Clone, Copy)]
struct NativePlatform {
    name: &'static str,
    target: &'static str,
    relative_path: &'static str,
    format: &'static str,
    sidecar_basename: &'static str,
}

impl NativePlatform {
    fn current() -> Self {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            Self {
                name: "windows",
                target: "x86_64-pc-windows-msvc",
                relative_path: "bbcom-plugin-host.exe",
                format: "pe",
                sidecar_basename: "bbcom-plugin-host.exe",
            }
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            Self {
                name: "macos",
                target: "aarch64-apple-darwin",
                relative_path: "bbcom.app/Contents/MacOS/bbcom-plugin-host",
                format: "mach-o",
                sidecar_basename: "bbcom-plugin-host",
            }
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            Self {
                name: "linux",
                target: "x86_64-unknown-linux-gnu",
                relative_path: "usr/bin/bbcom-plugin-host",
                format: "elf",
                sidecar_basename: "bbcom-plugin-host",
            }
        }
        #[cfg(not(any(
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "linux", target_arch = "x86_64")
        )))]
        compile_error!(
            "G45 packaged-host probe requires Windows x86_64, macOS arm64, or Linux x86_64"
        );
    }

    fn validate(self, arguments: &ProbeArguments) -> Result<(), PluginG45ProbeError> {
        if arguments.platform != self.name || arguments.target != self.target {
            return Err(PluginG45ProbeError::new(
                "probe platform or target does not match this installed application",
            ));
        }
        Ok(())
    }
}

struct FixtureSources {
    suite_sha256: String,
    entries: Vec<FixtureSource>,
}

struct FixtureSource {
    name: &'static str,
    path: PathBuf,
    source: Vec<u8>,
    source_sha256: String,
}

impl FixtureSources {
    fn load(primary: &Path) -> Result<Self, PluginG45ProbeError> {
        if primary.file_name() != Some(OsStr::new("g45-malicious.component.wasm")) {
            return Err(PluginG45ProbeError::new(
                "fixture basename is not the reviewed G45 Component",
            ));
        }
        let directory = primary
            .parent()
            .ok_or_else(|| PluginG45ProbeError::new("fixture has no parent directory"))?;
        let specifications = [
            ("primary", primary.to_path_buf()),
            (
                "ambient",
                directory.join("g45-ambient-import.component.wat"),
            ),
            ("trap", directory.join("g45-trap.component.wat")),
            ("runaway", directory.join("g45-runaway.component.wat")),
            ("memory", directory.join("g45-memory.component.wat")),
        ];
        let mut entries = Vec::with_capacity(specifications.len());
        let mut suite = Sha256::new();
        for (name, path) in specifications {
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| PluginG45ProbeError::new("fixture source is unavailable"))?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() == 0
                || metadata.len() > MAX_FIXTURE_SOURCE_BYTES
            {
                return Err(PluginG45ProbeError::new(
                    "fixture source must be a bounded regular non-symlink file",
                ));
            }
            let source = fs::read(&path)
                .map_err(|_| PluginG45ProbeError::new("fixture source could not be read"))?;
            suite.update((name.len() as u64).to_le_bytes());
            suite.update(name.as_bytes());
            suite.update((source.len() as u64).to_le_bytes());
            suite.update(&source);
            entries.push(FixtureSource {
                name,
                path,
                source_sha256: sha256_bytes(&source),
                source,
            });
        }
        Ok(Self {
            suite_sha256: hex_digest(suite.finalize()),
            entries,
        })
    }

    fn materialize(&self, root: &Path) -> Result<ProbePackages, PluginG45ProbeError> {
        let mut packages = Vec::with_capacity(self.entries.len());
        let mut artifacts = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let compiled = wat::parse_bytes(&entry.source)
                .map_err(|error| {
                    PluginG45ProbeError::new(format!(
                        "{} fixture is not valid Component text: {error}",
                        entry.name
                    ))
                })?
                .into_owned();
            if !compiled.starts_with(b"\0asm\x0d\0\x01\0") {
                return Err(PluginG45ProbeError::new(
                    "fixture compiled to a core module instead of a Component",
                ));
            }
            let compiled_sha256 = sha256_bytes(&compiled);
            let package = root.join(entry.name);
            fs::create_dir(&package)
                .and_then(|_| fs::create_dir(package.join("component")))
                .map_err(|_| PluginG45ProbeError::new("probe package could not be created"))?;
            fs::write(package.join("component/plugin.wasm"), &compiled)
                .map_err(|_| PluginG45ProbeError::new("compiled Component could not be written"))?;
            let manifest = format!(
                "id = \"dev.bbcom.g45-fixture\"\nname = \"G45 Malicious Fixture\"\nversion = \"1.0.0\"\napi = \"^2.0\"\nrequested-capabilities = []\n\n[component]\npath = \"component/plugin.wasm\"\nsha256 = \"{compiled_sha256}\"\n\n[publisher]\nname = \"bbcom G45\"\nwebsite = \"https://example.invalid\"\n"
            );
            fs::write(package.join("plugin.toml"), manifest)
                .map_err(|_| PluginG45ProbeError::new("probe manifest could not be written"))?;
            artifacts.push(FixtureArtifactEvidence {
                name: entry.name,
                source_file: entry
                    .path
                    .file_name()
                    .and_then(OsStr::to_str)
                    .ok_or_else(|| PluginG45ProbeError::new("fixture filename is not UTF-8"))?
                    .to_owned(),
                source_sha256: entry.source_sha256.clone(),
                compiled_sha256,
            });
            packages.push(package);
        }
        let [primary, ambient, trap, runaway, memory]: [PathBuf; 5] = packages
            .try_into()
            .map_err(|_| PluginG45ProbeError::new("fixture suite is incomplete"))?;
        Ok(ProbePackages {
            primary,
            ambient,
            trap,
            runaway,
            memory,
            artifacts,
        })
    }
}

struct ProbePackages {
    primary: PathBuf,
    ambient: PathBuf,
    trap: PathBuf,
    runaway: PathBuf,
    memory: PathBuf,
    artifacts: Vec<FixtureArtifactEvidence>,
}

struct ProbeRoot {
    path: PathBuf,
}

impl ProbeRoot {
    fn create() -> Result<Self, PluginG45ProbeError> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| PluginG45ProbeError::new("system clock is unavailable"))?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "bbcom-g45-component-probe-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir(&path)
            .map_err(|_| PluginG45ProbeError::new("temporary probe root could not be created"))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ProbeRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

enum InitializationExpectation {
    Success,
    ExactError(&'static str),
    OneOf(&'static [&'static str]),
}

fn classify_unlinked_ambient_import(package: &Path) -> Result<&'static str, PluginG45ProbeError> {
    let manifest = fs::read_to_string(package.join("plugin.toml"))
        .map_err(|_| PluginG45ProbeError::new("ambient fixture manifest is unavailable"))?;
    let artifact = TrustedPluginArtifact::load(package, &manifest)
        .map_err(|_| PluginG45ProbeError::new("ambient fixture artifact is invalid"))?;
    struct ProbeAuthorization;
    impl PluginAuthorizationGate for ProbeAuthorization {
        fn authorize(&self, _request: &AuthorizationRequest) -> bool {
            true
        }
    }
    let factory =
        PluginEngineFactory::with_authorization_gate(std::sync::Arc::new(ProbeAuthorization))
            .map_err(|_| PluginG45ProbeError::new("ambient fixture engine is unavailable"))?;
    let context = PluginLaunchContext {
        package_sha256: artifact.manifest.component.sha256.clone(),
        workspace_id: "g45-probe".to_owned(),
        instance_id: "ambient".to_owned(),
        generation: 1,
    };
    let rpc = CapabilityRpc::new(Box::new(std::io::sink()), MessageIdSequence::new());
    match factory.load_authorized(&artifact, &context, [], rpc) {
        Err(error) if error.code() == "PLUGIN_COMPONENT_INVALID" => Ok("PLUGIN_COMPONENT_INVALID"),
        Err(error) => Err(PluginG45ProbeError::new(format!(
            "ambient fixture returned {}, expected PLUGIN_COMPONENT_INVALID",
            error.code()
        ))),
        Ok(_) => Err(PluginG45ProbeError::new(
            "ambient fixture unexpectedly linked its undeclared WASI import",
        )),
    }
}

fn run_initialization_probe<S: SandboxDriver>(
    sandbox: &S,
    sidecar: &Path,
    package: &Path,
    expectation: InitializationExpectation,
) -> Result<Option<String>, PluginG45ProbeError> {
    let mut process = ProbeProcess::spawn(sandbox, sidecar, package)?;
    process.handshake()?;
    let response = process.request(
        2,
        request::Operation::Initialize(InitializeRequest {
            context: Some(HostContext {
                workspace_id: "g45-probe".to_owned(),
                plugin_id: "dev.bbcom.g45-fixture".to_owned(),
                instance_id: "g45-probe-1".to_owned(),
                generation: 1,
                locale: "en-US".to_owned(),
                theme: wire::ColorScheme::System as i32,
                granted_capabilities: Vec::new(),
                limits: Some(default_resource_limits()),
                sessions: Vec::new(),
            }),
        }),
    )?;
    match (expectation, response.payload) {
        (
            InitializationExpectation::Success,
            Some(envelope::Payload::Response(wire::Response {
                result: Some(response::Result::Initialize(_)),
            })),
        ) => Ok(None),
        (
            InitializationExpectation::ExactError(expected),
            Some(envelope::Payload::Error(error)),
        ) if classify_protocol_error(&error) == expected => Ok(Some(expected.to_owned())),
        (InitializationExpectation::OneOf(expected), Some(envelope::Payload::Error(error)))
            if expected.contains(&classify_protocol_error(&error)) =>
        {
            Ok(Some(classify_protocol_error(&error).to_owned()))
        }
        _ => Err(PluginG45ProbeError::new(
            "packaged host returned an unexpected initialization result",
        )),
    }
}

fn classify_protocol_error(error: &wire::Error) -> &'static str {
    match error.message_key.as_str() {
        "plugin.error.trap" => "PLUGIN_TRAP",
        "plugin.error.timeout" => "PLUGIN_TIMEOUT",
        "plugin.error.fuelExhausted" => "PLUGIN_FUEL_EXHAUSTED",
        "plugin.error.memoryLimit" => "PLUGIN_MEMORY_LIMIT",
        _ => "PLUGIN_PROTOCOL_INVALID",
    }
}

fn run_unlinked_ambient_import_probe<S: SandboxDriver>(
    sandbox: &S,
    sidecar: &Path,
    package: &Path,
) -> Result<(), PluginG45ProbeError> {
    let component_sha256 = probe_component_digest(package)?;
    let arguments = sidecar_arguments(sandbox, package, &component_sha256);
    let launch = SandboxLaunch {
        sidecar_executable: sidecar,
        package_root: package,
        memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
        arguments: &arguments,
    };
    let mut child = sandbox.spawn(&launch).map_err(|error| {
        PluginG45ProbeError::new(format!("ambient-import host launch failed: {error}"))
    })?;
    let deadline = Instant::now() + EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|_| PluginG45ProbeError::new("ambient-import host exit was unobservable"))?
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    child.terminate_and_wait();
    Err(PluginG45ProbeError::new(
        "Component with an unlinked WASI socket import reached the handshake deadline",
    ))
}

fn run_oversized_ipc_probe<S: SandboxDriver>(
    sandbox: &S,
    sidecar: &Path,
    package: &Path,
) -> Result<(), PluginG45ProbeError> {
    let mut process = ProbeProcess::spawn(sandbox, sidecar, package)?;
    process.handshake()?;
    process
        .stdin
        .write_all(&((MAX_FRAME_BYTES + 1) as u32).to_le_bytes())
        .and_then(|_| process.stdin.flush())
        .map_err(|_| PluginG45ProbeError::new("oversized IPC prefix could not be written"))?;
    let deadline = Instant::now() + EXIT_TIMEOUT;
    while Instant::now() < deadline {
        if process
            .child
            .try_wait()
            .map_err(|_| PluginG45ProbeError::new("packaged host exit could not be observed"))?
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Err(PluginG45ProbeError::new(
        "packaged host did not reject oversized IPC within the deadline",
    ))
}

struct ProbeProcess {
    child: SandboxedChild,
    stdin: Box<dyn Write + Send>,
    responses: Receiver<Result<Option<Envelope>, ()>>,
    reader: Option<JoinHandle<()>>,
    component_sha256: String,
}

impl ProbeProcess {
    fn spawn<S: SandboxDriver>(
        sandbox: &S,
        sidecar: &Path,
        package: &Path,
    ) -> Result<Self, PluginG45ProbeError> {
        let component_sha256 = probe_component_digest(package)?;
        let arguments = sidecar_arguments(sandbox, package, &component_sha256);
        let launch = SandboxLaunch {
            sidecar_executable: sidecar,
            package_root: package,
            memory_limit_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
            arguments: &arguments,
        };
        let mut child = sandbox.spawn(&launch).map_err(|error| {
            PluginG45ProbeError::new(format!("host sandbox launch failed: {error}"))
        })?;
        let stdin = child
            .take_stdin()
            .ok_or_else(|| PluginG45ProbeError::new("packaged host stdin is unavailable"))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| PluginG45ProbeError::new("packaged host stdout is unavailable"))?;
        let (sender, responses) = sync_channel(8);
        let reader = thread::Builder::new()
            .name("bbcom-g45-host-reader".to_owned())
            .spawn(move || {
                let mut reader = FrameReader::new(stdout);
                loop {
                    let response = reader.read_envelope().map_err(|_| ());
                    let terminal = !matches!(response, Ok(Some(_)));
                    if sender.send(response).is_err() || terminal {
                        return;
                    }
                }
            })
            .map_err(|_| PluginG45ProbeError::new("host reader thread could not be started"))?;
        Ok(Self {
            child,
            stdin,
            responses,
            reader: Some(reader),
            component_sha256,
        })
    }

    fn handshake(&mut self) -> Result<(), PluginG45ProbeError> {
        FrameWriter::new(&mut self.stdin)
            .write_envelope(&Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: MAX_PROTOCOL_MINOR,
                message_id: 1,
                reply_to: None,
                payload: Some(envelope::Payload::Handshake(Handshake {
                    hello: Some(handshake::Hello::Host(HostHello {
                        protocol_major: PROTOCOL_MAJOR,
                        min_minor: MIN_PROTOCOL_MINOR,
                        max_minor: MAX_PROTOCOL_MINOR,
                        wit_package: WIT_PACKAGE.to_owned(),
                        plugin: Some(PluginIdentity {
                            plugin_id: "dev.bbcom.g45-fixture".to_owned(),
                            plugin_version: "1.0.0".to_owned(),
                            component_sha256: self.component_sha256.clone(),
                        }),
                        granted_capabilities: Vec::new(),
                        limits: Some(default_resource_limits()),
                        workspace_id: "g45-probe".to_owned(),
                        instance_id: "g45-probe-1".to_owned(),
                        generation: 1,
                    })),
                })),
            })
            .map_err(|_| PluginG45ProbeError::new("host handshake could not be written"))?;
        match self.responses.recv_timeout(RESPONSE_TIMEOUT) {
            Ok(Ok(Some(Envelope {
                reply_to: Some(1),
                payload:
                    Some(envelope::Payload::Handshake(Handshake {
                        hello: Some(handshake::Hello::Plugin(hello)),
                    })),
                ..
            }))) if hello.wit_package == WIT_PACKAGE
                && hello.plugin.as_ref().is_some_and(|plugin| {
                    plugin.plugin_id == "dev.bbcom.g45-fixture"
                        && plugin.component_sha256 == self.component_sha256
                }) =>
            {
                Ok(())
            }
            _ => Err(PluginG45ProbeError::new(
                "packaged host handshake was not bound to the fixture",
            )),
        }
    }

    fn request(
        &mut self,
        request_id: u64,
        operation: request::Operation,
    ) -> Result<Envelope, PluginG45ProbeError> {
        FrameWriter::new(&mut self.stdin)
            .write_envelope(&Envelope {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: MAX_PROTOCOL_MINOR,
                message_id: request_id,
                reply_to: None,
                payload: Some(envelope::Payload::Request(Request {
                    operation: Some(operation),
                })),
            })
            .map_err(|_| PluginG45ProbeError::new("host request could not be written"))?;
        match self.responses.recv_timeout(RESPONSE_TIMEOUT) {
            Ok(Ok(Some(response))) if response.reply_to == Some(request_id) => Ok(response),
            Ok(_) => Err(PluginG45ProbeError::new(
                "host response was missing, malformed or mis-correlated",
            )),
            Err(RecvTimeoutError::Timeout) => Err(PluginG45ProbeError::new(
                "host response exceeded the probe deadline",
            )),
            Err(RecvTimeoutError::Disconnected) => Err(PluginG45ProbeError::new(
                "host response channel disconnected",
            )),
        }
    }
}

fn sidecar_arguments<S: SandboxDriver>(
    sandbox: &S,
    package: &Path,
    component_sha256: &str,
) -> Vec<OsString> {
    let request = AuthorizationRequest {
        plugin_id: "dev.bbcom.g45-fixture".to_owned(),
        plugin_version: "1.0.0".to_owned(),
        component_sha256: component_sha256.to_owned(),
        package_sha256: component_sha256.to_owned(),
        workspace_id: "g45-probe".to_owned(),
        instance_id: "g45-probe-1".to_owned(),
        generation: 1,
        capabilities: Vec::new(),
    };
    vec![
        OsString::from("--package-root"),
        package.as_os_str().to_owned(),
        OsString::from("--platform"),
        OsString::from(sandbox.platform_argument()),
        OsString::from("--memory-limit-bytes"),
        OsString::from(HOST_PROCESS_MEMORY_LIMIT_BYTES.to_string()),
        OsString::from("--blocks-child-processes"),
        OsString::from("--blocks-network"),
        OsString::from("--restricts-filesystem"),
        OsString::from("--package-sha256"),
        OsString::from(component_sha256),
        OsString::from("--workspace-id"),
        OsString::from("g45-probe"),
        OsString::from("--instance-id"),
        OsString::from("g45-probe-1"),
        OsString::from("--generation"),
        OsString::from("1"),
        OsString::from("--authorization-ticket"),
        OsString::from(authorization_ticket(&request)),
    ]
}

fn probe_component_digest(package: &Path) -> Result<String, PluginG45ProbeError> {
    let manifest = fs::read_to_string(package.join("plugin.toml"))
        .map_err(|_| PluginG45ProbeError::new("probe manifest is unavailable"))?;
    Ok(bbcom_plugin_contracts::PluginManifest::parse(&manifest)
        .map_err(|_| PluginG45ProbeError::new("probe manifest is invalid"))?
        .component
        .sha256)
}

impl Drop for ProbeProcess {
    fn drop(&mut self) {
        self.child.terminate_and_wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn packaged_sidecar_path(platform: NativePlatform) -> Result<PathBuf, PluginG45ProbeError> {
    let application = std::env::current_exe()
        .map_err(|_| PluginG45ProbeError::new("installed application path is unavailable"))?;
    let path = application
        .parent()
        .ok_or_else(|| PluginG45ProbeError::new("installed application has no parent directory"))?
        .join(platform.sidecar_basename);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| PluginG45ProbeError::new("packaged plugin host is unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PluginG45ProbeError::new(
            "packaged plugin host is not a regular non-symlink file",
        ));
    }
    Ok(path)
}

struct FileEvidence {
    bytes: u64,
    sha256: String,
}

fn file_evidence(path: &Path) -> Result<FileEvidence, PluginG45ProbeError> {
    let mut file = File::open(path)
        .map_err(|_| PluginG45ProbeError::new("packaged plugin host could not be opened"))?;
    let bytes = file
        .metadata()
        .map_err(|_| PluginG45ProbeError::new("packaged plugin host metadata is unavailable"))?
        .len();
    if bytes == 0 {
        return Err(PluginG45ProbeError::new("packaged plugin host is empty"));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| PluginG45ProbeError::new("packaged plugin host could not be hashed"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(FileEvidence {
        bytes,
        sha256: hex_digest(digest.finalize()),
    })
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvidence<'a> {
    schema_version: u32,
    evidence_kind: &'static str,
    probe_protocol: &'static str,
    commit_sha: &'a str,
    platform: &'static str,
    target: &'static str,
    execution: &'static str,
    host_executable: &'static str,
    market_ready: bool,
    fixture: FixtureEvidence<'a>,
    sidecar: SidecarEvidence<'a>,
    controls: &'static [&'static str],
    classifications: Classifications<'a>,
    platform_self_test: PlatformSelfTestEvidence,
    limitations: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureEvidence<'a> {
    component_package: &'static str,
    sha256: &'a str,
    digest_algorithm: &'static str,
    artifacts: &'a [FixtureArtifactEvidence],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureArtifactEvidence {
    name: &'static str,
    source_file: String,
    source_sha256: String,
    compiled_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEvidence<'a> {
    relative_path: &'static str,
    format: &'static str,
    bytes: u64,
    sha256: &'a str,
}

#[derive(Serialize)]
struct Classifications<'a> {
    ambient: &'static str,
    trap: &'static str,
    runaway: &'a str,
    memory: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformSelfTestEvidence {
    evidence_scope: &'static str,
    required_evidence: &'static str,
}
