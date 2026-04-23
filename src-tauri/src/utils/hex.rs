use crate::models::errors::AppError;

pub fn format_hex(data: &[u8]) -> String {
    let encoded = hex::encode_upper(data);
    let mut s = String::with_capacity(encoded.len() + data.len().saturating_sub(1));
    for (i, chunk) in encoded.as_bytes().chunks(2).enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push(chunk[0] as char);
        s.push(chunk[1] as char);
    }
    s
}

pub fn parse_hex(input: &str) -> Result<Vec<u8>, AppError> {
    let cleaned: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if cleaned.len() % 2 != 0 {
        return Err(AppError::InvalidHex("odd number of hex digits".to_string()));
    }
    hex::decode(&cleaned).map_err(|e| AppError::InvalidHex(e.to_string()))
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
    fn test_parse_hex_empty() {
        assert_eq!(parse_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(parse_hex("   ").unwrap(), Vec::<u8>::new());
    }
}
