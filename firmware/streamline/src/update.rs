//! Hardware-independent firmware-update release selection.
//!
//! The device discovers updates through GitHub's `releases/latest/download/`
//! redirect rather than the JSON API: it fetches the published `SHA256SUMS`,
//! picks the over-the-air application image, and learns both its filename and
//! expected digest from one small text file. Keeping the parsing and version
//! comparison here makes them host-testable, away from the network and flash
//! adapters.

use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::config::AutoUpdateSchedule;

/// The application image published for over-the-air updates. Its filename
/// carries the release version, so one `SHA256SUMS` entry yields everything the
/// installer needs.
const OTA_ASSET_SUFFIX: &str = "-ota.bin";
const ASSET_PREFIX: &str = "streamline-";

/// Let boot, Wi-Fi, SNTP, and the console settle before background maintenance.
pub const AUTO_UPDATE_INITIAL_DELAY: Duration = Duration::from_secs(10 * 60);
/// Monotonic schedule for automatic release installs.
///
/// The clock stays outside this unit so host tests use plain durations and the
/// ESP-IDF boot loop supplies its own monotonic elapsed time.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AutoUpdateTimer {
    last_attempt: Option<Duration>,
}

impl AutoUpdateTimer {
    /// Reserve a due attempt. A due update waits for the audio source to become
    /// idle, keeping automatic maintenance out of active listening sessions.
    pub fn take_due(
        &mut self,
        now: Duration,
        schedule: AutoUpdateSchedule,
        audio_idle: bool,
    ) -> bool {
        let Some(interval) = schedule.interval() else {
            return false;
        };
        let due_at = self
            .last_attempt
            .map(|last| last.saturating_add(interval))
            .unwrap_or(AUTO_UPDATE_INITIAL_DELAY);
        if !audio_idle || now < due_at {
            return false;
        }
        self.last_attempt = Some(now);
        true
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OtaRelease {
    /// Release version parsed from the asset filename, e.g. `0.2.2`.
    pub version: String,
    /// Asset filename to download from `releases/latest/download/`.
    pub filename: String,
    /// Lowercase hex SHA-256 the downloaded image must match.
    pub sha256: String,
}

/// Select the OTA application image from a `shasum -a 256` listing.
///
/// Each line is `<hex-digest>  <filename>`; the relevant entry is the one whose
/// filename ends in `-ota.bin`. Returns `None` when no such entry exists or the
/// digest is malformed.
pub fn parse_release(sums: &str) -> Option<OtaRelease> {
    for line in sums.lines() {
        let Some((digest, name)) = line.split_once("  ").or_else(|| line.split_once(' ')) else {
            continue;
        };
        let digest = digest.trim();
        let filename = name.trim();
        if !filename.ends_with(OTA_ASSET_SUFFIX) {
            continue;
        }
        if !is_sha256_hex(digest) {
            return None;
        }
        let version = version_from_filename(filename)?;
        return Some(OtaRelease {
            version,
            filename: filename.to_owned(),
            sha256: digest.to_ascii_lowercase(),
        });
    }
    None
}

/// Extract `X.Y.Z` from `streamline-X.Y.Z-ota.bin`.
fn version_from_filename(filename: &str) -> Option<String> {
    filename
        .strip_prefix(ASSET_PREFIX)?
        .strip_suffix(OTA_ASSET_SUFFIX)
        .map(str::to_owned)
}

/// Whether `candidate` is a strictly newer semantic version than `current`.
///
/// Non-numeric versions (e.g. a local `dev` build) never compare as older, so a
/// developer build always treats any published release as an available update.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_semver(current), parse_semver(candidate)) {
        (Some(current), Some(candidate)) => candidate > current,
        // An unparseable current version means an unversioned build: offer the update.
        (None, Some(_)) => true,
        _ => false,
    }
}

fn parse_semver(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_sha256_hex(digest: &str) -> bool {
    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A user-supplied image to install as-is: an exact URL and the SHA-256 that
/// pins its content. Used for development installs without USB access. The
/// digest — not the transport — is the root of trust, so a plain-HTTP LAN URL
/// is acceptable; the device refuses any payload whose hash differs.
#[derive(Clone, Eq, PartialEq)]
pub struct CustomImage {
    pub url: String,
    pub sha256: String,
}

impl CustomImage {
    /// Whether downloading this image needs TLS (and therefore a synced clock
    /// for certificate validation).
    pub fn needs_tls(&self) -> bool {
        self.url.starts_with("https://")
    }

    /// Non-sensitive name for status, diagnostics, and logs.
    pub const fn display_name(&self) -> &'static str {
        "custom image"
    }
}

impl std::fmt::Debug for CustomImage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CustomImage")
            .field("url", &"[redacted]")
            .field("sha256", &self.sha256)
            .finish()
    }
}

