//! OpenSea's documented Drops API, with a fixed production origin and no retries.
//!
//! Protocol references checked 2026-09-16:
//! https://docs.opensea.io/reference/build_drop_mint_transaction
//! https://docs.opensea.io/docs/mint-from-a-drop (Step 4)
//! https://github.com/ProjectOpenSea/opensea-js/blob/main/src/api/drops.ts

use crate::payload::{MAX_CALLDATA_BYTES, MintPayload};
use alloy_primitives::{Address, U256, hex};
use futures_util::StreamExt;
use reqwest::{
    Client, StatusCode, Url,
    header::{HeaderValue, RETRY_AFTER},
};
use serde::Deserialize;
use std::{net::IpAddr, time::Duration};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const API_ORIGIN: &str = "https://api.opensea.io";
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RETRY_AFTER_SECONDS: u64 = 300;

/// Neither the key, request headers, raw API response nor calldata is Debug-able.
pub struct OpenSeaClient {
    client: Client,
    origin: Url,
    api_key: Zeroizing<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ApiError {
    #[error("invalid OpenSea API key format")]
    ApiKey,
    #[error("invalid collection slug or zero minter address")]
    Request,
    #[error("local test API must be an HTTP(S) loopback origin without credentials")]
    LocalOrigin,
    #[error("could not initialize the OpenSea HTTPS client")]
    Client,
    #[error("OpenSea request timed out")]
    Timeout,
    #[error("OpenSea transport failed")]
    Transport,
    #[error("OpenSea authentication failed (HTTP {status})")]
    Auth { status: u16 },
    #[error("OpenSea rejected the mint request")]
    BadRequest,
    #[error("OpenSea drop was not found")]
    NotFound,
    #[error("OpenSea drop is not active")]
    NotActive,
    #[error("OpenSea mint preconditions failed: balance, eligibility, limit or supply")]
    NotEligible,
    #[error("OpenSea rate limit: wait {retry_after_seconds} seconds before retrying")]
    RateLimited { retry_after_seconds: u64 },
    #[error("OpenSea requested a retry delay beyond the supported limit; stop this run")]
    RetryDelayTooLong,
    #[error("OpenSea returned HTTP {status}")]
    Http { status: u16 },
    #[error("OpenSea response exceeds the size limit")]
    ResponseTooLarge,
    #[error("OpenSea response does not match the documented mint schema")]
    ResponseSchema,
}

impl OpenSeaClient {
    pub fn new(api_key: Zeroizing<String>) -> Result<Self, ApiError> {
        let origin = Url::parse(API_ORIGIN).map_err(|_| ApiError::Client)?;
        Self::with_origin(api_key, origin, REQUEST_TIMEOUT)
    }

    /// Only for the CLI's explicit local-test mode. The production constructor
    /// cannot accept another origin, including a redirect supplied by the API.
    pub fn new_local_test(api_key: Zeroizing<String>, base_url: &str) -> Result<Self, ApiError> {
        let origin = local_origin(base_url)?;
        Self::with_origin(api_key, origin, REQUEST_TIMEOUT)
    }

    fn with_origin(
        api_key: Zeroizing<String>,
        origin: Url,
        timeout: Duration,
    ) -> Result<Self, ApiError> {
        if api_key.is_empty()
            || api_key.len() > 1024
            || !api_key.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(ApiError::ApiKey);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(timeout)
            .connect_timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(15))
            .tcp_nodelay(true)
            .build()
            .map_err(|_| ApiError::Client)?;
        Ok(Self {
            client,
            origin,
            api_key,
        })
    }

    /// One HTTP request, exactly one NFT for the requested minter. The caller
    /// owns scheduling, bounded concurrency and handling of typed retry outcomes.
    pub async fn mint(&self, slug: &str, minter: Address) -> Result<MintPayload, ApiError> {
        if slug.is_empty()
            || slug.len() > 128
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || minter == Address::ZERO
        {
            return Err(ApiError::Request);
        }
        let url = self
            .origin
            .join(&format!("/api/v2/drops/{slug}/mint"))
            .map_err(|_| ApiError::Request)?;
        let mut key_header =
            HeaderValue::from_str(self.api_key.as_str()).map_err(|_| ApiError::ApiKey)?;
        key_header.set_sensitive(true);
        let response = self
            .client
            .post(url)
            .header("x-api-key", key_header)
            .json(&serde_json::json!({ "minter": minter.to_string(), "quantity": 1 }))
            .send()
            .await
            .map_err(transport_error)?;
        if response.status() != StatusCode::OK {
            // Never log or include remote error bodies: they may echo credentials
            // or the mint signature. No implicit retry or redirect follows.
            return Err(status_error(
                response.status(),
                response.headers().get(RETRY_AFTER),
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ApiError::ResponseTooLarge);
        }
        let mut stream = response.bytes_stream();
        let mut body = Zeroizing::new(Vec::new());
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(transport_error)?;
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
                return Err(ApiError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        parse_response(&body)
    }
}

fn local_origin(value: &str) -> Result<Url, ApiError> {
    let url = Url::parse(value).map_err(|_| ApiError::LocalOrigin)?;
    let host_is_loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !matches!(url.scheme(), "http" | "https")
        || !host_is_loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(ApiError::LocalOrigin);
    }
    Ok(url)
}

fn transport_error(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::Timeout
    } else {
        ApiError::Transport
    }
}

