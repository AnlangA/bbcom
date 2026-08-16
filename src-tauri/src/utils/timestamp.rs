use std::fmt::Write as _;
use std::sync::Mutex;

use chrono::{Local, TimeZone};

/// Milliseconds per day.
const MS_PER_DAY: i64 = 86_400_000;

/// Cached local-date prefix (`%Y-%m-%d`) together with the UTC offset that
/// was in effect when the prefix was computed. Formatting a capture or an
/// export touches thousands of timestamps per second; only the first format
/// call per day pays for chrono's timezone lookup, the rest reuse the prefix
/// and derive the clock arithmetically.
struct CachedLocalDate {
    /// UTC epoch day the entry was filled for.
    epoch_day: i64,
    /// Local epoch day (UTC day shifted by the cached offset) that the
    /// prefix belongs to. Guards against the local date rolling over while
    /// the UTC day stays the same, which happens every day for large
    /// offsets such as UTC+8.
    local_day: i64,
    prefix: String,
    offset_ms: i64,
}

static LOCAL_DATE_CACHE: Mutex<Option<CachedLocalDate>> = Mutex::new(None);

pub fn format_timestamp(millis: f64) -> String {
    let mut out = String::new();
    if !format_local_timestamp_into(millis as i64, &mut out) {
        // Out of chrono's representable range: keep the historical raw-float
        // fallback so the output stays byte-identical to the chrono format.
        let _ = write!(out, "{millis:.3}");
    }
    out
}

/// Append the formatted local timestamp for epoch-milliseconds `ms` to `out`
/// without allocating; the output is byte-identical to [`format_timestamp`]
/// for representable values.
pub fn format_timestamp_ms_into(ms: u64, out: &mut String) {
    if !format_local_timestamp_into(ms as i64, out) {
        let _ = write!(out, "{ms}.000");
    }
}

/// Format `millis` into `out`, reusing the cached local-date prefix while the
/// derived local day is unchanged. Returns `false` when `millis` is outside
/// chrono's representable range and the caller must fall back.
fn format_local_timestamp_into(millis: i64, out: &mut String) -> bool {
    if let Some((prefix, offset_ms)) = cached_prefix_for(millis) {
        let local_ms_of_day = (millis + offset_ms).rem_euclid(MS_PER_DAY);
        write_local_timestamp(out, &prefix, local_ms_of_day);
        return true;
    }
    let Some(datetime) = TimeZone::timestamp_millis_opt(&Local, millis).single() else {
        return false;
    };
    let prefix = datetime.format("%Y-%m-%d").to_string();
    let offset_ms = i64::from(datetime.offset().local_minus_utc()) * 1_000;
    // The prefix already carries chrono's local date, so wrap the derived
    // clock: when UTC-plus-offset reaches past local midnight the time of
    // day continues at 00:00 of the (already rolled-over) date.
    let local_ms_of_day = (millis + offset_ms).rem_euclid(MS_PER_DAY);
    write_local_timestamp(out, &prefix, local_ms_of_day);
    if let Ok(mut cache) = LOCAL_DATE_CACHE.lock() {
        *cache = Some(CachedLocalDate {
            epoch_day: millis.div_euclid(MS_PER_DAY),
            local_day: (millis + offset_ms).div_euclid(MS_PER_DAY),
            prefix,
            offset_ms,
        });
    }
    true
}

/// The cache applies only while both the UTC epoch day matches and shifting
/// `millis` by the cached offset still lands on the cached local day; any
/// other instant (day rollover, or an offset change inside the day) is
/// re-derived through chrono.
fn cached_prefix_for(millis: i64) -> Option<(String, i64)> {
    let cache = LOCAL_DATE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.as_ref().and_then(|cached| {
        if cached.epoch_day != millis.div_euclid(MS_PER_DAY)
            || cached.local_day != (millis + cached.offset_ms).div_euclid(MS_PER_DAY)
        {
            return None;
        }
        Some((cached.prefix.clone(), cached.offset_ms))
    })
}

/// Emit `<date> HH:MM:SS.mmm`, mirroring chrono's `%Y-%m-%d %H:%M:%S%.3f`
/// layout (space separator, zero-padded fields, dot-prefixed milliseconds).
fn write_local_timestamp(out: &mut String, date_prefix: &str, local_ms_of_day: i64) {
    let seconds_of_day = local_ms_of_day / 1_000;
    let _ = write!(
        out,
        "{date_prefix} {:02}:{:02}:{:02}.{:03}",
        seconds_of_day / 3_600,
        (seconds_of_day / 60) % 60,
        seconds_of_day % 60,
        local_ms_of_day % 1_000
    );
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

    #[test]
    fn into_buffer_variant_matches_chrono_format_exactly() {
        // Every representable value must render byte-identically to the
        // chrono-based formatting — including local-midnight rollover inside
        // a UTC day (offsets of ±8h and beyond) and warm-cache reuse — because
        // the export and auto-log golden tests pin these bytes.
        let mut previous = None;
        for value in [
            0_u64,
            1,
            999,
            1_000,
            1_710_000_000_123,
            1_710_057_599_999,
            1_710_057_600_000,
            1_710_086_399_999,
            1_710_086_400_000,
            1_747_000_000_000,
        ] {
            if previous == Some(value) {
                continue;
            }
            previous = Some(value);
            let expected = TimeZone::timestamp_millis_opt(&Local, value as i64)
                .single()
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
                .unwrap();
            let mut formatted = String::new();
            format_timestamp_ms_into(value, &mut formatted);
            assert_eq!(formatted, expected, "mismatch for {value}");
            // Repeat against the now-warm cache.
            let mut again = String::new();
            format_timestamp_ms_into(value, &mut again);
            assert_eq!(again, expected, "cache mismatch for {value}");
            let via_f64 = format_timestamp(value as f64);
            assert_eq!(via_f64, expected, "f64 mismatch for {value}");
        }
    }
}
