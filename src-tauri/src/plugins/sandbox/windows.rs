use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString, c_void};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
#[cfg(test)]
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, GENERIC_WRITE, GetLastError, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LocalFree, STILL_ACTIVE, SetHandleInformation,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT,
    SET_ACCESS, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, FreeSid, GetLengthSid, PSID, SECURITY_ATTRIBUTES,
    SECURITY_CAPABILITIES,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;

use super::{
    SandboxDriver, SandboxError, SandboxLaunch, SandboxSelfTest, SandboxedChild, SandboxedProcess,
};

const MAX_HOST_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const SELF_TEST_TIMEOUT_MS: u32 = 30_000;
const HANG_OBSERVATION_MS: u32 = 500;
const HANG_TERMINATION_TIMEOUT_MS: u32 = 5_000;
const HANG_TERMINATION_EXIT_CODE: u32 = 47;
const APPCONTAINER_PREFIX: &str = "bbcom.plugin.host";
const SELF_TEST_MARKER: &str = "bbcom-native-sandbox-readable-package";
const SELF_TEST_SECRET: &str = "bbcom-native-sandbox-sensitive-file";
// AppContainer process creation needs the Windows profile and temporary-path
// variables so it can redirect them into the profile. Keep this list limited
// to non-secret operating-system paths: application variables (including API
// keys) must never cross the plugin sandbox boundary.
const PLUGIN_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "ALLUSERSPROFILE",
    "APPDATA",
    "ComSpec",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "OS",
    "PATHEXT",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "windir",
];
const REQUIRED_PLUGIN_ENVIRONMENT: &[&str] = &["LOCALAPPDATA", "SystemRoot", "TEMP", "TMP"];

static NEXT_SELF_TEST_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_PROFILE_ID: AtomicU64 = AtomicU64::new(1);

/// Windows native launch broker.
///
/// Every package gets a distinct AppContainer SID with an empty capability
/// set. A native ACL lease grants that SID read-only package access and
/// read/execute access to the trusted sidecar for exactly the child lifetime.
/// The process receives the token-level child-process restriction, is created
/// suspended, and is attached to a kill-on-close, one-process, 256 MiB Job
/// before it is resumed.
#[derive(Clone, Copy, Debug, Default)]
pub struct WindowsSandboxDriver;

impl WindowsSandboxDriver {
    #[must_use]
    pub const fn system() -> Self {
        Self
    }
}

impl SandboxDriver for WindowsSandboxDriver {
    fn self_test(&self, sidecar_executable: &Path) -> Result<SandboxSelfTest, SandboxError> {
        run_self_test(sidecar_executable)?;
        Ok(SandboxSelfTest {
            blocks_network: true,
            blocks_child_processes: true,
            restricts_filesystem: true,
            enforces_memory_limit: true,
            observes_crashed_process: true,
            terminates_hung_process: true,
        })
    }

    fn command(&self, _launch: &SandboxLaunch<'_>) -> Result<Command, SandboxError> {
        Err(SandboxError::new(
            "Windows sandbox must use its atomic native spawn path",
        ))
    }

    fn spawn(&self, launch: &SandboxLaunch<'_>) -> Result<SandboxedChild, SandboxError> {
        validate_launch(launch)?;
        let process = unsafe { spawn_appcontainer_suspended(launch, false)? };
        Ok(SandboxedChild::platform(Box::new(process)))
    }

    fn platform_argument(&self) -> &'static str {
        "windows"
    }
}

struct WindowsSandboxedProcess {
    process: OwnedHandle,
    // `Drop` waits for termination before the Job, ACL lease, and temporary
    // AppContainer profile are released in declaration order.
    _job: OwnedHandle,
    _acl: AclLease,
    _profile: AppContainerProfile,
    stdin: Option<File>,
    stdout: Option<File>,
}

impl Drop for WindowsSandboxedProcess {
    fn drop(&mut self) {
        let mut code = 0u32;
        let process = raw_handle(&self.process);
        let running =
            unsafe { GetExitCodeProcess(process, &mut code) } != 0 && code == STILL_ACTIVE as u32;
        if running {
            unsafe {
                let _ = TerminateProcess(process, 1);
                let _ = WaitForSingleObject(process, INFINITE);
            }
        }
    }
}

impl SandboxedProcess for WindowsSandboxedProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.stdin
            .take()
            .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout
            .take()
            .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
    }

    fn try_wait(&mut self) -> std::io::Result<bool> {
        let mut code = 0;
        let success = unsafe { GetExitCodeProcess(raw_handle(&self.process), &mut code) };
        if success == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(code != STILL_ACTIVE as u32)
        }
    }

    fn terminate_and_wait(&mut self) {
        unsafe {
            let process = raw_handle(&self.process);
            let _ = TerminateProcess(process, 1);
            let _ = WaitForSingleObject(process, INFINITE);
        }
    }
}

