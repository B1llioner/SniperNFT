use std::{net::Ipv4Addr, path::PathBuf, time::Duration};

use anyhow::{Result, ensure};
use clap::{Parser, ValueEnum};
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_tungstenite::tungstenite::http::Uri;

pub const DEFAULT_ENDPOINT: &str = "wss://feed.mainnet.chain.robinhood.com";
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Tungstenite,
    Raw,
}

#[derive(Debug, Parser)]
#[command(
    version,
    about = "Read-only persistent Rust WebSocket feed ping/pong benchmark"
)]
pub struct Args {
    #[arg(long, default_value = DEFAULT_ENDPOINT)]
    pub endpoint: String,
    #[arg(long, value_enum, default_value_t = EngineKind::Tungstenite)]
    pub engine: EngineKind,
    #[arg(long)]
    pub connect_ip: Option<Ipv4Addr>,
    #[arg(long)]
    pub label: String,
    #[arg(long)]
    pub output: PathBuf,
    #[arg(long, default_value_t = 600, value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub duration_seconds: u64,
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u64).range(100..=60000))]
    pub interval_ms: u64,
    #[arg(long, default_value_t = 5000, value_parser = clap::value_parser!(u64).range(50..=60000))]
    pub timeout_ms: u64,
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u64).range(0..=1000))]
    pub warmup: u64,
    #[arg(long)]
    pub start_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub url: String,
    pub host: String,
    pub authority: String,
    pub path: String,
    pub port: u16,
    pub tls: bool,
}

impl Endpoint {
    pub fn parse(value: &str) -> Result<Self> {
        ensure!(
            value.len() <= 2048 && !value.contains(['#', '?']),
            "Endpoint must not contain a query or fragment"
        );
        let uri: Uri = value
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid WebSocket endpoint"))?;
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow::anyhow!("Endpoint requires a host"))?;
        ensure!(
            !authority.as_str().contains('@'),
            "Endpoint credentials are forbidden"
        );
        let host = uri
            .host()
            .ok_or_else(|| anyhow::anyhow!("Endpoint requires a host"))?;
        let host = host.trim_matches(['[', ']']);
        let tls = uri.scheme_str() == Some("wss");
        ensure!(
            tls || (uri.scheme_str() == Some("ws") && ["localhost", "127.0.0.1"].contains(&host)),
            "WSS required; plain WS is allowed only on IPv4 loopback"
        );
        let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
        ensure!(port != 0, "Endpoint port must be positive");
        let path = if uri.path().is_empty() {
            "/"
        } else {
            uri.path()
        };
        Ok(Self {
            url: format!("{}://{}{}", if tls { "wss" } else { "ws" }, authority, path),
            host: host.to_owned(),
            authority: authority.to_string(),
            path: path.to_owned(),
            port,
            tls,
        })
    }
}

impl Args {
    pub fn validate(&self) -> Result<(Endpoint, Option<OffsetDateTime>)> {
        ensure!(
            !self.label.is_empty()
                && self.label.len() <= 128
                && self
                    .label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b)),
            "Invalid label"
        );
        let endpoint = Endpoint::parse(&self.endpoint)?;
        if let (Ok(literal), Some(pin)) = (endpoint.host.parse::<Ipv4Addr>(), self.connect_ip) {
            ensure!(
                literal == pin,
                "A literal endpoint IP must match --connect-ip"
            );
        }
        if !endpoint.tls {
            ensure!(
                self.connect_ip.is_none_or(|ip| ip.is_loopback()),
                "Plain WS cannot be pinned outside loopback"
            );
        }
        let start = self
            .start_at
            .as_ref()
            .map(|value| -> Result<_> {
                ensure!(value.ends_with('Z'), "--start-at must end in Z");
                let value = OffsetDateTime::parse(value, &Rfc3339)?;
                let now = OffsetDateTime::now_utc();
                ensure!(
                    value > now && value <= now + Duration::from_secs(86400),
                    "--start-at must be within the next 24 hours"
                );
                Ok(value)
            })
            .transpose()?;
        Ok((endpoint, start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credentials_plain_remote_and_queries() {
        for value in [
            "ws://example.com",
            "wss://u:p@example.com",
            "wss://example.com/?token=x",
            "wss://example.com/#x",
            "file:///tmp/a",
        ] {
            assert!(Endpoint::parse(value).is_err());
        }
        assert!(Endpoint::parse(DEFAULT_ENDPOINT).is_ok());
        assert!(Endpoint::parse("ws://127.0.0.1:1234").is_ok());
    }

    #[test]
    fn rejects_invalid_args_without_network() {
        assert!(
            Args::try_parse_from([
                "probe",
                "--label",
                "a",
                "--output",
                "x",
                "--interval-ms",
                "0"
            ])
            .is_err()
        );
        assert!(
            Args::try_parse_from([
                "probe",
                "--label",
                "a",
                "--output",
                "x",
                "--connect-ip",
                "::1"
            ])
            .is_err()
        );
        let args = Args::try_parse_from([
            "probe",
            "--label",
            "a",
            "--output",
            "x",
            "--endpoint",
            "ws://127.0.0.1:1234",
            "--connect-ip",
            "1.1.1.1",
        ])
        .expect("args");
        assert!(args.validate().is_err());
        let args = Args::try_parse_from([
            "probe",
            "--label",
            "a",
            "--output",
            "x",
            "--endpoint",
            "wss://192.0.2.1/",
            "--connect-ip",
            "192.0.2.2",
        ])
        .expect("args");
        assert!(args.validate().is_err());
    }
}
