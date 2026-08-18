use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use super::{SandboxDriver, SandboxError, SandboxLaunch, SandboxSelfTest};

const MAX_HOST_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const DEFAULT_BWRAP: &str = "/usr/bin/bwrap";

/// Prefer the distro-managed absolute path; fall back to a PATH lookup for
/// distributions that install bubblewrap elsewhere (NixOS, some containers).
/// `verified_bwrap` applies the identical owner/permission/regular-file
/// validation to whichever candidate is chosen.
fn resolve_bwrap_path() -> PathBuf {
    if fs::symlink_metadata(DEFAULT_BWRAP).is_ok() {
        return PathBuf::from(DEFAULT_BWRAP);
    }
    let Some(path_var) = std::env::var_os("PATH") else {
        return PathBuf::from(DEFAULT_BWRAP);
    };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("bwrap");
        if fs::symlink_metadata(&candidate).is_ok() {
            return candidate;
        }
    }
    PathBuf::from(DEFAULT_BWRAP)
}

const SELF_TEST_PYTHON: &str = "/usr/bin/python3";
const SELF_TEST_MARKER: &str = "bbcom-private-root";
const PROCESS_PROBE_OBSERVATION: Duration = Duration::from_millis(200);
const SELF_TEST_SCRIPT: &str = r#"
import errno
import os
import resource
import socket
import sys

root = sys.argv[1]
limit = int(sys.argv[2])

try:
    with open(os.path.join(root, "sandbox-marker"), "r", encoding="ascii") as marker:
        if marker.read() != "bbcom-private-root":
            raise SystemExit(33)
    try:
        open("/etc/passwd", "rb")
    except (FileNotFoundError, PermissionError):
        pass
    else:
        raise SystemExit(33)
except OSError:
    raise SystemExit(33)

try:
    with open(os.path.join(root, "sandbox-write-probe"), "wb") as probe:
        probe.write(b"sandbox escaped read-only package mount")
except OSError as error:
    if error.errno not in (errno.EROFS, errno.EPERM, errno.EACCES):
        raise SystemExit(35)
else:
    raise SystemExit(35)

try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except OSError as error:
    if error.errno not in (errno.EPERM, errno.EACCES):
        raise SystemExit(31)
else:
    raise SystemExit(31)

try:
    os.fork()
except OSError as error:
    if error.errno not in (errno.EPERM, errno.EACCES):
        raise SystemExit(32)
else:
    os._exit(32)

soft, hard = resource.getrlimit(resource.RLIMIT_AS)
if soft != limit or hard != limit:
    raise SystemExit(34)

try:
    allocation = bytearray(limit)
except MemoryError:
    pass
else:
    del allocation
    raise SystemExit(34)
"#;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

/// Linux sandbox backed by bubblewrap namespaces and a seccomp cBPF policy.
///
/// The filesystem namespace starts empty. The trusted system runtime is
/// mounted read-only, the selected package is mounted read-only at its native
/// absolute path, and `/tmp` plus `/dev` are private. A seccomp filter rejects
/// socket creation and non-thread process creation. `RLIMIT_AS` provides the
/// hard 256 MiB process address-space boundary.
#[derive(Clone, Debug)]
pub struct LinuxSandboxDriver {
    bwrap: PathBuf,
}

impl LinuxSandboxDriver {
    #[must_use]
    pub fn system() -> Self {
        Self {
            bwrap: resolve_bwrap_path(),
        }
    }

    #[must_use]
    pub fn new(bwrap: PathBuf) -> Self {
        Self { bwrap }
    }

