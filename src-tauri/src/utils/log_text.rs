/// Convert serial text into readable logical log lines.
///
/// Text log files cannot render terminal control sequences, so CSI/SGR and
/// OSC sequences are removed. Some embedded consoles also deliver MCUboot and
/// Zephyr records without CR/LF bytes; well-known record prefixes provide a
/// conservative secondary boundary for RX data.
pub fn readable_log_lines(data: &[u8], infer_record_boundaries: bool) -> Vec<String> {
    let mut lines = Vec::new();
    visit_readable_log_lines(data, infer_record_boundaries, |line| {
        lines.push(line.to_owned());
        Ok::<(), std::convert::Infallible>(())
    })
    .expect("collecting readable log lines is infallible");
    lines
}

/// Visit readable logical log lines without collecting a `Vec<String>`.
///
/// Clean UTF-8 input containing LF line endings is borrowed directly from the
/// caller. A temporary buffer is only allocated when ANSI/OSC removal, CR
/// normalization, or lossy UTF-8 decoding actually requires one.
pub fn visit_readable_log_lines<E>(
    data: &[u8],
    infer_record_boundaries: bool,
    visitor: impl FnMut(&str) -> Result<(), E>,
) -> Result<(), E> {
    if needs_sanitizing(data) {
        let sanitized = sanitize_log_bytes(data);
        let text = String::from_utf8_lossy(&sanitized);
        visit_normalized_lines(&text, infer_record_boundaries, visitor)
    } else {
        let text = String::from_utf8_lossy(data);
        visit_normalized_lines(&text, infer_record_boundaries, visitor)
    }
}

fn visit_normalized_lines<E>(
    normalized: &str,
    infer_record_boundaries: bool,
    mut visitor: impl FnMut(&str) -> Result<(), E>,
) -> Result<(), E> {
    let bytes = normalized.as_bytes();
    let mut start = 0;
    let mut emitted = false;

    for index in 0..bytes.len() {
        let explicit_break = bytes[index] == b'\n';
        let inferred_break =
            infer_record_boundaries && index > start && is_log_record_prefix(bytes, index);
        if !explicit_break && !inferred_break {
            continue;
        }
        visitor(&normalized[start..index])?;
        emitted = true;
        start = index + usize::from(explicit_break);
    }

    // A terminal CR/LF terminates the current record; it does not request an
    // additional empty record. Preserve intentional empty lines in the middle.
    if start < normalized.len() {
        visitor(&normalized[start..])?;
    } else if !emitted {
        visitor("")?;
    }
    Ok(())
}

fn needs_sanitizing(data: &[u8]) -> bool {
    let mut index = 0;
    while index < data.len() {
        if matches!(data[index], b'\r' | 0x1b)
            || data[index] == b'[' && orphan_sgr_end(data, index + 1).is_some()
        {
            return true;
        }
        index += 1;
    }
    false
}

fn sanitize_log_bytes(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut index = 0;
    // Successful OSC lookaheads consume the bytes they inspect. The first
    // unsuccessful lookahead proves that the remaining suffix contains no OSC
    // terminator, so later ESC ] pairs can be handled without rescanning it.
    // Consequently every input byte is inspected at most twice (linear time).
    let mut osc_terminator_possible = true;

    while index < data.len() {
        if data[index] == 0x1b {
            if data.get(index + 1) == Some(&b'[')
                && let Some(end) = csi_end(data, index + 2)
            {
                index = end;
                continue;
            }
            if data.get(index + 1) == Some(&b']') && osc_terminator_possible {
                if let Some(end) = osc_end(data, index + 2) {
                    index = end;
                    continue;
                }
                osc_terminator_possible = false;
            }
            // Never leak a bare ESC control byte into a plain-text log.
            index += 1;
            continue;
        }

        // Also remove orphaned SGR fragments such as "[0m". They can occur
        // when a serial frame boundary lands between ESC and '['.
        if data[index] == b'['
            && let Some(end) = orphan_sgr_end(data, index + 1)
        {
            index = end;
            continue;
        }

        if data[index] == b'\r' {
            output.push(b'\n');
            index += 1;
            if data.get(index) == Some(&b'\n') {
                index += 1;
            }
            continue;
        }

        output.push(data[index]);
        index += 1;
    }
    output
}

fn csi_end(data: &[u8], mut index: usize) -> Option<usize> {
    while data
        .get(index)
        .is_some_and(|byte| (0x20..=0x3f).contains(byte))
    {
        index += 1;
    }
    data.get(index)
        .filter(|byte| (0x40..=0x7e).contains(*byte))
        .map(|_| index + 1)
}

