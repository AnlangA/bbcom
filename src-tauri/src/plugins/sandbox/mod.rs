//! Fail-closed operating-system isolation for native plugin hosts.
//!
//! This module is deliberately native-only. It does not expose paths or
//! process controls to Tauri commands. Platform drivers return a complete
//! [`SandboxSelfTest`] only after an executable probe has observed every
//! required control on the current machine.

use super::host_launcher::{SandboxDriver, SandboxError, SandboxLaunch, SandboxSelfTest};
#[cfg(target_os = "windows")]
use super::host_launcher::{SandboxedChild, SandboxedProcess};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::LinuxSandboxDriver as PlatformSandboxDriver;
#[cfg(target_os = "macos")]
pub use macos::MacOsSandboxDriver as PlatformSandboxDriver;
#[cfg(target_os = "windows")]
pub use windows::WindowsSandboxDriver as PlatformSandboxDriver;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlatformSandboxDriver;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl SandboxDriver for PlatformSandboxDriver {
    fn self_test(&self) -> Result<SandboxSelfTest, SandboxError> {
        Err(SandboxError::new(
            "plugin sandbox is unavailable on this operating system",
        ))
    }

    fn command(&self, _launch: &SandboxLaunch<'_>) -> Result<std::process::Command, SandboxError> {
        Err(SandboxError::new(
            "plugin sandbox is unavailable on this operating system",
        ))
    }

    fn platform_argument(&self) -> &'static str {
        "unsupported"
    }
}
