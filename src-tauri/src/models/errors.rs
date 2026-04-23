use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum AppError {
    #[error("invalid hex string: {0}")]
    InvalidHex(String),
    #[error("export failed: {0}")]
    ExportError(String),
    #[error("io error: {0}")]
    IoError(String),
    #[error("config error: {0}")]
    ConfigError(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::IoError(e.to_string())
    }
}
