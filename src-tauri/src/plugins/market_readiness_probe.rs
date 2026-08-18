//! Installed-application proof for the explicit plugin market release gate.
//!
//! Unlike the G45 Component probe, this entry point runs through normal Tauri
//! setup. Evidence is emitted only after the production command service and
//! lifecycle monitor have been installed from the packaged sidecar.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::workspace::WorkspaceManager;

use super::runtime_wiring::PluginLifecycleHandle;

const PROBE_FLAG: &str = "--plugin-market-readiness-probe";

#[derive(Clone, Debug)]
pub(crate) struct PluginMarketReadinessProbe {
    commit: String,
    platform: String,
    target: String,
    data_root: PathBuf,
}

#[derive(Debug)]
pub(crate) struct PluginMarketReadinessProbeError {
    detail: &'static str,
}

impl PluginMarketReadinessProbeError {
    const fn new(detail: &'static str) -> Self {
        Self { detail }
    }
}

impl fmt::Display for PluginMarketReadinessProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.detail)
    }
}

impl std::error::Error for PluginMarketReadinessProbeError {}

impl PluginMarketReadinessProbe {
    /// Returns `None` for a normal desktop launch and consumes the process only
    /// when the first argument is the private market-readiness flag.
    pub(crate) fn from_environment() -> Option<Result<Self, PluginMarketReadinessProbeError>> {
        let mut arguments = std::env::args_os();
        let _program = arguments.next();
        let first = arguments.next()?;
        if first != OsStr::new(PROBE_FLAG) {
            return None;
        }
        Some(Self::parse(arguments.collect()))
    }

