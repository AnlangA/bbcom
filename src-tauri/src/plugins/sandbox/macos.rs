use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{SandboxDriver, SandboxError, SandboxLaunch, SandboxSelfTest};

const MAX_HOST_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const SELF_TEST_PYTHON: &str = "/usr/bin/python3";
const SELF_TEST_MARKER: &str = "bbcom-seatbelt-readable-package";
const SELF_TEST_SECRET: &str = "bbcom-seatbelt-sensitive-home";
const PROCESS_PROBE_OBSERVATION: Duration = Duration::from_millis(200);
const SELF_TEST_SCRIPT: &str = r#"
import errno
import os
import resource
import socket
import sys

package = sys.argv[1]
sensitive = sys.argv[2]
limit = int(sys.argv[3])

try:
    with open(os.path.join(package, "package-marker"), "r", encoding="ascii") as marker:
        if marker.read() != "bbcom-seatbelt-readable-package":
            raise SystemExit(43)
except OSError:
    raise SystemExit(43)

try:
    open(os.path.join(package, "write-must-fail"), "wb")
except OSError as error:
    if error.errno not in (errno.EPERM, errno.EACCES, errno.EROFS):
        raise SystemExit(44)
else:
    raise SystemExit(44)

if os.environ.get("HOME") != sensitive:
    raise SystemExit(43)
for forbidden in (
    os.path.join(sensitive, "home-secret"),
    "/etc/passwd",
):
    try:
        open(forbidden, "rb")
    except OSError as error:
        if error.errno not in (errno.EPERM, errno.EACCES, errno.ENOENT):
            raise SystemExit(43)
    else:
        raise SystemExit(43)

stream = None
try:
    stream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    stream.settimeout(0.1)
    stream.connect(("127.0.0.1", 9))
except OSError as error:
    if error.errno not in (errno.EPERM, errno.EACCES):
        # Connection-refused or timeout means ambient network authority was
        # available even though no server accepted the probe.
        raise SystemExit(41)
else:
    raise SystemExit(41)
finally:
    if stream is not None:
        stream.close()

try:
    child = os.fork()
except OSError as error:
    if error.errno not in (errno.EPERM, errno.EACCES):
        raise SystemExit(42)
else:
    if child == 0:
        os._exit(42)
    os.waitpid(child, 0)
    raise SystemExit(42)

soft, hard = resource.getrlimit(resource.RLIMIT_AS)
if soft != limit or hard != limit:
    raise SystemExit(45)

try:
    allocation = bytearray(limit)
except MemoryError:
    pass
else:
    del allocation
    raise SystemExit(45)
"#;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

/// macOS Seatbelt driver.
///
/// `self_test` never infers support from the OS name. It runs a restricted
/// process through the system Seatbelt interface and returns unavailable when
/// that interface or its policy cannot be proven on the current host.
#[derive(Clone, Debug)]
pub struct MacOsSandboxDriver {
    sandbox_exec: PathBuf,
}

impl MacOsSandboxDriver {
    #[must_use]
    pub fn system() -> Self {
        Self {
            sandbox_exec: PathBuf::from(SANDBOX_EXEC),
        }
    }

    fn build_command(&self, launch: &SandboxLaunch<'_>) -> Result<Command, SandboxError> {
        if launch.memory_limit_bytes != MAX_HOST_MEMORY_BYTES {
            return Err(SandboxError::new(
                "macOS plugin host memory limit must be exactly 256 MiB",
            ));
        }
        validate_system_executable(
            &self.sandbox_exec,
            "macOS Seatbelt interface is unavailable",
        )?;
        validate_regular_file(
            launch.sidecar_executable,
            "plugin host executable is unavailable",
        )?;
        let executable = fs::canonicalize(launch.sidecar_executable)
            .map_err(|_| SandboxError::new("plugin host executable cannot be resolved"))?;
        let package = fs::canonicalize(launch.package_root)
            .map_err(|_| SandboxError::new("plugin package root is unavailable"))?;
        if !package.is_dir() {
            return Err(SandboxError::new("plugin package root is not a directory"));
        }
        let profile = seatbelt_profile(&executable, &package)?;
        let mut command = Command::new(&self.sandbox_exec);
        command.arg("-p").arg(profile).arg("--").arg(executable);
        apply_memory_limit(&mut command, launch.memory_limit_bytes);
        Ok(command)
    }