/// Interpret the optional `url`/`sha256` fields of an update request.
///
/// Both absent (or blank) selects the latest-release flow (`Ok(None)`); both
/// present selects a pinned custom image. One without the other is an error,
/// as is a non-HTTP URL or a malformed digest.
pub fn custom_image_from_form(
    url: Option<&str>,
    sha256: Option<&str>,
) -> Result<Option<CustomImage>, String> {
    let url = url.map(str::trim).filter(|value| !value.is_empty());
    let sha256 = sha256.map(str::trim).filter(|value| !value.is_empty());
    match (url, sha256) {
        (None, None) => Ok(None),
        (Some(url), Some(sha256)) => custom_image(url, sha256).map(Some),
        _ => Err("url and sha256 must be provided together".to_owned()),
    }
}

fn custom_image(url: &str, sha256: &str) -> Result<CustomImage, String> {
    validate_custom_image_url(url)?;
    if !is_sha256_hex(sha256) {
        return Err("sha256 must be 64 hex characters".to_owned());
    }
    Ok(CustomImage {
        url: url.to_owned(),
        sha256: sha256.to_ascii_lowercase(),
    })
}

/// Validate the URL shape without normalizing or dropping its signed query.
fn validate_custom_image_url(url: &str) -> Result<(), String> {
    let authority_and_path = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| "url must start with http:// or https://".to_owned())?;
    if url
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("url must not contain whitespace or control characters".to_owned());
    }
    if url.contains('#') {
        return Err("url fragments are not supported".to_owned());
    }
    let authority = authority_and_path
        .split_once(['/', '?'])
        .map_or(authority_and_path, |(authority, _)| authority);
    if authority.is_empty() {
        return Err("url must include a host".to_owned());
    }
    if authority.contains('@') {
        return Err("url userinfo is not supported".to_owned());
    }
    Ok(())
}

/// Bytes pulled in one read; large enough to keep flash writes efficient without
/// crowding the worker stack.
const CHUNK_BYTES: usize = 4_096;

/// A source of firmware-image bytes. The download pipeline reads from this rather
/// than a concrete HTTP client, so it runs against an in-memory buffer in tests.
pub trait ImageSource {
    /// Read into `buffer`, returning the byte count; `Ok(0)` signals end of stream.
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String>;
}

/// A destination for verified firmware bytes: an OTA flash slot on device, a
/// `Vec<u8>` in tests.
pub trait ImageSink {
    fn write(&mut self, chunk: &[u8]) -> Result<(), String>;
}

/// Lifecycle callbacks the pipeline emits so a caller can surface progress
/// however it likes (atomic counters on device, nothing in tests).
pub trait InstallProgress {
    fn downloaded(&mut self, bytes: u32);
    fn verifying(&mut self);
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallError {
    Source(String),
    Sink(String),
    Checksum { expected: String, actual: String },
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Source(error) => write!(f, "download read failed: {error}"),
            InstallError::Sink(error) => write!(f, "flash write failed: {error}"),
            InstallError::Checksum { expected, actual } => {
                write!(f, "checksum mismatch: expected {expected}, got {actual}")
            }
        }
    }
}

/// Stream the image from `source` into `sink`, hashing as it goes, and reject a
/// payload whose SHA-256 does not match `expected_sha256`.
///
/// The hash is verified only after the last byte, so the caller commits the slot
/// on `Ok` and discards it on `Err`: a wrong or corrupt image is never booted.
pub fn install_verified(
    source: &mut impl ImageSource,
    sink: &mut impl ImageSink,
    expected_sha256: &str,
    progress: &mut impl InstallProgress,
) -> Result<(), InstallError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; CHUNK_BYTES];
    let mut written: u32 = 0;
    loop {
        let read = source.read(&mut buffer).map_err(InstallError::Source)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        hasher.update(chunk);
        sink.write(chunk).map_err(InstallError::Sink)?;
        written = written.saturating_add(read as u32);
        progress.downloaded(written);
    }

    progress.verifying();
    let actual = hex_lower(&hasher.finalize());
    if actual != expected_sha256 {
        return Err(InstallError::Checksum {
            expected: expected_sha256.to_owned(),
            actual,
        });
    }
    Ok(())
}