fn validate_launch(launch: &SandboxLaunch<'_>) -> Result<(), SandboxError> {
    if launch.memory_limit_bytes != MAX_HOST_MEMORY_BYTES {
        return Err(SandboxError::new(
            "Windows plugin host memory limit must be exactly 256 MiB",
        ));
    }
    for (path, error) in [
        (
            launch.sidecar_executable,
            "Windows plugin host executable is unavailable",
        ),
        (
            launch.package_root,
            "Windows plugin package root is unavailable",
        ),
    ] {
        if !path.is_absolute() || path.as_os_str().encode_wide().any(|unit| unit == 0) {
            return Err(SandboxError::new(error));
        }
    }
    let executable = std::fs::symlink_metadata(launch.sidecar_executable)
        .map_err(|_| SandboxError::new("Windows plugin host executable is unavailable"))?;
    if executable.file_type().is_symlink()
        || executable.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !executable.is_file()
    {
        return Err(SandboxError::new(
            "Windows plugin host executable is unavailable",
        ));
    }
    let package = std::fs::symlink_metadata(launch.package_root)
        .map_err(|_| SandboxError::new("Windows plugin package root is unavailable"))?;
    if package.file_type().is_symlink()
        || package.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !package.is_dir()
    {
        return Err(SandboxError::new(
            "Windows plugin package root is unavailable",
        ));
    }
    Ok(())
}

struct AppContainerProfile {
    name: Vec<u16>,
    sid: PSID,
}

// `sid` is a process-local allocation owned by this value. Windows SIDs do
// not have thread affinity and the allocation remains immutable after setup.
unsafe impl Send for AppContainerProfile {}

impl AppContainerProfile {
    unsafe fn open(name: &OsStr) -> Result<Self, SandboxError> {
        let name = wide_null(name);
        let display = wide_null(OsStr::new("bbcom plugin host"));
        let description = wide_null(OsStr::new("isolated bbcom Wasm component host"));
        let mut sid = null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        let already_exists = hresult_from_win32(ERROR_ALREADY_EXISTS);
        if created < 0 && created != already_exists {
            return Err(SandboxError::new(
                "Windows AppContainer profile could not be created",
            ));
        }
        if created == already_exists {
            if !sid.is_null() {
                unsafe {
                    let _ = FreeSid(sid);
                }
            }
            sid = null_mut();
            if unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) } < 0 {
                return Err(SandboxError::new(
                    "Windows AppContainer SID could not be derived",
                ));
            }
        }
        if sid.is_null() {
            return Err(SandboxError::new(
                "Windows AppContainer profile returned an invalid SID",
            ));
        }
        Ok(Self { name, sid })
    }

    fn sid(&self) -> PSID {
        self.sid
    }
}

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeSid(self.sid);
            let _ = DeleteAppContainerProfile(self.name.as_ptr());
        }
    }
}

struct ProcessAttributeList {
    storage: Vec<usize>,
}

