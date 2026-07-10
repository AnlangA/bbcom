use chrono::{Local, TimeZone};

pub fn format_timestamp(millis: f64) -> String {
    let millis_i64 = millis as i64;
    TimeZone::timestamp_millis_opt(&Local, millis_i64)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| format!("{millis:.3}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_timestamp() {
        let ts = format_timestamp(1_710_000_000_123.0);
        let parts: Vec<&str> = ts.split(' ').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 10);
        assert_eq!(parts[1].len(), 12);
    }

    #[test]
    fn format_timestamp_falls_back_for_out_of_range_values() {
        // Far outside chrono's representable range — must not panic and must use
        // the raw-millis fallback (a bare float, no date/time colons).
        let result = format_timestamp(1e20);
        assert!(!result.is_empty());
        assert!(!result.contains(':'));
    }
}
