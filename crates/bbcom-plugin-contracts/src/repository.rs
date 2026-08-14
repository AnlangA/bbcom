use std::collections::BTreeSet;

use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::manifest::{validate_https_url, validate_plugin_id, validate_sha256};
use crate::{
    ContractError, MAX_PACKAGE_DOWNLOAD_BYTES, MAX_PACKAGE_EXPANDED_BYTES, MAX_PACKAGE_FILES,
    Result,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryIndex {
    pub schema: u32,
    pub generated_at: String,
    pub origin: String,
    pub update_policy: String,
    pub plugins: Vec<RepositoryPlugin>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryPlugin {
    pub id: String,
    pub publisher_identity: String,
    pub packages: Vec<RepositoryPackage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryPackage {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub download_bytes: u64,
    pub expanded_bytes: u64,
    pub files: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryCatalog {
    pub repositories: Vec<RepositoryIndex>,
}

impl RepositoryCatalog {
    pub fn new(repositories: Vec<RepositoryIndex>) -> Result<Self> {
        if repositories.is_empty() {
            return Err(ContractError::InvalidField {
                field: "repositories",
            });
        }
        let mut origins = BTreeSet::new();
        for repository in &repositories {
            repository.validate()?;
            if !origins.insert(repository.origin.as_str()) {
                return Err(ContractError::InvalidField { field: "origin" });
            }
        }
        Ok(Self { repositories })
    }
}

impl RepositoryIndex {
    pub fn parse(input: &str) -> Result<Self> {
        let index: Self = serde_json::from_str(input).map_err(map_json_error)?;
        index.validate()?;
        Ok(index)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema != 1 {
            return Err(ContractError::InvalidField { field: "schema" });
        }
        validate_https_url(&self.origin, "origin")?;
        validate_rfc3339_utc(&self.generated_at)?;
        if self.update_policy != "manual" {
            return Err(ContractError::InvalidField {
                field: "updatePolicy",
            });
        }
        if self.plugins.is_empty() {
            return Err(ContractError::InvalidField { field: "plugins" });
        }
        let mut plugin_ids = BTreeSet::new();
        for plugin in &self.plugins {
            validate_plugin_id(&plugin.id)?;
            if !plugin_ids.insert(&plugin.id) || plugin.packages.is_empty() {
                return Err(ContractError::InvalidField { field: "plugins" });
            }
            let identity = plugin.publisher_identity.strip_prefix("publisher:").ok_or(
                ContractError::InvalidField {
                    field: "publisherIdentity",
                },
            )?;
            if identity.len() < 3
                || identity.len() > 128
                || !identity
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| match byte {
                        b'a'..=b'z' | b'0'..=b'9' => true,
                        b'-' => index > 0 && index + 1 < identity.len(),
                        _ => false,
                    })
            {
                return Err(ContractError::InvalidField {
                    field: "publisherIdentity",
                });
            }
            let mut versions = BTreeSet::new();
            for package in &plugin.packages {
                Version::parse(&package.version)
                    .map_err(|_| ContractError::InvalidField { field: "version" })?;
                if !versions.insert(&package.version) {
                    return Err(ContractError::InvalidField { field: "packages" });
                }
                validate_https_url(&package.url, "url")?;
                if canonical_origin(&package.url)? != canonical_origin(&self.origin)? {
                    return Err(ContractError::InvalidField { field: "url" });
                }
                validate_sha256(&package.sha256, "sha256")?;
                validate_limit(
                    "downloadBytes",
                    package.download_bytes,
                    MAX_PACKAGE_DOWNLOAD_BYTES,
                )?;
                validate_limit(
                    "expandedBytes",
                    package.expanded_bytes,
                    MAX_PACKAGE_EXPANDED_BYTES,
                )?;
                validate_limit(
                    "files",
                    u64::from(package.files),
                    u64::from(MAX_PACKAGE_FILES),
                )?;
                if package.download_bytes == 0 || package.expanded_bytes == 0 || package.files == 0
                {
                    return Err(ContractError::InvalidField { field: "package" });
                }
            }
        }
        Ok(())
    }
}

fn canonical_origin(value: &str) -> Result<String> {
    let parsed = Url::parse(value).map_err(|_| ContractError::InvalidField { field: "url" })?;
    Ok(parsed.origin().ascii_serialization())
}

fn validate_limit(field: &'static str, actual: u64, limit: u64) -> Result<()> {
    if actual > limit {
        Err(ContractError::LimitExceeded {
            field,
            limit,
            actual,
        })
    } else {
        Ok(())
    }
}

fn validate_rfc3339_utc(value: &str) -> Result<()> {
    if value.len() != 20
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || !value.ends_with('Z')
        || value.bytes().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19) && !byte.is_ascii_digit()
        })
    {
        return Err(ContractError::InvalidField {
            field: "generatedAt",
        });
    }
    Ok(())
}

fn map_json_error(error: serde_json::Error) -> ContractError {
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
        ContractError::RepositorySyntax
    }
}
