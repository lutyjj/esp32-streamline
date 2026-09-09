//! Bounded release-check retry without disturbing audio transport.

use super::{parse_release, OtaRelease};

pub fn check_release(
    mut fetch: impl FnMut() -> Result<String, String>,
    retry: impl FnOnce(),
) -> Result<OtaRelease, String> {
    let body = match fetch() {
        Ok(body) => body,
        Err(_) => {
            retry();
            fetch()?
        }
    };
    parse_release(&body).ok_or_else(|| "release has no OTA image".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> String {
        format!("{}  streamline-1.2.3-ota.bin\n", "a".repeat(64))
    }

    #[test]
    fn transient_fetch_failure_retries_once() {
        let mut attempts = 0;
        let mut retries = 0;
        let release = check_release(
            || {
                attempts += 1;
                if attempts == 1 {
                    Err("TLS allocation".into())
                } else {
                    Ok(listing())
                }
            },
            || retries += 1,
        )
        .unwrap();
        assert_eq!(release.version, "1.2.3");
        assert_eq!((attempts, retries), (2, 1));
    }

    #[test]
    fn persistent_failure_is_bounded_and_keeps_the_final_error() {
        let mut attempts = 0;
        let result = check_release(
            || {
                attempts += 1;
                Err(format!("failure {attempts}"))
            },
            || {},
        );
        assert_eq!(result, Err("failure 2".into()));
        assert_eq!(attempts, 2);
    }

    #[test]
    fn success_and_invalid_listing_do_not_retry() {
        assert!(check_release(|| Ok(listing()), || panic!("retry")).is_ok());
        assert!(check_release(|| Ok("invalid".into()), || panic!("retry")).is_err());
    }
}
