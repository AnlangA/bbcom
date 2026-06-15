use crate::models::errors::AppError;
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

pub fn parse_hex(input: &str) -> Result<Vec<u8>, AppError> {
    // Only whitespace separators are allowed between hex pairs; any other non-hex char is an error.
    for (i, c) in input.char_indices() {
        if !c.is_ascii_hexdigit() && !c.is_ascii_whitespace() {
            return Err(AppError::InvalidHex {
                message: format!("invalid character '{}' at position {}", c, i),
                position: Some(i),
            });
        }
    }
    let cleaned: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if cleaned.len() % 2 != 0 {
        return Err(AppError::InvalidHex {
            message: "odd number of hex digits".to_string(),
            position: None,
        });
    }
    hex::decode(&cleaned).map_err(|e| AppError::InvalidHex {
        message: e.to_string(),
        position: None,
    })
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

    #[test]
    fn test_parse_hex() {
        assert_eq!(parse_hex("AA BB CC").unwrap(), vec![0xAA, 0xBB, 0xCC]);
        assert_eq!(parse_hex("AABBCC").unwrap(), vec![0xAA, 0xBB, 0xCC]);
        assert_eq!(parse_hex("aa bb cc").unwrap(), vec![0xAA, 0xBB, 0xCC]);
    }

    #[test]
    fn test_parse_hex_invalid() {
        assert!(parse_hex("AABBCCD").is_err());
    }

    #[test]
    fn test_parse_hex_invalid_chars() {
        assert!(parse_hex("GG").is_err());
        assert!(parse_hex("AA,BB").is_err());
        assert!(parse_hex("0x1A").is_err());
    }

    #[test]
    fn test_parse_hex_empty() {
        assert_eq!(parse_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(parse_hex("   ").unwrap(), Vec::<u8>::new());
    }
}
