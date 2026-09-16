use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, lookup_host},
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};

use crate::{ProbeError, config::Endpoint};

pub trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncIo for T {}
pub type Stream = Box<dyn AsyncIo>;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub opened: bool,
    pub attempts: u64,
    pub reconnects: u64,
    pub disconnects: u64,
    pub remote_address: Option<String>,
    pub remote_family: &'static str,
    pub tls_protocol: Option<String>,
    pub http_status: Option<u16>,
    pub opened_at: Option<String>,
    pub open_latency_ms: Option<f64>,
    pub tcp_no_delay: bool,
}

pub async fn connect(
    endpoint: &Endpoint,
    connect_ip: Option<Ipv4Addr>,
    meta: &mut Connection,
) -> Result<Stream, ProbeError> {
    let address = match connect_ip {
        Some(ip) => SocketAddr::new(ip.into(), endpoint.port),
        None => lookup_host((endpoint.host.as_str(), endpoint.port))
            .await
            .map_err(|_| ProbeError::Dns)?
            .find(SocketAddr::is_ipv4)
            .ok_or(ProbeError::Dns)?,
    };
    meta.attempts = 1;
    // Exactly one socket attempt. No address fallback or reconnection changes the measured path.
    let tcp = TcpStream::connect(address)
        .await
        .map_err(|_| ProbeError::Connect)?;
    tcp.set_nodelay(true).map_err(|_| ProbeError::Connect)?;
    meta.remote_address = Some(
        tcp.peer_addr()
            .map_err(|_| ProbeError::Connect)?
            .ip()
            .to_string(),
    );
    meta.remote_family = "IPv4";
    meta.tcp_no_delay = true;
    if !endpoint.tls {
        return Ok(Box::new(tcp));
    }
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // TLS config is shared with this single connector, never rebuilt per ping.
    let connector = TlsConnector::from(Arc::new(config));
    let name = ServerName::try_from(endpoint.host.clone()).map_err(|_| ProbeError::Tls)?;
    let tls = connector
        .connect(name, tcp)
        .await
        .map_err(|_| ProbeError::Tls)?;
    meta.tls_protocol = tls
        .get_ref()
        .1
        .protocol_version()
        .map(|version| format!("{version:?}"));
    Ok(Box::new(tls))
}