    fn verified_bwrap(&self) -> Result<PathBuf, SandboxError> {
        let metadata = fs::symlink_metadata(&self.bwrap)
            .map_err(|_| SandboxError::new("bubblewrap executable is unavailable"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SandboxError::new(
                "bubblewrap path must be a regular non-symlink file",
            ));
        }
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(SandboxError::new(
                "bubblewrap executable is not owned and protected by the system",
            ));
        }
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(SandboxError::new("bubblewrap executable is not executable"));
        }
        fs::canonicalize(&self.bwrap)
            .map_err(|_| SandboxError::new("bubblewrap executable cannot be resolved"))
    }

    fn build_command(
        &self,
        executable: &Path,
        package_root: &Path,
        memory_limit_bytes: usize,
    ) -> Result<Command, SandboxError> {
        let bwrap = self.verified_bwrap()?;
        validate_launch_paths(executable, package_root, memory_limit_bytes)?;
        let policy = create_seccomp_policy_file()?;
        let policy_fd = policy.as_raw_fd();

        let mut command = Command::new(bwrap);
        command
            .arg("--unshare-all")
            .arg("--new-session")
            .arg("--die-with-parent")
            .arg("--as-pid-1")
            .arg("--cap-drop")
            .arg("ALL")
            .arg("--clearenv")
            .arg("--ro-bind")
            .arg("/usr")
            .arg("/usr")
            .arg("--ro-bind-try")
            .arg("/lib")
            .arg("/lib")
            .arg("--ro-bind-try")
            .arg("/lib64")
            .arg("/lib64")
            .arg("--ro-bind-try")
            .arg("/etc/ld.so.cache")
            .arg("/etc/ld.so.cache")
            .arg("--proc")
            .arg("/proc")
            .arg("--dev")
            .arg("/dev")
            .arg("--tmpfs")
            .arg("/tmp")
            .arg("--ro-bind")
            .arg(package_root)
            .arg(package_root)
            .arg("--ro-bind")
            .arg(executable)
            .arg(executable)
            .arg("--chdir")
            .arg(package_root)
            .arg("--seccomp")
            .arg(policy_fd.to_string())
            .arg("--")
            .arg(executable);

        // The filter FD is deliberately captured by the pre-exec callback so
        // it remains open until bubblewrap consumes it. The callback removes
        // CLOEXEC and installs the inherited hard memory boundary before the
        // trusted wrapper starts.
        unsafe {
            command.pre_exec(move || {
                let flags = fcntl(policy_fd, F_GETFD);
                if flags < 0 || fcntl(policy_fd, F_SETFD, flags & !FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let limit = RLimit {
                    current: memory_limit_bytes as u64,
                    maximum: memory_limit_bytes as u64,
                };
                if setrlimit(RLIMIT_AS, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let _keep_policy_open = &policy;
                Ok(())
            });
        }
        Ok(command)
    }

    fn run_self_test(&self) -> Result<(), SandboxError> {
        let python = fs::canonicalize(SELF_TEST_PYTHON)
            .map_err(|_| SandboxError::new("Linux sandbox probe interpreter is unavailable"))?;
        let metadata = fs::symlink_metadata(&python)
            .map_err(|_| SandboxError::new("Linux sandbox probe interpreter is unavailable"))?;
        if !metadata.is_file() {
            return Err(SandboxError::new(
                "Linux sandbox probe interpreter is not a regular file",
            ));
        }

        let root = SelfTestRoot::create()?;
        fs::write(root.path.join("sandbox-marker"), SELF_TEST_MARKER)
            .map_err(|_| SandboxError::new("Linux sandbox self-test fixture cannot be written"))?;
        let mut command = self.build_command(&python, &root.path, MAX_HOST_MEMORY_BYTES)?;
        command
            .env_clear()
            .arg("-I")
            .arg("-c")
            .arg(SELF_TEST_SCRIPT)
            .arg(&root.path)
            .arg(MAX_HOST_MEMORY_BYTES.to_string());
        let status = command
            .status()
            .map_err(|_| SandboxError::new("Linux sandbox self-test could not start"))?;
        match status.code() {
            Some(0) => self.run_process_resilience_probes(&python, &root.path),
            Some(31) => Err(SandboxError::new(
                "Linux sandbox self-test did not prove network denial",
            )),
            Some(32) => Err(SandboxError::new(
                "Linux sandbox self-test did not prove child-process denial",
            )),
            Some(33) => Err(SandboxError::new(
                "Linux sandbox self-test did not prove filesystem confinement",
            )),
            Some(34) => Err(SandboxError::new(
                "Linux sandbox self-test did not prove the memory limit",
            )),
            Some(35) => Err(SandboxError::new(
                "Linux sandbox self-test did not prove read-only package access",
            )),
            _ => Err(SandboxError::new("Linux sandbox self-test failed")),
        }
    }

    fn run_process_resilience_probes(
        &self,
        python: &Path,
        package_root: &Path,
    ) -> Result<(), SandboxError> {
        let mut crash = self.build_command(python, package_root, MAX_HOST_MEMORY_BYTES)?;
        let crash_status = crash
            .env_clear()
            .arg("-I")
            .arg("-S")
            .arg("-c")
            .arg("import os; os.abort()")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| SandboxError::new("Linux sandbox crash probe could not start"))?;
        if crash_status.success() {
            return Err(SandboxError::new(
                "Linux sandbox crash probe was not observed as failed",
            ));
        }

        let mut hang = self.build_command(python, package_root, MAX_HOST_MEMORY_BYTES)?;
        let mut child = hang
            .env_clear()
            .arg("-I")
            .arg("-S")
            .arg("-c")
            .arg("while True: pass")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| SandboxError::new("Linux sandbox hang probe could not start"))?;
        thread::sleep(PROCESS_PROBE_OBSERVATION);
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) => {
                return Err(SandboxError::new(
                    "Linux sandbox hang probe exited before termination",
                ));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SandboxError::new(
                    "Linux sandbox hang probe could not be observed",
                ));
            }
        }
        if child.kill().is_err() {
            let _ = child.wait();
            return Err(SandboxError::new(
                "Linux sandbox hang probe could not be terminated",
            ));
        }
        let killed_status = child
            .wait()
            .map_err(|_| SandboxError::new("Linux sandbox hang probe could not be reaped"))?;
        if killed_status.success() {
            return Err(SandboxError::new(
                "Linux sandbox terminated hang probe reported success",
            ));
        }
        Ok(())
    }
}

