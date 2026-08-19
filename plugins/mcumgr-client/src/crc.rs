/// Compute CRC16-XMODEM / CRC-16/ITU-T.
///
/// Polynomial: `0x1021`; initial value: `0x0000`; no reflection; xor-out 0.
pub const fn crc16_xmodem(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    let mut offset = 0usize;
    while offset < bytes.len() {
        crc ^= (bytes[offset] as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
            bit += 1;
        }
        offset += 1;
    }
    crc
}
#[cfg(test)]
mod tests {
    use super::crc16_xmodem;

    #[test]
    fn check_value_matches_xmodem_catalogue_vector() {
        assert_eq!(crc16_xmodem(b"123456789"), 0x31c3);
    }

    #[test]
    fn empty_crc_is_initial_value() {
        assert_eq!(crc16_xmodem(&[]), 0);
    }
}
