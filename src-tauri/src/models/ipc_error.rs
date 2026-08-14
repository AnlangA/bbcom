//! Stable, non-sensitive error payloads for commands exposed to webviews.
//!
//! `AppError` predates the v0.5 command boundary and is still used by the
//! export formatter internally. New boundary-sensitive commands use this type
//! so callers can make a deterministic decision without parsing prose and so
//! logs never need to include request bodies, secrets, or file paths.

use crate::models::errors::AppError;

pub use bbcom_contracts::{AppErrorCode, IpcError};

/// Convert an internal error to the stable command boundary shape without
/// carrying a native error message, path, serial payload, or secret across IPC.
pub fn from_app_error(error: &AppError, operation: &'static str) -> IpcError {
    match error {
        AppError::ValidationError { field, .. } => {
            let field = stable_field(field);
            if field == "window" {
                return IpcError::security_denied(operation);
            }
            let code = match field {
                "frames" => AppErrorCode::LimitExceeded,
                _ => AppErrorCode::InvalidInput,
            };
            IpcError::new(
                code,
                if code == AppErrorCode::LimitExceeded {
                    "error.limit_exceeded"
                } else {
                    "error.invalid_input"
                },
                false,
                operation,
            )
            .with_field(field)
        }
        AppError::LimitError {
            field,
            limit,
            actual,
            ..
        } => {
            let field = stable_field(field);
            IpcError::new(
                AppErrorCode::LimitExceeded,
                "error.limit_exceeded",
                false,
                operation,
            )
            .with_field(field)
            .with_size(*limit, *actual)
        }
        AppError::Busy { .. } => IpcError::new(AppErrorCode::Busy, "error.busy", true, operation),
        AppError::Timeout { .. } => {
            IpcError::new(AppErrorCode::Timeout, "error.timeout", true, operation)
        }
        AppError::IoError { kind, .. } => {
            let code = match kind {
                std::io::ErrorKind::PermissionDenied => AppErrorCode::IoPermissionDenied,
                std::io::ErrorKind::StorageFull => AppErrorCode::IoDiskFull,
                _ => AppErrorCode::ExportReplaceFailed,
            };
            match code {
                AppErrorCode::IoPermissionDenied => {
                    IpcError::new(code, "error.io_permission_denied", false, operation)
                }
                AppErrorCode::IoDiskFull => {
                    IpcError::new(code, "error.io_disk_full", true, operation)
                }
                _ => IpcError::new(code, "error.export_failed", true, operation),
            }
        }
        AppError::ExportError { kind, .. } => match kind {
            std::io::ErrorKind::PermissionDenied => IpcError::new(
                AppErrorCode::IoPermissionDenied,
                "error.io_permission_denied",
                false,
                operation,
            ),
            std::io::ErrorKind::StorageFull => IpcError::new(
                AppErrorCode::IoDiskFull,
                "error.io_disk_full",
                true,
                operation,
            ),
            _ => IpcError::new(
                AppErrorCode::ExportReplaceFailed,
                "error.export_failed",
                true,
                operation,
            ),
        },
        AppError::ConfigError { .. } => IpcError::security_denied(operation),
        AppError::AiError { .. } => IpcError::new(
            AppErrorCode::AiProviderFailed,
            "error.ai_request_failed",
            true,
            operation,
        ),
    }
}

