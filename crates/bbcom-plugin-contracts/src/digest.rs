use sha2::{Digest, Sha256};

use crate::{ContractError, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub fn parse_hex(value: &str, field: &'static str) -> Result<Self> {
        if value.len() != 64 {
            return Err(ContractError::InvalidField { field });
        }
        let mut digest = [0_u8; 32];
        for (target, pair) in digest.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
            let high = decode_hex(pair[0]).ok_or(ContractError::InvalidField { field })?;
            let low = decode_hex(pair[1]).ok_or(ContractError::InvalidField { field })?;
            *target = (high << 4) | low;
        }
        Ok(Self(digest))
    }

    #[must_use]
    pub fn calculate(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    #[must_use]
    pub fn verifies(self, bytes: &[u8]) -> bool {
        self == Self::calculate(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}
