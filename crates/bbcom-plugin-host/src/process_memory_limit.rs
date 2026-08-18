//! Native process-wide memory confinement owned by the trusted sidecar.

use crate::{HostError, Result};

#[cfg(target_os = "macos")]
const RLIMIT_AS: i32 = 5;
#[cfg(target_os = "macos")]
const EINVAL: i32 = 22;

/// Apply the macOS address-space allowance after `exec` has replaced the
/// launcher process image.
///
/// Darwin counts system shared mappings in `RLIMIT_AS`, so an absolute
/// 256 MiB ceiling is already below the address-space size of a freshly
/// started process on current Apple platforms. The trusted host therefore
/// asks the kernel for the smallest accepted ceiling, then permits exactly the
/// requested additional address space before any plugin artifact is opened.
#[cfg(target_os = "macos")]
pub fn enforce_additional_address_space(bytes: usize) -> Result<()> {
    let mut original = RLimit::default();
    if unsafe { getrlimit(RLIMIT_AS, &raw mut original) } != 0 {
        return Err(HostError::InvalidProcessLimit);
    }
    let baseline = minimum_accepted_limit(original.maximum)?;
    let limit = additional_limit(baseline, bytes as u64, original.maximum)?;
    let value = RLimit {
        current: limit,
        maximum: limit,
    };
    if unsafe { setrlimit(RLIMIT_AS, &value) } != 0 {
        return Err(HostError::InvalidProcessLimit);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn minimum_accepted_limit(maximum: u64) -> Result<u64> {
    let mut lower = 0_u64;
    let mut upper = maximum;
    while lower < upper {
        let candidate = lower + (upper - lower) / 2;
        let probe = RLimit {
            current: candidate,
            maximum,
        };
        if unsafe { setrlimit(RLIMIT_AS, &probe) } == 0 {
            upper = candidate;
        } else if std::io::Error::last_os_error().raw_os_error() == Some(EINVAL) {
            lower = candidate + 1;
        } else {
            return Err(HostError::InvalidProcessLimit);
        }
    }
    Ok(lower)
}

#[cfg(target_os = "macos")]
fn additional_limit(baseline: u64, bytes: u64, maximum: u64) -> Result<u64> {
    let limit = baseline
        .checked_add(bytes)
        .ok_or(HostError::InvalidProcessLimit)?;
    if limit > maximum {
        return Err(HostError::InvalidProcessLimit);
    }
    Ok(limit)
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default)]
struct RLimit {
    current: u64,
    maximum: u64,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn getrlimit(resource: i32, limit: *mut RLimit) -> i32;
    fn setrlimit(resource: i32, limit: *const RLimit) -> i32;
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn additional_limit_preserves_runtime_baseline() {
        assert_eq!(additional_limit(4096, 1024, u64::MAX).unwrap(), 5120);
        assert!(additional_limit(u64::MAX, 1, u64::MAX).is_err());
        assert!(additional_limit(4096, 1025, 5120).is_err());
    }
}
