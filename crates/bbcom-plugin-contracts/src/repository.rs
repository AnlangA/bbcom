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
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Legacy self-asserted identity. Parsed for compatibility and ignored.
    #[serde(default)]
    pub publisher_identity: Option<String>,
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
            if plugin
                .name
                .as_deref()
                .is_some_and(|value| !valid_catalog_text(value, 128))
            {
                return Err(ContractError::InvalidField { field: "name" });
            }
            if plugin
                .description
                .as_deref()
                .is_some_and(|value| !valid_catalog_text(value, 1_024))
            {
                return Err(ContractError::InvalidField {
                    field: "description",
                });
            }
            if !plugin_ids.insert(&plugin.id) || plugin.packages.is_empty() {
                return Err(ContractError::InvalidField { field: "plugins" });
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

fn valid_catalog_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|character| {
            character.is_control() && !matches!(character, '\n' | '\r' | '\t')
        })
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

/// Maximum HTTP redirects a repository fetch may follow before failing.
pub const MAX_REDIRECTS: usize = 5;

/// Lowercase slugged repository id charset shared by every endpoint flavor:
/// `a-z`, `0-9`, and interior-only `-`, length 2..=64.
pub fn validate_repository_id(value: &str) -> Result<()> {
    if value.len() < 2
        || value.len() > 64
        || !value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'-' => index > 0 && index + 1 < value.len(),
            _ => false,
        })
    {
        return Err(ContractError::InvalidField {
            field: "repositoryId",
        });
    }
    Ok(())
}

/// One configured plugin repository: a validated id plus one canonical
/// strict-HTTPS URL. The repository index flavor keeps the full URL to the
/// index document; the metadata-base flavor (used by the trust core) keeps a
/// directory URL that relative metadata paths are resolved against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryEndpoint {
    id: String,
    url: String,
    origin: String,
}

impl RepositoryEndpoint {
    /// Index-document endpoint: `url` must be strict HTTPS without query or
    /// fragment. Duplicate detection across endpoints happens in
    /// [`RepositoryConfiguration::new`].
    pub fn new(id: impl Into<String>, url: impl Into<String>) -> Result<Self> {
        let id = id.into();
        validate_repository_id(&id)?;
        let parsed = strict_https(&url.into())?;
        if parsed.query().is_some() {
            return Err(ContractError::InvalidField {
                field: "repositoryUrl",
            });
        }
        Ok(Self::from_parts(id, parsed))
    }

    /// Metadata-base endpoint for the trust core: the URL additionally must
    /// end with `/` and must not contain dot, dot-dot, or encoded-dot path
    /// segments, so relative metadata paths can only resolve inside the
    /// configured directory.
    pub fn new_base(id: impl Into<String>, base_url: impl Into<String>) -> Result<Self> {
        let id = id.into();
        validate_repository_id(&id)?;
        let parsed = strict_https(&base_url.into())?;
        if parsed.query().is_some() || !parsed.path().ends_with('/') {
            return Err(ContractError::InvalidField {
                field: "repositoryUrl",
            });
        }
        Ok(Self::from_parts(id, parsed))
    }

    fn from_parts(id: String, url: Url) -> Self {
        Self {
            id,
            origin: url.origin().ascii_serialization(),
            url: url.to_string(),
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Canonical URL of the endpoint (the index document or metadata base).
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Resolves `relative` against a metadata-base endpoint. The relative
    /// path may not be empty, absolute, or contain a query, fragment, backslash,
    /// empty/dot/dot-dot/encoded-dot segment; the joined result must stay
    /// strict HTTPS inside the endpoint's origin.
    pub fn resolve(&self, relative: &str) -> Result<String> {
        if relative.is_empty() || relative.starts_with('/') || relative.contains(['#', '?', '\\']) {
            return Err(ContractError::InvalidField {
                field: "repositoryUrl",
            });
        }
        if relative.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || contains_encoded_dot(segment)
        }) {
            return Err(ContractError::InvalidField {
                field: "repositoryUrl",
            });
        }
        let joined = self
            .url
            .parse::<Url>()
            .map_err(|_| ContractError::InvalidField {
                field: "repositoryUrl",
            })?
            .join(relative)
            .map_err(|_| ContractError::InvalidField {
                field: "repositoryUrl",
            })?;
        if !is_strict_https(&joined)
            || contains_dot_segments(&joined)
            || joined.origin().ascii_serialization() != self.origin
            || joined.query().is_some()
        {
            return Err(ContractError::InvalidField {
                field: "repositoryUrl",
            });
        }
        Ok(joined.to_string())
    }
}

/// The complete manual-update repository set. At least one endpoint is
/// required and repository ids and origins must each be unique.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryConfiguration {
    repositories: Vec<RepositoryEndpoint>,
}

impl RepositoryConfiguration {
    pub fn new(repositories: Vec<RepositoryEndpoint>) -> Result<Self> {
        if repositories.is_empty() {
            return Err(ContractError::InvalidField {
                field: "repositories",
            });
        }
        let mut ids = BTreeSet::new();
        let mut origins = BTreeSet::new();
        for repository in &repositories {
            if !ids.insert(repository.id.as_str()) || !origins.insert(repository.origin.as_str()) {
                return Err(ContractError::InvalidField {
                    field: "repositories",
                });
            }
        }
        Ok(Self { repositories })
    }

    #[must_use]
    pub fn repositories(&self) -> &[RepositoryEndpoint] {
        &self.repositories
    }
}

fn strict_https(value: &str) -> Result<Url> {
    let parsed = Url::parse(value).map_err(|_| ContractError::InvalidField {
        field: "repositoryUrl",
    })?;
    if !is_strict_https(&parsed) || contains_dot_segments(&parsed) {
        return Err(ContractError::InvalidField {
            field: "repositoryUrl",
        });
    }
    Ok(parsed)
}

fn is_strict_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn contains_dot_segments(url: &Url) -> bool {
    url.path_segments().is_some_and(|segments| {
        segments
            .into_iter()
            .any(|segment| segment == "." || segment == ".." || contains_encoded_dot(segment))
    })
}

fn contains_encoded_dot(segment: &str) -> bool {
    segment.to_ascii_lowercase().contains("%2e")
}