impl ProcessAttributeList {
    unsafe fn security_capabilities(
        capabilities: &SECURITY_CAPABILITIES,
        inherited_handles: &[HANDLE],
        child_process_policy: &u32,
    ) -> Result<Self, SandboxError> {
        let mut bytes = 0usize;
        let _ = unsafe { InitializeProcThreadAttributeList(null_mut(), 3, 0, &mut bytes) };
        if bytes == 0 {
            return Err(SandboxError::new(
                "Windows process security attribute size is unavailable",
            ));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut list = Self {
            storage: vec![0usize; words],
        };
        if unsafe { InitializeProcThreadAttributeList(list.as_ptr(), 3, 0, &mut bytes) } == 0 {
            list.storage.clear();
            return Err(SandboxError::new(
                "Windows process security attributes could not be initialized",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (capabilities as *const SECURITY_CAPABILITIES).cast::<c_void>(),
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            unsafe { DeleteProcThreadAttributeList(list.as_ptr()) };
            list.storage.clear();
            return Err(SandboxError::new(
                "Windows AppContainer process attribute could not be applied",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited_handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(inherited_handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            unsafe { DeleteProcThreadAttributeList(list.as_ptr()) };
            list.storage.clear();
            return Err(SandboxError::new(
                "Windows plugin host inherited handle list could not be restricted",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize,
                (child_process_policy as *const u32)
                    .cast_mut()
                    .cast::<c_void>(),
                size_of::<u32>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            unsafe { DeleteProcThreadAttributeList(list.as_ptr()) };
            list.storage.clear();
            return Err(SandboxError::new(
                "Windows plugin host child-process restriction could not be applied",
            ));
        }
        Ok(list)
    }

    fn as_ptr(&self) -> *mut c_void {
        self.storage.as_ptr().cast_mut().cast()
    }
}

impl Drop for ProcessAttributeList {
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AclGrant {
    path: PathBuf,
    sid: Vec<u8>,
    access: u32,
}

impl AclGrant {
    fn resolve(path: &Path, sid: &[u8], execute: bool) -> Result<Self, SandboxError> {
        let path = fs::canonicalize(path)
            .map_err(|_| SandboxError::new("Windows package ACL target disappeared"))?;
        let mut access = FILE_GENERIC_READ;
        if execute {
            access |= FILE_GENERIC_EXECUTE;
        }
        Ok(Self {
            path,
            sid: sid.to_vec(),
            access,
        })
    }
}

#[derive(Default)]
struct ActiveSidGrants {
    access_ref_counts: BTreeMap<u32, usize>,
}

impl ActiveSidGrants {
    fn effective_access(&self) -> Option<u32> {
        let access = self
            .access_ref_counts
            .iter()
            .filter(|(_, count)| **count > 0)
            .fold(0, |combined, (access, _)| combined | *access);
        (access != 0).then_some(access)
    }

    fn effective_access_after_release(&self, released: u32) -> Option<u32> {
        let access = self
            .access_ref_counts
            .iter()
            .filter(|(access, count)| **access != released || **count > 1)
            .fold(0, |combined, (access, _)| combined | *access);
        (access != 0).then_some(access)
    }
}

trait AclWriter {
    fn set_sid_access(
        &mut self,
        path: &Path,
        sid: &[u8],
        access: Option<u32>,
    ) -> Result<(), SandboxError>;
}

#[derive(Default)]
struct NativeAclWriter;

impl AclWriter for NativeAclWriter {
    fn set_sid_access(
        &mut self,
        path: &Path,
        sid: &[u8],
        access: Option<u32>,
    ) -> Result<(), SandboxError> {
        // Use u32 storage so the SID pointer satisfies the native alignment
        // contract even though registry keys are byte vectors.
        let mut sid_words = vec![0u32; sid.len().div_ceil(size_of::<u32>())];
        unsafe {
            std::ptr::copy_nonoverlapping(
                sid.as_ptr(),
                sid_words.as_mut_ptr().cast::<u8>(),
                sid.len(),
            );
        }
        let mut wide = wide_null(path.as_os_str());
        let mut old_acl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_acl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(SandboxError::new(
                "Windows package security descriptor could not be read",
            ));
        }
        let descriptor_guard = LocalAllocation(descriptor);
        if old_acl.is_null() {
            return Err(SandboxError::new(
                "Windows package uses an unsafe null discretionary ACL",
            ));
        }
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access.unwrap_or(0),
            grfAccessMode: if access.is_some() {
                SET_ACCESS
            } else {
                REVOKE_ACCESS
            },
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid_words.as_mut_ptr().cast::<u16>(),
            },
        };
        let mut new_acl = null_mut();
        if unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) } != ERROR_SUCCESS {
            return Err(SandboxError::new(
                "Windows AppContainer ACL entry could not be constructed",
            ));
        }
        let new_acl_guard = LocalAllocation(new_acl.cast::<c_void>());
        if unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_acl,
                null_mut(),
            )
        } != ERROR_SUCCESS
        {
            return Err(SandboxError::new(
                "Windows AppContainer ACL entry could not be applied",
            ));
        }
        drop(new_acl_guard);
        drop(descriptor_guard);
        Ok(())
    }
}

struct AclBroker<W> {
    active: BTreeMap<PathBuf, BTreeMap<Vec<u8>, ActiveSidGrants>>,
    writer: W,
}

impl<W: AclWriter> AclBroker<W> {
    fn new(writer: W) -> Self {
        Self {
            active: BTreeMap::new(),
            writer,
        }
    }

    fn acquire(&mut self, grant: &AclGrant) -> Result<(), SandboxError> {
        let previous = self
            .active
            .get(&grant.path)
            .and_then(|by_sid| by_sid.get(&grant.sid))
            .and_then(ActiveSidGrants::effective_access);
        let next = Some(previous.unwrap_or(0) | grant.access);
        if previous != next {
            self.writer.set_sid_access(&grant.path, &grant.sid, next)?;
        }
        *self
            .active
            .entry(grant.path.clone())
            .or_default()
            .entry(grant.sid.clone())
            .or_default()
            .access_ref_counts
            .entry(grant.access)
            .or_default() += 1;
        Ok(())
    }

    fn release(&mut self, grant: &AclGrant) -> Result<(), SandboxError> {
        let by_sid = self
            .active
            .get(&grant.path)
            .ok_or_else(|| SandboxError::new("Windows ACL lease path was not registered"))?;
        let active = by_sid
            .get(&grant.sid)
            .ok_or_else(|| SandboxError::new("Windows ACL lease SID was not registered"))?;
        if active
            .access_ref_counts
            .get(&grant.access)
            .copied()
            .unwrap_or(0)
            == 0
        {
            return Err(SandboxError::new(
                "Windows ACL lease permission was not registered",
            ));
        }
        let previous = active.effective_access();
        let next = active.effective_access_after_release(grant.access);
        if previous != next {
            self.writer.set_sid_access(&grant.path, &grant.sid, next)?;
        }

        let by_sid = self.active.get_mut(&grant.path).expect("checked above");
        let active = by_sid.get_mut(&grant.sid).expect("checked above");
        let count = active
            .access_ref_counts
            .get_mut(&grant.access)
            .expect("checked above");
        *count -= 1;
        if *count == 0 {
            active.access_ref_counts.remove(&grant.access);
        }
        if active.access_ref_counts.is_empty() {
            by_sid.remove(&grant.sid);
        }
        if by_sid.is_empty() {
            self.active.remove(&grant.path);
        }
        Ok(())
    }
}

static ACL_BROKER: OnceLock<Mutex<AclBroker<NativeAclWriter>>> = OnceLock::new();

fn system_acl_broker() -> &'static Mutex<AclBroker<NativeAclWriter>> {
    ACL_BROKER.get_or_init(|| Mutex::new(AclBroker::new(NativeAclWriter)))
}

struct AclLease {
    grants: Vec<AclGrant>,
}

impl AclLease {
    unsafe fn grant(
        executable: &Path,
        package_root: &Path,
        sid: PSID,
    ) -> Result<Self, SandboxError> {
        let sid = copy_sid(sid)?;
        let mut lease = Self { grants: Vec::new() };
        lease.grant_path(executable, &sid, true)?;
        let mut paths = Vec::new();
        collect_package_paths(package_root, &mut paths)?;
        for path in paths {
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| SandboxError::new("Windows package ACL target disappeared"))?;
            lease.grant_path(&path, &sid, metadata.is_dir())?;
        }
        Ok(lease)
    }

