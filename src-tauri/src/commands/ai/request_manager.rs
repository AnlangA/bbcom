//! Explicit cancellation registry for bounded, non-streaming AI requests.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use tokio::sync::Notify;

use crate::models::ipc_error::{AppErrorCode, IpcError};

use super::{service::MAX_CONCURRENT_AI_REQUESTS, types::MAX_AI_REQUEST_ID_BYTES};

#[derive(Default)]
pub struct AiRequestManager {
    requests: Mutex<HashMap<String, Arc<AiCancellation>>>,
}

#[derive(Debug)]
pub struct AiCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl AiCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub async fn cancelled(&self) {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            self.notify.notified().await;
        }
    }
}

impl AiRequestManager {
    pub fn begin(&self, request_id: &str) -> Result<Arc<AiCancellation>, IpcError> {
        if request_id.is_empty() || request_id.len() > MAX_AI_REQUEST_ID_BYTES {
            return Err(IpcError::invalid_input("run_ai_request", "requestId")
                .with_size(MAX_AI_REQUEST_ID_BYTES, request_id.len()));
        }
        let mut requests = self.requests.lock().map_err(|_| {
            IpcError::new(
                AppErrorCode::Busy,
                "error.ai_request_registry_busy",
                true,
                "run_ai_request",
            )
        })?;
        if requests.contains_key(request_id) {
            return Err(IpcError::new(
                AppErrorCode::Busy,
                "error.ai_request_id_busy",
                true,
                "run_ai_request",
            )
            .with_request_id(request_id));
        }
        if requests.len() >= MAX_CONCURRENT_AI_REQUESTS {
            return Err(
                IpcError::new(AppErrorCode::Busy, "error.busy", true, "run_ai_request")
                    .with_request_id(request_id),
            );
        }
        let cancellation = Arc::new(AiCancellation::new());
        requests.insert(request_id.to_string(), Arc::clone(&cancellation));
        Ok(cancellation)
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), IpcError> {
        if request_id.is_empty() || request_id.len() > MAX_AI_REQUEST_ID_BYTES {
            return Err(IpcError::invalid_input("cancel_ai_request", "requestId")
                .with_size(MAX_AI_REQUEST_ID_BYTES, request_id.len()));
        }
        let request = self
            .requests
            .lock()
            .map_err(|_| {
                IpcError::new(
                    AppErrorCode::Busy,
                    "error.ai_request_registry_busy",
                    true,
                    "cancel_ai_request",
                )
            })?
            .get(request_id)
            .cloned();
        if let Some(request) = request {
            request.cancel();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn cancellation_wakes_the_registered_request() {
        let manager = AiRequestManager::default();
        let cancellation = manager.begin("request-1").unwrap();
        manager.cancel("request-1").unwrap();
        cancellation.cancelled().await;
        manager.finish("request-1");
        assert!(manager.begin("request-1").is_ok());
    }

    #[tokio::test]
    async fn cancellation_waits_until_an_inflight_request_is_cancelled() {
        let cancellation = Arc::new(AiCancellation::new());
        let waiting = Arc::clone(&cancellation);
        let mut waiter = tokio::spawn(async move { waiting.cancelled().await });

        // Confirm the task has reached the Notify wait rather than merely
        // relying on scheduler timing before exercising the wake-up path.
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiter)
                .await
                .is_err()
        );
        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("cancellation waiter must wake")
            .expect("waiter task must not panic");
    }

    #[test]
    fn third_request_is_rejected_immediately_without_queueing() {
        let manager = AiRequestManager::default();
        let _first = manager.begin("request-1").unwrap();
        let _second = manager.begin("request-2").unwrap();
        let error = manager
            .begin("request-3")
            .expect_err("third request must be rejected");
        assert_eq!(error.code, AppErrorCode::Busy);
        assert_eq!(error.operation, "run_ai_request");
    }

    #[test]
    fn ids_are_bounded_unique_and_unknown_cancellation_is_idempotent() {
        let manager = AiRequestManager::default();
        for invalid in ["", &"x".repeat(MAX_AI_REQUEST_ID_BYTES + 1)] {
            let error = manager
                .begin(invalid)
                .expect_err("invalid request id must be rejected");
            assert_eq!(error.code, AppErrorCode::InvalidInput);
            assert_eq!(error.field, Some("requestId"));
            assert_eq!(
                manager.cancel(invalid).unwrap_err().operation,
                "cancel_ai_request"
            );
        }

        let first = manager.begin("duplicate").unwrap();
        let duplicate = manager
            .begin("duplicate")
            .expect_err("duplicate request id must be rejected");
        assert_eq!(duplicate.code, AppErrorCode::Busy);
        assert_eq!(duplicate.request_id.as_deref(), Some("duplicate"));
        manager.cancel("missing").unwrap();
        manager.finish("duplicate");
        drop(first);
        assert!(manager.begin("duplicate").is_ok());
    }

    #[test]
    fn poisoned_registry_lock_returns_typed_busy_errors() {
        fn poison(manager: &AiRequestManager) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _guard = manager.requests.lock().unwrap();
                panic!("intentional request-registry poison");
            }));
        }

        let begin_manager = AiRequestManager::default();
        poison(&begin_manager);
        let begin_error = begin_manager.begin("request-id").unwrap_err();
        assert_eq!(begin_error.code, AppErrorCode::Busy);
        assert_eq!(begin_error.operation, "run_ai_request");

        let cancel_manager = AiRequestManager::default();
        poison(&cancel_manager);
        let cancel_error = cancel_manager.cancel("request-id").unwrap_err();
        assert_eq!(cancel_error.code, AppErrorCode::Busy);
        assert_eq!(cancel_error.operation, "cancel_ai_request");
    }
}
