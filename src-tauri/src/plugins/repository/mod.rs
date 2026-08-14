//! Native-only HTTP transport for the signed plugin repository trust core.
//!
//! This module owns no update scheduler and never follows redirects. Every
//! request performs a fresh DNS resolution, rejects any non-public result, and
//! pins the complete reviewed address set into a one-request reqwest client.

use std::fmt;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use bbcom_plugin_trust::{FetchPort, FetchResponse};
use reqwest::Url;
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{ACCEPT_ENCODING, LOCATION};
use reqwest::redirect::Policy;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeRepositoryFetchPort;

impl NativeRepositoryFetchPort {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl FetchPort for NativeRepositoryFetchPort {
    type Error = NativeRepositoryFetchError;

    fn get(&mut self, url: &str, maximum_bytes: u64) -> Result<FetchResponse, Self::Error> {
        let parsed = validate_url(url)?;
        let host = parsed
            .host_str()
            .ok_or(NativeRepositoryFetchError::InvalidUrl)?;
        let port = parsed
            .port_or_known_default()
            .ok_or(NativeRepositoryFetchError::InvalidUrl)?;
        let addresses = resolve_public(host, port)?;
        let client = build_pinned_client(host, &addresses)?;
        let mut response = client
            .get(parsed)
            // Content transformations are forbidden even if a future reqwest
            // feature accidentally enables a decompressor.
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|_| NativeRepositoryFetchError::Request)?;

        let status = response.status().as_u16();
        let location = exact_location(response.headers())?;
        let maximum_plus_one = maximum_bytes
            .checked_add(1)
            .ok_or(NativeRepositoryFetchError::InvalidLimit)?;
        reject_declared_length(response.content_length(), maximum_bytes)?;
        let body = read_bounded(&mut response, maximum_bytes, maximum_plus_one)?;

        Ok(FetchResponse {
            status,
            location,
            body,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRepositoryFetchError {
    InvalidUrl,
    InvalidLimit,
    Resolution,
    NoAddresses,
    NonPublicAddress,
    Client,
    Request,
    InvalidLocation,
    ResponseTooLarge,
    Read,
}

impl fmt::Display for NativeRepositoryFetchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidUrl => "repository request URL is not strict HTTPS",
            Self::InvalidLimit => "repository response limit is invalid",
            Self::Resolution => "repository DNS resolution failed",
            Self::NoAddresses => "repository DNS resolution returned no addresses",
            Self::NonPublicAddress => "repository DNS resolution returned a non-public address",
            Self::Client => "repository HTTP client configuration failed",
            Self::Request => "repository HTTPS request failed",
            Self::InvalidLocation => "repository response contains an invalid Location header",
            Self::ResponseTooLarge => "repository response exceeded its fixed limit",
            Self::Read => "repository response read failed",
        })
    }
}

impl std::error::Error for NativeRepositoryFetchError {}

fn validate_url(value: &str) -> Result<Url, NativeRepositoryFetchError> {
    let parsed = Url::parse(value).map_err(|_| NativeRepositoryFetchError::InvalidUrl)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.port_or_known_default().is_none()
    {
        return Err(NativeRepositoryFetchError::InvalidUrl);
    }
    Ok(parsed)
}

fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, NativeRepositoryFetchError> {
    let mut addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| NativeRepositoryFetchError::Resolution)?
        .collect();
    if addresses.is_empty() {
        return Err(NativeRepositoryFetchError::NoAddresses);
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(NativeRepositoryFetchError::NonPublicAddress);
    }
    Ok(addresses)
}

fn build_pinned_client(
    host: &str,
    addresses: &[SocketAddr],
) -> Result<Client, NativeRepositoryFetchError> {
    ClientBuilder::new()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        // Reqwest uses no cookie store by default. The direct dependency does
        // not enable its optional `cookies` feature, so no cookie API or
        // persistence implementation is compiled into this boundary.
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .no_hickory_dns()
        .https_only(true)
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(|_| NativeRepositoryFetchError::Client)
}

fn exact_location(
    headers: &reqwest::header::HeaderMap,
) -> Result<Option<String>, NativeRepositoryFetchError> {
    let mut values = headers.get_all(LOCATION).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(NativeRepositoryFetchError::InvalidLocation);
    }
    first
        .to_str()
        .map(str::to_owned)
        .map(Some)
        .map_err(|_| NativeRepositoryFetchError::InvalidLocation)
}