impl Default for LinuxSandboxDriver {
    fn default() -> Self {
        Self::system()
    }
}

impl SandboxDriver for LinuxSandboxDriver {
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
        self.build_command(
            launch.sidecar_executable,
            launch.package_root,
            launch.memory_limit_bytes,
        )
    }

    fn platform_argument(&self) -> &'static str {
        "linux"
    }
}

fn validate_launch_paths(
    executable: &Path,
    package_root: &Path,
    memory_limit_bytes: usize,
) -> Result<(), SandboxError> {
    if memory_limit_bytes != MAX_HOST_MEMORY_BYTES {
        return Err(SandboxError::new(
            "Linux plugin host memory limit must be exactly 256 MiB",
        ));
    }
    if !executable.is_absolute() || !package_root.is_absolute() {
        return Err(SandboxError::new("Linux sandbox paths must be absolute"));
    }
    let executable_metadata = fs::symlink_metadata(executable)
        .map_err(|_| SandboxError::new("plugin host executable is unavailable"))?;
    if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
        return Err(SandboxError::new(
            "plugin host executable must be a regular non-symlink file",
        ));
    }
    let package_metadata = fs::symlink_metadata(package_root)
        .map_err(|_| SandboxError::new("plugin package root is unavailable"))?;
    if package_metadata.file_type().is_symlink() || !package_metadata.is_dir() {
        return Err(SandboxError::new(
            "plugin package root must be a non-symlink directory",
        ));
    }
    Ok(())
}

struct SelfTestRoot {
    path: PathBuf,
}

impl SelfTestRoot {
    fn create() -> Result<Self, SandboxError> {
        for _ in 0..32 {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "bbcom-plugin-sandbox-selftest-{}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(
                        |_| SandboxError::new("Linux sandbox self-test root cannot be protected"),
                    )?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    return Err(SandboxError::new(
                        "Linux sandbox self-test root cannot be created",
                    ));
                }
            }
        }
        Err(SandboxError::new(
            "Linux sandbox self-test root cannot be allocated",
        ))
    }
}