fn status_error(status: StatusCode, retry_after: Option<&HeaderValue>) -> ApiError {
    match status.as_u16() {
        400 => ApiError::BadRequest,
        401 | 403 => ApiError::Auth {
            status: status.as_u16(),
        },
        404 => ApiError::NotFound,
        409 => ApiError::NotActive,
        422 => ApiError::NotEligible,
        429 => {
            // Numeric Retry-After is the SDK's documented seconds form. An
            // unrecognized/date-valued header falls back to a conservative 60s.
            let seconds = match retry_after.and_then(|value| value.to_str().ok()) {
                Some(value)
                    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) =>
                {
                    match value.parse::<u64>() {
                        Ok(seconds) => seconds.max(1),
                        Err(_) => return ApiError::RetryDelayTooLong,
                    }
                }
                _ => 60,
            };
            if seconds > MAX_RETRY_AFTER_SECONDS {
                ApiError::RetryDelayTooLong
            } else {
                ApiError::RateLimited {
                    retry_after_seconds: seconds,
                }
            }
        }
        _ => ApiError::Http {
            status: status.as_u16(),
        },
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMint {
    target: String,
    calldata: String,
    value: String,
}

impl Drop for WireMint {
    fn drop(&mut self) {
        self.calldata.zeroize();
    }
}

fn parse_response(body: &[u8]) -> Result<MintPayload, ApiError> {
    // Typed serde rejects duplicate fields; aliases/wrappers are deliberately
    // unsupported so API drift cannot silently select an unintended transaction.
    let wire: WireMint = serde_json::from_slice(body).map_err(|_| ApiError::ResponseSchema)?;
    let target = wire
        .target
        .parse::<Address>()
        .map_err(|_| ApiError::ResponseSchema)?;
    if target == Address::ZERO
        || !wire.calldata.starts_with("0x")
        || wire.calldata.len() < 10
        || wire.calldata.len() > MAX_CALLDATA_BYTES * 2 + 2
        || !wire.calldata.len().is_multiple_of(2)
    {
        return Err(ApiError::ResponseSchema);
    }
    let data = hex::decode(&wire.calldata).map_err(|_| ApiError::ResponseSchema)?;
    let (digits, radix) = if let Some(digits) = wire.value.strip_prefix("0x") {
        (digits, 16)
    } else {
        (wire.value.as_str(), 10)
    };
    if digits.is_empty()
        || digits.len() > 78
        || !digits.bytes().all(|byte| {
            if radix == 16 {
                byte.is_ascii_hexdigit()
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return Err(ApiError::ResponseSchema);
    }
    let value = U256::from_str_radix(digits, radix).map_err(|_| ApiError::ResponseSchema)?;
    Ok(MintPayload {
        target,
        data,
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    const SYNTHETIC_KEY: &str = "fixture-api-key-do-not-log";
    const BODY: &str = r#"{"target":"0x00005ea00ac477b1030ce78506496e8c2de24bf5","calldata":"0x161ac21f","value":"0"}"#;

    fn key() -> Zeroizing<String> {
        Zeroizing::new(SYNTHETIC_KEY.into())
    }

    async fn fixture(
        responses: Vec<(String, Duration)>,
    ) -> (String, tokio::task::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut requests = Vec::new();
            for (response, delay) in responses {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let byte = socket.read_u8().await.unwrap();
                    request.push(byte);
                    assert!(request.len() < 8192);
                }
                let headers = std::str::from_utf8(&request).unwrap();
                let size = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; size];
                socket.read_exact(&mut body).await.unwrap();
                request.extend_from_slice(&body);
                requests.push(request);
                tokio::time::sleep(delay).await;
                // Timeout/oversized-response tests deliberately close early.
                if socket.write_all(response.as_bytes()).await.is_err() {
                    break;
                }
            }
            requests
        });
        (origin, task)
    }

    fn response(status: u16, body: &str, extra: &str) -> String {
        format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{extra}\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn sends_documented_request_and_reuses_the_same_connection() {
        let (origin, server) = fixture(vec![
            (response(200, BODY, ""), Duration::ZERO),
            (response(200, BODY, ""), Duration::ZERO),
        ])
        .await;
        let client = OpenSeaClient::new_local_test(key(), &origin).unwrap();
        for _ in 0..2 {
            let payload = client
                .mint("rare-friends-genesis", Address::repeat_byte(0x11))
                .await
                .unwrap();
            assert_eq!(payload.value, U256::ZERO);
        }
        let requests = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests {
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /api/v2/drops/rare-friends-genesis/mint HTTP/1.1"));
            assert!(request.contains(SYNTHETIC_KEY));
            let body: serde_json::Value =
                serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["quantity"], 1);
            assert_eq!(body["minter"], Address::repeat_byte(0x11).to_string());
        }
    }

    #[tokio::test]
    async fn errors_are_typed_without_remote_body_or_credentials() {
        for status in [400, 401, 403, 404, 409, 422, 429, 500] {
            let (origin, server) = fixture(vec![(
                response(status, SYNTHETIC_KEY, "Retry-After: 2\r\n"),
                Duration::ZERO,
            )])
            .await;
            let client = OpenSeaClient::new_local_test(key(), &origin).unwrap();
            let result = client.mint("fixture", Address::repeat_byte(1)).await;
            let error = result.err().unwrap();
            assert!(!format!("{error:?} {error}").contains(SYNTHETIC_KEY));
            match status {
                401 | 403 => assert_eq!(error, ApiError::Auth { status }),
                409 => assert_eq!(error, ApiError::NotActive),
                422 => assert_eq!(error, ApiError::NotEligible),
                429 => assert_eq!(
                    error,
                    ApiError::RateLimited {
                        retry_after_seconds: 2
                    }
                ),
                _ => {}
            }
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn redirect_is_not_followed() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let extra = format!(
            "Location: http://{}/secret-sink\r\n",
            redirect_target.local_addr().unwrap()
        );
        let (origin, server) = fixture(vec![(response(307, "", &extra), Duration::ZERO)]).await;
        let client = OpenSeaClient::new_local_test(key(), &origin).unwrap();
        assert!(matches!(
            client.mint("fixture", Address::repeat_byte(1)).await,
            Err(ApiError::Http { status: 307 })
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), redirect_target.accept())
                .await
                .is_err()
        );
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn timeout_covers_a_stalled_response_without_retry() {
        let (origin, server) =
            fixture(vec![(response(200, BODY, ""), Duration::from_millis(120))]).await;
        let client = OpenSeaClient::with_origin(
            key(),
            local_origin(&origin).unwrap(),
            Duration::from_millis(20),
        )
        .unwrap();
        assert!(matches!(
            client.mint("fixture", Address::repeat_byte(1)).await,
            Err(ApiError::Timeout)
        ));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn oversized_content_length_and_chunked_response_are_bounded() {
        for raw in [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            ),
            format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                MAX_RESPONSE_BYTES + 1,
                "x".repeat(MAX_RESPONSE_BYTES + 1)
            ),
        ] {
            let (origin, server) = fixture(vec![(raw, Duration::ZERO)]).await;
            let client = OpenSeaClient::new_local_test(key(), &origin).unwrap();
            assert!(matches!(
                client.mint("fixture", Address::repeat_byte(1)).await,
                Err(ApiError::ResponseTooLarge)
            ));
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[test]
    fn malformed_ambiguous_wrapped_or_non_integer_responses_are_rejected() {
        assert!(parse_response(BODY.as_bytes()).is_ok());
        for body in [
            format!(r#"{{"transaction":{BODY}}}"#),
            BODY.replace("\"value\":\"0\"", "\"value\":\"0\",\"value\":\"1\""),
            BODY.replace("\"value\":\"0\"", "\"value\":0"),
            BODY.replace("\"value\":\"0\"", "\"value\":\"-1\""),
            BODY.replace("\"value\":\"0\"", "\"value\":\"1e9\""),
            BODY.replace("0x161ac21f", "0x123"),
            BODY.replace("0x161ac21f", "not-hex"),
            BODY.replace("\"calldata\"", "\"data\""),
        ] {
            assert!(matches!(
                parse_response(body.as_bytes()),
                Err(ApiError::ResponseSchema)
            ));
        }
    }

    #[test]
    fn production_origin_is_fixed_and_local_override_cannot_escape_loopback() {
        let client = OpenSeaClient::new(key()).unwrap();
        assert_eq!(client.origin.as_str(), "https://api.opensea.io/");
        for url in [
            "https://example.com",
            "http://127.0.0.1.attacker.test",
            "http://user@127.0.0.1",
            "http://127.0.0.1/path",
            "http://127.0.0.1?key=x",
            "file:///tmp/test",
        ] {
            assert!(matches!(
                OpenSeaClient::new_local_test(key(), url),
                Err(ApiError::LocalOrigin)
            ));
        }
        assert!(OpenSeaClient::new_local_test(key(), "http://[::1]:1234").is_ok());
        let retry = HeaderValue::from_static("301");
        assert_eq!(
            status_error(StatusCode::TOO_MANY_REQUESTS, Some(&retry)),
            ApiError::RetryDelayTooLong
        );
    }
}
