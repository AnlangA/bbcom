use std::collections::BTreeSet;

use bbcom_plugin_contracts::{
    MAX_PACKAGE_DOWNLOAD_BYTES, RepositoryCatalog, RepositoryIndex, RepositoryPackage, Sha256Digest,
};
use semver::Version;
use thiserror::Error;
use url::Url;

use crate::{RepositoryError, Result};

pub const MAX_REPOSITORY_INDEX_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryEndpoint {
    id: String,
    index_url: String,
    origin: String,
}

impl RepositoryEndpoint {
    pub fn new(id: impl Into<String>, index_url: impl Into<String>) -> Result<Self> {
        let id = id.into();
        if id.len() < 2
            || id.len() > 64
            || !id.bytes().enumerate().all(|(index, byte)| match byte {
                b'a'..=b'z' | b'0'..=b'9' => true,
                b'-' => index > 0 && index + 1 < id.len(),
                _ => false,
            })
        {
            return Err(RepositoryError::InvalidConfiguration("repository id"));
        }
        let index_url = index_url.into();
        let parsed = parse_https_url(&index_url)?;
        if parsed.fragment().is_some() || parsed.query().is_some() {
            return Err(RepositoryError::InvalidHttpsUrl);
        }
        let origin = canonical_origin(&parsed);
        Ok(Self {
            id,
            index_url: parsed.to_string(),
            origin,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn index_url(&self) -> &str {
        &self.index_url
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryConfiguration {
    repositories: Vec<RepositoryEndpoint>,
}

impl RepositoryConfiguration {
    pub fn new(repositories: Vec<RepositoryEndpoint>) -> Result<Self> {
        if repositories.is_empty() {
            return Err(RepositoryError::InvalidConfiguration("repositories"));
        }
        let mut ids = BTreeSet::new();
        let mut origins = BTreeSet::new();
        for repository in &repositories {
            if !ids.insert(repository.id.as_str()) {
                return Err(RepositoryError::InvalidConfiguration(
                    "duplicate repository id",
                ));
            }
            if !origins.insert(repository.origin.as_str()) {
                return Err(RepositoryError::InvalidConfiguration(
                    "duplicate repository origin",
                ));
            }
        }
        Ok(Self { repositories })
    }

    #[must_use]
    pub fn repositories(&self) -> &[RepositoryEndpoint] {
        &self.repositories
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpsResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpsResponse {
    #[must_use]
    pub fn new(status: u16, headers: Vec<(String, String)>, body: Vec<u8>) -> Self {
        Self {
            status,
            headers,
            body,
        }
    }

    #[must_use]
    pub const fn status(&self) -> u16 {
        self.status
    }

    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct TransportError {
    message: String,
}

impl TransportError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait HttpsTransport {
    /// Performs one GET without automatically following redirects.
    /// Implementations must stop reading after `max_response_bytes + 1` bytes.
    fn get(
        &self,
        url: &str,
        max_response_bytes: u64,
    ) -> std::result::Result<HttpsResponse, TransportError>;
}

#[derive(Clone, Debug)]
pub struct DownloadedPackage {
    repository_origin: String,
    plugin_id: String,
    publisher_identity: String,
    package: RepositoryPackage,
    bytes: Vec<u8>,
}

impl DownloadedPackage {
    /// Constructs a package only from an upstream trust boundary that has
    /// already authenticated the repository target and publisher. The
    /// repository layer independently rechecks every structural, length and
    /// digest invariant before any bytes can enter installation staging.
    pub fn from_verified_target(
        repository_origin: String,
        plugin_id: String,
        publisher_identity: String,
        package: RepositoryPackage,
        bytes: Vec<u8>,
    ) -> Result<Self> {
        if parse_origin_field(&repository_origin)? != repository_origin {
            return Err(RepositoryError::RepositoryOriginMismatch);
        }
        validate_verified_publisher_identity(&publisher_identity)?;
        RepositoryIndex {
            schema: 1,
            generated_at: "1970-01-01T00:00:00Z".to_owned(),
            origin: repository_origin.clone(),
            update_policy: "manual".to_owned(),
            plugins: vec![bbcom_plugin_contracts::RepositoryPlugin {
                id: plugin_id.clone(),
                publisher_identity: publisher_identity.clone(),
                packages: vec![package.clone()],
            }],
        }
        .validate()?;
        let actual = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual != package.download_bytes {
            return Err(RepositoryError::PackageMetadataMismatch {
                field: "downloadBytes",
                expected: package.download_bytes,
                actual,
            });
        }
        let expected = Sha256Digest::parse_hex(&package.sha256, "sha256")?;
        if !expected.verifies(&bytes) {
            return Err(RepositoryError::PackageDigestMismatch);
        }
        Ok(Self {
            repository_origin,
            plugin_id,
            publisher_identity,
            package,
            bytes,
        })
    }

    #[must_use]
    pub fn repository_origin(&self) -> &str {
        &self.repository_origin
    }

    #[must_use]
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    #[must_use]
    pub fn publisher_identity(&self) -> &str {
        &self.publisher_identity
    }

    #[must_use]
    pub fn package(&self) -> &RepositoryPackage {
        &self.package
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

fn validate_verified_publisher_identity(value: &str) -> Result<()> {
    let fingerprint =
        value
            .strip_prefix("publisher:sha256-")
            .ok_or(RepositoryError::InvalidConfiguration(
                "verified publisher identity",
            ))?;
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(RepositoryError::InvalidConfiguration(
            "verified publisher identity",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManualUpdateCandidate {
    pub repository_origin: String,
    pub plugin_id: String,
    pub publisher_identity: String,
    pub package: RepositoryPackage,
}

pub struct RepositoryClient<T> {
    transport: T,
}

impl<T: HttpsTransport> RepositoryClient<T> {
    #[must_use]
    pub const fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn fetch_catalog(
        &self,
        configuration: &RepositoryConfiguration,
    ) -> Result<RepositoryCatalog> {
        let mut indexes = Vec::with_capacity(configuration.repositories.len());
        for endpoint in &configuration.repositories {
            let bytes = self.get_bounded(&endpoint.index_url, MAX_REPOSITORY_INDEX_BYTES)?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| RepositoryError::InvalidConfiguration("repository encoding"))?;
            let index = RepositoryIndex::parse(text)?;
            let index_origin = parse_origin_field(&index.origin)?;
            if index_origin != endpoint.origin {
                return Err(RepositoryError::RepositoryOriginMismatch);
            }
            indexes.push(index);
        }
        RepositoryCatalog::new(indexes).map_err(Into::into)
    }

    pub fn manual_update_candidates(
        &self,
        catalog: &RepositoryCatalog,
        plugin_id: &str,
        current_version: &str,
    ) -> Result<Vec<ManualUpdateCandidate>> {
        let current = Version::parse(current_version)
            .map_err(|_| RepositoryError::InvalidConfiguration("current version"))?;
        let mut candidates = Vec::new();
        for index in &catalog.repositories {
            index.validate()?;
            for plugin in index.plugins.iter().filter(|plugin| plugin.id == plugin_id) {
                for package in &plugin.packages {
                    let version = Version::parse(&package.version)
                        .map_err(|_| RepositoryError::InvalidConfiguration("package version"))?;
                    if version > current {
                        candidates.push((
                            version,
                            ManualUpdateCandidate {
                                repository_origin: index.origin.clone(),
                                plugin_id: plugin.id.clone(),
                                publisher_identity: plugin.publisher_identity.clone(),
                                package: package.clone(),
                            },
                        ));
                    }
                }
            }
        }
        candidates.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.repository_origin.cmp(&right.1.repository_origin))
        });
        Ok(candidates
            .into_iter()
            .map(|(_, candidate)| candidate)
            .collect())
    }

    pub fn download_package(
        &self,
        index: &RepositoryIndex,
        plugin_id: &str,
        version: &str,
    ) -> Result<DownloadedPackage> {
        index.validate()?;
        let plugin = index
            .plugins
            .iter()
            .find(|plugin| plugin.id == plugin_id)
            .ok_or(RepositoryError::PackageNotFound)?;
        let package = plugin
            .packages
            .iter()
            .find(|package| package.version == version)
            .ok_or(RepositoryError::PackageNotFound)?;
        let bytes = self.get_bounded(&package.url, MAX_PACKAGE_DOWNLOAD_BYTES)?;
        let actual = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual != package.download_bytes {
            return Err(RepositoryError::PackageMetadataMismatch {
                field: "downloadBytes",
                expected: package.download_bytes,
                actual,
            });
        }
        let expected = Sha256Digest::parse_hex(&package.sha256, "sha256")?;
        if !expected.verifies(&bytes) {
            return Err(RepositoryError::PackageDigestMismatch);
        }
        Ok(DownloadedPackage {
            repository_origin: index.origin.clone(),
            plugin_id: plugin.id.clone(),
            publisher_identity: plugin.publisher_identity.clone(),
            package: package.clone(),
            bytes,
        })
    }

    fn get_bounded(&self, initial_url: &str, limit: u64) -> Result<Vec<u8>> {
        let mut current = parse_https_url(initial_url)?;
        let initial_origin = canonical_origin(&current);
        for redirect_count in 0..=MAX_REDIRECTS {
            let response = self
                .transport
                .get(current.as_str(), limit)
                .map_err(|error| RepositoryError::Transport(error.to_string()))?;
            if u64::try_from(response.body.len()).unwrap_or(u64::MAX) > limit {
                return Err(RepositoryError::ResponseTooLarge { limit });
            }
            if response.status == 200 {
                return Ok(response.body);
            }
            if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                return Err(RepositoryError::HttpStatus(response.status));
            }
            if redirect_count == MAX_REDIRECTS {
                return Err(RepositoryError::RedirectLimitExceeded);
            }
            let mut locations = response
                .headers
                .iter()
                .filter(|(name, _)| name.eq_ignore_ascii_case("location"));
            let location = locations
                .next()
                .map(|(_, value)| value)
                .ok_or(RepositoryError::InvalidRedirect)?;
            if locations.next().is_some() {
                return Err(RepositoryError::InvalidRedirect);
            }
            let next = current
                .join(location)
                .map_err(|_| RepositoryError::InvalidRedirect)?;
            validate_parsed_https_url(&next)?;
            if canonical_origin(&next) != initial_origin {
                return Err(RepositoryError::CrossOriginRedirect);
            }
            current = next;
        }
        Err(RepositoryError::RedirectLimitExceeded)
    }
}

fn parse_https_url(value: &str) -> Result<Url> {
    let parsed = Url::parse(value).map_err(|_| RepositoryError::InvalidHttpsUrl)?;
    validate_parsed_https_url(&parsed)?;
    Ok(parsed)
}

fn validate_parsed_https_url(parsed: &Url) -> Result<()> {
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(RepositoryError::InvalidHttpsUrl);
    }
    Ok(())
}

fn parse_origin_field(value: &str) -> Result<String> {
    let parsed = parse_https_url(value)?;
    if parsed.path() != "/" || parsed.query().is_some() {
        return Err(RepositoryError::RepositoryOriginMismatch);
    }
    Ok(canonical_origin(&parsed))
}

fn canonical_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

#[cfg(test)]
mod verified_target_tests {
    use super::*;

    #[test]
    fn verified_target_constructor_rechecks_identity_structure_length_and_digest() {
        let bytes = b"signed package".to_vec();
        let package = RepositoryPackage {
            version: "1.0.0".to_owned(),
            url: "https://repo.test/plugins/dev.bbcom.fixture/1.0.0.bbcom".to_owned(),
            sha256: hex(Sha256Digest::calculate(&bytes).as_bytes()),
            download_bytes: bytes.len() as u64,
            expanded_bytes: 4096,
            files: 2,
        };
        let identity = format!("publisher:sha256-{}", "ab".repeat(32));
        assert!(
            DownloadedPackage::from_verified_target(
                "https://repo.test".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                identity.clone(),
                package.clone(),
                bytes.clone(),
            )
            .is_ok()
        );
        assert!(
            DownloadedPackage::from_verified_target(
                "https://repo.test/catalog".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                identity,
                package.clone(),
                bytes.clone(),
            )
            .is_err()
        );
        assert!(
            DownloadedPackage::from_verified_target(
                "https://repo.test".to_owned(),
                "dev.bbcom.fixture".to_owned(),
                "publisher:display-name".to_owned(),
                package,
                b"substituted".to_vec(),
            )
            .is_err()
        );
    }

    fn hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(char::from(HEX[usize::from(byte >> 4)]));
            output.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        output
    }
}
