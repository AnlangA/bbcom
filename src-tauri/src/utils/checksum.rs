use crc::{Crc, CRC_8_SMBUS, CRC_16_IBM_SDLC, CRC_32_ISO_HDLC};

pub fn calculate_checksum(data: &[u8]) -> String {
    let sum: u32 = data.iter().map(|&b| b as u32).sum();
    format!("{:02X}", (sum & 0xFF) as u8)
}

pub fn calculate_crc8(data: &[u8]) -> String {
    let crc = Crc::<u8>::new(&CRC_8_SMBUS);
    format!("{:02X}", crc.checksum(data))
}

pub fn calculate_crc16(data: &[u8]) -> String {
    let crc = Crc::<u16>::new(&CRC_16_IBM_SDLC);
    format!("{:04X}", crc.checksum(data))
}

pub fn calculate_crc32(data: &[u8]) -> String {
    let crc = Crc::<u32>::new(&CRC_32_ISO_HDLC);
    format!("{:08X}", crc.checksum(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checksum() {
        assert_eq!(calculate_checksum(&[0x01, 0x02, 0x03]), "06");
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
