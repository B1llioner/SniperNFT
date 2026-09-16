//! OpenSea's documented Drops API, with a fixed production origin and no retries.
//!
//! Protocol references checked 2026-09-16:
//! https://docs.opensea.io/reference/build_drop_mint_transaction
//! https://docs.opensea.io/docs/mint-from-a-drop (Step 4)
//! https://github.com/ProjectOpenSea/opensea-js/blob/main/src/api/drops.ts
//! https://docs.opensea.io/reference/api-keys
//! https://docs.opensea.io/reference/create_instant_api_key

use crate::payload::{MAX_CALLDATA_BYTES, MintPayload};
use alloy_primitives::{Address, U256, hex};
use futures_util::StreamExt;
use reqwest::{
    Client, StatusCode, Url,
    header::{HeaderMap, HeaderValue, RETRY_AFTER},
};
use serde::{Deserialize, Serialize};
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
    expires_at_unix_seconds: Option<u64>,
}

/// Sanitized server-advertised limits; no API key or response strings are kept.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct RateLimit {
    pub requests: u32,
    pub window_seconds: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct InstantRateLimits {
    pub read: RateLimit,
    pub write: RateLimit,
    pub fulfillment: RateLimit,
}

/// These headers describe the key-creation endpoint, not the new key's mint
/// allowance. In particular, remaining=0 must not be treated as zero mint quota.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct QuotaSnapshot {
    pub limit: u64,
    pub remaining: u64,
    pub reset_unix_seconds: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct EphemeralMetadata {
    pub expires_at_unix_seconds: u64,
    pub rate_limits: InstantRateLimits,
    pub creation_quota: Option<QuotaSnapshot>,
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
    #[error("OpenSea instant-key response has invalid schema, expiry or rate limits")]
    InstantKeySchema,
    #[error("OpenSea instant API key is expired or too close to expiry")]
    InstantKeyExpired,
    #[error("OpenSea instant-key service is disabled or temporarily unavailable")]
    InstantKeyUnavailable,
    #[error("OpenSea instant-key creation returned HTTP {status}")]
    InstantKeyHttp { status: u16 },
    #[error("OpenSea rate-limit headers are invalid")]
    QuotaSchema,
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

    /// Creates exactly one anonymous free-tier key. The key only lives in this
    /// client; it is never returned, serialized, persisted or renewed implicitly.
    pub async fn ephemeral() -> Result<(Self, EphemeralMetadata), ApiError> {
        let origin = Url::parse(API_ORIGIN).map_err(|_| ApiError::Client)?;
        Self::ephemeral_with_origin(origin, REQUEST_TIMEOUT).await
    }

    /// The same flow against a loopback test service. Production callers
    /// cannot supply an alternate origin or a redirect destination.
    pub async fn ephemeral_local_test(
        base_url: &str,
    ) -> Result<(Self, EphemeralMetadata), ApiError> {
        Self::ephemeral_with_origin(local_origin(base_url)?, REQUEST_TIMEOUT).await
    }

    async fn ephemeral_with_origin(
        origin: Url,
        timeout: Duration,
    ) -> Result<(Self, EphemeralMetadata), ApiError> {
        let client = http_client(timeout)?;
        let url = origin
            .join("/api/v2/auth/keys")
            .map_err(|_| ApiError::Client)?;
        let response = client
            .post(url)
            .header("accept", "application/json")
            .body("")
            .send()
            .await
            .map_err(transport_error)?;
        match response.status().as_u16() {
            201 => {}
            401 | 403 => {
                return Err(ApiError::Auth {
                    status: response.status().as_u16(),
                });
            }
            429 => return Err(rate_error(response.headers())),
            503 => return Err(ApiError::InstantKeyUnavailable),
            status => return Err(ApiError::InstantKeyHttp { status }),
        }
        let creation_quota = quota_snapshot(response.headers())?;
        let body = bounded_body(response).await?;
        let (api_key, metadata) = parse_instant_key(&body, creation_quota)?;
        Ok((
            Self {
                client,
                origin,
                api_key,
                expires_at_unix_seconds: Some(metadata.expires_at_unix_seconds),
            },
            metadata,
        ))
    }

    fn with_origin(
        api_key: Zeroizing<String>,
        origin: Url,
        timeout: Duration,
    ) -> Result<Self, ApiError> {
        if !valid_api_key(&api_key) {
            return Err(ApiError::ApiKey);
        }
        let client = http_client(timeout)?;
        Ok(Self {
            client,
            origin,
            api_key,
            expires_at_unix_seconds: None,
        })
    }

    /// One HTTP request, exactly one NFT for the requested minter. The caller
    /// owns scheduling, bounded concurrency and handling of typed retry outcomes.
    pub async fn mint(&self, slug: &str, minter: Address) -> Result<MintPayload, ApiError> {
        if self.expires_at_unix_seconds.is_some_and(|expiry| {
            i128::from(expiry) <= i128::from(time::OffsetDateTime::now_utc().unix_timestamp()) + 10
        }) {
            return Err(ApiError::InstantKeyExpired);
        }
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
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                return Err(rate_error(response.headers()));
            }
            return Err(status_error(
                response.status(),
                response.headers().get(RETRY_AFTER),
            ));
        }
        let body = bounded_body(response).await?;
        parse_response(&body)
    }
}