    fn grant_path(&mut self, path: &Path, sid: &[u8], execute: bool) -> Result<(), SandboxError> {
        let grant = AclGrant::resolve(path, sid, execute)?;
        system_acl_broker()
            .lock()
            .map_err(|_| SandboxError::new("Windows ACL broker is unavailable"))?
            .acquire(&grant)?;
        self.grants.push(grant);
        Ok(())
    }
}

impl Drop for AclLease {
    fn drop(&mut self) {
        let mut broker = match system_acl_broker().lock() {
            Ok(broker) => broker,
            Err(poisoned) => poisoned.into_inner(),
        };
        for grant in self.grants.iter().rev() {
            if let Err(error) = broker.release(grant) {
                tracing::error!(%error, path = %grant.path.display(), "Windows ACL lease release failed");
            }
        }
    }
}

fn copy_sid(sid: PSID) -> Result<Vec<u8>, SandboxError> {
    if sid.is_null() {
        return Err(SandboxError::new("Windows AppContainer SID is invalid"));
    }
    let bytes = unsafe { GetLengthSid(sid) } as usize;
    if bytes == 0 {
        return Err(SandboxError::new("Windows AppContainer SID is invalid"));
    }
    let mut owned = vec![0u8; bytes];
    unsafe {
        std::ptr::copy_nonoverlapping(sid.cast::<u8>(), owned.as_mut_ptr(), bytes);
    }
    Ok(owned)
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = LocalFree(self.0);
            }
        }
    }
}

fn collect_package_paths(path: &Path, paths: &mut Vec<PathBuf>) -> Result<(), SandboxError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| SandboxError::new("Windows plugin package path is unavailable"))?;
    if metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(SandboxError::new(
            "Windows plugin packages may not contain reparse points",
        ));
    }
    paths.push(path.to_path_buf());
    if metadata.is_dir() {
        let entries = fs::read_dir(path)
            .map_err(|_| SandboxError::new("Windows plugin package cannot be enumerated"))?;
        for entry in entries {
            let entry = entry
                .map_err(|_| SandboxError::new("Windows plugin package cannot be enumerated"))?;
            collect_package_paths(&entry.path(), paths)?;
        }
    } else if !metadata.is_file() {
        return Err(SandboxError::new(
            "Windows plugin packages may contain only files and directories",
        ));
    }
    Ok(())
}

fn profile_name(package_root: &Path, temporary: bool) -> Result<std::ffi::OsString, SandboxError> {
    let package_hash = package_identity_hash(package_root);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SandboxError::new("Windows AppContainer profile clock is unavailable"))?
        .as_nanos() as u64;
    let sequence = NEXT_PROFILE_ID.fetch_add(1, Ordering::Relaxed);
    let nonce = now ^ sequence.rotate_left(17) ^ u64::from(std::process::id()).rotate_left(33);
    let probe = if temporary { ".p" } else { "" };
    Ok(std::ffi::OsString::from(format!(
        "{APPCONTAINER_PREFIX}.{package_hash:016x}.{nonce:016x}{probe}"
    )))
}

fn package_identity_hash(package_root: &Path) -> u64 {
    let mut first = 0xcbf29ce484222325u64;
    let mut second = 0x9e3779b97f4a7c15u64;
    for unit in package_root.as_os_str().encode_wide() {
        let value = u64::from(unit);
        first = (first ^ value).wrapping_mul(0x100000001b3);
        second = (second ^ value.rotate_left(7)).wrapping_mul(0x9ddfea08eb382d69);
    }
    first ^ second.rotate_left(29)
}

const fn hresult_from_win32(code: u32) -> i32 {
    ((code & 0xffff) | 0x8007_0000) as i32
}

