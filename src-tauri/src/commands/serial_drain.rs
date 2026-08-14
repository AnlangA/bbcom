//! Explicit serial stop-and-drain boundary for serialplugin v3.
//!
//! The plugin's `unwatch` acknowledgement detaches the Channel watcher but is
//! not itself a barrier for bytes already buffered in the shared RX hub or the
//! OS driver. The renderer calls this main-window-only command immediately
//! after `unwatch` and before closing the port.

use std::time::{Duration, Instant};

use bbcom_contracts::{
    AppErrorCode, IpcError, MAX_SERIAL_DRAIN_BYTES, MAX_SERIAL_PORT_PATH_BYTES,
    SerialDrainCompletion, SerialDrainRequest, SerialDrainResponse,
};
use tauri::{State, WebviewWindow};
use tauri_plugin_serialplugin::api::SerialPort;

use crate::commands::file_grants::ensure_main_window;
use crate::models::ipc_error::from_app_error;

const OPERATION: &str = "drain_serial_input";
const NATIVE_IDLE_GAP: Duration = Duration::from_millis(25);
const TOTAL_DRAIN_DEADLINE: Duration = Duration::from_millis(500);
const READ_TIMEOUT_MS: u64 = 10;
const POLL_INTERVAL: Duration = Duration::from_millis(2);

#[derive(Clone, Copy)]
struct DrainPolicy {
    idle_gap: Duration,
    total_deadline: Duration,
    poll_interval: Duration,
    max_bytes: usize,
}

impl Default for DrainPolicy {
    fn default() -> Self {
        Self {
            idle_gap: NATIVE_IDLE_GAP,
            total_deadline: TOTAL_DRAIN_DEADLINE,
            poll_interval: POLL_INTERVAL,
            max_bytes: MAX_SERIAL_DRAIN_BYTES,
        }
    }
}

trait SerialDrainSource {
    fn contains_open_port(&self, path: &str) -> Result<bool, ()>;
    fn bytes_to_read(&self, path: &str) -> Result<u32, ()>;
    fn read_binary(&self, path: &str, size: usize) -> Result<Vec<u8>, ()>;
}

impl SerialDrainSource for SerialPort<tauri::Wry> {
    fn contains_open_port(&self, path: &str) -> Result<bool, ()> {
        self.managed_ports()
            .map(|ports| ports.iter().any(|candidate| candidate == path))
            .map_err(|_| ())
    }

    fn bytes_to_read(&self, path: &str) -> Result<u32, ()> {
        SerialPort::bytes_to_read(self, path.to_owned()).map_err(|_| ())
    }

    fn read_binary(&self, path: &str, size: usize) -> Result<Vec<u8>, ()> {
        SerialPort::read_binary(self, path.to_owned(), Some(READ_TIMEOUT_MS), Some(size))
            .map_err(|_| ())
    }
}

/// Drains bytes left in serialplugin's native RX hub and the OS driver after
/// the renderer has acknowledged `unwatch`.
///
/// serialplugin v3 is path-scoped and its existing `open`, `watch`, `write`,
/// and `close` calls already receive the renderer's port name. This command
/// temporarily retains that boundary, restricts it to the main window, bounds
/// and validates the path, and never returns or logs it. Replacing the plugin's
/// path API with an opaque native lease is the route for removing it entirely.
#[tauri::command]
pub async fn drain_serial_input(
    window: WebviewWindow,
    serial: State<'_, SerialPort<tauri::Wry>>,
    request: SerialDrainRequest,
) -> Result<SerialDrainResponse, IpcError> {
    ensure_main_window(window.label()).map_err(|error| from_app_error(&error, OPERATION))?;
    validate_path(&request.path)?;

    let path = request.path;
    let serial = SerialPort::clone(serial.inner());
    tauri::async_runtime::spawn_blocking(move || {
        drain_from_source(&serial, &path, DrainPolicy::default())
    })
    .await
    .map_err(|_| IpcError::new(AppErrorCode::Busy, "error.busy", true, OPERATION))
}

