//! Reviewed native probes used by the platform sandbox release gate.
//!
//! The probe lives in the same trusted, packaged executable as the plugin
//! host, avoiding interpreter and developer-tool dependencies inside the
//! restricted process.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use bbcom_plugin_contracts::HOST_PROCESS_MEMORY_LIMIT_BYTES;

const SELF_TEST_MARKER: &str = "bbcom-native-sandbox-readable-package";
const NETWORK_DENIAL_FAILURE: i32 = 41;
const CHILD_PROCESS_DENIAL_FAILURE: i32 = 42;
const PACKAGE_WRITE_DENIAL_FAILURE: i32 = 44;
#[cfg(target_os = "windows")]
const MEMORY_LIMIT_FAILURE: i32 = 45;
const INVALID_PROBE_ARGUMENTS: i32 = 46;
const PACKAGE_READ_FAILURE: i32 = 48;
const SENSITIVE_FILE_DENIAL_FAILURE: i32 = 49;

/// Execute a reviewed internal probe mode, returning `None` for the normal
/// sidecar protocol command line.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn run_if_requested(arguments: &[OsString]) -> Option<i32> {
    let mode = arguments.first()?.to_str()?;
    match mode {
        "--native-sandbox-self-test" => {
            if arguments.len() != 4 {
                return Some(INVALID_PROBE_ARGUMENTS);
            }
            Some(run_base_probe(
                &PathBuf::from(&arguments[1]),
                &PathBuf::from(&arguments[2]),
                &PathBuf::from(&arguments[3]),
            ))
        }
        #[cfg(target_os = "macos")]
        "--native-sandbox-memory" if arguments.len() == 1 => run_resident_memory_probe(),
        "--native-sandbox-crash" if arguments.len() == 1 => std::process::abort(),
        "--native-sandbox-hang" if arguments.len() == 1 => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        value if value.starts_with("--native-sandbox-") => Some(INVALID_PROBE_ARGUMENTS),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_base_probe(package: &Path, sensitive: &Path, child_executable: &Path) -> i32 {
    if !matches!(
        fs::read_to_string(package.join("package-marker")),
        Ok(marker) if marker == SELF_TEST_MARKER
    ) {
        return PACKAGE_READ_FAILURE;
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(package.join("write-must-fail"))
    {
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
            ) => {}
        _ => return PACKAGE_WRITE_DENIAL_FAILURE,
    }
    for forbidden in [sensitive, Path::new(system_sensitive_file())] {
        match fs::read(forbidden) {
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::NotFound
                ) => {}
            _ => return SENSITIVE_FILE_DENIAL_FAILURE,
        }
    }

    // TEST-NET-1 is permanently non-routable. A process with ambient network
    // authority would time out or report routing failure, while the sandbox
    // must reject the connect attempt immediately with access denied.
    let network_probe = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 9);
    match TcpStream::connect_timeout(&network_probe, Duration::from_millis(100)) {
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {}
        _ => return NETWORK_DENIAL_FAILURE,
    }
    if !child_process_is_denied(child_executable) {
        return CHILD_PROCESS_DENIAL_FAILURE;
    }
    #[cfg(target_os = "windows")]
    if !oversized_allocation_is_denied() {
        return MEMORY_LIMIT_FAILURE;
    }
    0
}

#[cfg(target_os = "macos")]
fn run_resident_memory_probe() -> ! {
    const PROBE_BYTES: usize = HOST_PROCESS_MEMORY_LIMIT_BYTES + 64 * 1024 * 1024;
    const PAGE_SIZE: usize = 16 * 1024;

    let mut allocation = vec![0_u8; PROBE_BYTES];
    for offset in (0..allocation.len()).step_by(PAGE_SIZE) {
        allocation[offset] = (offset as u8).wrapping_add(1);
    }
    std::hint::black_box(&allocation);
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(target_os = "macos")]
const fn system_sensitive_file() -> &'static str {
    "/etc/passwd"
}

#[cfg(target_os = "windows")]
const fn system_sensitive_file() -> &'static str {
    r"C:\Windows\System32\config\SAM"
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn child_process_is_denied(executable: &Path) -> bool {
    match std::process::Command::new(executable)
        .arg("--native-sandbox-invalid-child")
        .status()
    {
        Err(error) => child_creation_error_is_denial(&error),
        Ok(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn child_creation_error_is_denial(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::PermissionDenied
}

#[cfg(target_os = "windows")]
fn child_creation_error_is_denial(error: &std::io::Error) -> bool {
    // Win32 reports the dedicated "process creation has been blocked" code
    // for the token-level child-process mitigation rather than access denied.
    const ERROR_CHILD_PROCESS_BLOCKED: i32 = 367;

    error.kind() == ErrorKind::PermissionDenied
        || error.raw_os_error() == Some(ERROR_CHILD_PROCESS_BLOCKED)
}

#[cfg(target_os = "windows")]
fn oversized_allocation_is_denied() -> bool {
    let mut allocation = Vec::<u8>::new();
    allocation
        .try_reserve_exact(HOST_PROCESS_MEMORY_LIMIT_BYTES + 64 * 1024 * 1024)
        .is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrelated_arguments_are_not_probe_modes() {
        assert_eq!(run_if_requested(&[OsString::from("--package-root")]), None);
        assert_eq!(
            run_if_requested(&[OsString::from("--native-sandbox-unknown")]),
            Some(INVALID_PROBE_ARGUMENTS)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn recognizes_the_windows_child_process_policy_error() {
        assert!(child_creation_error_is_denial(
            &std::io::Error::from_raw_os_error(367)
        ));
        assert!(!child_creation_error_is_denial(
            &std::io::Error::from_raw_os_error(2)
        ));
    }
}
