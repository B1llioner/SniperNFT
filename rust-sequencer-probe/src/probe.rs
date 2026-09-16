use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, client::conn::http1, header};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, lookup_host},
    task::JoinHandle,
    time::Instant,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};

use crate::config::Endpoint;

const BODY_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, thiserror::Error)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProbeError {
    #[error("DNS_ERROR")]
    DnsError,
    #[error("CONNECT_ERROR")]
    ConnectError,
    #[error("TLS_ERROR")]
    TlsError,
    #[error("NETWORK_ERROR")]
    NetworkError,
    #[error("TIMEOUT")]
    Timeout,
    #[error("HTTP_STATUS")]
    HttpStatus,
    #[error("HTTP_REDIRECT")]
    HttpRedirect,
    #[error("INVALID_RESPONSE")]
    InvalidResponse,
    #[error("RPC_ERROR")]
    RpcError,
    #[error("RPC_METHOD_NOT_FOUND")]
    RpcMethodNotFound,
    #[error("RESPONSE_TOO_LARGE")]
    ResponseTooLarge,
    #[error("UNSUPPORTED_ENCODING")]
    UnsupportedEncoding,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: u64,
    pub total_ms: f64,
    pub ok: bool,
    pub reused_socket: bool,
    pub connection_id: Option<u64>,
    pub remote_address: Option<String>,
    pub http_status: Option<u16>,
    pub error_code: Option<ProbeError>,
}

/// Lifetime counters include warmup and interrupted requests, unlike measured samples.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStats {
    pub dns_lookups: u64,
    pub tcp_connect_attempts: u64,
    pub tcp_connections_opened: u64,
    pub tls_handshakes_completed: u64,
    pub http_connections_opened: u64,
    pub requests_attempted: u64,
    pub requests_on_reused_connection: u64,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

struct Connection {
    sender: http1::SendRequest<Full<Bytes>>,
    driver: JoinHandle<Result<(), hyper::Error>>,
    id: u64,
    remote: String,
    used: bool,
}

impl Drop for Connection {
    fn drop(&mut self) {
        // The owned driver has no work after the sender/connection is discarded.
        self.driver.abort();
    }
}

pub struct Probe {
    endpoint: Endpoint,
    connect_ip: Option<Ipv4Addr>,
    timeout: Duration,
    tls: TlsConnector,
    connection: Option<Connection>,
    next_connection: u64,
    stats: ConnectionStats,
}

impl Probe {
    pub fn new(endpoint: Endpoint, timeout: Duration) -> Self {
        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Self {
            endpoint,
            connect_ip: None,
            timeout,
            tls: TlsConnector::from(Arc::new(config)),
            connection: None,
            next_connection: 0,
            stats: ConnectionStats::default(),
        }
    }

    /// Set once before requests; the TLS/HTTP identity always comes from the endpoint URL.
    pub fn with_connect_ip(mut self, connect_ip: Option<Ipv4Addr>) -> Self {
        self.connect_ip = connect_ip;
        self
    }

    pub fn connection_stats(&self) -> ConnectionStats {
        self.stats
    }

    pub async fn sample(&mut self, id: u64) -> Sample {
        self.stats.requests_attempted += 1;
        let started = Instant::now();
        let mut sample = Sample {
            id,
            total_ms: 0.0,
            ok: false,
            reused_socket: false,
            connection_id: None,
            remote_address: None,
            http_status: None,
            error_code: None,
        };
        let result = tokio::time::timeout(self.timeout, self.request(id, &mut sample)).await;
        let result = match result {
            Ok(result) => result,
            Err(_) => Err(ProbeError::Timeout),
        };
        sample.total_ms = started.elapsed().as_secs_f64() * 1000.0;
        sample.ok = result.is_ok();
        if let Err(error) = result {
            sample.error_code = Some(error);
            // Never reuse a timed-out or partially consumed response connection.
            self.connection = None;
        }
        sample
    }

