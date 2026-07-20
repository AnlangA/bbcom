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
        write!(s, "{byte:02X}").unwrap();
    }
    s
}

/// Format bytes as a hex-editor dump: uppercase hex pairs on the left and an
/// ASCII gutter on the right, 16 bytes per line. The layout matches the
/// frontend `formatHexAscii` view exactly, so saved logs read like the
/// on-screen HEX+ASCII display: printable bytes (0x20-0x7E) render as-is,
/// everything else becomes `.`, and the gutter is always 16 columns wide.
pub fn format_hex_dump(data: &[u8]) -> String {
    const BYTES_PER_LINE: usize = 16;
    let mut out = String::new();
    for chunk in data.chunks(BYTES_PER_LINE) {
        if !out.is_empty() {
            out.push('\n');
        }
        let mut hex = String::with_capacity(BYTES_PER_LINE * 3);
        let mut ascii = String::with_capacity(BYTES_PER_LINE);
        for index in 0..BYTES_PER_LINE {
            if let Some(&byte) = chunk.get(index) {
                write!(hex, "{byte:02X} ").unwrap();
                ascii.push(if (0x20..=0x7E).contains(&byte) {
                    byte as char
                } else {
                    '.'
                });
            } else {
                hex.push_str("   ");
                ascii.push(' ');
            }
        }
        out.push_str(hex.trim_end());
        out.push_str("  |");
        out.push_str(&ascii);
        out.push('|');
    }
    out
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
    fn test_format_hex_dump_empty() {
        assert_eq!(format_hex_dump(&[]), "");
    }

    #[test]
    fn test_format_hex_dump_matches_frontend_layout() {
        // Same expectations as the frontend formatHexAscii tests: hex pairs
        // plus a 16-column ASCII gutter, printable bytes as-is, dots for the
        // rest, short lines padded inside the gutter only.
        assert_eq!(format_hex_dump(&[0x48, 0x69]), "48 69  |Hi              |");
        assert_eq!(
            format_hex_dump(&[0x00, 0x41, 0x7F]),
            "00 41 7F  |.A.             |"
        );
    }

    #[test]
    fn test_format_hex_dump_wraps_at_sixteen_bytes() {
        let dump = format_hex_dump(&[0x00_u8; 20]);
        let lines: Vec<&str> = dump.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  |................|"
        );
        assert_eq!(lines[1], "00 00 00 00  |....            |");
    }
}
