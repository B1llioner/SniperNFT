use std::{net::IpAddr, path::PathBuf};

use alloy_primitives::Address;
use anyhow::{Result, bail, ensure};
use clap::{Parser, ValueEnum};

pub const CHAIN_ID: u64 = 4663;
pub const ROUNDS: u64 = 10;
pub const OFFICIAL_SEQUENCER: &str = "https://sequencer.mainnet.chain.robinhood.com";

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
pub enum Mode {
    Https,
    Wss,
    Both,
}

impl Mode {
    pub fn routes(self) -> &'static [Self] {
        match self {
            Self::Https => &[Self::Https],
            Self::Wss => &[Self::Wss],
            Self::Both => &[Self::Https, Self::Wss],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Https => "https-sequencer",
            Self::Wss => "wss-rpc-provider",
            Self::Both => "both",
        }
    }
}

#[derive(Parser)]
#[command(
    about = "Deploy an isolated NFT benchmark and attempt ten consecutive one-second mint windows"
)]
pub struct Args {
    /// Expected signer and NFT recipient; the entered key must match.
    #[arg(long)]
    pub wallet: Address,
    #[arg(long, value_enum, default_value = "https")]
    pub transport: Mode,
    /// Without --send, perform read-only preflight; never ask for a key.
    #[arg(long)]
    pub send: bool,
    #[arg(long, default_value = "https://rpc.mainnet.chain.robinhood.com")]
    pub read_rpc: String,
    #[arg(long, default_value = OFFICIAL_SEQUENCER)]
    pub https_url: String,
    #[arg(long, default_value = "wss://robinhood-rpc.publicnode.com")]
    pub wss_url: String,
    /// A new report directory; never overwrite or resume uncertain sends.
    #[arg(long)]
    pub output: PathBuf,
    /// Shared across invocations on this server, for the wallet lock.
    #[arg(long, default_value = ".state/real-tx-locks")]
    pub lock_dir: PathBuf,
    #[arg(long, default_value = "0.019")]
    pub max_total_cost_eth: String,
    #[arg(long, default_value = "0.001")]
    pub reserve_eth: String,
    #[arg(long, default_value_t = 10)]
    pub quantity: u64,
    #[arg(long, default_value_t = 30)]
    pub start_delay_seconds: u64,
    #[arg(long, default_value_t = 0)]
    pub send_offset_ms: u64,
    #[arg(long, default_value_t = 4)]
    pub fee_multiplier: u128,
    #[arg(long, default_value_t = 3_000_000)]
    pub batch_gas_limit: u64,
    #[arg(long, default_value_t = 30)]
    pub receipt_timeout_seconds: u64,
    /// Only for isolated loopback integration tests with synthetic keys.
    #[arg(long, hide = true)]
    pub test_key_stdin: bool,
}

pub fn ether(value: &str) -> Result<u128> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    ensure!(
        !whole.is_empty() && whole.len() <= 18 && whole.bytes().all(|v| v.is_ascii_digit()),
        "Invalid ETH amount"
    );
    ensure!(
        fraction.len() <= 18 && fraction.bytes().all(|v| v.is_ascii_digit()),
        "Invalid ETH decimals"
    );
    ensure!(!value.ends_with('.'), "Invalid ETH amount");
    let whole: u128 = whole.parse()?;
    let fractional: u128 = if fraction.is_empty() {
        0
    } else {
        fraction.parse()?
    };
    whole
        .checked_mul(10_u128.pow(18))
        .and_then(|v| {
            fractional
                .checked_mul(10_u128.pow(18 - fraction.len() as u32))
                .and_then(|f| v.checked_add(f))
        })
        .ok_or_else(|| anyhow::anyhow!("ETH amount overflow"))
}

impl Args {
    pub fn validate(&self) -> Result<()> {
        for (input, secure, local) in [
            (&self.read_rpc, "https", "http"),
            (&self.https_url, "https", "http"),
            (&self.wss_url, "wss", "ws"),
        ] {
            let parsed =
                url::Url::parse(input).map_err(|_| anyhow::anyhow!("Invalid endpoint URL"))?;
            ensure!(
                parsed.scheme() == secure || (parsed.scheme() == local && loopback(&parsed)),
                "Endpoint scheme does not match its transport"
            );
        }
        ensure!(self.wallet != Address::ZERO, "Wallet must not be zero");
        ensure!((1..=10).contains(&self.quantity), "Quantity must be 1..10");
        ensure!(
            (15..=120).contains(&self.start_delay_seconds),
            "Start delay must be 15..120 seconds"
        );
        ensure!(self.send_offset_ms <= 900, "Send offset must be 0..900 ms");
        ensure!(
            (1..=10).contains(&self.fee_multiplier),
            "Fee multiplier must be 1..10"
        );
        ensure!(
            (1_000_000..=10_000_000).contains(&self.batch_gas_limit),
            "Batch gas limit must be 1000000..10000000"
        );
        ensure!(
            (5..=120).contains(&self.receipt_timeout_seconds),
            "Receipt timeout must be 5..120 seconds"
        );
        let budget = ether(&self.max_total_cost_eth)?;
        let reserve = ether(&self.reserve_eth)?;
        ensure!(
            budget > 0 && budget <= ether("0.019")?,
            "This benchmark permits at most 0.019 ETH total"
        );
        ensure!(
            reserve >= ether("0.001")?,
            "Keep at least 0.001 ETH reserve"
        );
        if self.test_key_stdin && !self.local() {
            bail!("Piped test keys require exclusively loopback endpoints");
        }
        Ok(())
    }

    pub fn local(&self) -> bool {
        [&self.read_rpc, &self.https_url, &self.wss_url]
            .iter()
            .all(|s| {
                url::Url::parse(s).is_ok_and(|url| {
                    loopback(&url)
                        && matches!(url.scheme(), "http" | "ws")
                        && url.username().is_empty()
                        && url.password().is_none()
                })
            })
    }

    pub fn sender_host(&self, mode: Mode) -> Result<String> {
        let input = if mode == Mode::Https {
            &self.https_url
        } else {
            &self.wss_url
        };
        let url = url::Url::parse(input).map_err(|_| anyhow::anyhow!("Invalid sender URL"))?;
        Ok(url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Missing sender hostname"))?
            .to_owned())
    }
}

fn loopback(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decimal_budgets_do_not_use_floats() -> Result<()> {
        assert_eq!(ether("0.019")?, 19_000_000_000_000_000);
        assert_eq!(ether("0.000000000000000001")?, 1);
        for value in ["-1", "1e-3", "NaN", "1.", ".1", "0.0000000000000000001"] {
            assert!(ether(value).is_err());
        }
        Ok(())
    }

    #[test]
    fn transport_roles_and_synthetic_key_scope_are_enforced() -> Result<()> {
        let mut args = Args::try_parse_from([
            "test",
            "--wallet",
            "0x1111111111111111111111111111111111111111",
            "--output",
            "unused",
        ])?;
        args.validate()?;
        args.https_url = "wss://robinhood-rpc.publicnode.com".into();
        assert!(args.validate().is_err());
        args.https_url = "http://127.0.0.1:1234".into();
        args.read_rpc = "http://127.0.0.1:1234".into();
        args.wss_url = "ws://127.0.0.1:1234".into();
        args.test_key_stdin = true;
        args.validate()?;
        args.wss_url = "ws://127.0.0.1:1234@evil.example".into();
        assert!(!args.local());
        assert!(args.validate().is_err());
        Ok(())
    }
}