fn valid_api_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 1024 && key.bytes().all(|byte| byte.is_ascii_graphic())
}

fn http_client(timeout: Duration) -> Result<Client, ApiError> {
    Client::builder()
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
        .map_err(|_| ApiError::Client)
}

async fn bounded_body(response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>, ApiError> {
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
    Ok(body)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireInstantKey {
    #[serde(deserialize_with = "deserialize_secret")]
    api_key: Zeroizing<String>,
    #[serde(rename = "name")]
    _name: String,
    expires_at: String,
    rate_limits: WireRateLimits,
    #[serde(rename = "upgrade_url")]
    _upgrade_url: String,
}

fn deserialize_secret<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRateLimits {
    read: String,
    write: String,
    fulfillment: String,
}

fn parse_rate_limit(value: &str) -> Result<RateLimit, ApiError> {
    if value.len() > 16 {
        return Err(ApiError::InstantKeySchema);
    }
    let (requests, unit) = value.split_once('/').ok_or(ApiError::InstantKeySchema)?;
    if requests.is_empty() || !requests.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::InstantKeySchema);
    }
    let requests = requests
        .parse::<u32>()
        .map_err(|_| ApiError::InstantKeySchema)?;
    let window_seconds = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return Err(ApiError::InstantKeySchema),
    };
    if requests == 0 {
        return Err(ApiError::InstantKeySchema);
    }
    Ok(RateLimit {
        requests,
        window_seconds,
    })
}

fn parse_instant_key(
    body: &[u8],
    creation_quota: Option<QuotaSnapshot>,
) -> Result<(Zeroizing<String>, EphemeralMetadata), ApiError> {
    let mut wire: WireInstantKey =
        serde_json::from_slice(body).map_err(|_| ApiError::InstantKeySchema)?;
    if !valid_api_key(&wire.api_key) || wire.expires_at.len() > 40 {
        return Err(ApiError::InstantKeySchema);
    }
    let expires = time::OffsetDateTime::parse(
        &wire.expires_at,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| ApiError::InstantKeySchema)?
    .unix_timestamp();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    if i128::from(expires) <= i128::from(now) + 60 {
        return Err(ApiError::InstantKeyExpired);
    }
    let metadata = EphemeralMetadata {
        expires_at_unix_seconds: expires.try_into().map_err(|_| ApiError::InstantKeySchema)?,
        rate_limits: InstantRateLimits {
            read: parse_rate_limit(&wire.rate_limits.read)?,
            write: parse_rate_limit(&wire.rate_limits.write)?,
            fulfillment: parse_rate_limit(&wire.rate_limits.fulfillment)?,
        },
        creation_quota,
    };
    Ok((std::mem::take(&mut wire.api_key), metadata))
}

fn numeric_header(headers: &HeaderMap, name: &str) -> Result<Option<u64>, ApiError> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(ApiError::QuotaSchema);
    }
    let value = value.to_str().map_err(|_| ApiError::QuotaSchema)?;
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::QuotaSchema);
    }
    value.parse().map(Some).map_err(|_| ApiError::QuotaSchema)
}

fn quota_snapshot(headers: &HeaderMap) -> Result<Option<QuotaSnapshot>, ApiError> {
    match (
        numeric_header(headers, "x-ratelimit-limit")?,
        numeric_header(headers, "x-ratelimit-remaining")?,
        numeric_header(headers, "x-ratelimit-reset")?,
    ) {
        (None, None, None) => Ok(None),
        (Some(limit), Some(remaining), Some(reset_unix_seconds))
            if limit > 0 && remaining <= limit =>
        {
            Ok(Some(QuotaSnapshot {
                limit,
                remaining,
                reset_unix_seconds,
            }))
        }
        _ => Err(ApiError::QuotaSchema),
    }
}