    fn parse(arguments: Vec<OsString>) -> Result<Self, PluginMarketReadinessProbeError> {
        if !arguments.len().is_multiple_of(2) {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness probe arguments are incomplete",
            ));
        }

        let mut format = None;
        let mut commit = None;
        let mut platform = None;
        let mut target = None;
        let mut data_root = None;
        for pair in arguments.chunks_exact(2) {
            let key = pair[0].to_str().ok_or_else(|| {
                PluginMarketReadinessProbeError::new(
                    "market-readiness probe argument name is not UTF-8",
                )
            })?;
            let value = pair[1].to_str().ok_or_else(|| {
                PluginMarketReadinessProbeError::new(
                    "market-readiness probe argument value is not UTF-8",
                )
            })?;
            let slot = match key {
                "--format" => &mut format,
                "--commit" => &mut commit,
                "--platform" => &mut platform,
                "--target" => &mut target,
                "--data-root" => &mut data_root,
                _ => {
                    return Err(PluginMarketReadinessProbeError::new(
                        "market-readiness probe argument is unsupported",
                    ));
                }
            };
            if slot.replace(value.to_owned()).is_some() {
                return Err(PluginMarketReadinessProbeError::new(
                    "market-readiness probe argument is duplicated",
                ));
            }
        }

        let layout = NativeLayout::current()?;
        let commit = commit.ok_or_else(|| {
            PluginMarketReadinessProbeError::new("market-readiness commit is missing")
        })?;
        if format.as_deref() != Some("json") {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness format must be json",
            ));
        }
        if commit.len() != 40
            || !commit
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness commit is malformed",
            ));
        }
        if platform.as_deref() != Some(layout.platform) {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness platform does not match this executable",
            ));
        }
        if target.as_deref() != Some(layout.target) {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness target does not match this executable",
            ));
        }
        let data_root = PathBuf::from(data_root.ok_or_else(|| {
            PluginMarketReadinessProbeError::new("market-readiness data root is missing")
        })?);
        if !data_root.is_absolute() {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness data root must be absolute",
            ));
        }

        Ok(Self {
            commit,
            platform: layout.platform.to_owned(),
            target: layout.target.to_owned(),
            data_root,
        })
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    /// Creates a fresh private root so the installed probe cannot read or
    /// mutate a developer's real projects, plugin state, or source registry.
    pub(crate) fn prepare_data_root(&self) -> Result<(), PluginMarketReadinessProbeError> {
        fs::create_dir(&self.data_root).map_err(|_| {
            PluginMarketReadinessProbeError::new(
                "market-readiness data root must be fresh and creatable",
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&self.data_root, fs::Permissions::from_mode(0o700)).map_err(
                |_| {
                    PluginMarketReadinessProbeError::new(
                        "market-readiness data root could not be made private",
                    )
                },
            )?;
        }
        Ok(())
    }

    /// Writes canonical evidence only after normal native setup composed the
    /// production runtime in a detached (no active project) state.
    pub(crate) fn write_evidence<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<(), PluginMarketReadinessProbeError> {
        if !app
            .try_state::<PluginLifecycleHandle>()
            .is_some_and(|handle| handle.current().is_some())
        {
            return Err(PluginMarketReadinessProbeError::new(
                "production plugin runtime did not compose",
            ));
        }
        let workspace = app.try_state::<WorkspaceManager>().ok_or_else(|| {
            PluginMarketReadinessProbeError::new("workspace manager is unavailable")
        })?;
        if workspace.plugin_workspace_snapshot().is_some() {
            return Err(PluginMarketReadinessProbeError::new(
                "market-readiness probe requires a detached workspace",
            ));
        }

        let layout = NativeLayout::current()?;
        let sidecar_path = packaged_sidecar_path(layout)?;
        let sidecar = file_evidence(&sidecar_path)?;
        let evidence = RuntimeEvidence {
            schema_version: 1,
            evidence_kind: "bbcom-production-plugin-runtime",
            probe_protocol: "bbcom-plugin-market-readiness/v1",
            commit_sha: &self.commit,
            platform: &self.platform,
            target: &self.target,
            sidecar: RuntimeSidecarEvidence {
                relative_path: layout.relative_path,
                format: layout.format,
                bytes: sidecar.bytes,
                sha256: &sidecar.sha256,
            },
            runtime: RuntimeGraphEvidence {
                command_service: "native-production",
                lifecycle_monitor: "active",
                host_launcher: "packaged-sidecar",
                open_project_behavior: "stopped",
                market_release_gate: "explicit",
            },
        };

        let stdout = std::io::stdout();
        let mut writer = stdout.lock();
        serde_json::to_writer(&mut writer, &evidence).map_err(|_| {
            PluginMarketReadinessProbeError::new(
                "market-readiness evidence JSON could not be serialized",
            )
        })?;
        writer.write_all(b"\n").map_err(|_| {
            PluginMarketReadinessProbeError::new("market-readiness evidence could not be written")
        })?;
        writer.flush().map_err(|_| {
            PluginMarketReadinessProbeError::new("market-readiness evidence could not be flushed")
        })
    }
}

#[derive(Clone, Copy)]
struct NativeLayout {
    platform: &'static str,
    target: &'static str,
    sidecar_basename: &'static str,
    relative_path: &'static str,
    format: &'static str,
}

impl NativeLayout {
    fn current() -> Result<Self, PluginMarketReadinessProbeError> {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Ok(Self {
                platform: "windows",
                target: "x86_64-pc-windows-msvc",
                sidecar_basename: "bbcom-plugin-host.exe",
                relative_path: "bbcom-plugin-host.exe",
                format: "pe",
            });
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Ok(Self {
                platform: "macos",
                target: "aarch64-apple-darwin",
                sidecar_basename: "bbcom-plugin-host",
                relative_path: "bbcom.app/Contents/MacOS/bbcom-plugin-host",
                format: "mach-o",
            });
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Ok(Self {
                platform: "linux",
                target: "x86_64-unknown-linux-gnu",
                sidecar_basename: "bbcom-plugin-host",
                relative_path: "usr/bin/bbcom-plugin-host",
                format: "elf",
            });
        }
        #[allow(unreachable_code)]
        Err(PluginMarketReadinessProbeError::new(
            "market-readiness probe does not support this native target",
        ))
    }
}

