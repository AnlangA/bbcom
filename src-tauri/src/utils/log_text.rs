/// Convert serial text into readable logical log lines.
///
/// Text log files cannot render terminal control sequences, so CSI/SGR and
/// OSC sequences are removed. Some embedded consoles also deliver MCUboot and
/// Zephyr records without CR/LF bytes; well-known record prefixes provide a
/// conservative secondary boundary for RX data.
pub fn readable_log_lines(data: &[u8], infer_record_boundaries: bool) -> Vec<String> {
    let cleaned = strip_ansi_sequences(data);
    let normalized = String::from_utf8_lossy(&cleaned)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let bytes = normalized.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;

    for index in 0..bytes.len() {
        let explicit_break = bytes[index] == b'\n';
        let inferred_break =
            infer_record_boundaries && index > start && is_log_record_prefix(bytes, index);
        if !explicit_break && !inferred_break {
            continue;
        }
        lines.push(normalized[start..index].to_string());
        start = index + usize::from(explicit_break);
    }

    // A terminal CR/LF terminates the current record; it does not request an
    // additional empty record. Preserve intentional empty lines in the middle.
    if start < normalized.len() {
        lines.push(normalized[start..].to_string());
    } else if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn strip_ansi_sequences(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == 0x1b {
            if data.get(index + 1) == Some(&b'[')
                && let Some(end) = csi_end(data, index + 2)
            {
                index = end;
                continue;
            }
            if data.get(index + 1) == Some(&b']')
                && let Some(end) = osc_end(data, index + 2)
            {
                index = end;
                continue;
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
}