fn reject_declared_length(
    content_length: Option<u64>,
    maximum_bytes: u64,
) -> Result<(), NativeRepositoryFetchError> {
    if content_length.is_some_and(|length| length > maximum_bytes) {
        Err(NativeRepositoryFetchError::ResponseTooLarge)
    } else {
        Ok(())
    }
}

fn read_bounded(
    reader: &mut impl Read,
    maximum_bytes: u64,
    maximum_plus_one: u64,
) -> Result<Vec<u8>, NativeRepositoryFetchError> {
    let capacity = usize::try_from(maximum_plus_one.min(64 * 1024)).unwrap_or(64 * 1024);
    let mut body = Vec::with_capacity(capacity);
    reader
        .take(maximum_plus_one)
        .read_to_end(&mut body)
        .map_err(|_| NativeRepositoryFetchError::Read)?;
    if u64::try_from(body.len()).unwrap_or(u64::MAX) > maximum_bytes {
        return Err(NativeRepositoryFetchError::ResponseTooLarge);
    }
    Ok(body)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, d] = address.octets();
    !(
        // Current network, private, loopback, link-local and shared CGNAT.
        a == 0
            || a == 10
            || a == 127
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            // IETF protocol assignments include 192.0.0.192 metadata services.
            || (a == 192 && b == 0 && c == 0)
            // Documentation networks.
            || (a == 192 && b == 0 && c == 2)
            || (a == 192 && b == 88 && c == 99)
            || (a == 198 && b == 51 && c == 100)
            || (a == 203 && b == 0 && c == 113)
            // Benchmarking.
            || (a == 198 && (b == 18 || b == 19))
            // Multicast, reserved and limited broadcast.
            || a >= 224
            // Explicit cloud metadata endpoints already covered by ranges are
            // repeated here as a readable permanent policy assertion.
            || [a, b, c, d] == [169, 254, 169, 254]
            || [a, b, c, d] == [100, 100, 100, 200]
    )
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = address.segments();
    let first = segments[0];
    // Public IPv6 unicast is 2000::/3. This excludes unspecified, loopback,
    // IPv4-compatible, ULA, link-local and multicast space by construction.
    if !(0x2000..=0x3fff).contains(&first) {
        return false;
    }
    // Documentation, benchmarking, ORCHID and retired 6bone ranges are never
    // valid plugin repository destinations.
    if (first == 0x2001 && segments[1] == 0x0db8)
        || (first == 0x2001 && segments[1] == 0x0002)
        || (first == 0x2001 && (segments[1] & 0xfff0 == 0x0010))
        || (first == 0x2001 && (segments[1] & 0xfff0 == 0x0020))
        || first == 0x3ffe
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credentials_query_fragment_and_non_https() {
        for value in [
            "http://example.com/package",
            "https://user@example.com/package",
            "https://example.com/package?token=secret",
            "https://example.com/package#fragment",
        ] {
            assert_eq!(
                validate_url(value).unwrap_err(),
                NativeRepositoryFetchError::InvalidUrl
            );
        }
    }

    #[test]
    fn rejects_malicious_ipv4_ranges_and_allows_public_unicast() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "100.100.100.200",
            "127.0.0.1",
            "169.254.169.254",
            "172.31.255.255",
            "192.0.0.192",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public_ip(value.parse().unwrap()), "accepted {value}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn rejects_non_global_ipv6_and_ipv4_mapped_private_addresses() {
        for value in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "2001:2::1",
            "2001:db8::1",
            "3ffe::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(value.parse().unwrap()), "accepted {value}");
        }
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn oversized_declared_body_is_rejected_before_reading() {
        assert_eq!(
            reject_declared_length(Some(11), 10).unwrap_err(),
            NativeRepositoryFetchError::ResponseTooLarge
        );
        assert!(reject_declared_length(Some(10), 10).is_ok());
        assert!(reject_declared_length(None, 10).is_ok());
        let mut body = std::io::Cursor::new(vec![0_u8; 11]);
        assert_eq!(
            read_bounded(&mut body, 10, 11).unwrap_err(),
            NativeRepositoryFetchError::ResponseTooLarge
        );
    }
}
