use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChecksumType {
    Checksum,
    Crc8,
    Crc16,
    Crc32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_frontend_constant_strings() {
        // Must match src/lib/constants.ts CHECKSUM_ALGORITHMS values exactly.
        assert_eq!(
            serde_json::to_string(&ChecksumType::Checksum).unwrap(),
            "\"CHECKSUM\""
        );
        assert_eq!(
            serde_json::to_string(&ChecksumType::Crc8).unwrap(),
            "\"CRC8\""
        );
        assert_eq!(
            serde_json::to_string(&ChecksumType::Crc16).unwrap(),
            "\"CRC16\""
        );
        assert_eq!(
            serde_json::to_string(&ChecksumType::Crc32).unwrap(),
            "\"CRC32\""
        );
    }

    #[test]
    fn deserializes_frontend_constant_strings() {
        assert_eq!(
            serde_json::from_str::<ChecksumType>("\"CHECKSUM\"").unwrap(),
            ChecksumType::Checksum
        );
        assert_eq!(
            serde_json::from_str::<ChecksumType>("\"CRC8\"").unwrap(),
            ChecksumType::Crc8
        );
        assert_eq!(
            serde_json::from_str::<ChecksumType>("\"CRC16\"").unwrap(),
            ChecksumType::Crc16
        );
        assert_eq!(
            serde_json::from_str::<ChecksumType>("\"CRC32\"").unwrap(),
            ChecksumType::Crc32
        );
    }
}