fn validate_path(path: &str) -> Result<(), IpcError> {
    if path.is_empty()
        || path.len() > MAX_SERIAL_PORT_PATH_BYTES
        || path
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == 0x7f)
    {
        return Err(IpcError::invalid_input(OPERATION, "path")
            .with_size(MAX_SERIAL_PORT_PATH_BYTES, path.len()));
    }
    Ok(())
}

fn drain_from_source(
    source: &impl SerialDrainSource,
    path: &str,
    policy: DrainPolicy,
) -> SerialDrainResponse {
    let is_open = source.contains_open_port(path);
    if !matches!(is_open, Ok(true)) {
        return response(Vec::new(), SerialDrainCompletion::NativeReadFailed);
    }

    let started = Instant::now();
    let mut idle_since: Option<Instant> = None;
    let mut bytes = Vec::new();

    loop {
        if started.elapsed() >= policy.total_deadline {
            return response(bytes, SerialDrainCompletion::DeadlineReached);
        }

        let available = match source.bytes_to_read(path) {
            Ok(value) => value as usize,
            Err(()) => {
                return response(bytes, SerialDrainCompletion::NativeReadFailed);
            }
        };

        if available == 0 {
            let idle_started = idle_since.get_or_insert_with(Instant::now);
            if idle_started.elapsed() >= policy.idle_gap {
                return response(bytes, SerialDrainCompletion::IdleGapObserved);
            }
            std::thread::sleep(policy.poll_interval);
            continue;
        }

        idle_since = None;
        let remaining = policy.max_bytes.saturating_sub(bytes.len());
        if remaining == 0 {
            return response(bytes, SerialDrainCompletion::ByteLimitReached);
        }

        let requested = available.min(remaining);
        let chunk = match source.read_binary(path, requested) {
            Ok(chunk) => chunk,
            Err(()) => {
                return response(bytes, SerialDrainCompletion::NativeReadFailed);
            }
        };
        if chunk.is_empty() {
            std::thread::sleep(policy.poll_interval);
            continue;
        }
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return response(bytes, SerialDrainCompletion::ByteLimitReached);
        }
        bytes.extend_from_slice(&chunk);
    }
}

