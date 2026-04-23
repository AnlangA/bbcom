use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum ChecksumType {
    Checksum,
    Crc8,
    Crc16,
    Crc32,
}
