//! Form body parsing and request size limits.

use anyhow::{anyhow, bail, Result};
use embedded_svc::http::Headers;
use embedded_svc::io::Read;
use serde::de::DeserializeOwned;

use crate::board;

/// A form-urlencoded byte can expand to `%XX`, so a descriptor upload can be
/// three times its raw size on the wire; the rest of the fields fit in 512.
const URL_ENCODED_EXPANSION: usize = 3;
const MAX_REQUEST_BYTES: usize = board::MAX_DESCRIPTOR_BYTES * URL_ENCODED_EXPANSION + 512;

pub(super) fn form<C, T>(request: &mut embedded_svc::http::server::Request<C>) -> Result<T>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: DeserializeOwned,
{
    let length = request.content_len().unwrap_or(0) as usize;
    if length > MAX_REQUEST_BYTES {
        bail!("request is too large");
    }
    let mut body = vec![0; length];
    request.read_exact(&mut body)?;
    serde_urlencoded::from_bytes(&body).map_err(|error| anyhow!("invalid form: {error}"))
}

#[cfg(test)]
mod tests {
    use crate::api;

    #[test]
    fn decodes_browser_urlencoded_forms() {
        let form: api::WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Studio+WiFi&target_host=bridge%2Elocal")
                .expect("valid form");
        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host.as_deref(), Some("bridge.local"));
    }
}
