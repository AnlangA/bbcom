use std::collections::BTreeMap;
use std::fmt;

use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::model::{
    Key, MetadataDescription, Role, RoleDefinition, RootMetadata, Signature, Signed,
    SnapshotMetadata, TargetDescription, TargetsMetadata, TimestampMetadata,
};
use crate::trust::MetadataDecoder;

const MAX_SIGNATURES: usize = 32;
const SPEC_MAJOR_MINOR: &str = "1.0";

#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalJsonDecoder;

impl MetadataDecoder for CanonicalJsonDecoder {
    type Error = DecodeError;

    fn root(&self, bytes: &[u8]) -> Result<Signed<RootMetadata>, Self::Error> {
        let envelope = decode_envelope::<WireRoot>(bytes)?;
        require_type(&envelope.signed.kind, "root")?;
        require_spec(&envelope.signed.spec_version)?;

        let mut keys = BTreeMap::new();
        for (key_id, key) in envelope.signed.keys {
            require_key_id(&key_id)?;
            if key.keytype != "ed25519" || key.scheme != "ed25519" {
                return Err(DecodeError);
            }
            let public = decode_array::<32>(&key.keyval.public)?;
            let canonical_key = canonical_key(&key.keyval.public)?;
            let calculated = hex(&Sha256::digest(canonical_key));
            if calculated != key_id {
                return Err(DecodeError);
            }
            keys.insert(key_id, Key { ed25519: public });
        }

        let mut roles = BTreeMap::new();
        for (name, definition) in envelope.signed.roles {
            let role = role(&name)?;
            if definition.keyids.is_empty() || definition.threshold == 0 {
                return Err(DecodeError);
            }
            for key_id in &definition.keyids {
                require_key_id(key_id)?;
            }
            if roles
                .insert(
                    role,
                    RoleDefinition {
                        key_ids: definition.keyids,
                        threshold: definition.threshold,
                    },
                )
                .is_some()
            {
                return Err(DecodeError);
            }
        }
        if roles.len() != 4 {
            return Err(DecodeError);
        }

        Ok(Signed {
            canonical_signed: envelope.canonical_signed,
            signatures: envelope.signatures,
            signed: RootMetadata {
                version: nonzero(envelope.signed.version)?,
                expires_unix: expires(&envelope.signed.expires)?,
                consistent_snapshot: envelope.signed.consistent_snapshot,
                keys,
                roles,
            },
        })
    }

    fn timestamp(&self, bytes: &[u8]) -> Result<Signed<TimestampMetadata>, Self::Error> {
        let envelope = decode_envelope::<WireTimestamp>(bytes)?;
        require_type(&envelope.signed.kind, "timestamp")?;
        require_spec(&envelope.signed.spec_version)?;
        let snapshot = exact_description(envelope.signed.meta, "snapshot.json")?;
        Ok(Signed {
            canonical_signed: envelope.canonical_signed,
            signatures: envelope.signatures,
            signed: TimestampMetadata {
                version: nonzero(envelope.signed.version)?,
                expires_unix: expires(&envelope.signed.expires)?,
                snapshot,
            },
        })
    }

    fn snapshot(&self, bytes: &[u8]) -> Result<Signed<SnapshotMetadata>, Self::Error> {
        let envelope = decode_envelope::<WireSnapshot>(bytes)?;
        require_type(&envelope.signed.kind, "snapshot")?;
        require_spec(&envelope.signed.spec_version)?;
        let targets = exact_description(envelope.signed.meta, "targets.json")?;
        Ok(Signed {
            canonical_signed: envelope.canonical_signed,
            signatures: envelope.signatures,
            signed: SnapshotMetadata {
                version: nonzero(envelope.signed.version)?,
                expires_unix: expires(&envelope.signed.expires)?,
                targets,
            },
        })
    }