fn osc_end(data: &[u8], mut index: usize) -> Option<usize> {
    while index < data.len() {
        if data[index] == 0x07 {
            return Some(index + 1);
        }
        if data[index] == 0x1b && data.get(index + 1) == Some(&b'\\') {
            return Some(index + 2);
        }
        index += 1;
    }
    None
}

fn orphan_sgr_end(data: &[u8], mut index: usize) -> Option<usize> {
    while data
        .get(index)
        .is_some_and(|byte| byte.is_ascii_digit() || *byte == b';')
    {
        index += 1;
    }
    (data.get(index) == Some(&b'm')).then_some(index + 1)
}

fn is_log_record_prefix(data: &[u8], index: usize) -> bool {
    let tail = &data[index..];
    tail.starts_with(b"*** Booting")
        || tail.starts_with(b"*** Using")
        || is_mcuboot_severity_prefix(data, index)
        || is_zephyr_timestamp_prefix(tail)
}

fn is_mcuboot_severity_prefix(data: &[u8], index: usize) -> bool {
    let Some(prefix) = data.get(index..index + 3) else {
        return false;
    };
    if !matches!(prefix, [b'I' | b'W' | b'E' | b'D', b':', byte] if byte.is_ascii_whitespace()) {
        return false;
    }
    index == 0 || !data[index - 1].is_ascii_uppercase() && data[index - 1] != b'_'
}

fn is_zephyr_timestamp_prefix(tail: &[u8]) -> bool {
    if tail.len() < 23
        || tail[0] != b'['
        || tail[3] != b':'
        || tail[6] != b':'
        || tail[9] != b'.'
        || tail[13] != b','
        || tail[17] != b']'
        || ![1, 2, 4, 5, 7, 8, 10, 11, 12, 14, 15, 16]
            .into_iter()
            .all(|index| tail[index].is_ascii_digit())
    {
        return false;
    }
    let mut index = 18;
    while tail
        .get(index)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        index += 1;
    }
    tail.get(index) == Some(&b'<')
        && tail
            .get(index + 1..index + 4)
            .is_some_and(|level| level.len() == 3 && level.iter().all(u8::is_ascii_lowercase))
        && tail.get(index + 4) == Some(&b'>')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_and_splits_concatenated_mcuboot_and_zephyr_records() {
        let data = concat!(
            "*** Booting MCUboot v2.4.0 ***",
            "*** Using Zephyr OS build v4.4.1 ***",
            "I: Starting bootloader",
            "I: Primary slot: version=0.1.0+0",
            "[00:00:00.101,000] \u{1b}[0m<inf> flash: ready\u{1b}[0m",
            "*** Booting Zephyr OS build v4.4.1 ***"
        );

        assert_eq!(
            readable_log_lines(data.as_bytes(), true),
            [
                "*** Booting MCUboot v2.4.0 ***",
                "*** Using Zephyr OS build v4.4.1 ***",
                "I: Starting bootloader",
                "I: Primary slot: version=0.1.0+0",
                "[00:00:00.101,000] <inf> flash: ready",
                "*** Booting Zephyr OS build v4.4.1 ***",
            ]
        );
    }

    #[test]
    fn normalizes_line_endings_strips_orphan_sgr_and_ignores_protocol_tokens() {
        assert_eq!(
            readable_log_lines(b"SPI: ready\r\n[0msecond\rthird\n", true),
            ["SPI: ready", "second", "third"]
        );
        assert_eq!(
            readable_log_lines(b"sentI: intact", false),
            ["sentI: intact"]
        );
    }

    #[test]
    fn removes_complete_osc_sequences() {
        assert_eq!(readable_log_lines(b"a\x1b]0;title\x07b", true), ["ab"]);
    }

    #[test]
    fn clean_utf8_lines_are_visited_from_the_input_buffer() {
        let data = b"first\nsecond";
        let input = data.as_ptr() as usize..data.as_ptr() as usize + data.len();
        let mut lines = Vec::new();
        visit_readable_log_lines(data, false, |line| {
            let pointer = line.as_ptr() as usize;
            assert!(input.contains(&pointer));
            lines.push(line.to_owned());
            Ok::<(), ()>(())
        })
        .unwrap();
        assert_eq!(lines, ["first", "second"]);
    }

    #[test]
    fn many_unterminated_osc_prefixes_are_processed_linearly() {
        const REPEATS: usize = 16_384;
        let mut data = Vec::with_capacity(REPEATS * 3);
        for _ in 0..REPEATS {
            data.extend_from_slice(b"\x1b]x");
        }

        let lines = readable_log_lines(&data, false);
        assert_eq!(lines, ["]x".repeat(REPEATS)]);
    }

    #[test]
    fn unterminated_osc_preserves_payload_while_dropping_escape_bytes() {
        assert_eq!(
            readable_log_lines(b"a\x1b]first\x1b]second", false),
            ["a]first]second"]
        );
    }
}
