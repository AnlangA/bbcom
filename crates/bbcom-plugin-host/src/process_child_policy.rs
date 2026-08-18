//! Windows token-level child-process restriction for the native sidecar.

use std::ffi::c_void;
use std::mem::size_of;

use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessMitigationPolicy, ProcessChildProcessPolicy,
    SetProcessMitigationPolicy,
};

const NO_CHILD_PROCESS_CREATION: u32 = 1;

/// Apply and verify the irreversible no-child-process policy before any
/// untrusted package input is parsed or loaded.
pub fn enforce() -> Result<(), &'static str> {
    let requested = NO_CHILD_PROCESS_CREATION;
    if unsafe {
        SetProcessMitigationPolicy(
            ProcessChildProcessPolicy,
            (&requested as *const u32).cast::<c_void>(),
            size_of::<u32>(),
        )
    } == 0
    {
        return Err("Windows child-process restriction could not be applied");
    }

    let mut observed = 0u32;
    if unsafe {
        GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessChildProcessPolicy,
            (&mut observed as *mut u32).cast::<c_void>(),
            size_of::<u32>(),
        )
    } == 0
        || observed & NO_CHILD_PROCESS_CREATION == 0
    {
        return Err("Windows child-process restriction could not be verified");
    }
    Ok(())
}
