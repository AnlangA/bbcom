use std::fmt;
use std::path::{Path, PathBuf};

use super::{ProjectContainerError, ProjectContainerResult};

pub const BBCOM_PROJECT_EXTENSION: &str = "bbcom";

/// Canonical lower-case RFC 4122 UUID used as the only managed project key.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WorkspaceUuid(String);

impl WorkspaceUuid {
    pub fn parse(value: &str) -> ProjectContainerResult<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 36
            || bytes.iter().enumerate().any(|(index, byte)| match index {
                8 | 13 | 18 | 23 => *byte != b'-',
                _ => !byte.is_ascii_hexdigit(),
            })
            || bytes
                .iter()
                .filter(|byte| **byte != b'-')
                .all(|byte| *byte == b'0')
        {
            return Err(ProjectContainerError::InvalidInput {
                field: "workspaceId",
            });
        }
        if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(ProjectContainerError::InvalidInput {
                field: "workspaceId",
            });
        }
        Ok(Self(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WorkspaceUuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Validated internal file name. It contains exactly one UUID and the fixed
/// `.bbcom` extension, so joining it to the managed root cannot traverse out.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ManagedProjectFileName(String);

impl ManagedProjectFileName {
    #[must_use]
    pub fn for_workspace(workspace_id: &WorkspaceUuid) -> Self {
        Self(format!(
            "{}.{}",
            workspace_id.as_str(),
            BBCOM_PROJECT_EXTENSION
        ))
    }

    pub fn parse(value: &str) -> ProjectContainerResult<Self> {
        let suffix = format!(".{BBCOM_PROJECT_EXTENSION}");
        let stem = value
            .strip_suffix(&suffix)
            .ok_or(ProjectContainerError::InvalidInput {
                field: "managedFileName",
            })?;
        let workspace_id =
            WorkspaceUuid::parse(stem).map_err(|_| ProjectContainerError::InvalidInput {
                field: "managedFileName",
            })?;
        let canonical = Self::for_workspace(&workspace_id);
        if canonical.as_str() != value {
            return Err(ProjectContainerError::InvalidInput {
                field: "managedFileName",
            });
        }
        Ok(canonical)
    }

    pub fn workspace_id(&self) -> ProjectContainerResult<WorkspaceUuid> {
        let stem = self
            .0
            .strip_suffix(".bbcom")
            .ok_or(ProjectContainerError::InvalidInput {
                field: "managedFileName",
            })?;
        WorkspaceUuid::parse(stem)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A path selected and resolved by native Rust code. This type is intentionally
/// not serializable and is never part of an IPC DTO.
#[derive(Clone, Debug)]
pub struct NativeProjectSource(PathBuf);

impl NativeProjectSource {
    #[must_use]
    pub fn from_native_path(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }
}

/// A native-selected export target. Renderer strings cannot be converted by
/// serde into this type; the native file-grant layer must construct it.
#[derive(Clone, Debug)]
pub struct NativeProjectDestination(PathBuf);

impl NativeProjectDestination {
    #[must_use]
    pub fn from_native_path(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }
}

pub(crate) fn validate_bbcom_extension(
    path: &Path,
    field: &'static str,
) -> ProjectContainerResult<()> {
    if path.extension().and_then(|value| value.to_str()) == Some(BBCOM_PROJECT_EXTENSION) {
        Ok(())
    } else {
        Err(ProjectContainerError::InvalidInput { field })
    }
}