    async fn connect(&mut self) -> Result<Connection, ProbeError> {
        let stream = if let Some(address) = self.connect_ip {
            self.stats.tcp_connect_attempts += 1;
            TcpStream::connect((address, self.endpoint.port))
                .await
                .map_err(|_| ProbeError::ConnectError)?
        } else {
            self.stats.dns_lookups += 1;
            let addresses = lookup_host((self.endpoint.host.as_str(), self.endpoint.port))
                .await
                .map_err(|_| ProbeError::DnsError)?;
            let mut connected = None;
            // Match the JavaScript CLI's family=4; all attempts share one request timeout.
            for address in addresses.filter(|address| address.is_ipv4()) {
                self.stats.tcp_connect_attempts += 1;
                if let Ok(stream) = TcpStream::connect(address).await {
                    connected = Some(stream);
                    break;
                }
            }
            connected.ok_or(ProbeError::ConnectError)?
        };
        self.stats.tcp_connections_opened += 1;
        stream
            .set_nodelay(true)
            .map_err(|_| ProbeError::ConnectError)?;
        let remote = stream
            .peer_addr()
            .map_err(|_| ProbeError::ConnectError)?
            .ip()
            .to_string();
        let stream: Box<dyn Stream> = if self.endpoint.tls {
            let name = ServerName::try_from(self.endpoint.host.clone())
                .map_err(|_| ProbeError::TlsError)?;
            let stream = self
                .tls
                .connect(name, stream)
                .await
                .map_err(|_| ProbeError::TlsError)?;
            self.stats.tls_handshakes_completed += 1;
            Box::new(stream)
        } else {
            Box::new(stream)
        };
        let (sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|_| ProbeError::NetworkError)?;
        let driver = tokio::spawn(connection);
        self.next_connection += 1;
        self.stats.http_connections_opened += 1;
        Ok(Connection {
            sender,
            driver,
            id: self.next_connection,
            remote,
            used: false,
        })
    }

    async fn request(&mut self, id: u64, sample: &mut Sample) -> Result<(), ProbeError> {
        if self.connection.as_ref().is_some_and(|connection| {
            connection.sender.is_closed() || connection.driver.is_finished()
        }) {
            self.connection = None;
        }
        if self.connection.is_none() {
            self.connection = Some(self.connect().await?);
        }
        let connection = self.connection.as_mut().ok_or(ProbeError::NetworkError)?;
        sample.reused_socket = connection.used;
        sample.connection_id = Some(connection.id);
        sample.remote_address = Some(connection.remote.clone());
        if connection.used {
            self.stats.requests_on_reused_connection += 1;
        }
        connection.used = true;
        let request_id = format!("az-probe-{id}");
        let payload = serde_json::json!({"jsonrpc":"2.0", "id":request_id, "method":"arb_checkPublisherHealth", "params":[]}).to_string();
        let request = Request::post(&self.endpoint.path)
            .header(header::HOST, &self.endpoint.authority)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json")
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::CONNECTION, "keep-alive")
            .header(header::USER_AGENT, "rare-friends-rust-probe/0.1")
            .header(header::CONTENT_LENGTH, payload.len())
            .body(Full::new(Bytes::from(payload)))
            .map_err(|_| ProbeError::InvalidResponse)?;
        connection
            .sender
            .ready()
            .await
            .map_err(|_| ProbeError::NetworkError)?;
        let response = connection
            .sender
            .send_request(request)
            .await
            .map_err(|_| ProbeError::NetworkError)?;
        sample.http_status = Some(response.status().as_u16());
        if response.status().is_redirection() {
            return Err(ProbeError::HttpRedirect);
        }
        if !response.status().is_success() {
            return Err(ProbeError::HttpStatus);
        }
        if response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > BODY_LIMIT as u64)
        {
            return Err(ProbeError::ResponseTooLarge);
        }
        if response
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_some_and(|encoding| encoding != "identity")
        {
            return Err(ProbeError::UnsupportedEncoding);
        }
        let mut body = response.into_body();
        let mut bytes = Vec::with_capacity(256);
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| ProbeError::NetworkError)?;
            if let Some(chunk) = frame.data_ref() {
                if bytes.len() + chunk.len() > BODY_LIMIT {
                    return Err(ProbeError::ResponseTooLarge);
                }
                bytes.extend_from_slice(chunk);
            }
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| ProbeError::InvalidResponse)?;
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || value.get("id").and_then(Value::as_str) != Some(request_id.as_str())
        {
            return Err(ProbeError::InvalidResponse);
        }
        if let Some(error) = value.get("error") {
            return Err(
                if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                    ProbeError::RpcMethodNotFound
                } else {
                    ProbeError::RpcError
                },
            );
        }
        if value.get("result") != Some(&Value::Null) {
            return Err(ProbeError::InvalidResponse);
        }
        Ok(())
    }
}