fn packaged_sidecar_path(layout: NativeLayout) -> Result<PathBuf, PluginMarketReadinessProbeError> {
    let application = std::env::current_exe().map_err(|_| {
        PluginMarketReadinessProbeError::new("installed application path is unavailable")
    })?;
    let path = application
        .parent()
        .ok_or_else(|| {
            PluginMarketReadinessProbeError::new("installed application has no parent directory")
        })?
        .join(layout.sidecar_basename);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| PluginMarketReadinessProbeError::new("packaged plugin host is unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PluginMarketReadinessProbeError::new(
            "packaged plugin host is not a regular file",
        ));
    }
    Ok(path)
}

struct FileEvidence {
    bytes: u64,
    sha256: String,
}

fn file_evidence(path: &Path) -> Result<FileEvidence, PluginMarketReadinessProbeError> {
    let mut file = File::open(path).map_err(|_| {
        PluginMarketReadinessProbeError::new("packaged plugin host could not be opened")
    })?;
    let bytes = file
        .metadata()
        .map_err(|_| {
            PluginMarketReadinessProbeError::new("packaged plugin host metadata is unavailable")
        })?
        .len();
    if bytes == 0 {
        return Err(PluginMarketReadinessProbeError::new(
            "packaged plugin host is empty",
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| {
            PluginMarketReadinessProbeError::new("packaged plugin host could not be hashed")
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(FileEvidence {
        bytes,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEvidence<'a> {
    schema_version: u8,
    evidence_kind: &'static str,
    probe_protocol: &'static str,
    commit_sha: &'a str,
    platform: &'a str,
    target: &'a str,
    sidecar: RuntimeSidecarEvidence<'a>,
    runtime: RuntimeGraphEvidence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSidecarEvidence<'a> {
    relative_path: &'static str,
    format: &'static str,
    bytes: u64,
    sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeGraphEvidence {
    command_service: &'static str,
    lifecycle_monitor: &'static str,
    host_launcher: &'static str,
    open_project_behavior: &'static str,
    market_release_gate: &'static str,
}

#[cfg(test)]
mod tests {
    use super::{NativeLayout, PluginMarketReadinessProbe};
    use std::ffi::OsString;

    fn valid_arguments() -> Vec<OsString> {
        let layout = NativeLayout::current().unwrap();
        let data_root = if cfg!(windows) {
            r"C:\bbcom-g46-unit-test"
        } else {
            "/tmp/bbcom-g46-unit-test"
        };
        [
            "--format",
            "json",
            "--commit",
            "0123456789abcdef0123456789abcdef01234567",
            "--platform",
            layout.platform,
            "--target",
            layout.target,
            "--data-root",
            data_root,
        ]
        .into_iter()
        .map(OsString::from)
        .collect()
    }

    #[test]
    fn accepts_exact_native_market_probe_contract() {
        let probe = PluginMarketReadinessProbe::parse(valid_arguments()).unwrap();
        assert_eq!(probe.commit, "0123456789abcdef0123456789abcdef01234567");
    }

    #[test]
    fn rejects_unknown_or_duplicated_arguments() {
        let mut unknown = valid_arguments();
        unknown.extend([OsString::from("--extra"), OsString::from("value")]);
        assert!(PluginMarketReadinessProbe::parse(unknown).is_err());

        let mut duplicated = valid_arguments();
        duplicated.extend([OsString::from("--format"), OsString::from("json")]);
        assert!(PluginMarketReadinessProbe::parse(duplicated).is_err());
    }

    #[test]
    fn rejects_malformed_commit_or_foreign_target() {
        let mut malformed = valid_arguments();
        malformed[3] = OsString::from("not-a-commit");
        assert!(PluginMarketReadinessProbe::parse(malformed).is_err());

        let mut foreign = valid_arguments();
        foreign[7] = OsString::from("foreign-target");
        assert!(PluginMarketReadinessProbe::parse(foreign).is_err());

        let mut relative_root = valid_arguments();
        relative_root[9] = OsString::from("relative-root");
        assert!(PluginMarketReadinessProbe::parse(relative_root).is_err());
    }
}