unsafe fn spawn_appcontainer_suspended(
    launch: &SandboxLaunch<'_>,
    temporary_profile: bool,
) -> Result<WindowsSandboxedProcess, SandboxError> {
    let executable = fs::canonicalize(launch.sidecar_executable)
        .map_err(|_| SandboxError::new("Windows plugin host executable cannot be resolved"))?;
    let package_root = fs::canonicalize(launch.package_root)
        .map_err(|_| SandboxError::new("Windows plugin package root cannot be resolved"))?;
    let profile_name = profile_name(&package_root, temporary_profile)?;
    let profile = unsafe { AppContainerProfile::open(&profile_name)? };
    let acl = unsafe { AclLease::grant(&executable, &package_root, profile.sid())? };
    let job = unsafe { create_constrained_job(launch.memory_limit_bytes)? };
    verify_job_limits(&job, launch.memory_limit_bytes)?;
    let (child_stdin, parent_stdin) = unsafe { create_pipe_pair(false)? };
    let (parent_stdout, child_stdout) = unsafe { create_pipe_pair(true)? };
    let null_stderr = unsafe { open_null_output()? };

    let executable_wide = wide_null(executable.as_os_str());
    let current_directory = wide_null(package_root.as_os_str());
    let mut command_line = command_line(&executable, launch.arguments);
    // The self-test and production launch execute the same trusted sidecar, so
    // both must prove they start with the strict non-secret system allowlist.
    let mut environment = sanitized_environment_block()?;
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid(),
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let inherited_handles = [
        raw_handle(&child_stdin),
        raw_handle(&child_stdout),
        raw_handle(&null_stderr),
    ];
    let child_process_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    let attributes = unsafe {
        ProcessAttributeList::security_capabilities(
            &capabilities,
            &inherited_handles,
            &child_process_policy,
        )?
    };
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw_handle(&child_stdin);
    startup.StartupInfo.hStdOutput = raw_handle(&child_stdout);
    startup.StartupInfo.hStdError = raw_handle(&null_stderr);
    startup.lpAttributeList = attributes.as_ptr();
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    // SECURITY_CAPABILITIES is the supported CreateProcessW LowBox path. It
    // constructs the AppContainer token without requiring the caller to hold
    // TOKEN_ASSIGN_PRIMARY or SeAssignPrimaryTokenPrivilege. Supplying a
    // separately restricted token would require CreateProcessAsUserW and is
    // intentionally not mixed with this AppContainer boundary.
    let created = unsafe {
        CreateProcessW(
            executable_wide.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_mut_ptr().cast::<c_void>(),
            current_directory.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(SandboxError::from_win32(
            "Windows AppContainer plugin host could not be created",
            unsafe { GetLastError() },
        ));
    }
    let process_handle = match unsafe { owned_handle(process.hProcess) } {
        Ok(handle) => handle,
        Err(error) => {
            if !process.hThread.is_null() && process.hThread != INVALID_HANDLE_VALUE {
                let _ = unsafe { CloseHandle(process.hThread) };
            }
            return Err(error);
        }
    };
    let thread_handle = match unsafe { owned_handle(process.hThread) } {
        Ok(handle) => handle,
        Err(error) => {
            unsafe { terminate_suspended(&process_handle) };
            return Err(error);
        }
    };

    if unsafe { AssignProcessToJobObject(raw_handle(&job), raw_handle(&process_handle)) } == 0 {
        unsafe { terminate_suspended(&process_handle) };
        return Err(SandboxError::new(
            "Windows plugin host could not be assigned to its Job Object",
        ));
    }
    if unsafe { ResumeThread(raw_handle(&thread_handle)) } == u32::MAX {
        unsafe { terminate_suspended(&process_handle) };
        return Err(SandboxError::new(
            "Windows plugin host primary thread could not be resumed",
        ));
    }

    // Parent endpoints are converted only after successful assignment/resume;
    // every earlier error closes all handles and terminates the suspended child.
    let stdin = File::from(parent_stdin);
    let stdout = File::from(parent_stdout);
    Ok(WindowsSandboxedProcess {
        process: process_handle,
        _job: job,
        _acl: acl,
        _profile: profile,
        stdin: Some(stdin),
        stdout: Some(stdout),
    })
}

fn sanitized_environment_block() -> Result<Vec<u16>, SandboxError> {
    let entries = PLUGIN_ENVIRONMENT_ALLOWLIST
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| ((*name).to_owned(), value)))
        .collect::<Vec<_>>();

    if REQUIRED_PLUGIN_ENVIRONMENT.iter().any(|required| {
        !entries
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case(required) && !value.is_empty())
    }) {
        return Err(SandboxError::new(
            "Windows plugin environment is missing a required system path",
        ));
    }

    encode_environment_block(entries)
}