/// Render bytes as a lowercase hex string for digest comparison.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        custom_image_from_form, install_verified, is_newer, parse_release, AutoUpdateTimer,
        CustomImage, ImageSink, ImageSource, InstallError, InstallProgress, OtaRelease,
        AUTO_UPDATE_INITIAL_DELAY,
    };
    use crate::config::AutoUpdateSchedule;
    use std::time::Duration;

    /// SHA-256 of `b"hello"`, the reference vector the pipeline tests verify against.
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    struct SliceSource<'a> {
        data: &'a [u8],
        position: usize,
    }

    impl ImageSource for SliceSource<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
            let remaining = &self.data[self.position..];
            let take = remaining.len().min(buffer.len());
            buffer[..take].copy_from_slice(&remaining[..take]);
            self.position += take;
            Ok(take)
        }
    }

    struct FailingSource;

    impl ImageSource for FailingSource {
        fn read(&mut self, _buffer: &mut [u8]) -> Result<usize, String> {
            Err("connection reset".to_owned())
        }
    }

    #[derive(Default)]
    struct VecSink(Vec<u8>);

    impl ImageSink for VecSink {
        fn write(&mut self, chunk: &[u8]) -> Result<(), String> {
            self.0.extend_from_slice(chunk);
            Ok(())
        }
    }

    #[derive(Default)]
    struct CountingProgress {
        last_written: u32,
        verifying_calls: u32,
    }

    impl InstallProgress for CountingProgress {
        fn downloaded(&mut self, bytes: u32) {
            self.last_written = bytes;
        }
        fn verifying(&mut self) {
            self.verifying_calls += 1;
        }
    }

    #[test]
    fn install_commits_a_payload_whose_digest_matches() {
        let mut source = SliceSource {
            data: b"hello",
            position: 0,
        };
        let mut sink = VecSink::default();
        let mut progress = CountingProgress::default();

        install_verified(&mut source, &mut sink, HELLO_SHA256, &mut progress)
            .expect("matching digest installs");

        assert_eq!(sink.0, b"hello");
        assert_eq!(progress.last_written, 5);
        assert_eq!(progress.verifying_calls, 1);
    }

    #[test]
    fn install_rejects_a_digest_mismatch() {
        let mut source = SliceSource {
            data: b"hello",
            position: 0,
        };
        let mut sink = VecSink::default();
        let mut progress = CountingProgress::default();
        let expected = "0".repeat(64);

        let error = install_verified(&mut source, &mut sink, &expected, &mut progress)
            .expect_err("wrong digest is rejected");

        assert_eq!(
            error,
            InstallError::Checksum {
                expected,
                actual: HELLO_SHA256.to_owned(),
            }
        );
    }

    #[test]
    fn install_surfaces_a_source_error() {
        let mut source = FailingSource;
        let mut sink = VecSink::default();
        let mut progress = CountingProgress::default();

        let error = install_verified(&mut source, &mut sink, HELLO_SHA256, &mut progress)
            .expect_err("read failure aborts");

        assert_eq!(error, InstallError::Source("connection reset".to_owned()));
        assert!(sink.0.is_empty());
    }

    const SUMS: &str = "\
647c75052d1d7863a2b9a1692268843fde27f454dfe112db57906f20c6bc360f  streamline-0.2.2-full.bin
4b0478725ea1dff4a25bfa7c3d55f229d9db47a29b70f2ae83c8f5f959d92460  streamline-0.2.2-ota.bin
216bca477b5cc9cdd5771831b889b006ee805284c67f445e4eda7d949463fbd6  streamline-0.2.2.elf
";

    #[test]
    fn selects_the_ota_image_with_version_and_digest() {
        assert_eq!(
            parse_release(SUMS),
            Some(OtaRelease {
                version: "0.2.2".to_owned(),
                filename: "streamline-0.2.2-ota.bin".to_owned(),
                sha256: "4b0478725ea1dff4a25bfa7c3d55f229d9db47a29b70f2ae83c8f5f959d92460"
                    .to_owned(),
            })
        );
    }

    #[test]
    fn rejects_listings_without_an_ota_image() {
        let sums = "abc  streamline-0.2.2-full.bin\n";
        assert_eq!(parse_release(sums), None);
    }

    #[test]
    fn rejects_a_malformed_digest() {
        let sums = "notahash  streamline-0.2.2-ota.bin\n";
        assert_eq!(parse_release(sums), None);
    }

    #[test]
    fn skips_lines_without_a_digest_and_filename() {
        let sums = format!("unrelated-noise\n{SUMS}");
        assert_eq!(parse_release(&sums), parse_release(SUMS));
    }

    #[test]
    fn compares_released_versions() {
        assert!(is_newer("0.2.1", "0.2.2"));
        assert!(is_newer("0.2.1", "0.3.0"));
        assert!(is_newer("0.9.9", "1.0.0"));
        assert!(!is_newer("0.2.2", "0.2.2"));
        assert!(!is_newer("0.2.2", "0.2.1"));
    }

    #[test]
    fn an_unversioned_build_always_sees_an_update() {
        assert!(is_newer("dev", "0.2.2"));
    }

    #[test]
    fn absent_or_blank_custom_fields_select_the_release_flow() {
        assert_eq!(custom_image_from_form(None, None), Ok(None));
        // Browsers submit empty inputs; blank must mean absent.
        assert_eq!(custom_image_from_form(Some("  "), Some("")), Ok(None));
    }

    #[test]
    fn a_pinned_custom_image_is_accepted_with_a_normalized_digest() {
        let digest_upper = HELLO_SHA256.to_ascii_uppercase();
        assert_eq!(
            custom_image_from_form(
                Some(" http://bench.local:8000/streamline-dev-ota.bin "),
                Some(&digest_upper)
            ),
            Ok(Some(CustomImage {
                url: "http://bench.local:8000/streamline-dev-ota.bin".to_owned(),
                sha256: HELLO_SHA256.to_owned(),
            }))
        );
    }

    #[test]
    fn signed_query_stays_downloadable_but_never_appears_in_debug_output() {
        let canary = "private-query-canary";
        let url = format!("https://bench.local/a.bin?token={canary}&part=1");
        let image = custom_image_from_form(Some(&url), Some(HELLO_SHA256))
            .expect("signed URL is valid")
            .expect("custom image is selected");

        assert_eq!(image.url, url);
        assert_eq!(image.display_name(), "custom image");
        assert!(!format!("{image:?}").contains(canary));
    }

    #[test]
    fn a_url_without_a_digest_is_rejected_and_vice_versa() {
        assert!(custom_image_from_form(Some("http://bench.local/a.bin"), None).is_err());
        assert!(custom_image_from_form(None, Some(HELLO_SHA256)).is_err());
    }

    #[test]
    fn non_http_urls_are_rejected() {
        for url in [
            "ftp://bench.local/a.bin",
            "file:///a.bin",
            "bench.local/a.bin",
        ] {
            assert!(custom_image_from_form(Some(url), Some(HELLO_SHA256)).is_err());
        }
    }

    #[test]
    fn custom_urls_reject_ambiguous_or_disclosive_components() {
        for url in [
            "http:///a.bin",
            "http://user:secret@bench.local/a.bin",
            "https://bench.local/a.bin#private-fragment",
            "https://bench.local/a bin",
        ] {
            let error = custom_image_from_form(Some(url), Some(HELLO_SHA256))
                .expect_err("unsafe URL shape is rejected");
            assert!(!error.contains("secret"));
            assert!(!error.contains("private-fragment"));
        }
    }

    #[test]
    fn malformed_digests_are_rejected() {
        for digest in [
            "notahash",
            &HELLO_SHA256[..63],
            &format!("{}x", &HELLO_SHA256[..63]),
        ] {
            assert!(
                custom_image_from_form(Some("http://bench.local/a.bin"), Some(digest)).is_err()
            );
        }
    }

    #[test]
    fn only_https_images_need_tls() {
        let image = |url: &str| CustomImage {
            url: url.to_owned(),
            sha256: HELLO_SHA256.to_owned(),
        };
        assert!(image("https://bench.local/a.bin").needs_tls());
        assert!(!image("http://bench.local/a.bin").needs_tls());
    }

    #[test]
    fn automatic_updates_wait_for_boot_and_repeat_daily() {
        let mut timer = AutoUpdateTimer::default();

        assert!(!timer.take_due(
            AUTO_UPDATE_INITIAL_DELAY - Duration::from_secs(1),
            AutoUpdateSchedule::Daily,
            true
        ));
        assert!(timer.take_due(AUTO_UPDATE_INITIAL_DELAY, AutoUpdateSchedule::Daily, true));
        assert!(!timer.take_due(
            AUTO_UPDATE_INITIAL_DELAY + Duration::from_secs(24 * 60 * 60 - 1),
            AutoUpdateSchedule::Daily,
            true
        ));
        assert!(timer.take_due(
            AUTO_UPDATE_INITIAL_DELAY + Duration::from_secs(24 * 60 * 60),
            AutoUpdateSchedule::Daily,
            true
        ));
    }

    #[test]
    fn due_maintenance_waits_for_idle_audio() {
        let mut timer = AutoUpdateTimer::default();
        let overdue = AUTO_UPDATE_INITIAL_DELAY + Duration::from_secs(30);

        assert!(!timer.take_due(overdue, AutoUpdateSchedule::Daily, false));
        assert!(timer.take_due(overdue, AutoUpdateSchedule::Daily, true));
    }

    #[test]
    fn disabled_maintenance_does_not_consume_an_overdue_attempt() {
        let mut timer = AutoUpdateTimer::default();
        let overdue = AUTO_UPDATE_INITIAL_DELAY + Duration::from_secs(30);

        assert!(!timer.take_due(overdue, AutoUpdateSchedule::Disabled, true));
        assert!(timer.take_due(overdue, AutoUpdateSchedule::Weekly, true));
    }
}
