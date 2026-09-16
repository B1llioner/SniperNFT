use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    time::Duration,
};

use anyhow::{Result, ensure};
use clap::Parser;
use hyper::Uri;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const DEFAULT_ENDPOINT: &str = "https://sequencer.mainnet.chain.robinhood.com";

#[derive(Debug, Parser)]
#[command(
    version,
    about = "Read-only warm HTTP/1.1 sequencer health latency probe"
)]
pub struct Args {
    #[arg(long, default_value = DEFAULT_ENDPOINT)]
    pub endpoint: String,
    /// Pin the TCP destination; preserve the endpoint's Host, TLS SNI and certificate checks.
    #[arg(long)]
    pub connect_ip: Option<Ipv4Addr>,
    #[arg(long)]
    pub label: String,
    #[arg(long)]
    pub output: PathBuf,
    #[arg(long, default_value_t = 1800, value_parser = clap::value_parser!(u64).range(1..=7200))]
    pub duration_seconds: u64,
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u64).range(100..=60000))]
    pub interval_ms: u64,
    #[arg(long, default_value_t = 5000, value_parser = clap::value_parser!(u64).range(100..=20000))]
    pub timeout_ms: u64,
    #[arg(long, alias = "warmup-samples", default_value_t = 5, value_parser = clap::value_parser!(u64).range(0..=20))]
    pub warmup: u64,
    #[arg(long)]
    pub start_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub authority: String,
    pub path: String,
    pub origin: String,
    pub id: String,
}

impl Endpoint {
    pub fn parse(value: &str) -> Result<Self> {
        ensure!(
            value.len() <= 8192 && !value.contains('#'),
            "Invalid endpoint URL"
        );
        let uri: Uri = value
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid endpoint URL"))?;
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow::anyhow!("Endpoint requires a host"))?;
        ensure!(
            !authority.as_str().contains('@'),
            "Endpoint credentials are not allowed"
        );
        let host = uri
            .host()
            .ok_or_else(|| anyhow::anyhow!("Endpoint requires a host"))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let tls = uri.scheme_str() == Some("https");
        ensure!(
            tls || (uri.scheme_str() == Some("http")
                && ["localhost", "127.0.0.1", "::1"].contains(&host)),
            "Use HTTPS; HTTP is permitted only for localhost tests"
        );
        let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
        ensure!(port > 0, "Endpoint port must be positive");
        let path = uri.path_and_query().map_or("/", |part| part.as_str());
        let normalized = format!(
            "{}://{}{}",
            if tls { "https" } else { "http" },
            authority,
            path
        );
        Ok(Self {
            host: host.to_owned(),
            port,
            tls,
            authority: authority.to_string(),
            path: path.to_owned(),
            origin: format!("{}://{}", if tls { "https" } else { "http" }, authority),
            id: format!("{:x}", Sha256::digest(normalized.as_bytes())),
        })
    }
}

impl Args {
    pub fn validate(&self) -> Result<(Endpoint, Option<OffsetDateTime>)> {
        ensure!(
            !self.label.is_empty()
                && self.label.len() <= 64
                && self.label.as_bytes()[0].is_ascii_alphanumeric()
                && self
                    .label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)),
            "Label must contain 1-64 letters, digits, dots, underscores or hyphens"
        );
        let endpoint = Endpoint::parse(&self.endpoint)?;
        ensure!(
            endpoint.tls || self.connect_ip.is_none_or(|address| address.is_loopback()),
            "HTTP test endpoints require a loopback --connect-ip; use HTTPS for remote hosts"
        );
        if let (Some(pin), Ok(host)) = (self.connect_ip, endpoint.host.parse::<IpAddr>()) {
            ensure!(
                host == IpAddr::V4(pin),
                "--connect-ip must match an IP-literal endpoint; use a hostname endpoint to pin routing"
            );
        }
        let start = self
            .start_at
            .as_ref()
            .map(|value| -> Result<OffsetDateTime> {
                ensure!(
                    value.ends_with('Z'),
                    "--start-at must be an ISO UTC timestamp ending in Z"
                );
                let start = OffsetDateTime::parse(value, &Rfc3339)?;
                let now = OffsetDateTime::now_utc();
                ensure!(
                    start > now && start <= now + Duration::from_secs(86400),
                    "--start-at must be in the next 24 hours"
                );
                Ok(start)
            })
            .transpose()?;
        Ok((endpoint, start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_endpoints() {
        for value in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/#fragment",
            "file:///tmp/a",
        ] {
            assert!(Endpoint::parse(value).is_err());
        }
        assert!(Endpoint::parse(DEFAULT_ENDPOINT).is_ok());
        assert!(Endpoint::parse("http://127.0.0.1:1234").is_ok());
    }

    #[test]
    fn validates_arguments_without_network() {
        assert!(
            Args::try_parse_from([
                "probe",
                "--label",
                "ok",
                "--output",
                "a.json",
                "--interval-ms",
                "1"
            ])
            .is_err()
        );
        let args = Args::try_parse_from(["probe", "--label", "bad label", "--output", "a.json"]);
        assert!(args.is_ok_and(|args| args.validate().is_err()));
    }

    #[test]
    fn connect_ip_accepts_only_ipv4_addresses() -> Result<()> {
        let args = Args::try_parse_from([
            "probe",
            "--label",
            "test",
            "--output",
            "a.json",
            "--connect-ip",
            "192.0.2.1",
        ])?;
        assert_eq!(args.connect_ip, Some(Ipv4Addr::new(192, 0, 2, 1)));
        for value in ["::1", "example.com", "300.0.0.1"] {
            assert!(
                Args::try_parse_from([
                    "probe",
                    "--label",
                    "test",
                    "--output",
                    "a.json",
                    "--connect-ip",
                    value,
                ])
                .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn pinning_cannot_route_local_http_to_remote_hosts() -> Result<()> {
        for (address, allowed) in [("127.0.0.1", true), ("192.0.2.1", false)] {
            let args = Args::try_parse_from([
                "probe",
                "--label",
                "test",
                "--output",
                "a.json",
                "--endpoint",
                "http://localhost:8080",
                "--connect-ip",
                address,
            ])?;
            assert_eq!(args.validate().is_ok(), allowed);
        }
        Ok(())
    }

    #[test]
    fn pinned_literal_endpoints_must_match_ipv4_address() -> Result<()> {
        for (endpoint, pin, allowed) in [
            ("https://192.0.2.1", "192.0.2.1", true),
            ("https://192.0.2.1", "192.0.2.2", false),
            ("http://127.0.0.1:8080", "127.0.0.1", true),
            ("http://127.0.0.1:8080", "127.0.0.2", false),
            ("https://[::1]", "127.0.0.1", false),
            ("https://[::ffff:127.0.0.1]", "127.0.0.1", false),
            ("https://example.com", "192.0.2.1", true),
        ] {
            let args = Args::try_parse_from([
                "probe",
                "--label",
                "test",
                "--output",
                "a.json",
                "--endpoint",
                endpoint,
                "--connect-ip",
                pin,
            ])?;
            assert_eq!(
                args.validate().is_ok(),
                allowed,
                "{endpoint} pinned to {pin}"
            );
        }
        Ok(())
    }
}