fn encode_environment_block(
    mut entries: Vec<(String, OsString)>,
) -> Result<Vec<u16>, SandboxError> {
    entries.sort_by(|(left, _), (right, _)| {
        left.to_ascii_uppercase()
            .cmp(&right.to_ascii_uppercase())
            .then_with(|| left.cmp(right))
    });

    let mut block = Vec::new();
    for (name, value) in entries {
        if name.is_empty() || name.contains('=') || name.encode_utf16().any(|unit| unit == 0) {
            return Err(SandboxError::new(
                "Windows plugin environment contains an invalid variable name",
            ));
        }
        let value = value.encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(SandboxError::new(
                "Windows plugin environment contains an invalid variable value",
            ));
        }
        block.extend(name.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

unsafe fn create_constrained_job(memory_limit: usize) -> Result<OwnedHandle, SandboxError> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    let job = unsafe { owned_handle(job) }?;
    let limits = job_limit_information(memory_limit);
    if unsafe {
        SetInformationJobObject(
            raw_handle(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(SandboxError::new(
            "Windows Job Object limits could not be applied",
        ));
    }
    Ok(job)
}

fn verify_job_limits(job: &OwnedHandle, memory_limit: usize) -> Result<(), SandboxError> {
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    if unsafe {
        QueryInformationJobObject(
            raw_handle(job),
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        )
    } == 0
    {
        return Err(SandboxError::new(
            "Windows Job Object limits could not be verified",
        ));
    }
    let required = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    if limits.BasicLimitInformation.LimitFlags & required != required
        || limits.BasicLimitInformation.ActiveProcessLimit != 1
        || limits.ProcessMemoryLimit != memory_limit
    {
        return Err(SandboxError::new(
            "Windows Job Object limits differ from the required policy",
        ));
    }
    Ok(())
}

fn job_limit_information(memory_limit: usize) -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = memory_limit;
    limits
}

unsafe fn create_pipe_pair(parent_reads: bool) -> Result<(OwnedHandle, OwnedHandle), SandboxError> {
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe {
        windows_sys::Win32::System::Pipes::CreatePipe(&mut read, &mut write, &mut attributes, 0)
    } == 0
    {
        return Err(SandboxError::new(
            "Windows plugin host pipe could not be created",
        ));
    }
    let read = unsafe { owned_handle(read) }?;
    let write = unsafe { owned_handle(write) }?;
    let parent = if parent_reads { &read } else { &write };
    if unsafe { SetHandleInformation(raw_handle(parent), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(SandboxError::new(
            "Windows plugin host parent pipe could not be protected",
        ));
    }
    Ok((read, write))
}

unsafe fn open_null_output() -> Result<OwnedHandle, SandboxError> {
    let name = wide_null(OsStr::new("NUL"));
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(SandboxError::new(
            "Windows plugin host null stderr could not be opened",
        ))
    } else {
        unsafe { owned_handle(handle) }
    }
}

unsafe fn terminate_suspended(process: &OwnedHandle) {
    unsafe {
        let process = raw_handle(process);
        let _ = TerminateProcess(process, 1);
        let _ = WaitForSingleObject(process, INFINITE);
    }
}

unsafe fn owned_handle(handle: HANDLE) -> Result<OwnedHandle, SandboxError> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(SandboxError::new(
            "Windows returned an invalid native handle",
        ))
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast::<c_void>()) })
    }
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast::<c_void>()
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn command_line(executable: &Path, arguments: &[std::ffi::OsString]) -> Vec<u16> {
    let mut command = quote_windows_argument(executable.as_os_str());
    for argument in arguments {
        command.push(' ');
        command.push_str(&quote_windows_argument(argument));
    }
    OsStr::new(&command).encode_wide().chain([0]).collect()
}

fn quote_windows_argument(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if !value.is_empty() && !value.contains(|character| matches!(character, ' ' | '\t' | '"')) {
        return value.into_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

fn run_self_test(sidecar: &Path) -> Result<(), SandboxError> {
    validate_probe_executable(sidecar)?;
    let sidecar = fs::canonicalize(sidecar)
        .map_err(|_| SandboxError::new("Windows sandbox probe executable cannot be resolved"))?;
    let fixture = WindowsSelfTestFixture::create()?;
    let base_arguments = vec![
        std::ffi::OsString::from("--native-sandbox-self-test"),
        fixture.package.clone().into_os_string(),
        fixture.sensitive_file.clone().into_os_string(),
        sidecar.clone().into_os_string(),
    ];
    match run_self_test_probe(&sidecar, &fixture.package, &base_arguments)? {
        0 => {}
        41 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove network denial",
            ));
        }
        42 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove child-process denial",
            ));
        }
        43 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove sensitive-file denial",
            ));
        }
        44 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove read-only package access",
            ));
        }
        45 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove the process memory limit",
            ));
        }
        48 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test could not read the package fixture",
            ));
        }
        49 => {
            return Err(SandboxError::new(
                "Windows AppContainer self-test did not prove sensitive-file denial",
            ));
        }
        code => {
            return Err(SandboxError::from_process_exit(
                "Windows AppContainer base self-test failed",
                code,
            ));
        }
    }

    let crash_arguments = vec![std::ffi::OsString::from("--native-sandbox-crash")];
    let crash_code = run_self_test_probe(&sidecar, &fixture.package, &crash_arguments)?;
    if crash_code == 0 || crash_code == STILL_ACTIVE as u32 {
        return Err(SandboxError::new(
            "Windows AppContainer crash probe was not observed as failed",
        ));
    }

    let hang_arguments = vec![std::ffi::OsString::from("--native-sandbox-hang")];
    run_hang_termination_probe(&sidecar, &fixture.package, &hang_arguments)
}

