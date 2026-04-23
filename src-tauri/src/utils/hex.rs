use crate::models::errors::AppError;

pub fn format_hex(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 3);
    for (i, b) in data.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{:02X}", b));
    }
    s
}

pub fn parse_hex(input: &str) -> Result<Vec<u8>, AppError> {
    let cleaned: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() % 2 != 0 {
        return Err(AppError::InvalidHex("odd number of hex digits".to_string()));
    }
    (0..cleaned.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&cleaned[i..i + 2], 16)
                .map_err(|e| AppError::InvalidHex(e.to_string()))
        })
        .collect()
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
}