    fn targets(&self, bytes: &[u8]) -> Result<Signed<TargetsMetadata>, Self::Error> {
        let envelope = decode_envelope::<WireTargets>(bytes)?;
        require_type(&envelope.signed.kind, "targets")?;
        require_spec(&envelope.signed.spec_version)?;
        if envelope.signed.targets.is_empty() {
            return Err(DecodeError);
        }
        let mut targets = BTreeMap::new();
        for (path, target) in envelope.signed.targets {
            if !valid_target_path(&path) {
                return Err(DecodeError);
            }
            let description = TargetDescription {
                plugin_id: target.custom.plugin_id,
                version: target.custom.version,
                length: nonzero(target.length)?,
                sha256: exact_sha256(target.hashes)?,
                expanded_bytes: nonzero(target.custom.expanded_bytes)?,
                files: nonzero_u32(target.custom.files)?,
                publisher_key: decode_array::<32>(&target.custom.publisher_key)?,
                publisher_signature: target
                    .custom
                    .publisher_signature
                    .as_deref()
                    .map(decode_array::<64>)
                    .transpose()?,
            };
            targets.insert(path, description);
        }
        Ok(Signed {
            canonical_signed: envelope.canonical_signed,
            signatures: envelope.signatures,
            signed: TargetsMetadata {
                version: nonzero(envelope.signed.version)?,
                expires_unix: expires(&envelope.signed.expires)?,
                targets,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeError;

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid canonical TUF JSON")
    }
}

impl std::error::Error for DecodeError {}

struct DecodedEnvelope<T> {
    canonical_signed: Vec<u8>,
    signatures: Vec<Signature>,
    signed: T,
}

fn decode_envelope<T: DeserializeOwned>(bytes: &[u8]) -> Result<DecodedEnvelope<T>, DecodeError> {
    let strict: StrictJson = serde_json::from_slice(bytes).map_err(|_| DecodeError)?;
    let StrictJson::Object(mut outer) = strict else {
        return Err(DecodeError);
    };
    if outer.len() != 2 {
        return Err(DecodeError);
    }
    let signed = outer.remove("signed").ok_or(DecodeError)?;
    let signatures = outer.remove("signatures").ok_or(DecodeError)?;
    let canonical_signed = canonical_json(&signed)?;
    let signed = serde_json::from_value(signed.into_value()).map_err(|_| DecodeError)?;
    let wire_signatures: Vec<WireSignature> =
        serde_json::from_value(signatures.into_value()).map_err(|_| DecodeError)?;
    if wire_signatures.is_empty() || wire_signatures.len() > MAX_SIGNATURES {
        return Err(DecodeError);
    }
    let signatures = wire_signatures
        .into_iter()
        .map(|signature| {
            require_key_id(&signature.keyid)?;
            Ok(Signature {
                key_id: signature.keyid,
                ed25519: decode_array::<64>(&signature.sig)?,
            })
        })
        .collect::<Result<Vec<_>, DecodeError>>()?;
    Ok(DecodedEnvelope {
        canonical_signed,
        signatures,
        signed,
    })
}

#[derive(Debug)]
enum StrictJson {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictJson;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("strict JSON without duplicate keys or floating point values")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJson::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictJson::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictJson::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictJson::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictJson::Number(value.into()))
    }

    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<Self::Value, E> {
        Err(E::custom("floating point values are forbidden"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictJson::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictJson::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(StrictJson::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, StrictJson>()? {
            if values.insert(key, value).is_some() {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
        }
        Ok(StrictJson::Object(values))
    }
}

impl StrictJson {
    fn into_value(self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(value) => serde_json::Value::Bool(value),
            Self::Number(value) => serde_json::Value::Number(value),
            Self::String(value) => serde_json::Value::String(value),
            Self::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(Self::into_value).collect())
            }
            Self::Object(values) => serde_json::Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value()))
                    .collect(),
            ),
        }
    }
}

fn canonical_json(value: &StrictJson) -> Result<Vec<u8>, DecodeError> {
    let mut output = Vec::new();
    write_canonical(value, &mut output)?;
    Ok(output)
}

