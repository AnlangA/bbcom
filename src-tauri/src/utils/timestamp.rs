pub fn now_millis() -> String {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    // Calculate date components from unix timestamp
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Calculate year/month/day from days since epoch
    let (year, month, day) = days_to_ymd(days as i64);
    format!(
        "{}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        year, month, day, h, m, s, millis
    )
}

fn days_to_ymd(mut days: i64) -> (i64, u32, u32) {
    // Shift to align with 400-year cycle starting March 1, year 0
    days += 719468;
    let era = if days >= 0 { days / 146097 } else { (days - 146096) / 146097 };
    let day_of_era = days - era * 146097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (day_of_year * 5 + 308) / 153 - 2;
    let day = day_of_year - (month * 153 + 2) / 5 + 1;
    let year = year_of_era + era * 400 + if month <= 1 { 0 } else { 1 };
    (year, (month + 3) as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timestamp_format() {
        let ts = now_millis();
        // Should be like "2026-04-23 12:34:56.789"
        let parts: Vec<&str> = ts.split(' ').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 10); // date part
        assert_eq!(parts[1].len(), 12); // time part
    }
}
