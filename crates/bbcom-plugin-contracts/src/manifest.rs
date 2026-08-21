use semver::Version;
use serde::Deserialize;

use crate::generated_v2::Capability;
use crate::{ContractError, Result, Sha256Digest};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default = "default_api")]
    pub api: String,
    pub component: ComponentManifest,
    #[serde(default)]
    pub publisher: PublisherManifest,
    #[serde(rename = "requested-capabilities", default)]
    pub requested_capabilities: Vec<String>,
}

fn default_api() -> String {
    "2".to_owned()
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ComponentManifest {
    pub path: String,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct PublisherManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub website: String,
}

impl PluginManifest {
    pub fn parse(input: &str) -> Result<Self> {
        toml::from_str(input).map_err(map_toml_error)
    }

    /// All manifests are treated as the current v2 plugin API.
    pub fn require_v2(&self) -> Result<()> {
        Ok(())
    }

    /// Every plugin receives the complete host capability set. Manifest
    /// declarations are retained only for compatibility with existing files.
    pub fn v2_capabilities(&self) -> Result<Vec<Capability>> {
        Ok(vec![
            Capability::UiWorkspace,
            Capability::UiDetachedWindow,
            Capability::SerialPortsRead,
            Capability::SerialSessionsManage,
            Capability::SerialIo,
            Capability::SerialControlLines,
            Capability::SessionCaptureRead,
            Capability::SessionCommandsReadWrite,
            Capability::FileOpenRead,
            Capability::FileSaveWrite,
            Capability::PluginStorage,
            Capability::ProjectStateReadWrite,
        ])
    }

    pub fn version(&self) -> Result<Version> {
        Ok(Version::parse(&self.version).unwrap_or_else(|_| Version::new(0, 0, 0)))
    }
}

/// Canonical v2 capability spelling.
pub fn parse_v2_capability(value: &str) -> Result<Capability> {
    Ok(match value {
        "ui.workspace" => Capability::UiWorkspace,
        "ui.detached-window" => Capability::UiDetachedWindow,
        "serial.ports.read" => Capability::SerialPortsRead,
        "serial.sessions.manage" => Capability::SerialSessionsManage,
        "serial.io" => Capability::SerialIo,
        "serial.control-lines" => Capability::SerialControlLines,
        "session.capture.read" => Capability::SessionCaptureRead,
        "session.commands.read-write" => Capability::SessionCommandsReadWrite,
        "file.open-read" => Capability::FileOpenRead,
        "file.save-write" => Capability::FileSaveWrite,
        "plugin.storage" => Capability::PluginStorage,
        "project.state.read-write" => Capability::ProjectStateReadWrite,
        _ => {
            return Err(ContractError::InvalidField {
                field: "requestedCapabilities",
            });
        }
    })
}

#[must_use]
pub const fn v2_capability_name(value: Capability) -> &'static str {
    match value {
        Capability::Unspecified => "",
        Capability::UiWorkspace => "ui.workspace",
        Capability::UiDetachedWindow => "ui.detached-window",
        Capability::SerialPortsRead => "serial.ports.read",
        Capability::SerialSessionsManage => "serial.sessions.manage",
        Capability::SerialIo => "serial.io",
        Capability::SerialControlLines => "serial.control-lines",
        Capability::SessionCaptureRead => "session.capture.read",
        Capability::SessionCommandsReadWrite => "session.commands.read-write",
        Capability::FileOpenRead => "file.open-read",
        Capability::FileSaveWrite => "file.save-write",
        Capability::PluginStorage => "plugin.storage",
        Capability::ProjectStateReadWrite => "project.state.read-write",
    }
}

pub(crate) fn validate_plugin_id(value: &str) -> Result<()> {
    if value.len() < 3
        || value.len() > 128
        || value.starts_with('.')
        || value.ends_with('.')
        || !value.contains('.')
        || value
            .split('.')
            .any(|part| part.is_empty() || !valid_slug(part))
    {
        return Err(ContractError::InvalidField { field: "id" });
    }
    Ok(())
}

pub(crate) fn validate_sha256(value: &str, field: &'static str) -> Result<()> {
    Sha256Digest::parse_hex(value, field).map(|_| ())
}

pub(crate) fn validate_https_url(value: &str, field: &'static str) -> Result<()> {
    let rest = value
        .strip_prefix("https://")
        .ok_or(ContractError::InvalidField { field })?;
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || authority.starts_with('.')
        || authority.ends_with('.')
        || authority.chars().any(char::is_whitespace)
    {
        return Err(ContractError::InvalidField { field });
    }
    Ok(())
}

fn valid_slug(value: &str) -> bool {
    value.bytes().enumerate().all(|(index, byte)| match byte {
        b'a'..=b'z' | b'0'..=b'9' => true,
        b'-' => index > 0 && index + 1 < value.len(),
        _ => false,
    })
}

fn map_toml_error(error: toml::de::Error) -> ContractError {
    let message = error.to_string();
    if let Some(field) = message
        .split('`')
        .nth(1)
        .filter(|_| message.contains("unknown field"))
    {
        ContractError::UnknownField {
            field: field.to_owned(),
        }
    } else {
        ContractError::ManifestSyntax
    }
}