impl Drop for SelfTestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path.join("sandbox-marker"));
        let _ = fs::remove_file(self.path.join("sandbox-write-probe"));
        let _ = fs::remove_dir(&self.path);
    }
}

fn create_seccomp_policy_file() -> Result<File, SandboxError> {
    let policy = seccomp_program()?;
    for _ in 0..32 {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!(".bbcom-plugin-seccomp-{}-{id}", std::process::id()));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true).mode(0o600);
        match options.open(&path) {
            Ok(mut file) => {
                if file.write_all(&policy).is_err()
                    || file.flush().is_err()
                    || file.seek(SeekFrom::Start(0)).is_err()
                {
                    let _ = fs::remove_file(path);
                    return Err(SandboxError::new("seccomp policy cannot be materialized"));
                }
                if fs::remove_file(path).is_err() {
                    return Err(SandboxError::new("seccomp policy cannot be unlinked"));
                }
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SandboxError::new("seccomp policy file cannot be created")),
        }
    }
    Err(SandboxError::new("seccomp policy file cannot be allocated"))
}

#[derive(Clone, Copy)]
struct FilterInstruction {
    code: u16,
    jump_true: u8,
    jump_false: u8,
    value: u32,
}

impl FilterInstruction {
    fn append_to(self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(&self.code.to_ne_bytes());
        bytes.push(self.jump_true);
        bytes.push(self.jump_false);
        bytes.extend_from_slice(&self.value.to_ne_bytes());
    }
}

fn seccomp_program() -> Result<Vec<u8>, SandboxError> {
    let (audit_arch, clone_syscall, denied_syscalls): (u32, u32, &[u32]) = architecture_policy()?;
    let mut instructions = vec![
        load_absolute(SECCOMP_ARCH_OFFSET),
        jump_equal(audit_arch, 1, 0),
        return_value(SECCOMP_RET_KILL_PROCESS),
        load_absolute(SECCOMP_SYSCALL_OFFSET),
    ];

    #[cfg(target_arch = "x86_64")]
    {
        instructions.push(jump_greater_or_equal(X32_SYSCALL_BIT, 0, 1));
        instructions.push(return_value(SECCOMP_RET_KILL_PROCESS));
    }

    // cBPF cannot safely dereference clone3's argument structure. Returning
    // ENOSYS makes libc use legacy clone, whose flag word can be inspected
    // below, without permitting clone3-based process creation.
    instructions.push(jump_equal(CLONE3_SYSCALL, 0, 1));
    instructions.push(return_value(SECCOMP_RET_ERRNO_ENOSYS));

    for syscall in denied_syscalls {
        instructions.push(jump_equal(*syscall, 0, 1));
        instructions.push(return_value(SECCOMP_RET_ERRNO_EPERM));
    }

    // clone is permitted only for a real thread. Linux requires CLONE_THREAD
    // to be paired with the VM/sighand sharing flags, so this cannot create an
    // independently privileged child process.
    instructions.push(jump_equal(clone_syscall, 0, 3));
    instructions.push(load_absolute(SECCOMP_ARGUMENT_0_OFFSET));
    instructions.push(jump_bits_set(CLONE_THREAD, 1, 0));
    instructions.push(return_value(SECCOMP_RET_ERRNO_EPERM));
    instructions.push(return_value(SECCOMP_RET_ALLOW));

    let mut bytes = Vec::with_capacity(instructions.len() * 8);
    for instruction in instructions {
        instruction.append_to(&mut bytes);
    }
    Ok(bytes)
}

#[cfg(target_arch = "x86_64")]
fn architecture_policy() -> Result<(u32, u32, &'static [u32]), SandboxError> {
    // socket, socketpair, fork, vfork, unshare, setns, ptrace,
    // process_vm_readv/writev and pidfd operations.
    Ok((
        0xc000_003e,
        56,
        &[41, 53, 57, 58, 272, 308, 101, 310, 311, 434, 424],
    ))
}

