use core::fmt;

/// Errors produced while decoding or encoding CBOR values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CborError {
    Truncated,
    TrailingData,
    InvalidAdditionalInfo(u8),
    UnexpectedBreak,
    InvalidUtf8,
    IntegerOutOfRange,
    UnsupportedSimple(u8),
    DepthLimit,
    ItemLimit,
    ByteLimit,
    MapKeyNotText,
}

impl fmt::Display for CborError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated CBOR value"),
            Self::TrailingData => f.write_str("trailing data after CBOR value"),
            Self::InvalidAdditionalInfo(value) => {
                write!(f, "invalid CBOR additional-info value {value}")
            }
            Self::UnexpectedBreak => f.write_str("unexpected CBOR break marker"),
            Self::InvalidUtf8 => f.write_str("CBOR text is not UTF-8"),
            Self::IntegerOutOfRange => f.write_str("CBOR integer is outside the supported range"),
            Self::UnsupportedSimple(value) => write!(f, "unsupported CBOR simple value {value}"),
            Self::DepthLimit => f.write_str("CBOR nesting depth limit exceeded"),
            Self::ItemLimit => f.write_str("CBOR item limit exceeded"),
            Self::ByteLimit => f.write_str("CBOR byte limit exceeded"),
            Self::MapKeyNotText => f.write_str("typed MCUmgr request map key is not text"),
        }
    }
}

/// Bounded, deterministic wire-protocol failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    InvalidHeaderLength { actual: usize },
    ReservedHeaderBits(u8),
    UnsupportedVersion(u8),
    InvalidOperation(u8),
    PayloadTooLarge { actual: usize, maximum: usize },
    Truncated { needed: usize, actual: usize },
    LengthMismatch { declared: usize, actual: usize },
    InvalidBase64Length(usize),
    InvalidBase64Byte { offset: usize, byte: u8 },
    InvalidBase64Padding,
    NonCanonicalBase64,
    ConsoleFrameTooSmall(usize),
    ConsoleLineTooLong { maximum: usize },
    ConsoleFragmentTooShort,
    UnexpectedContinuation,
    CrcMismatch { expected: u16, actual: u16 },
    SequenceMismatch { expected: u8, actual: u8 },
    GroupMismatch { expected: u16, actual: u16 },
    CommandMismatch { expected: u8, actual: u8 },
    OperationMismatch { expected: u8, actual: u8 },
    VersionMismatch { expected: u8, actual: u8 },
    Cbor(CborError),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHeaderLength { actual } => {
                write!(f, "SMP header must be 8 bytes, got {actual}")
            }
            Self::ReservedHeaderBits(value) => {
                write!(f, "SMP header reserved bits are non-zero: {value:#04x}")
            }
            Self::UnsupportedVersion(value) => write!(f, "unsupported SMP version bits: {value}"),
            Self::InvalidOperation(value) => write!(f, "invalid SMP operation: {value}"),
            Self::PayloadTooLarge { actual, maximum } => {
                write!(f, "payload has {actual} bytes; maximum is {maximum}")
            }
            Self::Truncated { needed, actual } => {
                write!(f, "truncated frame: need {needed} bytes, got {actual}")
            }
            Self::LengthMismatch { declared, actual } => {
                write!(
                    f,
                    "declared length {declared} does not match {actual} bytes"
                )
            }
            Self::InvalidBase64Length(value) => write!(f, "invalid Base64 length {value}"),
            Self::InvalidBase64Byte { offset, byte } => {
                write!(f, "invalid Base64 byte {byte:#04x} at offset {offset}")
            }
            Self::InvalidBase64Padding => f.write_str("invalid Base64 padding"),
            Self::NonCanonicalBase64 => f.write_str("non-canonical Base64 trailing bits"),
            Self::ConsoleFrameTooSmall(value) => {
                write!(
                    f,
                    "console frame size {value} cannot hold a framed SMP packet"
                )
            }
            Self::ConsoleLineTooLong { maximum } => {
                write!(f, "console line exceeds {maximum} bytes")
            }
            Self::ConsoleFragmentTooShort => f.write_str("console first fragment has no length"),
            Self::UnexpectedContinuation => {
                f.write_str("console continuation has no first fragment")
            }
            Self::CrcMismatch { expected, actual } => {
                write!(
                    f,
                    "CRC mismatch: expected {expected:#06x}, got {actual:#06x}"
                )
            }
            Self::SequenceMismatch { expected, actual } => {
                write!(f, "sequence mismatch: expected {expected}, got {actual}")
            }
            Self::GroupMismatch { expected, actual } => {
                write!(f, "group mismatch: expected {expected}, got {actual}")
            }
            Self::CommandMismatch { expected, actual } => {
                write!(f, "command mismatch: expected {expected}, got {actual}")
            }
            Self::OperationMismatch { expected, actual } => {
                write!(f, "operation mismatch: expected {expected}, got {actual}")
            }
            Self::VersionMismatch { expected, actual } => {
                write!(f, "version mismatch: expected {expected}, got {actual}")
            }
            Self::Cbor(error) => write!(f, "CBOR error: {error}"),
        }
    }
}

impl From<CborError> for ProtocolError {
    fn from(value: CborError) -> Self {
        Self::Cbor(value)
    }
}

#[cfg(feature = "std")]
impl std::error::Error for CborError {}

#[cfg(feature = "std")]
impl std::error::Error for ProtocolError {}
