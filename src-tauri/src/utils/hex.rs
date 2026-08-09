const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
const BYTES_PER_DUMP_LINE: usize = 16;
const MAX_DUMP_LINE_LEN: usize = BYTES_PER_DUMP_LINE * 3 + 19;

pub fn format_hex(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let mut output = String::with_capacity(data.len().saturating_mul(3).saturating_sub(1));
    for (i, &byte) in data.iter().enumerate() {
        if i > 0 {
            output.push(' ');
        }
        output.push(HEX_UPPER[(byte >> 4) as usize] as char);
        output.push(HEX_UPPER[(byte & 0x0f) as usize] as char);
    }
    output
}

/// Append space-separated uppercase hex pairs directly to an existing byte
/// buffer. This is the allocation-free production counterpart to
/// [`format_hex`].
pub fn append_hex(output: &mut Vec<u8>, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    output.reserve(data.len().saturating_mul(3).saturating_sub(1));
    for (index, &byte) in data.iter().enumerate() {
        if index > 0 {
            output.push(b' ');
        }
        output.push(HEX_UPPER[(byte >> 4) as usize]);
        output.push(HEX_UPPER[(byte & 0x0f) as usize]);
    }
}

/// Visit each line of a hex-editor dump.
///
/// A single stack buffer is reused for every line; `line` is only valid for
/// the duration of the callback. Empty input emits no lines. Returning an
/// error stops formatting immediately, which lets callers stream directly
/// into their own output without first allocating a complete dump.
pub fn visit_hex_dump_lines<E>(
    data: &[u8],
    mut visitor: impl FnMut(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
    let mut line = [b' '; MAX_DUMP_LINE_LEN];

    for chunk in data.chunks(BYTES_PER_DUMP_LINE) {
        let mut length = 0;
        for (index, &byte) in chunk.iter().enumerate() {
            if index > 0 {
                line[length] = b' ';
                length += 1;
            }
            line[length] = HEX_UPPER[(byte >> 4) as usize];
            line[length + 1] = HEX_UPPER[(byte & 0x0f) as usize];
            length += 2;
        }

        line[length..length + 3].copy_from_slice(b"  |");
        length += 3;
        for index in 0..BYTES_PER_DUMP_LINE {
            line[length + index] = chunk.get(index).map_or(b' ', |&byte| {
                if (0x20..=0x7e).contains(&byte) {
                    byte
                } else {
                    b'.'
                }
            });
        }
        length += BYTES_PER_DUMP_LINE;
        line[length] = b'|';
        length += 1;

        visitor(&line[..length])?;
    }

    Ok(())
}

/// Format bytes as a hex-editor dump: uppercase hex pairs on the left and an
/// ASCII gutter on the right, 16 bytes per line. The layout matches the
/// frontend `formatHexAscii` view exactly, so saved logs read like the
/// on-screen HEX+ASCII display: printable bytes (0x20-0x7E) render as-is,
/// everything else becomes `.`, and the gutter is always 16 columns wide.
pub fn format_hex_dump(data: &[u8]) -> String {
    let line_count = data.len().div_ceil(BYTES_PER_DUMP_LINE);
    let mut output = Vec::with_capacity(
        data.len()
            .saturating_mul(3)
            .saturating_add(line_count.saturating_mul(20)),
    );
    let mut first = true;
    visit_hex_dump_lines(data, |line| {
        if !first {
            output.push(b'\n');
        }
        first = false;
        output.extend_from_slice(line);
        Ok::<(), std::convert::Infallible>(())
    })
    .expect("hex dump visitor is infallible");
    String::from_utf8(output).expect("hex dump only contains ASCII")
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
    fn append_hex_matches_string_helper() {
        let mut output = b"prefix:".to_vec();
        append_hex(&mut output, &[0x00, 0xab, 0xff]);
        assert_eq!(output, b"prefix:00 AB FF");
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

    #[test]
    fn dump_visitor_reuses_layout_and_propagates_errors() {
        let data = [0x41_u8; 17];
        let mut lines = Vec::new();
        visit_hex_dump_lines(&data, |line| {
            lines.push(line.to_vec());
            Ok::<(), ()>(())
        })
        .unwrap();
        assert_eq!(lines.join(&b'\n'), format_hex_dump(&data).as_bytes());

        let mut visits = 0;
        let result = visit_hex_dump_lines(&data, |_| {
            visits += 1;
            Err("stop")
        });
        assert_eq!(result, Err("stop"));
        assert_eq!(visits, 1);
    }
}
