use crc::{CRC_8_SMBUS, CRC_16_IBM_SDLC, CRC_32_ISO_HDLC, Crc};
use std::sync::LazyLock;

static CRC8: LazyLock<Crc<u8>> = LazyLock::new(|| Crc::<u8>::new(&CRC_8_SMBUS));
static CRC16: LazyLock<Crc<u16>> = LazyLock::new(|| Crc::<u16>::new(&CRC_16_IBM_SDLC));
static CRC32: LazyLock<Crc<u32>> = LazyLock::new(|| Crc::<u32>::new(&CRC_32_ISO_HDLC));

pub fn calculate_checksum(data: &[u8]) -> String {
    let sum: u32 = data.iter().map(|&b| b as u32).sum();
    format!("{:02X}", (sum & 0xFF) as u8)
}

pub fn calculate_crc8(data: &[u8]) -> String {
    format!("{:02X}", CRC8.checksum(data))
}

pub fn calculate_crc16(data: &[u8]) -> String {
    format!("{:04X}", CRC16.checksum(data))
}

pub fn calculate_crc32(data: &[u8]) -> String {
    format!("{:08X}", CRC32.checksum(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checksum() {
        assert_eq!(calculate_checksum(&[0x01, 0x02, 0x03]), "06");
    }

    #[test]
    fn test_checksum_masks_to_one_byte() {
        // 0xFF + 0x02 = 0x101 — must be masked to the low byte (0x01), not 0x101.
        assert_eq!(calculate_checksum(&[0xFF, 0x02]), "01");
        // 0xFF + 0x01 = 0x100 → low byte 0x00.
        assert_eq!(calculate_checksum(&[0xFF, 0x01]), "00");
    }

    #[test]
    fn test_crc8() {
        assert_eq!(calculate_crc8(&[0x31, 0x32, 0x33]), "C0");
    }

    #[test]
    fn test_crc16() {
        assert_eq!(calculate_crc16(b"123456789"), "906E");
    }

    #[test]
    fn test_crc32() {
        assert_eq!(calculate_crc32(b"123456789"), "CBF43926");
    }
}