fn stable_field(field: &str) -> &'static str {
    match field {
        "token" => "token",
        "exportId" => "exportId",
        "logId" => "logId",
        "frames" => "frames",
        "expectedFrames" => "expectedFrames",
        "expectedRawBytes" => "expectedRawBytes",
        "suggestedName" => "suggestedName",
        "format" => "format",
        "path" => "path",
        "window" => "window",
        _ => "request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_exact_stable_contract_without_message_text() {
        let error = IpcError::invalid_input("run_ai_request", "prompt")
            .with_size(10, 11)
            .with_request_id("abc");
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "INVALID_INPUT");
        assert_eq!(value["messageKey"], "error.invalid_input");
        assert_eq!(value["operation"], "run_ai_request");
        assert_eq!(value["field"], "prompt");
        assert!(value.get("message").is_none());
    }

    #[test]
    fn window_validation_is_a_security_denial_not_bad_input() {
        let error = AppError::ValidationError {
            message: "must not cross IPC".to_string(),
            field: "window".to_string(),
        };
        let mapped = from_app_error(&error, "begin_export");
        assert_eq!(mapped.code, AppErrorCode::SecurityDenied);
        assert_eq!(mapped.message_key, "error.security_denied");
        assert!(!mapped.retryable);
        assert_eq!(mapped.operation, "begin_export");
    }

    #[test]
    fn io_kinds_keep_stable_actionable_codes_without_native_details() {
        for (kind, code, retryable) in [
            (
                std::io::ErrorKind::PermissionDenied,
                AppErrorCode::IoPermissionDenied,
                false,
            ),
            (
                std::io::ErrorKind::StorageFull,
                AppErrorCode::IoDiskFull,
                true,
            ),
            (
                std::io::ErrorKind::Other,
                AppErrorCode::ExportReplaceFailed,
                true,
            ),
        ] {
            let error = AppError::ExportError {
                message: "native detail must not cross IPC".to_string(),
                format: "CSV".to_string(),
                path: "/secret/path/capture.csv".to_string(),
                kind,
            };
            let mapped = from_app_error(&error, "finish_export");
            assert_eq!(mapped.code, code);
            assert_eq!(mapped.retryable, retryable);
            let value = serde_json::to_value(mapped).unwrap();
            assert!(value.get("message").is_none());
            assert!(value.get("path").is_none());
            assert!(!value.to_string().contains("secret"));
            assert!(!value.to_string().contains("native detail"));
        }
    }

    #[test]
    fn structured_limit_error_preserves_field_limit_and_actual() {
        let error = AppError::LimitError {
            message: "frame byte prose".to_string(),
            field: "frames".to_string(),
            limit: 512,
            actual: 513,
        };
        let mapped = from_app_error(&error, "append_export_batch");
        assert_eq!(mapped.code, AppErrorCode::LimitExceeded);
        assert_eq!(mapped.field, Some("frames"));
        assert_eq!(mapped.limit, Some(512));
        assert_eq!(mapped.actual, Some(513));
        assert_eq!(mapped.message_key, "error.limit_exceeded");
    }

    #[test]
    fn export_total_mismatch_and_finished_session_are_stable_non_retryable_errors() {
        for field in ["expectedFrames", "expectedRawBytes", "exportId"] {
            let error = AppError::ValidationError {
                message: "internal mismatch detail".to_string(),
                field: field.to_string(),
            };
            let mapped = from_app_error(&error, "finish_export");
            assert_eq!(mapped.code, AppErrorCode::InvalidInput);
            assert_eq!(mapped.field, Some(field));
            assert_eq!(mapped.message_key, "error.invalid_input");
            assert!(!mapped.retryable);
            assert!(
                !serde_json::to_string(&mapped)
                    .unwrap()
                    .contains("internal mismatch detail")
            );
        }
    }

    #[test]
    fn all_internal_error_classes_map_without_native_message_or_path() {
        for (error, expected) in [
            (
                AppError::ValidationError {
                    message: "frame prose".to_string(),
                    field: "expectedFrames".to_string(),
                },
                AppErrorCode::InvalidInput,
            ),
            (
                AppError::Busy {
                    message: "busy prose".to_string(),
                },
                AppErrorCode::Busy,
            ),
            (
                AppError::Timeout {
                    message: "timeout prose".to_string(),
                },
                AppErrorCode::Timeout,
            ),
            (
                AppError::ConfigError {
                    message: "config prose".to_string(),
                },
                AppErrorCode::SecurityDenied,
            ),
            (
                AppError::AiError {
                    message: "model prose".to_string(),
                },
                AppErrorCode::AiProviderFailed,
            ),
        ] {
            let mapped = from_app_error(&error, "operation");
            assert_eq!(mapped.code, expected);
            assert!(!serde_json::to_string(&mapped).unwrap().contains("prose"));
        }

        for (kind, expected) in [
            (
                std::io::ErrorKind::PermissionDenied,
                AppErrorCode::IoPermissionDenied,
            ),
            (std::io::ErrorKind::StorageFull, AppErrorCode::IoDiskFull),
            (std::io::ErrorKind::Other, AppErrorCode::ExportReplaceFailed),
        ] {
            let error = AppError::IoError {
                message: "native path /secret".to_string(),
                kind,
            };
            let mapped = from_app_error(&error, "operation");
            assert_eq!(mapped.code, expected);
            assert!(!serde_json::to_string(&mapped).unwrap().contains("secret"));
        }
    }
}
