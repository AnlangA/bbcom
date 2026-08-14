use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable error codes; clients must never branch on native error prose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    Busy,
    RateLimited,
    Cancelled,
    Timeout,
    AiProviderFailed,
    InvalidInput,
    LimitExceeded,
    SecurityDenied,
    SerialDisconnected,
    SerialQueueFull,
    SerialPartialWrite,
    IoPermissionDenied,
    IoDiskFull,
    ExportReplaceFailed,
    RevisionConflict,
    WorkspaceReadOnly,
    WorkspaceCorrupt,
    PortInUse,
    PluginPermissionDenied,
}

/// Structured IPC failure with no native paths, payload bytes, prompts, or keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct IpcError {
    pub code: AppErrorCode,
    pub message_key: &'static str,
    pub retryable: bool,
    pub operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub retry_after_ms: Option<u64>,
}

impl IpcError {
    pub const fn new(
        code: AppErrorCode,
        message_key: &'static str,
        retryable: bool,
        operation: &'static str,
    ) -> Self {
        Self {
            code,
            message_key,
            retryable,
            operation,
            request_id: None,
            field: None,
            limit: None,
            actual: None,
            retry_after_ms: None,
        }
    }

    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into().into_boxed_str());
        self
    }

    pub const fn with_field(mut self, field: &'static str) -> Self {
        self.field = Some(field);
        self
    }

    pub const fn with_size(mut self, limit: usize, actual: usize) -> Self {
        self.limit = Some(limit);
        self.actual = Some(actual);
        self
    }

    pub const fn with_retry_after(mut self, retry_after_ms: u64) -> Self {
        self.retry_after_ms = Some(retry_after_ms);
        self
    }

    pub const fn invalid_input(operation: &'static str, field: &'static str) -> Self {
        Self::new(
            AppErrorCode::InvalidInput,
            "error.invalid_input",
            false,
            operation,
        )
        .with_field(field)
    }

    pub const fn security_denied(operation: &'static str) -> Self {
        Self::new(
            AppErrorCode::SecurityDenied,
            "error.security_denied",
            false,
            operation,
        )
    }
}