#[cfg(target_arch = "aarch64")]
fn architecture_policy() -> Result<(u32, u32, &'static [u32]), SandboxError> {
    Ok((
        0xc000_00b7,
        220,
        &[198, 199, 97, 268, 117, 270, 271, 434, 424],
    ))
}

#[cfg(target_arch = "riscv64")]
fn architecture_policy() -> Result<(u32, u32, &'static [u32]), SandboxError> {
    Ok((
        0xc000_00f3,
        220,
        &[198, 199, 97, 268, 117, 270, 271, 434, 424],
    ))
}

#[cfg(not(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    target_arch = "riscv64"
)))]
fn architecture_policy() -> Result<(u32, u32, &'static [u32]), SandboxError> {
    Err(SandboxError::new(
        "seccomp policy is unavailable on this Linux architecture",
    ))
}

const fn load_absolute(offset: u32) -> FilterInstruction {
    FilterInstruction {
        code: BPF_LD_W_ABS,
        jump_true: 0,
        jump_false: 0,
        value: offset,
    }
}

const fn jump_equal(value: u32, jump_true: u8, jump_false: u8) -> FilterInstruction {
    FilterInstruction {
        code: BPF_JMP_JEQ_K,
        jump_true,
        jump_false,
        value,
    }
}

#[cfg(target_arch = "x86_64")]
const fn jump_greater_or_equal(value: u32, jump_true: u8, jump_false: u8) -> FilterInstruction {
    FilterInstruction {
        code: BPF_JMP_JGE_K,
        jump_true,
        jump_false,
        value,
    }
}

const fn jump_bits_set(value: u32, jump_true: u8, jump_false: u8) -> FilterInstruction {
    FilterInstruction {
        code: BPF_JMP_JSET_K,
        jump_true,
        jump_false,
        value,
    }
}

const fn return_value(value: u32) -> FilterInstruction {
    FilterInstruction {
        code: BPF_RET_K,
        jump_true: 0,
        jump_false: 0,
        value,
    }
}

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
#[cfg(target_arch = "x86_64")]
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_JMP_JSET_K: u16 = 0x45;
const BPF_RET_K: u16 = 0x06;
const SECCOMP_ARCH_OFFSET: u32 = 4;
const SECCOMP_SYSCALL_OFFSET: u32 = 0;
const SECCOMP_ARGUMENT_0_OFFSET: u32 = 16;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO_EPERM: u32 = 0x0005_0001;
const SECCOMP_RET_ERRNO_ENOSYS: u32 = 0x0005_0026;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const CLONE3_SYSCALL: u32 = 435;
const CLONE_THREAD: u32 = 0x0001_0000;
#[cfg(target_arch = "x86_64")]
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

#[repr(C)]
struct RLimit {
    current: u64,
    maximum: u64,
}

const RLIMIT_AS: i32 = 9;
const F_GETFD: i32 = 1;
const F_SETFD: i32 = 2;
const FD_CLOEXEC: i32 = 1;

unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn setrlimit(resource: i32, limit: *const RLimit) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seccomp_program_is_a_sequence_of_complete_cbpf_instructions() {
        let program = seccomp_program().expect("supported test architecture");
        assert!(!program.is_empty());
        assert_eq!(program.len() % 8, 0);
        assert!(
            program
                .windows(4)
                .any(|bytes| bytes == 0x0005_0001_u32.to_ne_bytes())
        );
        assert!(
            program
                .windows(4)
                .any(|bytes| bytes == 0x7fff_0000_u32.to_ne_bytes())
        );
    }

    #[test]
    fn launch_validation_requires_the_fixed_memory_boundary() {
        let error = validate_launch_paths(Path::new("relative"), Path::new("relative"), 1)
            .expect_err("memory validation happens before path access");
        assert_eq!(
            error.to_string(),
            "Linux plugin host memory limit must be exactly 256 MiB"
        );
    }
}
