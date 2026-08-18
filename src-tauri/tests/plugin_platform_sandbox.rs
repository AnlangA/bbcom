//! Native operating-system sandbox self-test evidence.
//!
//! The normal R1 quality suite compiles but deliberately ignores this test.
//! `.github/workflows/plugin-market-gate.yml` runs it explicitly on the three
//! native operating systems. This is not evidence that a packaged
//! `bbcom-plugin-host` executed a malicious Wasm Component; G45 additionally
//! requires that separate executable probe before it can pass.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use bbcom::plugins::{PlatformSandboxDriver, SandboxDriver, SandboxSelfTest};
use serde::Serialize;

#[test]
#[ignore = "run only in the native G45 plugin market gate"]
fn platform_sandbox_self_test_proves_os_controls() {
    let sandbox = PlatformSandboxDriver::system();
    let sidecar = std::env::var_os("BBCOM_G45_SIDECAR")
        .map(PathBuf::from)
        .expect("BBCOM_G45_SIDECAR must identify the reviewed probe executable");
    let sidecar = fs::canonicalize(sidecar).expect("the reviewed probe executable must exist");
    let evidence = sandbox
        .self_test(&sidecar)
        .expect("the native plugin sandbox self-test must be executable and complete");
    assert!(evidence.blocks_network, "network denial was not proven");
    assert!(
        evidence.blocks_child_processes,
        "child-process denial was not proven"
    );
    assert!(
        evidence.restricts_filesystem,
        "filesystem confinement was not proven"
    );
    assert!(
        evidence.enforces_memory_limit,
        "the 256 MiB host memory limit was not proven"
    );
    assert!(
        evidence.observes_crashed_process,
        "a sandboxed process crash was not observed"
    );
    assert!(
        evidence.terminates_hung_process,
        "a sandboxed hung process was not terminated and reaped"
    );
    write_evidence_when_requested(evidence);
}

fn write_evidence_when_requested(observations: SandboxSelfTest) {
    const OUTPUT: &str = "BBCOM_G45_SANDBOX_EVIDENCE";
    const COMMIT: &str = "BBCOM_G45_COMMIT_SHA";
    const PLATFORM: &str = "BBCOM_G45_PLATFORM";
    const TARGET: &str = "BBCOM_G45_TARGET";

    let Some(output) = std::env::var_os(OUTPUT) else {
        for name in [COMMIT, PLATFORM, TARGET] {
            assert!(
                std::env::var_os(name).is_none(),
                "{name} must not be set without {OUTPUT}"
            );
        }
        return;
    };
    let output = PathBuf::from(output);
    let commit_sha = required_utf8_env(COMMIT);
    let platform = required_utf8_env(PLATFORM);
    let target = required_utf8_env(TARGET);
    let expected = native_identity();
    assert_eq!(platform, expected.platform, "platform evidence mismatch");
    assert_eq!(target, expected.target, "target evidence mismatch");
    assert!(
        commit_sha.len() == 40
            && commit_sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "commit evidence must be a lowercase 40-byte Git SHA"
    );
    assert_eq!(
        output.file_name().and_then(|name| name.to_str()),
        Some(expected.evidence_filename),
        "sandbox evidence filename is not platform-bound"
    );
    let parent = output.parent().expect("sandbox evidence needs a parent");
    fs::create_dir_all(parent).expect("sandbox evidence parent could not be created");
    let document = SandboxEvidence {
        schema_version: 1,
        evidence_kind: "bbcom-native-plugin-sandbox-self-test",
        probe_protocol: "bbcom-plugin-sandbox-g45/v1",
        evidence_scope: "native-sandbox-self-test-not-component-attempt",
        execution: "native-adversarial-process",
        commit_sha: &commit_sha,
        platform: expected.platform,
        target: expected.target,
        market_ready: false,
        controls: &[
            "child-process-denied",
            "crash-observed",
            "filesystem-confined",
            "hang-terminated",
            "memory-limit-enforced",
            "network-denied",
        ],
        observations: SandboxObservations {
            blocks_network: observations.blocks_network,
            blocks_child_processes: observations.blocks_child_processes,
            restricts_filesystem: observations.restricts_filesystem,
            enforces_memory_limit: observations.enforces_memory_limit,
            observes_crashed_process: observations.observes_crashed_process,
            terminates_hung_process: observations.terminates_hung_process,
        },
    };
    let bytes = serde_json::to_vec(&document).expect("sandbox evidence must serialize");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .expect("sandbox evidence file already exists or cannot be created");
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .expect("sandbox evidence could not be durably written");
}

fn required_utf8_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required and must be UTF-8"))
}

struct NativeIdentity {
    platform: &'static str,
    target: &'static str,
    evidence_filename: &'static str,
}

fn native_identity() -> NativeIdentity {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return NativeIdentity {
        platform: "windows",
        target: "x86_64-pc-windows-msvc",
        evidence_filename: "plugin-g45-sandbox-windows.json",
    };
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return NativeIdentity {
        platform: "macos",
        target: "aarch64-apple-darwin",
        evidence_filename: "plugin-g45-sandbox-macos.json",
    };
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return NativeIdentity {
        platform: "linux",
        target: "x86_64-unknown-linux-gnu",
        evidence_filename: "plugin-g45-sandbox-linux.json",
    };
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    compile_error!("G45 sandbox evidence requires Windows x86_64, macOS arm64, or Linux x86_64");
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SandboxEvidence<'a> {
    schema_version: u32,
    evidence_kind: &'static str,
    probe_protocol: &'static str,
    evidence_scope: &'static str,
    execution: &'static str,
    commit_sha: &'a str,
    platform: &'static str,
    target: &'static str,
    market_ready: bool,
    controls: &'static [&'static str],
    observations: SandboxObservations,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SandboxObservations {
    blocks_network: bool,
    blocks_child_processes: bool,
    restricts_filesystem: bool,
    enforces_memory_limit: bool,
    observes_crashed_process: bool,
    terminates_hung_process: bool,
}
