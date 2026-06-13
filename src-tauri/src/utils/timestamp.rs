use chrono::{Local, TimeZone};

pub fn now_millis() -> f64 {
    Local::now().timestamp_millis() as f64
}

pub fn format_timestamp(millis: f64) -> String {
    let millis_i64 = millis as i64;
    TimeZone::timestamp_millis_opt(&Local, millis_i64)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| format!("{:.3}", millis))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_timestamp() {
        let ts = format_timestamp(now_millis());
        let parts: Vec<&str> = ts.split(' ').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 10);
        assert_eq!(parts[1].len(), 12);
    }
}