    fn run_self_test(&self) -> Result<(), SandboxError> {
        validate_system_executable(
            &self.sandbox_exec,
            "macOS Seatbelt interface is unavailable",
        )?;
        let python = PathBuf::from(SELF_TEST_PYTHON);
        validate_system_executable(&python, "macOS Seatbelt probe interpreter is unavailable")?;
        let python = fs::canonicalize(python).map_err(|_| {
            SandboxError::new("macOS Seatbelt probe interpreter cannot be resolved")
        })?;
        let fixture = SelfTestFixture::create()?;
        let profile = self_test_profile(&python, &fixture.package)?;
        let mut command = Command::new(&self.sandbox_exec);
        command
            .env_clear()
            .env("HOME", &fixture.sensitive)
            .arg("-p")
            .arg(profile)
            .arg("--")
            .arg(&python)
            .arg("-I")
            .arg("-S")
            .arg("-c")
            .arg(SELF_TEST_SCRIPT)
            .arg(&fixture.package)
            .arg(&fixture.sensitive)
            .arg(MAX_HOST_MEMORY_BYTES.to_string());
        apply_memory_limit(&mut command, MAX_HOST_MEMORY_BYTES);
        let status = command
            .status()
            .map_err(|_| SandboxError::new("macOS Seatbelt self-test could not start"))?;
        match status.code() {
            Some(0) => self.run_process_resilience_probes(&python, &fixture),
            Some(41) => Err(SandboxError::new(
                "macOS Seatbelt self-test did not prove network denial",
            )),
            Some(42) => Err(SandboxError::new(
                "macOS Seatbelt self-test did not prove child-process denial",
            )),
            Some(43) => Err(SandboxError::new(
                "macOS Seatbelt self-test did not prove filesystem confinement",
            )),
            Some(44) => Err(SandboxError::new(
                "macOS Seatbelt self-test did not prove package write denial",
            )),
            Some(45) => Err(SandboxError::new(
                "macOS Seatbelt self-test did not prove the memory limit",
            )),
            _ => Err(SandboxError::new("macOS Seatbelt self-test failed")),
        }
    }

    fn run_process_resilience_probes(
        &self,
        python: &Path,
        fixture: &SelfTestFixture,
    ) -> Result<(), SandboxError> {
        let mut crash = self.self_test_process_command(python, fixture)?;
        let crash_status = crash
            .arg("-I")
            .arg("-S")
            .arg("-c")
            .arg("import os; os.abort()")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| SandboxError::new("macOS Seatbelt crash probe could not start"))?;
        if crash_status.success() {
            return Err(SandboxError::new(
                "macOS Seatbelt crash probe was not observed as failed",
            ));
        }

        let mut hang = self.self_test_process_command(python, fixture)?;
        let mut child = hang
            .arg("-I")
            .arg("-S")
            .arg("-c")
            .arg("while True: pass")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| SandboxError::new("macOS Seatbelt hang probe could not start"))?;
        thread::sleep(PROCESS_PROBE_OBSERVATION);
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) => {
                return Err(SandboxError::new(
                    "macOS Seatbelt hang probe exited before termination",
                ));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SandboxError::new(
                    "macOS Seatbelt hang probe could not be observed",
                ));
            }
        }
        if child.kill().is_err() {
            let _ = child.wait();
            return Err(SandboxError::new(
                "macOS Seatbelt hang probe could not be terminated",
            ));
        }
        let killed_status = child
            .wait()
            .map_err(|_| SandboxError::new("macOS Seatbelt hang probe could not be reaped"))?;
        if killed_status.success() {
            return Err(SandboxError::new(
                "macOS Seatbelt terminated hang probe reported success",
            ));
        }
        Ok(())
    }

    fn self_test_process_command(
        &self,
        python: &Path,
        fixture: &SelfTestFixture,
    ) -> Result<Command, SandboxError> {
        let profile = self_test_profile(python, &fixture.package)?;
        let mut command = Command::new(&self.sandbox_exec);
        command
            .env_clear()
            .env("HOME", &fixture.sensitive)
            .arg("-p")
            .arg(profile)
            .arg("--")
            .arg(python);
        apply_memory_limit(&mut command, MAX_HOST_MEMORY_BYTES);
        Ok(command)
    }
}

impl Default for MacOsSandboxDriver {
    fn default() -> Self {
        Self::system()
    }
}

impl SandboxDriver for MacOsSandboxDriver {
    fn self_test(&self) -> Result<SandboxSelfTest, SandboxError> {
        self.run_self_test()?;
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
        self.build_command(launch)
    }

    fn platform_argument(&self) -> &'static str {
        "macos"
    }
}

fn validate_regular_file(path: &Path, error: &'static str) -> Result<(), SandboxError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SandboxError::new(error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SandboxError::new(error));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(SandboxError::new(error));
    }
    Ok(())
}

fn validate_system_executable(path: &Path, error: &'static str) -> Result<(), SandboxError> {
    validate_regular_file(path, error)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| SandboxError::new(error))?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(SandboxError::new(error));
    }
    Ok(())
}

fn seatbelt_profile(executable: &Path, package: &Path) -> Result<String, SandboxError> {
    let executable = executable
        .to_str()
        .ok_or_else(|| SandboxError::new("plugin host path is not valid UTF-8"))?;
    let package = package
        .to_str()
        .ok_or_else(|| SandboxError::new("plugin package path is not valid UTF-8"))?;
    let executable = escape_profile_literal(executable);
    let package = escape_profile_literal(package);
    Ok(format!(
        r#"(version 1)
(deny default)
(deny network*)
(deny process-fork)
(allow process-exec (literal "{executable}"))
(allow file-read* (literal "{executable}"))
(allow file-read* (subpath "{package}"))
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read-metadata)
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
"#
    ))
}

