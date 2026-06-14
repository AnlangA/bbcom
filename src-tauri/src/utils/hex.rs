use std::fmt::Write;

pub fn format_hex(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let mut s = String::with_capacity(data.len() * 3);
    for (i, &byte) in data.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        write!(s, "{:02X}", byte).unwrap();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_hex() {
        assert_eq!(format_hex(&[0xAA, 0xBB, 0xCC]), "AA BB CC");
    }

    #[test]
    fn test_format_hex_empty() {
        assert_eq!(format_hex(&[]), "");
    }

    #[test]
    fn test_format_hex_single_byte() {
        assert_eq!(format_hex(&[0x0F]), "0F");
    }
}
