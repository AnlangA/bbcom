use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::str::FromStr;

use semver::{Version, VersionReq};
use serde::Deserialize;

use crate::{ContractError, Permission, Result, Sha256Digest};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api: String,
    pub component: ComponentManifest,
    pub publisher: PublisherManifest,
    #[serde(rename = "requested-capabilities", default)]
    pub requested_capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentManifest {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherManifest {
    pub name: String,
    pub identity: String,
    pub website: String,
}

impl PluginManifest {
    pub fn parse(input: &str) -> Result<Self> {
        let manifest: Self = toml::from_str(input).map_err(map_toml_error)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        validate_plugin_id(&self.id)?;
        validate_display_text(&self.name, "name", 128)?;
        Version::parse(&self.version)
            .map_err(|_| ContractError::InvalidField { field: "version" })?;
        let requirement = VersionReq::parse(&self.api)
            .map_err(|_| ContractError::InvalidField { field: "api" })?;
        if !requirement.matches(&Version::new(1, 0, 0)) {
            return Err(ContractError::InvalidField { field: "api" });
        }
        validate_component_path(&self.component.path)?;
        validate_sha256(&self.component.sha256, "component.sha256")?;
        validate_display_text(&self.publisher.name, "publisher.name", 128)?;
        validate_publisher_identity(&self.publisher.identity)?;
        validate_https_url(&self.publisher.website, "publisher.website")?;

        let mut unique = BTreeSet::new();
        for value in &self.requested_capabilities {
            let permission = Permission::from_str(value)?;
            if permission.is_implicit() || !unique.insert(permission) {
                return Err(ContractError::InvalidField {
                    field: "requestedCapabilities",
                });
            }
        }
        Ok(())
    }

    pub fn permissions(&self) -> Result<Vec<Permission>> {
        self.requested_capabilities
            .iter()
            .map(|value| Permission::from_str(value))
            .collect()
    }

    pub fn version(&self) -> Result<Version> {
        Version::parse(&self.version).map_err(|_| ContractError::InvalidField { field: "version" })
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

fn validate_component_path(value: &str) -> Result<()> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("wasm")
        || path.components().count() != 2
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !value.starts_with("component/")
    {
        return Err(ContractError::InvalidField {
            field: "component.path",
        });
    }
    Ok(())
}

fn validate_publisher_identity(value: &str) -> Result<()> {
    let Some(identity) = value.strip_prefix("publisher:") else {
        return Err(ContractError::InvalidField {
            field: "publisher.identity",
        });
    };
    if identity.len() < 3 || identity.len() > 128 || !valid_slug(identity) {
        return Err(ContractError::InvalidField {
            field: "publisher.identity",
        });
    }
    Ok(())
}

fn validate_display_text(value: &str, field: &'static str, max: usize) -> Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
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
