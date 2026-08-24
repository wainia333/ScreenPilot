use chrono::{DateTime, Utc};
use std::time::Duration;

pub fn retry_after(value: Option<&str>) -> Option<Duration> {
    retry_after_at(value, Utc::now())
}

fn retry_after_at(value: Option<&str>, now: DateTime<Utc>) -> Option<Duration> {
    const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

    let text = value?.trim();
    if let Ok(seconds) = text.parse::<u64>() {
        return Some(Duration::from_secs(seconds).min(MAX_RETRY_AFTER));
    }

    let retry_at = DateTime::parse_from_rfc2822(text).ok()?.with_timezone(&Utc);
    let delay = retry_at.signed_duration_since(now);
    if delay <= chrono::Duration::zero() {
        return Some(Duration::ZERO);
    }
    delay.to_std().ok().map(|delay| delay.min(MAX_RETRY_AFTER))
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
    use chrono::TimeZone;

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
    fn parses_http_date_retry_after_relative_to_an_injected_clock() {
        let now = Utc
            .with_ymd_and_hms(2015, 10, 21, 7, 27, 50)
            .single()
            .expect("valid test time");

        assert_eq!(
            retry_after_at(Some("Wed, 21 Oct 2015 07:28:00 GMT"), now),
            Some(Duration::from_secs(10))
        );
        assert_eq!(
            retry_after_at(Some("Wed, 21 Oct 2015 07:27:00 GMT"), now),
            Some(Duration::ZERO)
        );
        assert_eq!(
            retry_after_at(Some("Wed, 21 Oct 2015 08:28:00 GMT"), now),
            Some(Duration::from_secs(30))
        );
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
