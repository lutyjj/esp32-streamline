//! Form body parsing and request size limits.

use embedded_svc::http::Headers;
use embedded_svc::io::Read;
use serde::de::DeserializeOwned;

use crate::{board, mutation::MutationError};

/// A form-urlencoded byte can expand to `%XX`, so a descriptor upload can be
/// three times its raw size on the wire; the rest of the fields fit in 512.
const URL_ENCODED_EXPANSION: usize = 3;
const MAX_REQUEST_BYTES: usize = board::MAX_DESCRIPTOR_BYTES * URL_ENCODED_EXPANSION + 512;

/// Parse a form-urlencoded body. Every failure is a malformed request the
/// caller must fix, so it surfaces as [`MutationError::InvalidInput`].
pub(super) fn form<C, T>(
    request: &mut embedded_svc::http::server::Request<C>,
) -> Result<T, MutationError>
where
    C: embedded_svc::http::server::Connection,
    C::Error: std::error::Error + Send + Sync + 'static,
    T: DeserializeOwned,
{
    let length = request.content_len().unwrap_or(0) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(MutationError::InvalidInput(
            "request is too large".to_owned(),
        ));
    }
    let mut body = vec![0; length];
    request
        .read_exact(&mut body)
        .map_err(|_| MutationError::InvalidInput("could not read request body".to_owned()))?;
    serde_urlencoded::from_bytes(&body)
        .map_err(|error| MutationError::InvalidInput(format!("invalid form: {error}")))
}