fn run_self_test_probe(
    executable: &Path,
    package_root: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<u32, SandboxError> {
    let launch = SandboxLaunch {
        sidecar_executable: executable,
        package_root,
        memory_limit_bytes: MAX_HOST_MEMORY_BYTES,
        arguments,
    };
    validate_launch(&launch)?;
    let mut process = unsafe { spawn_appcontainer_suspended(&launch, true)? };
    process.stdin.take();
    let wait = unsafe { WaitForSingleObject(raw_handle(&process.process), SELF_TEST_TIMEOUT_MS) };
    if wait == WAIT_TIMEOUT {
        process.terminate_and_wait();
        return Err(SandboxError::new(
            "Windows AppContainer self-test timed out",
        ));
    }
    if wait != WAIT_OBJECT_0 {
        process.terminate_and_wait();
        return Err(SandboxError::new(
            "Windows AppContainer self-test could not be observed",
        ));
    }
    let mut code = 0u32;
    if unsafe { GetExitCodeProcess(raw_handle(&process.process), &mut code) } == 0 {
        return Err(SandboxError::new(
            "Windows AppContainer self-test exit status is unavailable",
        ));
    }
    Ok(code)
}

fn run_hang_termination_probe(
    executable: &Path,
    package_root: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<(), SandboxError> {
    let launch = SandboxLaunch {
        sidecar_executable: executable,
        package_root,
        memory_limit_bytes: MAX_HOST_MEMORY_BYTES,
        arguments,
    };
    validate_launch(&launch)?;
    let mut process = unsafe { spawn_appcontainer_suspended(&launch, true)? };
    process.stdin.take();

    let observed =
        unsafe { WaitForSingleObject(raw_handle(&process.process), HANG_OBSERVATION_MS) };
    if observed == WAIT_OBJECT_0 {
        return Err(SandboxError::new(
            "Windows AppContainer hang probe exited before termination",
        ));
    }
    if observed != WAIT_TIMEOUT {
        process.terminate_and_wait();
        return Err(SandboxError::new(
            "Windows AppContainer hang probe could not be observed",
        ));
    }

    if unsafe { TerminateProcess(raw_handle(&process.process), HANG_TERMINATION_EXIT_CODE) } == 0 {
        process.terminate_and_wait();
        return Err(SandboxError::new(
            "Windows AppContainer hang probe could not be terminated",
        ));
    }
    if unsafe { WaitForSingleObject(raw_handle(&process.process), HANG_TERMINATION_TIMEOUT_MS) }
        != WAIT_OBJECT_0
    {
        process.terminate_and_wait();
        return Err(SandboxError::new(
            "Windows AppContainer terminated hang probe could not be reaped",
        ));
    }
    let mut code = 0u32;
    if unsafe { GetExitCodeProcess(raw_handle(&process.process), &mut code) } == 0
        || code != HANG_TERMINATION_EXIT_CODE
    {
        return Err(SandboxError::new(
            "Windows AppContainer hang probe termination was not observed",
        ));
    }
    Ok(())
}

fn validate_probe_executable(executable: &Path) -> Result<(), SandboxError> {
    let metadata = fs::symlink_metadata(executable)
        .map_err(|_| SandboxError::new("Windows sandbox probe executable is unavailable"))?;
    if metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !metadata.is_file()
    {
        return Err(SandboxError::new(
            "Windows sandbox probe is not a protected regular file",
        ));
    }
    Ok(())
}

struct WindowsSelfTestFixture {
    root: PathBuf,
    package: PathBuf,
    sensitive_file: PathBuf,
}

impl WindowsSelfTestFixture {
    fn create() -> Result<Self, SandboxError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SandboxError::new("Windows sandbox self-test clock is unavailable"))?
            .as_nanos();
        let id = NEXT_SELF_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "bbcom-plugin-appcontainer-selftest-{}-{now}-{id}",
            std::process::id()
        ));
        fs::create_dir(&root)
            .map_err(|_| SandboxError::new("Windows sandbox self-test root cannot be created"))?;
        let package = root.join("package");
        let sensitive = root.join("sensitive");
        if fs::create_dir(&package).is_err() || fs::create_dir(&sensitive).is_err() {
            let _ = fs::remove_dir_all(&root);
            return Err(SandboxError::new(
                "Windows sandbox self-test fixture cannot be created",
            ));
        }
        let sensitive_file = sensitive.join("secret.txt");
        let writes = [
            (package.join("package-marker"), SELF_TEST_MARKER),
            (sensitive_file.clone(), SELF_TEST_SECRET),
        ];
        for (path, contents) in writes {
            if fs::write(path, contents).is_err() {
                let _ = fs::remove_dir_all(&root);
                return Err(SandboxError::new(
                    "Windows sandbox self-test fixture cannot be written",
                ));
            }
        }
        Ok(Self {
            root,
            package,
            sensitive_file,
        })
    }
}