fn rate_error(headers: &HeaderMap) -> ApiError {
    let base = status_error(StatusCode::TOO_MANY_REQUESTS, headers.get(RETRY_AFTER));
    let ApiError::RateLimited {
        retry_after_seconds,
    } = base
    else {
        return base;
    };
    let reset = match numeric_header(headers, "x-ratelimit-reset") {
        Ok(value) => value,
        Err(error) => return error,
    };
    let until_reset = reset.map_or(0, |reset| {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        (i128::from(reset) - i128::from(now))
            .max(0)
            .min(i128::from(u64::MAX)) as u64
    });
    let retry_after_seconds = retry_after_seconds.max(until_reset);
    if retry_after_seconds > MAX_RETRY_AFTER_SECONDS {
        ApiError::RetryDelayTooLong
    } else {
        ApiError::RateLimited {
            retry_after_seconds,
        }
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
    const KEY_BODY: &str = r#"{"api_key":"fixture-api-key-do-not-log","name":"agent_free_fixture","expires_at":"2099-01-01T00:00:00.795591270Z","rate_limits":{"read":"600/h","write":"30/h","fulfillment":"5/m"},"upgrade_url":"https://opensea.io/settings/developer"}"#;

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
                    .unwrap_or(0);
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
        // Allow loopback connection/request setup under concurrent test load;
        // the intentional response stall must be what triggers the deadline.
        let (origin, server) =
            fixture(vec![(response(200, BODY, ""), Duration::from_secs(1))]).await;
        let client = OpenSeaClient::with_origin(
            key(),
            local_origin(&origin).unwrap(),
            Duration::from_millis(200),
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

    #[tokio::test]
    async fn anonymous_key_is_issued_once_kept_private_and_reuses_connection_for_mint() {
        let (origin, server) = fixture(vec![
            (response(201, KEY_BODY, "X-RateLimit-Limit: 1\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 4070908800\r\n"), Duration::ZERO),
            (response(200, BODY, ""), Duration::ZERO),
            (response(200, BODY, ""), Duration::ZERO),
        ]).await;
        let (client, metadata) = OpenSeaClient::ephemeral_local_test(&origin).await.unwrap();
        assert_eq!(metadata.expires_at_unix_seconds, 4_070_908_800);
        assert_eq!(
            metadata.rate_limits.write,
            RateLimit {
                requests: 30,
                window_seconds: 3600
            }
        );
        assert_eq!(
            metadata.rate_limits.fulfillment,
            RateLimit {
                requests: 5,
                window_seconds: 60
            }
        );
        assert_eq!(metadata.creation_quota.unwrap().remaining, 0);
        assert!(!format!("{metadata:?}").contains(SYNTHETIC_KEY));
        assert!(
            !serde_json::to_string(&metadata)
                .unwrap()
                .contains(SYNTHETIC_KEY)
        );
        for _ in 0..2 {
            client
                .mint("fixture", Address::repeat_byte(1))
                .await
                .unwrap();
        }
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        let creation = String::from_utf8(requests[0].clone()).unwrap();
        assert!(creation.starts_with("POST /api/v2/auth/keys HTTP/1.1"));
        assert!(!creation.to_ascii_lowercase().contains("x-api-key"));
        assert!(!creation.contains(SYNTHETIC_KEY));
        for request in &requests[1..] {
            let request = std::str::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /api/v2/drops/fixture/mint HTTP/1.1"));
            assert!(request.contains(SYNTHETIC_KEY));
        }
    }

    #[test]
    fn instant_key_schema_rejects_ambiguous_expired_and_malformed_data() {
        assert!(parse_instant_key(KEY_BODY.as_bytes(), None).is_ok());
        for body in [
            format!(r#"{{"data":{KEY_BODY}}}"#),
            KEY_BODY.replace("\"api_key\":", "\"api_key\":\"duplicate\",\"api_key\":"),
            KEY_BODY.replace(SYNTHETIC_KEY, ""),
            KEY_BODY.replace(SYNTHETIC_KEY, "contains spaces"),
            KEY_BODY.replace("2099-01-01T00:00:00.795591270Z", "not-a-date"),
            KEY_BODY.replace("600/h", "0/h"),
            KEY_BODY.replace("600/h", "600/week"),
            KEY_BODY.replace("600/h", "18446744073709551616/h"),
            KEY_BODY.replace("600/h", "600/h/second"),
            KEY_BODY.replace("600/h", "-1/h"),
        ] {
            let error = parse_instant_key(body.as_bytes(), None).err().unwrap();
            assert_eq!(error, ApiError::InstantKeySchema);
            assert!(!format!("{error:?} {error}").contains(SYNTHETIC_KEY));
        }
        assert!(matches!(
            parse_instant_key(
                KEY_BODY.replace("2099-01-01", "2000-01-01").as_bytes(),
                None
            ),
            Err(ApiError::InstantKeyExpired)
        ));
    }

    #[tokio::test]
    async fn key_creation_redirect_errors_and_rate_limits_never_retry_or_echo_body() {
        let sink = TcpListener::bind("127.0.0.1:0").await.unwrap();
        for (status, headers, expected) in [
            (
                307,
                format!(
                    "Location: http://{}/secret-sink\r\n",
                    sink.local_addr().unwrap()
                ),
                ApiError::InstantKeyHttp { status: 307 },
            ),
            (401, String::new(), ApiError::Auth { status: 401 }),
            (403, String::new(), ApiError::Auth { status: 403 }),
            (503, String::new(), ApiError::InstantKeyUnavailable),
            (
                429,
                "Retry-After: 2\r\n".into(),
                ApiError::RateLimited {
                    retry_after_seconds: 2,
                },
            ),
            (
                429,
                "Retry-After: 2\r\nX-RateLimit-Reset: 4070908800\r\n".into(),
                ApiError::RetryDelayTooLong,
            ),
        ] {
            let (origin, server) =
                fixture(vec![(response(status, KEY_BODY, &headers), Duration::ZERO)]).await;
            let error = OpenSeaClient::ephemeral_local_test(&origin)
                .await
                .err()
                .unwrap();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains(SYNTHETIC_KEY));
            assert_eq!(server.await.unwrap().len(), 1);
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(25), sink.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn key_creation_response_is_size_and_time_bounded() {
        for body in [
            format!(
                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            ),
            format!(
                "HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                MAX_RESPONSE_BYTES + 1,
                "x".repeat(MAX_RESPONSE_BYTES + 1)
            ),
        ] {
            let (origin, server) = fixture(vec![(body, Duration::ZERO)]).await;
            assert!(matches!(
                OpenSeaClient::ephemeral_local_test(&origin).await,
                Err(ApiError::ResponseTooLarge)
            ));
            assert_eq!(server.await.unwrap().len(), 1);
        }
        let (origin, server) =
            fixture(vec![(response(201, KEY_BODY, ""), Duration::from_secs(1))]).await;
        assert!(matches!(
            OpenSeaClient::ephemeral_with_origin(
                local_origin(&origin).unwrap(),
                Duration::from_millis(200)
            )
            .await,
            Err(ApiError::Timeout)
        ));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[test]
    fn quota_headers_reject_ambiguity_and_reset_controls_backoff() {
        let mut headers = HeaderMap::new();
        assert_eq!(quota_snapshot(&headers).unwrap(), None);
        headers.insert("x-ratelimit-limit", HeaderValue::from_static("3"));
        assert!(matches!(
            quota_snapshot(&headers),
            Err(ApiError::QuotaSchema)
        ));
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("4"));
        headers.insert("x-ratelimit-reset", HeaderValue::from_static("4070908800"));
        assert!(matches!(
            quota_snapshot(&headers),
            Err(ApiError::QuotaSchema)
        ));
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("2"));
        assert_eq!(quota_snapshot(&headers).unwrap().unwrap().remaining, 2);
        headers.append("x-ratelimit-remaining", HeaderValue::from_static("1"));
        assert!(matches!(
            quota_snapshot(&headers),
            Err(ApiError::QuotaSchema)
        ));
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("1"));
        let reset = time::OffsetDateTime::now_utc().unix_timestamp() + 120;
        headers.insert(
            "x-ratelimit-reset",
            HeaderValue::from_str(&reset.to_string()).unwrap(),
        );
        assert!(matches!(
            rate_error(&headers),
            ApiError::RateLimited {
                retry_after_seconds: 119..=120
            }
        ));
    }

    #[tokio::test]
    async fn expired_ephemeral_key_stops_before_network_and_local_origin_is_restricted() {
        let mut client = OpenSeaClient::new_local_test(key(), "http://127.0.0.1:1").unwrap();
        client.expires_at_unix_seconds = Some(1);
        assert!(matches!(
            client.mint("fixture", Address::repeat_byte(1)).await,
            Err(ApiError::InstantKeyExpired)
        ));
        for url in [
            "https://api.opensea.io",
            "http://127.0.0.1.attacker.test",
            "http://user@127.0.0.1",
            "http://127.0.0.1/path",
        ] {
            assert!(matches!(
                OpenSeaClient::ephemeral_local_test(url).await,
                Err(ApiError::LocalOrigin)
            ));
        }
    }
}