fn response(bytes: Vec<u8>, completion: SerialDrainCompletion) -> SerialDrainResponse {
    SerialDrainResponse {
        bytes,
        guaranteed: completion == SerialDrainCompletion::IdleGapObserved,
        completion,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;

    struct FakeSource {
        open: Result<bool, ()>,
        available: RefCell<VecDeque<Result<u32, ()>>>,
        reads: RefCell<VecDeque<Result<Vec<u8>, ()>>>,
        fallback_available: Result<u32, ()>,
    }

    impl SerialDrainSource for FakeSource {
        fn contains_open_port(&self, _path: &str) -> Result<bool, ()> {
            self.open
        }

        fn bytes_to_read(&self, _path: &str) -> Result<u32, ()> {
            self.available
                .borrow_mut()
                .pop_front()
                .unwrap_or(self.fallback_available)
        }

        fn read_binary(&self, _path: &str, size: usize) -> Result<Vec<u8>, ()> {
            self.reads
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| Ok(vec![0; size]))
        }
    }

    fn policy(max_bytes: usize) -> DrainPolicy {
        DrainPolicy {
            idle_gap: Duration::ZERO,
            total_deadline: Duration::from_secs(1),
            poll_interval: Duration::ZERO,
            max_bytes,
        }
    }

    #[test]
    fn idle_gap_is_the_only_guaranteed_completion() {
        let source = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(3), Ok(0)])),
            reads: RefCell::new(VecDeque::from([Ok(vec![1, 2, 3])])),
            fallback_available: Ok(0),
        };

        let result = drain_from_source(&source, "COM1", policy(16));

        assert_eq!(result.bytes, vec![1, 2, 3]);
        assert!(result.guaranteed);
        assert_eq!(result.completion, SerialDrainCompletion::IdleGapObserved);
    }

    #[test]
    fn byte_limit_and_native_failure_preserve_the_partial_tail_but_are_not_guaranteed() {
        let limited = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(4), Ok(1)])),
            reads: RefCell::new(VecDeque::from([Ok(vec![1, 2, 3, 4])])),
            fallback_available: Ok(1),
        };
        let limit_result = drain_from_source(&limited, "COM1", policy(4));
        assert_eq!(limit_result.bytes, vec![1, 2, 3, 4]);
        assert!(!limit_result.guaranteed);
        assert_eq!(
            limit_result.completion,
            SerialDrainCompletion::ByteLimitReached
        );

        let failed = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(2), Err(())])),
            reads: RefCell::new(VecDeque::from([Ok(vec![9, 8])])),
            fallback_available: Err(()),
        };
        let failure_result = drain_from_source(&failed, "COM1", policy(16));
        assert_eq!(failure_result.bytes, vec![9, 8]);
        assert!(!failure_result.guaranteed);
        assert_eq!(
            failure_result.completion,
            SerialDrainCompletion::NativeReadFailed
        );
    }

    #[test]
    fn rejects_unsafe_path_shapes_without_echoing_them() {
        for value in ["", "COM1\n", &"x".repeat(MAX_SERIAL_PORT_PATH_BYTES + 1)] {
            let error = validate_path(value).unwrap_err();
            assert_eq!(error.code, AppErrorCode::InvalidInput);
            assert_eq!(error.field, Some("path"));
            if !value.is_empty() {
                assert!(!serde_json::to_string(&error).unwrap().contains(value));
            }
        }
    }

    #[test]
    fn unavailable_ports_and_deadlines_fail_without_claiming_a_barrier() {
        for open in [Ok(false), Err(())] {
            let source = FakeSource {
                open,
                available: RefCell::new(VecDeque::new()),
                reads: RefCell::new(VecDeque::new()),
                fallback_available: Ok(0),
            };
            let result = drain_from_source(&source, "COM1", policy(16));
            assert!(result.bytes.is_empty());
            assert!(!result.guaranteed);
            assert_eq!(result.completion, SerialDrainCompletion::NativeReadFailed);
        }

        let source = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::new()),
            reads: RefCell::new(VecDeque::new()),
            fallback_available: Ok(0),
        };
        let deadline = drain_from_source(
            &source,
            "COM1",
            DrainPolicy {
                total_deadline: Duration::ZERO,
                ..policy(16)
            },
        );
        assert_eq!(deadline.completion, SerialDrainCompletion::DeadlineReached);
        assert!(!deadline.guaranteed);
    }

    #[test]
    fn native_read_failures_empty_reads_and_oversized_chunks_are_bounded() {
        let failed_read = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(1)])),
            reads: RefCell::new(VecDeque::from([Err(())])),
            fallback_available: Ok(0),
        };
        assert_eq!(
            drain_from_source(&failed_read, "COM1", policy(16)).completion,
            SerialDrainCompletion::NativeReadFailed
        );

        let empty_then_idle = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(1), Ok(0)])),
            reads: RefCell::new(VecDeque::from([Ok(Vec::new())])),
            fallback_available: Ok(0),
        };
        let idle = drain_from_source(&empty_then_idle, "COM1", policy(16));
        assert!(idle.bytes.is_empty());
        assert_eq!(idle.completion, SerialDrainCompletion::IdleGapObserved);

        let oversized = FakeSource {
            open: Ok(true),
            available: RefCell::new(VecDeque::from([Ok(2)])),
            reads: RefCell::new(VecDeque::from([Ok(vec![1, 2, 3, 4, 5])])),
            fallback_available: Ok(0),
        };
        let bounded = drain_from_source(&oversized, "COM1", policy(3));
        assert_eq!(bounded.bytes, vec![1, 2, 3]);
        assert_eq!(bounded.completion, SerialDrainCompletion::ByteLimitReached);
        assert!(!bounded.guaranteed);

        assert!(validate_path(&"x".repeat(MAX_SERIAL_PORT_PATH_BYTES)).is_ok());
    }
}