impl Drop for WindowsSelfTestFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingAclWriter {
        effective: BTreeMap<(PathBuf, Vec<u8>), u32>,
    }

    impl AclWriter for RecordingAclWriter {
        fn set_sid_access(
            &mut self,
            path: &Path,
            sid: &[u8],
            access: Option<u32>,
        ) -> Result<(), SandboxError> {
            let key = (path.to_path_buf(), sid.to_vec());
            if let Some(access) = access {
                self.effective.insert(key, access);
            } else {
                self.effective.remove(&key);
            }
            Ok(())
        }
    }

    #[test]
    fn job_policy_is_kill_on_close_single_process_and_exact_memory() {
        let limits = job_limit_information(MAX_HOST_MEMORY_BYTES);
        assert_eq!(limits.BasicLimitInformation.ActiveProcessLimit, 1);
        assert_eq!(limits.ProcessMemoryLimit, MAX_HOST_MEMORY_BYTES);
        assert_eq!(
            limits.BasicLimitInformation.LimitFlags,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        );
    }

    #[test]
    fn command_line_quoting_preserves_spaces_quotes_and_trailing_slashes() {
        assert_eq!(quote_windows_argument(OsStr::new("plain")), "plain");
        assert_eq!(
            quote_windows_argument(OsStr::new("two words")),
            "\"two words\""
        );
        assert_eq!(
            quote_windows_argument(OsStr::new("a\\\"b")),
            "\"a\\\\\\\"b\""
        );
        assert_eq!(
            quote_windows_argument(OsStr::new("trail \\")),
            r#""trail \\""#
        );
    }

    #[test]
    fn environment_block_is_sorted_unicode_and_double_null_terminated() {
        let block = encode_environment_block(vec![
            ("TMP".to_owned(), OsString::from(r"C:\Temp")),
            ("SystemRoot".to_owned(), OsString::from(r"C:\Windows")),
        ])
        .expect("environment block");
        let expected = "SystemRoot=C:\\Windows\0TMP=C:\\Temp\0\0"
            .encode_utf16()
            .collect::<Vec<_>>();
        assert_eq!(block, expected);
        assert_eq!(
            encode_environment_block(Vec::new()).expect("empty environment block"),
            vec![0, 0]
        );
    }

    #[test]
    fn environment_block_rejects_embedded_nulls() {
        let invalid_value =
            OsString::from_wide(&[u16::from(b'C'), u16::from(b':'), 0, u16::from(b'x')]);
        assert!(encode_environment_block(vec![("TEMP".to_owned(), invalid_value)]).is_err());
        assert!(
            encode_environment_block(vec![("BAD\0NAME".to_owned(), OsString::from("value"))])
                .is_err()
        );
    }

    #[test]
    fn plugin_environment_allowlist_contains_only_system_paths() {
        assert_eq!(
            PLUGIN_ENVIRONMENT_ALLOWLIST,
            [
                "ALLUSERSPROFILE",
                "APPDATA",
                "ComSpec",
                "HOMEDRIVE",
                "HOMEPATH",
                "LOCALAPPDATA",
                "OS",
                "PATHEXT",
                "ProgramData",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "SystemDrive",
                "SystemRoot",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "windir",
            ]
        );
    }

    #[test]
    fn appcontainer_profile_identity_is_package_scoped() {
        let first =
            profile_name(Path::new(r"C:\packages\first"), false).expect("first profile name");
        let repeated =
            profile_name(Path::new(r"C:\packages\first"), false).expect("repeated profile name");
        let second =
            profile_name(Path::new(r"C:\packages\second"), false).expect("second profile name");
        assert_ne!(first, repeated, "every host must receive a fresh SID");
        assert_ne!(first, second);
        assert!(first.to_string_lossy().starts_with(APPCONTAINER_PREFIX));
        assert_eq!(
            package_identity_hash(Path::new(r"C:\packages\first")),
            package_identity_hash(Path::new(r"C:\packages\first"))
        );
        assert_ne!(
            package_identity_hash(Path::new(r"C:\packages\first")),
            package_identity_hash(Path::new(r"C:\packages\second"))
        );
    }

    #[test]
    fn appcontainer_has_no_declared_network_capabilities() {
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: null_mut(),
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        assert_eq!(capabilities.CapabilityCount, 0);
        assert!(capabilities.Capabilities.is_null());
    }

    #[test]
    fn shared_acl_leases_release_safely_out_of_lifo_order() {
        let path = PathBuf::from(r"C:\Program Files\bbcom\bbcom-plugin-host.exe");
        let first = AclGrant {
            path: path.clone(),
            sid: vec![1, 1, 1],
            access: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        };
        let second = AclGrant {
            path: path.clone(),
            sid: vec![2, 2, 2],
            access: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        };
        let mut broker = AclBroker::new(RecordingAclWriter::default());

        broker.acquire(&first).expect("first lease");
        broker.acquire(&second).expect("second lease");
        broker.release(&first).expect("first lease released first");

        assert!(
            !broker
                .writer
                .effective
                .contains_key(&(path.clone(), first.sid.clone()))
        );
        assert_eq!(
            broker
                .writer
                .effective
                .get(&(path.clone(), second.sid.clone())),
            Some(&(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)),
            "releasing the older lease must preserve the newer SID grant"
        );

        broker.release(&second).expect("second lease released");
        assert!(broker.writer.effective.is_empty());
        assert!(broker.active.is_empty());
    }
}