fn self_test_profile(executable: &Path, package: &Path) -> Result<String, SandboxError> {
    let executable = executable
        .to_str()
        .ok_or_else(|| SandboxError::new("Seatbelt probe path is not valid UTF-8"))?;
    let package = package
        .to_str()
        .ok_or_else(|| SandboxError::new("Seatbelt fixture path is not valid UTF-8"))?;
    let executable = escape_profile_literal(executable);
    let package = escape_profile_literal(package);
    Ok(format!(
        r#"(version 1)
(deny default)
(deny network*)
(deny process-fork)
(allow process-exec (literal "{executable}"))
(allow file-read* (literal "{executable}"))
(allow file-read* (subpath "{package}"))
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework"))
(allow file-read-metadata)
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
"#
    ))
}

fn apply_memory_limit(command: &mut Command, memory_limit_bytes: usize) {
    let limit = memory_limit_bytes as u64;
    unsafe {
        command.pre_exec(move || {
            let value = RLimit {
                current: limit,
                maximum: limit,
            };
            if setrlimit(RLIMIT_AS, &value) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

struct SelfTestFixture {
    root: PathBuf,
    package: PathBuf,
    sensitive: PathBuf,
}

impl SelfTestFixture {
    fn create() -> Result<Self, SandboxError> {
        for _ in 0..32 {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| SandboxError::new("macOS Seatbelt self-test clock is unavailable"))?
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "bbcom-seatbelt-selftest-{}-{id}-{nanos}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let package = root.join("package");
                    let sensitive = root.join("sensitive-home");
                    let fixture = Self {
                        root,
                        package,
                        sensitive,
                    };
                    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).map_err(
                        |_| SandboxError::new("macOS Seatbelt self-test root cannot be protected"),
                    )?;
                    fs::create_dir(&fixture.package).map_err(|_| {
                        SandboxError::new("macOS Seatbelt package fixture cannot be created")
                    })?;
                    fs::create_dir(&fixture.sensitive).map_err(|_| {
                        SandboxError::new("macOS Seatbelt HOME fixture cannot be created")
                    })?;
                    fs::set_permissions(&fixture.package, fs::Permissions::from_mode(0o700))
                        .map_err(|_| {
                            SandboxError::new("macOS Seatbelt package fixture cannot be protected")
                        })?;
                    fs::set_permissions(&fixture.sensitive, fs::Permissions::from_mode(0o700))
                        .map_err(|_| {
                            SandboxError::new("macOS Seatbelt HOME fixture cannot be protected")
                        })?;
                    fs::write(fixture.package.join("package-marker"), SELF_TEST_MARKER).map_err(
                        |_| SandboxError::new("macOS Seatbelt package fixture cannot be written"),
                    )?;
                    fs::write(fixture.sensitive.join("home-secret"), SELF_TEST_SECRET).map_err(
                        |_| SandboxError::new("macOS Seatbelt sensitive fixture cannot be written"),
                    )?;
                    return Ok(fixture);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    return Err(SandboxError::new(
                        "macOS Seatbelt self-test root cannot be created",
                    ));
                }
            }
        }
        Err(SandboxError::new(
            "macOS Seatbelt self-test root cannot be allocated",
        ))
    }
}

impl Drop for SelfTestFixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.package.join("write-must-fail"));
        let _ = fs::remove_file(self.package.join("package-marker"));
        let _ = fs::remove_file(self.sensitive.join("home-secret"));
        let _ = fs::remove_dir(&self.package);
        let _ = fs::remove_dir(&self.sensitive);
        let _ = fs::remove_dir(&self.root);
    }
}

fn escape_profile_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[repr(C)]
struct RLimit {
    current: u64,
    maximum: u64,
}

const RLIMIT_AS: i32 = 5;

unsafe extern "C" {
    fn setrlimit(resource: i32, limit: *const RLimit) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_escapes_untrusted_path_characters() {
        let escaped = escape_profile_literal("/tmp/plugin\\\"name");
        assert_eq!(escaped, "/tmp/plugin\\\\\\\"name");
    }

    #[test]
    fn command_profile_has_no_write_or_user_directory_allowance() {
        let profile = seatbelt_profile(
            Path::new("/Applications/bbcom.app/Contents/MacOS/bbcom-plugin-host"),
            Path::new("/private/var/plugin-package"),
        )
        .unwrap();
        assert!(!profile.contains("file-write"));
        assert!(!profile.contains("/Users/"));
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(deny process-fork)"));
    }

    #[test]
    fn probe_maps_every_missing_evidence_to_a_distinct_exit_code() {
        for code in [41, 42, 43, 44, 45] {
            assert!(SELF_TEST_SCRIPT.contains(&format!("SystemExit({code})")));
        }
    }
}
