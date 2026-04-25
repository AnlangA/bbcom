use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "details")]
pub enum AppError {
    #[error("invalid hex string: {message}")]
    InvalidHex {
        message: String,
        #[serde(skip)]
        position: Option<usize>,
    },

    #[error("export failed: {message}")]
    ExportError {
        message: String,
        format: String,
        path: String,
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
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::IoError {
            message: e.to_string(),
            kind: e.kind(),
        }
    }
}
