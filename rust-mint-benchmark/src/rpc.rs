//! Persistent, sequential JSON-RPC transports. No request is automatically
//! retried. Cancellation or ambiguous transport failure poisons the client; the
//! caller reconciles the transaction hash before explicitly reconnecting.

use std::{net::IpAddr, time::Duration};

use futures_util::{SinkExt, StreamExt};
use reqwest::redirect::Policy;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_UNSOLICITED_MESSAGES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    #[error("INVALID_RPC_URL")]
    InvalidUrl,
    #[error("INVALID_RPC_REQUEST")]
    InvalidRequest,
    #[error("RPC_TIMEOUT")]
    Timeout,
    #[error("RPC_NETWORK_ERROR")]
    Network,
    #[error("RPC_HTTP_STATUS_{0}")]
    HttpStatus(u16),
    #[error("INVALID_RPC_RESPONSE")]
    Protocol,
    #[error("RPC_RESPONSE_TOO_LARGE")]
    ResponseTooLarge,
    #[error("RPC_REMOTE_ERROR_{code}")]
    Remote { code: i64 },
    #[error("RPC_CLIENT_CLOSED_OR_AMBIGUOUS")]
    Closed,
}

enum Transport {
    Http { client: reqwest::Client, url: Url },
    WebSocket(Box<WebSocketStream<MaybeTlsStream<TcpStream>>>),
}

/// URL and request contents deliberately have no Debug implementation.
pub struct RpcClient {
    transport: Transport,
    timeout: Duration,
    next_id: u64,
    poisoned: bool,
}

fn endpoint(input: &str) -> Result<Url, RpcError> {
    if input.len() > 4096 || input.bytes().any(|b| b.is_ascii_whitespace() || b == b'\\') {
        return Err(RpcError::InvalidUrl);
    }
    let url = Url::parse(input).map_err(|_| RpcError::InvalidUrl)?;
    let host = url.host_str().ok_or(RpcError::InvalidUrl)?;
    let authority = input
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default());
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !url.username().is_empty()
        || url.password().is_some()
        || authority.is_some_and(|value| value.contains('@'))
        || url.fragment().is_some()
        || !matches!(url.scheme(), "https" | "wss" | "http" | "ws")
        || (matches!(url.scheme(), "http" | "ws") && !loopback)
        || (host.starts_with("feed.")
            && host.trim_end_matches('.').ends_with(".chain.robinhood.com"))
        || url.port_or_known_default().is_none()
    {
        return Err(RpcError::InvalidUrl);
    }
    Ok(url)
}

fn response(value: Value, id: u64) -> Result<Value, RpcError> {
    let object = value.as_object().ok_or(RpcError::Protocol)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object.get("id").and_then(Value::as_u64) != Some(id)
        || object.contains_key("method")
        || object.contains_key("result") == object.contains_key("error")
    {
        return Err(RpcError::Protocol);
    }
    if let Some(error) = object.get("error") {
        let error = error.as_object().ok_or(RpcError::Protocol)?;
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .ok_or(RpcError::Protocol)?;
        if !error.get("message").is_some_and(Value::is_string) {
            return Err(RpcError::Protocol);
        }
        // Messages/data can include echoed tokens, URLs or transaction bytes.
        // Preserve only the stable numeric code for caller policy decisions.
        return Err(RpcError::Remote { code });
    }
    object.get("result").cloned().ok_or(RpcError::Protocol)
}

fn notification(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
            && !object.contains_key("id")
            && object.get("method").is_some_and(Value::is_string)
            && !object.contains_key("result")
            && !object.contains_key("error")
    })
}

fn network(error: reqwest::Error) -> RpcError {
    if error.is_timeout() {
        RpcError::Timeout
    } else {
        RpcError::Network
    }
}

fn websocket_error(error: tokio_tungstenite::tungstenite::Error) -> RpcError {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Http(response) => RpcError::HttpStatus(response.status().as_u16()),
        Error::Capacity(_) => RpcError::ResponseTooLarge,
        Error::ConnectionClosed | Error::AlreadyClosed => RpcError::Closed,
        Error::Io(_) | Error::Tls(_) => RpcError::Network,
        _ => RpcError::Protocol,
    }
}

