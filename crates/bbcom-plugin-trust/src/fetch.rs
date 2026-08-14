use crate::{Error, Result};
use std::collections::BTreeSet;
use url::Url;

pub const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryEndpoint {
    id: String,
    base_url: String,
    origin: String,
}

impl RepositoryEndpoint {
    pub fn new(id: impl Into<String>, base_url: impl Into<String>) -> Result<Self> {
        let id = id.into();
        if id.len() < 2
            || id.len() > 64
            || !id.bytes().enumerate().all(|(index, byte)| match byte {
                b'a'..=b'z' | b'0'..=b'9' => true,
                b'-' => index > 0 && index + 1 < id.len(),
                _ => false,
            })
        {
            return Err(Error::InvalidConfiguration);
        }
        let base_url = base_url.into();
        let parsed = StrictHttpsUrl::parse(&base_url)?;
        if parsed.url.query().is_some() || !parsed.url.path().ends_with('/') {
            return Err(Error::InvalidConfiguration);
        }
        Ok(Self {
            id,
            base_url: parsed.url.to_string(),
            origin: parsed.origin,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub(crate) fn url(&self, relative: &str) -> Result<String> {
        if relative.is_empty() || relative.starts_with('/') || relative.contains(['#', '?', '\\']) {
            return Err(Error::InvalidUrl);
        }
        if relative.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || contains_encoded_dot(segment)
        }) {
            return Err(Error::InvalidUrl);
        }
        let joined = self
            .base_url
            .parse::<Url>()
            .map_err(|_| Error::InvalidUrl)?
            .join(relative)
            .map_err(|_| Error::InvalidUrl)?;
        let parsed = StrictHttpsUrl::from_url(joined)?;
        if parsed.origin != self.origin || parsed.url.query().is_some() {
            return Err(Error::InvalidUrl);
        }
        Ok(parsed.url.to_string())
    }

    pub(crate) fn target_url(&self, relative: &str) -> Result<String> {
        self.url(relative)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryConfiguration {
    repositories: Vec<RepositoryEndpoint>,
}

impl RepositoryConfiguration {
    pub fn new(repositories: Vec<RepositoryEndpoint>) -> Result<Self> {
        if repositories.is_empty() {
            return Err(Error::InvalidConfiguration);
        }
        let mut ids = BTreeSet::new();
        let mut origins = BTreeSet::new();
        for repository in &repositories {
            if !ids.insert(repository.id()) || !origins.insert(repository.origin()) {
                return Err(Error::InvalidConfiguration);
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
pub struct FetchResponse {
    pub status: u16,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

pub trait FetchPort {
    type Error;

    /// Performs one GET and must not follow redirects automatically. The
    /// implementation must stop reading after `maximum_bytes + 1` bytes and
    /// reject loopback, link-local, private, and metadata-service destinations
    /// after every DNS resolution. The trust core independently rechecks every
    /// returned redirect's HTTPS origin.
    fn get(
        &mut self,
        url: &str,
        maximum_bytes: u64,
    ) -> std::result::Result<FetchResponse, Self::Error>;
}

pub(crate) fn fetch_bounded<F: FetchPort>(
    fetch: &mut F,
    endpoint: &RepositoryEndpoint,
    relative: &str,
    maximum_bytes: u64,
) -> Result<Vec<u8>> {
    let mut url = endpoint.url(relative)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let response = fetch
            .get(&url, maximum_bytes)
            .map_err(|_| Error::Transport)?;
        if u64::try_from(response.body.len()).unwrap_or(u64::MAX) > maximum_bytes {
            return Err(Error::ResponseTooLarge);
        }
        if response.status == 200 {
            return Ok(response.body);
        }
        if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            return Err(Error::HttpStatus(response.status));
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(Error::RedirectLimit);
        }
        let next = response.location.ok_or(Error::InvalidUrl)?;
        // Redirect locations are required to be absolute. This prevents a
        // transport implementation from applying a different URL join policy.
        let parsed = StrictHttpsUrl::parse(&next)?;
        if parsed.origin != endpoint.origin {
            return Err(Error::CrossOriginRedirect);
        }
        url = parsed.url.to_string();
    }
    Err(Error::RedirectLimit)
}

struct StrictHttpsUrl {
    url: Url,
    origin: String,
}

impl StrictHttpsUrl {
    fn parse(value: &str) -> Result<Self> {
        let url = Url::parse(value).map_err(|_| Error::InvalidUrl)?;
        Self::from_url(url)
    }

    fn from_url(url: Url) -> Result<Self> {
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.port_or_known_default().is_none()
        {
            return Err(Error::InvalidUrl);
        }
        if url.path_segments().is_some_and(|segments| {
            segments
                .into_iter()
                .any(|segment| segment == "." || segment == ".." || contains_encoded_dot(segment))
        }) {
            return Err(Error::InvalidUrl);
        }
        let origin = url.origin().ascii_serialization();
        Ok(Self { url, origin })
    }
}

fn contains_encoded_dot(segment: &str) -> bool {
    let lowercase = segment.to_ascii_lowercase();
    lowercase.contains("%2e")
}
