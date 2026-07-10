use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "details")]
pub enum AppError {
    #[error("export failed: {message}")]
    ExportError {
        message: String,
        format: String,
        path: String,
        #[serde(skip)]
        kind: std::io::ErrorKind,
    },

    #[error("io error: {message}")]
    IoError {
        message: String,
        #[serde(skip)]
        kind: std::io::ErrorKind,
    },

    #[error("config error: {message}")]
    ConfigError { message: String },

    #[error("validation error: {message}")]
    ValidationError { message: String, field: String },

    #[error("limit exceeded: {message}")]
    LimitError {
        message: String,
        field: String,
        limit: usize,
        actual: usize,
    },

    #[error("resource busy: {message}")]
    Busy { message: String },

    #[error("operation timed out: {message}")]
    Timeout { message: String },

    #[error("ai error: {message}")]
    AiError { message: String },
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::IoError {
            message: e.to_string(),
            kind: e.kind(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_converts_preserving_kind_and_message() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing file");
        let app_err: AppError = io_err.into();
        match app_err {
            AppError::IoError { message, kind } => {
                assert_eq!(kind, std::io::ErrorKind::NotFound);
                assert!(message.contains("missing file"));
            }
            other => panic!("expected IoError, got {other:?}"),
        }
    }

    #[test]
    fn other_io_error_kinds_convert_too() {
        let kinds = [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::AlreadyExists,
            std::io::ErrorKind::UnexpectedEof,
        ];
        for kind in kinds {
            let io_err = std::io::Error::new(kind, "x");
            let app_err: AppError = io_err.into();
            assert!(
                matches!(app_err, AppError::IoError { kind: k, .. } if k == kind),
                "{kind:?} did not round-trip"
            );
        }
    }
}