impl RpcClient {
    /// HTTPS connects lazily on the first call; a read-only warmup call opens
    /// its pooled connection. WSS establishes its single connection here.
    pub async fn connect(input: &str, timeout: Duration) -> Result<Self, RpcError> {
        let url = endpoint(input)?;
        if timeout.is_zero() || timeout > Duration::from_secs(300) {
            return Err(RpcError::InvalidRequest);
        }
        let transport = if matches!(url.scheme(), "https" | "http") {
            let client = reqwest::Client::builder()
                .use_rustls_tls()
                .http1_only()
                .tcp_nodelay(true)
                .tcp_keepalive(Duration::from_secs(30))
                .pool_max_idle_per_host(1)
                .pool_idle_timeout(Duration::from_secs(90))
                .connect_timeout(timeout)
                .timeout(timeout)
                .redirect(Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .build()
                .map_err(network)?;
            Transport::Http { client, url }
        } else {
            let config = WebSocketConfig::default()
                .read_buffer_size(16 * 1024)
                .write_buffer_size(0)
                .max_write_buffer_size(MAX_RESPONSE_BYTES + 1024)
                .max_message_size(Some(MAX_RESPONSE_BYTES))
                .max_frame_size(Some(MAX_RESPONSE_BYTES));
            let (stream, response) = tokio::time::timeout(
                timeout,
                connect_async_with_config(url.as_str(), Some(config), true),
            )
            .await
            .map_err(|_| RpcError::Timeout)?
            .map_err(websocket_error)?;
            if response.headers().contains_key("sec-websocket-extensions")
                || response.headers().contains_key("sec-websocket-protocol")
            {
                return Err(RpcError::Protocol);
            }
            Transport::WebSocket(Box::new(stream))
        };
        Ok(Self {
            transport,
            timeout,
            next_id: 1,
            poisoned: false,
        })
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.poisoned {
            return Err(RpcError::Closed);
        }
        if method.is_empty()
            || method.len() > 128
            || !method
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.'))
            || (!params.is_array() && !params.is_object())
        {
            return Err(RpcError::InvalidRequest);
        }
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(RpcError::InvalidRequest)?;
        let body = serde_json::to_string(
            &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .map_err(|_| RpcError::InvalidRequest)?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(RpcError::InvalidRequest);
        }
        // This assignment happens before the first await. Dropping this future
        // leaves poisoned=true, so an interrupted send is never silently reused.
        self.poisoned = true;
        let result = tokio::time::timeout(self.timeout, self.call_inner(id, body))
            .await
            .map_err(|_| RpcError::Timeout)
            .and_then(|result| result);
        if result.is_ok() || matches!(result, Err(RpcError::Remote { .. })) {
            self.poisoned = false;
        }
        result
    }

    async fn call_inner(&mut self, id: u64, body: String) -> Result<Value, RpcError> {
        match &mut self.transport {
            Transport::Http { client, url } => {
                let mut result = client
                    .post(url.clone())
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .header(reqwest::header::ACCEPT_ENCODING, "identity")
                    .body(body)
                    .send()
                    .await
                    .map_err(network)?;
                if !result.status().is_success() {
                    return Err(RpcError::HttpStatus(result.status().as_u16()));
                }
                if result
                    .content_length()
                    .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
                {
                    return Err(RpcError::ResponseTooLarge);
                }
                if result
                    .headers()
                    .get(reqwest::header::CONTENT_ENCODING)
                    .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
                {
                    return Err(RpcError::Protocol);
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = result.chunk().await.map_err(network)? {
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                        return Err(RpcError::ResponseTooLarge);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value = serde_json::from_slice(&bytes).map_err(|_| RpcError::Protocol)?;
                response(value, id)
            }
            Transport::WebSocket(stream) => {
                stream
                    .send(Message::Text(body.into()))
                    .await
                    .map_err(websocket_error)?;
                let mut unsolicited = 0_usize;
                loop {
                    let message = stream
                        .next()
                        .await
                        .ok_or(RpcError::Closed)?
                        .map_err(websocket_error)?;
                    let value: Value = match message {
                        Message::Text(text) => {
                            serde_json::from_str(text.as_ref()).map_err(|_| RpcError::Protocol)?
                        }
                        Message::Binary(bytes) => {
                            serde_json::from_slice(&bytes).map_err(|_| RpcError::Protocol)?
                        }
                        Message::Ping(_) => {
                            // tungstenite queues the matching Pong automatically.
                            stream.flush().await.map_err(websocket_error)?;
                            unsolicited += 1;
                            if unsolicited > MAX_UNSOLICITED_MESSAGES {
                                return Err(RpcError::Protocol);
                            }
                            continue;
                        }
                        Message::Pong(_) => {
                            unsolicited += 1;
                            if unsolicited > MAX_UNSOLICITED_MESSAGES {
                                return Err(RpcError::Protocol);
                            }
                            continue;
                        }
                        Message::Close(_) => return Err(RpcError::Closed),
                        Message::Frame(_) => return Err(RpcError::Protocol),
                    };
                    if notification(&value) {
                        unsolicited += 1;
                        if unsolicited > MAX_UNSOLICITED_MESSAGES {
                            return Err(RpcError::Protocol);
                        }
                        continue;
                    }
                    return response(value, id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };
    use tokio_tungstenite::accept_async;

    async fn request(reader: &mut BufReader<TcpStream>) -> Value {
        let mut length = None;
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).await.unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = Some(value.trim().parse::<usize>().unwrap());
            }
        }
        let mut body = vec![0_u8; length.unwrap()];
        reader.read_exact(&mut body).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn reply(reader: &mut BufReader<TcpStream>, status: u16, body: &str) {
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
            body.len()
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    }

    #[test]
    fn endpoint_validation_rejects_plaintext_remote_auth_fragments_and_feed() {
        for input in [
            "https://user:synthetic-secret@example.com/",
            "https://@example.com/",
            "https://example.com/#private",
            "http://example.com/",
            "ws://example.com/",
            "file:///tmp/test",
            "https://example.com/\r\nInjected: x",
            "https://example.com\\@evil.invalid/",
            "wss://feed.mainnet.chain.robinhood.com/",
            "wss://feed.testnet.chain.robinhood.com/",
            "wss://feed.mainnet.chain.robinhood.com./",
        ] {
            assert!(matches!(endpoint(input), Err(RpcError::InvalidUrl)));
        }
        for input in [
            "https://example.com/key?token=synthetic",
            "wss://example.com/rpc",
            "http://127.0.0.1:8545/",
            "ws://[::1]:8546/",
            "http://localhost:8545/",
        ] {
            assert!(endpoint(input).is_ok());
        }
    }

    #[test]
    fn response_requires_matching_id_exactly_one_outcome_and_valid_error() {
        for value in [
            json!({"jsonrpc":"2.0","id":2,"result":true}),
            json!({"jsonrpc":"2.0","id":"1","result":true}),
            json!({"id":1,"result":true}),
            json!({"jsonrpc":"2.0","id":1,"result":true,"error":{"code":-1,"message":"x"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":"-1","message":"x"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-1}}),
            json!([{"jsonrpc":"2.0","id":1,"result":true}]),
        ] {
            assert_eq!(response(value, 1), Err(RpcError::Protocol));
        }
        assert_eq!(
            response(json!({"jsonrpc":"2.0","id":1,"result":null}), 1),
            Ok(Value::Null)
        );
    }

    #[tokio::test]
    async fn http_reuses_one_connection_and_remote_errors_are_redacted() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            for index in 0..3 {
                let request = request(&mut reader).await;
                assert_eq!(request["id"], index + 1);
                let body = if index == 1 {
                    json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"synthetic-api-secret","data":"0xsignedbytes"}})
                } else {
                    json!({"jsonrpc":"2.0","id":request["id"],"result":"0x1"})
                };
                reply(&mut reader, 200, &body.to_string()).await;
            }
        });
        let mut client = RpcClient::connect(&format!("http://{address}/"), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(client.call("eth_chainId", json!([])).await.unwrap(), "0x1");
        let error = client.call("missing_method", json!([])).await.unwrap_err();
        assert_eq!(error, RpcError::Remote { code: -32601 });
        assert!(!format!("{error:?} {error}").contains("synthetic-api-secret"));
        assert!(!format!("{error:?} {error}").contains("signedbytes"));
        assert_eq!(client.call("eth_chainId", json!([])).await.unwrap(), "0x1");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_mismatch_body_limit_and_redirect_fail_without_retry() {
        for kind in 0..3 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let _request = request(&mut reader).await;
                match kind {
                    0 => reply(&mut reader, 200, r#"{"jsonrpc":"2.0","id":99,"result":true}"#).await,
                    1 => reader.get_mut().write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_RESPONSE_BYTES + 1).as_bytes()).await.unwrap(),
                    _ => reader.get_mut().write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n").await.unwrap(),
                }
            });
            let mut client =
                RpcClient::connect(&format!("http://{address}/"), Duration::from_secs(2))
                    .await
                    .unwrap();
            let expected = [
                RpcError::Protocol,
                RpcError::ResponseTooLarge,
                RpcError::HttpStatus(302),
            ][kind];
            assert_eq!(
                client
                    .call("eth_sendRawTransaction", json!(["0xsynthetic"]))
                    .await,
                Err(expected)
            );
            assert_eq!(
                client.call("eth_chainId", json!([])).await,
                Err(RpcError::Closed)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_timeout_and_cancellation_poison_client() {
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let _request = request(&mut reader).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
            let mut client =
                RpcClient::connect(&format!("http://{address}/"), Duration::from_millis(50))
                    .await
                    .unwrap();
            if cancel {
                assert!(
                    tokio::time::timeout(
                        Duration::from_millis(20),
                        client.call("eth_sendRawTransaction", json!(["0xsynthetic"]))
                    )
                    .await
                    .is_err()
                );
            } else {
                assert_eq!(
                    client
                        .call("eth_sendRawTransaction", json!(["0xsynthetic"]))
                        .await,
                    Err(RpcError::Timeout)
                );
            }
            assert_eq!(
                client.call("eth_chainId", json!([])).await,
                Err(RpcError::Closed)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn websocket_reuses_connection_correlates_ids_and_answers_ping() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            for id in 1..=2 {
                let message = ws.next().await.unwrap().unwrap();
                let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                assert_eq!(request["id"], id);
                ws.send(Message::Text(
                    json!({"jsonrpc":"2.0","method":"eth_subscription","params":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
                ws.send(Message::Ping(b"server-ping".to_vec().into()))
                    .await
                    .unwrap();
                let pong = ws.next().await.unwrap().unwrap();
                assert_eq!(pong, Message::Pong(b"server-ping".to_vec().into()));
                ws.send(Message::Text(
                    json!({"jsonrpc":"2.0","id":id,"result":"0x2"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            }
        });
        let mut client = RpcClient::connect(&format!("ws://{address}/"), Duration::from_secs(2))
            .await
            .unwrap();
        for _ in 0..2 {
            assert_eq!(client.call("eth_chainId", json!([])).await.unwrap(), "0x2");
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_mismatch_and_notification_flood_poison_client() {
        for flood in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut ws = accept_async(socket).await.unwrap();
                let _request = ws.next().await.unwrap().unwrap();
                if flood {
                    for _ in 0..=MAX_UNSOLICITED_MESSAGES {
                        ws.send(Message::Text(
                            json!({"jsonrpc":"2.0","method":"notification"})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    }
                } else {
                    ws.send(Message::Text(
                        json!({"jsonrpc":"2.0","id":99,"result":true})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                }
            });
            let mut client =
                RpcClient::connect(&format!("ws://{address}/"), Duration::from_secs(2))
                    .await
                    .unwrap();
            assert_eq!(
                client.call("eth_chainId", json!([])).await,
                Err(RpcError::Protocol)
            );
            assert_eq!(
                client.call("eth_chainId", json!([])).await,
                Err(RpcError::Closed)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn websocket_timeout_poisoning_prevents_repeated_send() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let _request = ws.next().await.unwrap().unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let mut client = RpcClient::connect(&format!("ws://{address}/"), Duration::from_millis(40))
            .await
            .unwrap();
        assert_eq!(
            client
                .call("eth_sendRawTransaction", json!(["0xsynthetic"]))
                .await,
            Err(RpcError::Timeout)
        );
        assert_eq!(
            client
                .call("eth_sendRawTransaction", json!(["0xsynthetic"]))
                .await,
            Err(RpcError::Closed)
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_streamed_body_limit_does_not_trust_missing_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let _request = request(&mut reader).await;
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            let payload = vec![b' '; MAX_RESPONSE_BYTES + 1];
            let mut chunk = format!("{:x}\r\n", payload.len()).into_bytes();
            chunk.extend(payload);
            chunk.extend_from_slice(b"\r\n0\r\n\r\n");
            // The receiver may close as soon as its strict limit is crossed.
            if let Err(error) = reader.get_mut().write_all(&chunk).await {
                assert!(matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ));
            }
        });
        let mut client = RpcClient::connect(&format!("http://{address}/"), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            client.call("eth_chainId", json!([])).await,
            Err(RpcError::ResponseTooLarge)
        );
        drop(client);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_size_limit_rejects_oversized_advertised_frame() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let _request = ws.next().await.unwrap().unwrap();
            // Announce the large frame without allocating or sending its body.
            let mut header = vec![0x82, 127];
            header.extend_from_slice(&((MAX_RESPONSE_BYTES + 1) as u64).to_be_bytes());
            ws.get_mut().write_all(&header).await.unwrap();
        });
        let mut client = RpcClient::connect(&format!("ws://{address}/"), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            client.call("eth_chainId", json!([])).await,
            Err(RpcError::ResponseTooLarge)
        );
        assert_eq!(
            client.call("eth_chainId", json!([])).await,
            Err(RpcError::Closed)
        );
        server.await.unwrap();
    }
}
