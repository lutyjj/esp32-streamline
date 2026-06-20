//! Hardware-independent firmware-update release selection.
//!
//! The device discovers updates through GitHub's `releases/latest/download/`
//! redirect rather than the JSON API: it fetches the published `SHA256SUMS`,
//! picks the over-the-air application image, and learns both its filename and
//! expected digest from one small text file. Keeping the parsing and version
//! comparison here makes them host-testable, away from the network and flash
//! adapters.

/// The application image published for over-the-air updates. Its filename
/// carries the release version, so one `SHA256SUMS` entry yields everything the
/// installer needs.
const OTA_ASSET_SUFFIX: &str = "-ota.bin";
const ASSET_PREFIX: &str = "streamline-";

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
        let (digest, name) = line.split_once("  ").or_else(|| line.split_once(' '))?;
        let digest = digest.trim();
        let filename = name.trim();
        if !filename.ends_with(OTA_ASSET_SUFFIX) {
            continue;
        }
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
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

#[cfg(test)]
mod tests {
    use super::{is_newer, parse_release, OtaRelease};

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
}
