//! HTTP(S) GET connections for the update worker: release checks and firmware
//! downloads.
//!
//! Built on `esp_http_client` directly because each connection must pick its
//! TLS receive-buffer strategy ([`TlsRxBuffer`]), which the esp-idf-svc
//! client does not expose.

use anyhow::{bail, Context, Result};
use esp_idf_svc::sys;

/// GitHub's `releases/latest/download/` asset URLs resolve through one or two
/// hops; anything past this bound is a broken or hostile server.
const MAX_REDIRECT_HOPS: usize = 5;

/// The HTTP client's own response/request buffers; TLS record buffers are
/// governed separately by [`TlsRxBuffer`].
const RESPONSE_BUFFER_BYTES: i32 = 4_096;
const REQUEST_BUFFER_BYTES: i32 = 1_024;

/// How mbedTLS buffers this connection's incoming records. Plain-HTTP
/// connections ignore it.
#[derive(Clone, Copy)]
pub enum TlsRxBuffer {
    /// Allocate per record and free after: the smallest footprint beside a
    /// live PCM stream, right for small bodies.
    PerRecord,
    /// Allocate once after the handshake and hold until close
    /// (`ESP_TLS_DYN_BUF_RX_STATIC`). A full-size record otherwise costs a
    /// fresh contiguous ~17 KB block, which a megabyte download cannot win
    /// repeatedly from a fragmenting heap (#373).
    Held,
}

/// An issued GET request with status and headers received and the body ready
/// to read. Errors never echo the URL: a custom image URL may carry a signed
/// query.
pub struct HttpGet {
    client: sys::esp_http_client_handle_t,
    status: u16,
    content_length: i64,
}

impl HttpGet {
    /// Issue a GET and follow redirects until a non-redirect response.
    pub fn get(url: &str, rx: TlsRxBuffer) -> Result<Self> {
        let c_url = std::ffi::CString::new(url).context("URL contains a NUL byte")?;
        let mut config = sys::esp_http_client_config_t {
            url: c_url.as_ptr(),
            crt_bundle_attach: Some(sys::esp_crt_bundle_attach),
            buffer_size: RESPONSE_BUFFER_BYTES,
            buffer_size_tx: REQUEST_BUFFER_BYTES,
            ..Default::default()
        };
        // The zeroed strategy is esp_http_client's per-record default; only
        // the held buffer has a named constant upstream.
        if let TlsRxBuffer::Held = rx {
            config.tls_dyn_buf_strategy =
                sys::esp_http_client_tls_dyn_buf_strategy_t_HTTP_TLS_DYN_BUF_RX_STATIC;
        }
        // SAFETY: `config` and the URL it points at outlive the call; the
        // client copies what it keeps.
        let client = unsafe { sys::esp_http_client_init(&config) };
        if client.is_null() {
            bail!("cannot create HTTP client");
        }
        let mut request = Self {
            client,
            status: 0,
            content_length: -1,
        };
        request.open_following_redirects()?;
        Ok(request)
    }

    fn open_following_redirects(&mut self) -> Result<()> {
        // SAFETY: `self.client` is a live client handle throughout.
        for _ in 0..=MAX_REDIRECT_HOPS {
            check(unsafe { sys::esp_http_client_open(self.client, 0) })
                .context("cannot open HTTP connection")?;
            if unsafe { sys::esp_http_client_fetch_headers(self.client) } < 0 {
                bail!("reading response headers failed");
            }
            let status = unsafe { sys::esp_http_client_get_status_code(self.client) } as u16;
            if !is_redirect(status) {
                self.status = status;
                self.content_length =
                    unsafe { sys::esp_http_client_get_content_length(self.client) };
                return Ok(());
            }
            let mut flushed = 0_i32;
            check(unsafe { sys::esp_http_client_flush_response(self.client, &mut flushed) })
                .context("cannot flush redirect response")?;
            check(unsafe {
                sys::esp_http_client_set_method(
                    self.client,
                    sys::esp_http_client_method_t_HTTP_METHOD_GET,
                )
            })
            .context("cannot reset method for redirect")?;
            check(unsafe { sys::esp_http_client_set_redirection(self.client) })
                .context("cannot follow redirect")?;
            // A redirect may cross hosts or ride a connection the server
            // already closed; reconnect instead of reusing it.
            check(unsafe { sys::esp_http_client_close(self.client) })
                .context("cannot close redirected connection")?;
        }
        bail!("too many redirects")
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    /// The body length the server declared; `None` when it did not.
    pub fn content_length(&self) -> Option<u64> {
        u64::try_from(self.content_length).ok()
    }

    /// Read body bytes into `buffer`; `Ok(0)` signals the end of the body.
    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize> {
        // SAFETY: the buffer pointer and length describe live writable memory.
        let read = unsafe {
            sys::esp_http_client_read(self.client, buffer.as_mut_ptr().cast(), buffer.len() as _)
        };
        if read < 0 {
            bail!("HTTP read failed (error {read})");
        }
        Ok(read as usize)
    }
}

impl Drop for HttpGet {
    fn drop(&mut self) {
        // SAFETY: the handle is dropped exactly once; close on a never-opened
        // connection is a harmless error.
        unsafe {
            sys::esp_http_client_close(self.client);
            sys::esp_http_client_cleanup(self.client);
        }
    }
}

/// Redirect statuses `esp_http_client_set_redirection` can follow; 304 carries
/// no Location and ends the request.
fn is_redirect(status: u16) -> bool {
    matches!(status, 300..=399) && status != 304
}

fn check(error: sys::esp_err_t) -> Result<()> {
    if error == sys::ESP_OK {
        Ok(())
    } else {
        bail!("esp_http_client error {error}")
    }
}