fn write_canonical(value: &StrictJson, output: &mut Vec<u8>) -> Result<(), DecodeError> {
    match value {
        StrictJson::Null => output.extend_from_slice(b"null"),
        StrictJson::Bool(true) => output.extend_from_slice(b"true"),
        StrictJson::Bool(false) => output.extend_from_slice(b"false"),
        StrictJson::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        StrictJson::String(value) => output.extend_from_slice(
            serde_json::to_string(value)
                .map_err(|_| DecodeError)?
                .as_bytes(),
        ),
        StrictJson::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical(value, output)?;
            }
            output.push(b']');
        }
        StrictJson::Object(values) => {
            output.push(b'{');
            for (index, (key, value)) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| DecodeError)?
                        .as_bytes(),
                );
                output.push(b':');
                write_canonical(value, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSignature {
    keyid: String,
    sig: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRoot {
    #[serde(rename = "_type")]
    kind: String,
    spec_version: String,
    version: u64,
    expires: String,
    consistent_snapshot: bool,
    keys: BTreeMap<String, WireKey>,
    roles: BTreeMap<String, WireRole>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireKey {
    keytype: String,
    scheme: String,
    keyval: WireKeyValue,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireKeyValue {
    public: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRole {
    keyids: Vec<String>,
    threshold: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTimestamp {
    #[serde(rename = "_type")]
    kind: String,
    spec_version: String,
    version: u64,
    expires: String,
    meta: BTreeMap<String, WireDescription>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSnapshot {
    #[serde(rename = "_type")]
    kind: String,
    spec_version: String,
    version: u64,
    expires: String,
    meta: BTreeMap<String, WireDescription>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireDescription {
    version: u64,
    length: u64,
    hashes: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTargets {
    #[serde(rename = "_type")]
    kind: String,
    spec_version: String,
    version: u64,
    expires: String,
    targets: BTreeMap<String, WireTarget>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTarget {
    length: u64,
    hashes: BTreeMap<String, String>,
    custom: WireTargetCustom,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTargetCustom {
    plugin_id: String,
    version: String,
    expanded_bytes: u64,
    files: u32,
    publisher_key: String,
    publisher_signature: Option<String>,
}

fn canonical_key(public: &str) -> Result<Vec<u8>, DecodeError> {
    let key = WireKey {
        keytype: "ed25519".to_owned(),
        scheme: "ed25519".to_owned(),
        keyval: WireKeyValue {
            public: public.to_owned(),
        },
    };
    let value = serde_json::to_value(key).map_err(|_| DecodeError)?;
    let strict: StrictJson = serde_json::from_value(value).map_err(|_| DecodeError)?;
    canonical_json(&strict)
}

fn exact_description(
    mut descriptions: BTreeMap<String, WireDescription>,
    name: &str,
) -> Result<MetadataDescription, DecodeError> {
    if descriptions.len() != 1 {
        return Err(DecodeError);
    }
    let description = descriptions.remove(name).ok_or(DecodeError)?;
    Ok(MetadataDescription {
        version: nonzero(description.version)?,
        length: nonzero(description.length)?,
        sha256: exact_sha256(description.hashes)?,
    })
}

fn exact_sha256(mut hashes: BTreeMap<String, String>) -> Result<[u8; 32], DecodeError> {
    if hashes.len() != 1 {
        return Err(DecodeError);
    }
    decode_array::<32>(&hashes.remove("sha256").ok_or(DecodeError)?)
}

fn require_type(actual: &str, expected: &str) -> Result<(), DecodeError> {
    if actual == expected {
        Ok(())
    } else {
        Err(DecodeError)
    }
}

fn require_spec(value: &str) -> Result<(), DecodeError> {
    let mut parts = value.split('.');
    if parts.next() != Some("1")
        || parts.next() != Some("0")
        || parts.next().is_none_or(|patch| {
            patch.is_empty() || !patch.bytes().all(|byte| byte.is_ascii_digit())
        })
        || parts.next().is_some()
        || !value.starts_with(SPEC_MAJOR_MINOR)
    {
        Err(DecodeError)
    } else {
        Ok(())
    }
}

fn role(value: &str) -> Result<Role, DecodeError> {
    match value {
        "root" => Ok(Role::Root),
        "timestamp" => Ok(Role::Timestamp),
        "snapshot" => Ok(Role::Snapshot),
        "targets" => Ok(Role::Targets),
        _ => Err(DecodeError),
    }
}

fn expires(value: &str) -> Result<u64, DecodeError> {
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| DecodeError)?;
    if parsed.offset() != time::UtcOffset::UTC || !value.ends_with('Z') {
        return Err(DecodeError);
    }
    u64::try_from(parsed.unix_timestamp()).map_err(|_| DecodeError)
}

fn nonzero(value: u64) -> Result<u64, DecodeError> {
    if value == 0 {
        Err(DecodeError)
    } else {
        Ok(value)
    }
}

fn nonzero_u32(value: u32) -> Result<u32, DecodeError> {
    if value == 0 {
        Err(DecodeError)
    } else {
        Ok(value)
    }
}

fn require_key_id(value: &str) -> Result<(), DecodeError> {
    if value.len() == 64 && value.bytes().all(is_lower_hex) {
        Ok(())
    } else {
        Err(DecodeError)
    }
}

fn decode_array<const N: usize>(value: &str) -> Result<[u8; N], DecodeError> {
    if value.len() != N * 2 || !value.bytes().all(is_lower_hex) {
        return Err(DecodeError);
    }
    let mut output = [0_u8; N];
    for (target, pair) in output.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *target = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(output)
}

fn decode_nibble(value: u8) -> Result<u8, DecodeError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(DecodeError),
    }
}

fn is_lower_hex(value: u8) -> bool {
    value.is_ascii_digit() || matches!(value, b'a'..=b'f')
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

fn valid_target_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', '?', '#'])
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}
