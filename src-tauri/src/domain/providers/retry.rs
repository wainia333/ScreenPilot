use std::time::Duration;

pub fn retry_after(value: Option<&str>) -> Option<Duration> {
    value
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds.min(30)))
}

pub fn exponential_backoff(attempt: u8) -> Duration {
    let multiplier = 1_u64 << u32::from(attempt.min(5));
    Duration::from_millis((500 * multiplier).min(10_000))
}

pub fn should_retry(status: Option<u16>) -> bool {
    matches!(status, None | Some(429 | 500..=599))
}

pub fn should_rotate_key(status: u16) -> bool {
    matches!(status, 401 | 402 | 403 | 429)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_retry_after_and_backoff() {
        assert_eq!(retry_after(Some("0")), Some(Duration::ZERO));
        assert_eq!(retry_after(Some("12")), Some(Duration::from_secs(12)));
        assert_eq!(retry_after(Some("999999")), Some(Duration::from_secs(30)));
        assert_eq!(retry_after(Some("invalid")), None);
        assert_eq!(retry_after(None), None);
        assert_eq!(exponential_backoff(0), Duration::from_millis(500));
        assert_eq!(exponential_backoff(5), Duration::from_secs(10));
        assert_eq!(exponential_backoff(200), Duration::from_secs(10));
    }

    #[test]
    fn classifies_retry_and_key_rotation_statuses() {
        assert!(should_retry(None));
        assert!(should_retry(Some(429)));
        assert!(should_retry(Some(503)));
        assert!(!should_retry(Some(400)));
        assert!(should_rotate_key(401));
        assert!(should_rotate_key(402));
        assert!(should_rotate_key(403));
        assert!(should_rotate_key(429));
        assert!(!should_rotate_key(500));
    }
}
