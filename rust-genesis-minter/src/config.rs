//! Sanitized config only; credentials are never config fields or CLI arguments.
use alloy_primitives::{Address, B256, address, b256};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use url::Url;

pub const CHAIN_ID: u64 = 4663;
pub const GENESIS: Address = address!("116eaa62241751e0c98da43d458600c6c17cd361");
pub const GENESIS_HASH: B256 =
    b256!("7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c");
pub const SEADROP: Address = address!("00005ea00ac477b1030ce78506496e8c2de24bf5");
pub const SEA_HASH: B256 =
    b256!("53e4b9339cf624803c9a7d0195576cca5b917920813508d86b3eb93dcbabeb5c");
pub const FEE_RECIPIENT: Address = address!("0000a26b00c1f0df003000390027140000faa719");
pub const SEQUENCER: &str = "https://sequencer.mainnet.chain.robinhood.com";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Auto,
    Public,
    Signed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Route {
    pub sea_drop: Address,
    pub code_hash: B256,
    pub fee_recipient: Address,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    pub wallet: Address,
    #[serde(default)]
    pub recipient: Option<Address>,
    #[serde(default = "ten")]
    pub quantity: u16,
    #[serde(default = "one")]
    pub min_quantity: u16,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default = "genesis")]
    pub nft: Address,
    #[serde(default = "genesis_hash")]
    pub nft_code_hash: B256,
    #[serde(default = "routes")]
    pub routes: Vec<Route>,
    #[serde(default = "slug")]
    pub collection_slug: String,
    #[serde(default = "reader")]
    pub read_rpc: String,
    /// Optional read-only log subscription. Notifications only trigger fresh RPC reads.
    #[serde(default)]
    pub watch_rpc: Option<String>,
    #[serde(default = "senders")]
    pub send_rpc_urls: Vec<String>,
    #[serde(default = "two")]
    pub concurrency: usize,
    #[serde(default = "timeout")]
    pub request_timeout_ms: u64,
    #[serde(default = "poll")]
    pub poll_interval_ms: u64,
    #[serde(default = "refresh")]
    pub payload_refresh_ms: u64,
    #[serde(default = "max_age")]
    pub max_payload_age_ms: u64,
    #[serde(default = "preflight_age")]
    pub max_preflight_age_ms: u64,
    #[serde(default = "signature_remaining")]
    pub min_signature_remaining_secs: u64,
    #[serde(default = "wait_timeout")]
    pub wait_timeout_secs: u64,
    #[serde(default)]
    pub wait_until_timestamp: Option<u64>,
    #[serde(default)]
    pub wait_until_block: Option<u64>,
    #[serde(default = "gas_child")]
    pub gas_per_child: u64,
    #[serde(default = "gas_cap")]
    pub max_gas_cost_eth: String,
    #[serde(default = "total_cap")]
    pub max_total_gas_cost_eth: String,
    #[serde(default = "reserve")]
    pub reserve_eth: String,
    #[serde(default = "fee_cap")]
    pub max_fee_per_gas_gwei: String,
    #[serde(default = "priority")]
    pub max_priority_fee_per_gas_gwei: String,
    #[serde(default = "fee_multiplier")]
    pub max_fee_multiplier: u32,
    #[serde(default = "receipt_timeout")]
    pub receipt_timeout_secs: u64,
}
fn ten() -> u16 {
    10
}
fn one() -> u16 {
    1
}
fn two() -> usize {
    2
}
fn genesis() -> Address {
    GENESIS
}
fn genesis_hash() -> B256 {
    GENESIS_HASH
}
fn routes() -> Vec<Route> {
    vec![Route {
        sea_drop: SEADROP,
        code_hash: SEA_HASH,
        fee_recipient: FEE_RECIPIENT,
    }]
}
fn slug() -> String {
    "rare-friends-genesis".into()
}
fn reader() -> String {
    "https://robinhood-rpc.publicnode.com".into()
}
fn senders() -> Vec<String> {
    vec![SEQUENCER.into()]
}
fn timeout() -> u64 {
    10_000
}
fn poll() -> u64 {
    1_000
}
fn refresh() -> u64 {
    5_000
}
fn max_age() -> u64 {
    15_000
}
fn preflight_age() -> u64 {
    2_000
}
fn signature_remaining() -> u64 {
    5
}
fn wait_timeout() -> u64 {
    86_400
}
fn gas_child() -> u64 {
    1_000_000
}
fn gas_cap() -> String {
    "0.005".into()
}
fn total_cap() -> String {
    "0.019".into()
}
fn reserve() -> String {
    "0.001".into()
}
fn fee_cap() -> String {
    "10".into()
}
fn priority() -> String {
    "0".into()
}
fn fee_multiplier() -> u32 {
    4
}
fn receipt_timeout() -> u64 {
    120
}

pub fn decimal_units(text: &str, decimals: usize) -> Result<u128> {
    ensure!(
        !text.is_empty() && text.len() <= 80,
        "INVALID_DECIMAL_AMOUNT"
    );
    let mut split = text.split('.');
    let whole = split
        .next()
        .ok_or_else(|| anyhow::anyhow!("INVALID_DECIMAL_AMOUNT"))?;
    let fraction = split.next().unwrap_or("");
    ensure!(
        split.next().is_none()
            && !whole.is_empty()
            && whole.bytes().all(|b| b.is_ascii_digit())
            && fraction.bytes().all(|b| b.is_ascii_digit())
            && fraction.len() <= decimals,
        "INVALID_DECIMAL_AMOUNT"
    );
    let scale = 10u128
        .checked_pow(decimals.try_into()?)
        .ok_or_else(|| anyhow::anyhow!("AMOUNT_OVERFLOW"))?;
    let a = whole
        .parse::<u128>()
        .map_err(|_| anyhow::anyhow!("AMOUNT_OVERFLOW"))?;
    let b = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<u128>()
            .map_err(|_| anyhow::anyhow!("AMOUNT_OVERFLOW"))?
    };
    a.checked_mul(scale)
        .and_then(|v| {
            v.checked_add(
                b.checked_mul(10u128.checked_pow((decimals - fraction.len()).try_into().ok()?)?)?,
            )
        })
        .ok_or_else(|| anyhow::anyhow!("AMOUNT_OVERFLOW"))
}

pub fn loopback_url(text: &str) -> bool {
    Url::parse(text).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && url.host_str().is_some_and(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            })
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}
impl Config {
    pub fn load(path: &Path, local: bool) -> Result<Self> {
        let meta = std::fs::metadata(path).map_err(|_| anyhow::anyhow!("CONFIG_READ_FAILED"))?;
        ensure!(
            meta.is_file() && meta.len() <= 65_536,
            "INVALID_CONFIG_FILE"
        );
        let body = std::fs::read(path).map_err(|_| anyhow::anyhow!("CONFIG_READ_FAILED"))?;
        let cfg: Self =
            serde_json::from_slice(&body).map_err(|_| anyhow::anyhow!("INVALID_CONFIG_JSON"))?;
        cfg.validate(local)?;
        Ok(cfg)
    }
    pub fn recipient(&self) -> Address {
        self.recipient.unwrap_or(self.wallet)
    }
    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.request_timeout_ms)
    }
    pub fn validate(&self, local: bool) -> Result<()> {
        ensure!(
            self.wallet != Address::ZERO && self.recipient() != Address::ZERO,
            "ZERO_WALLET_OR_RECIPIENT"
        );
        ensure!(
            (1..=100).contains(&self.quantity) && (1..=self.quantity).contains(&self.min_quantity),
            "INVALID_QUANTITY"
        );
        ensure!(
            self.quantity != 1 || self.recipient() == self.wallet,
            "DIRECT_MINT_REQUIRES_WALLET_RECIPIENT"
        );
        ensure!(
            self.nft != Address::ZERO && self.nft_code_hash != B256::ZERO,
            "INVALID_NFT_IDENTITY"
        );
        ensure!(
            local || (self.nft == GENESIS && self.nft_code_hash == GENESIS_HASH),
            "UNRESEARCHED_COLLECTION_REQUIRES_LOCAL_TEST"
        );
        ensure!(
            !self.routes.is_empty() && self.routes.len() <= 4,
            "INVALID_APPROVED_ROUTES"
        );
        let mut seen = std::collections::BTreeSet::new();
        for r in &self.routes {
            ensure!(
                r.sea_drop != Address::ZERO
                    && r.fee_recipient != Address::ZERO
                    && r.code_hash != B256::ZERO
                    && seen.insert(r.sea_drop),
                "INVALID_APPROVED_ROUTE"
            );
        }
        ensure!(
            !self.collection_slug.is_empty()
                && self.collection_slug.len() <= 128
                && self
                    .collection_slug
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "INVALID_COLLECTION_SLUG"
        );
        ensure!(
            !self.send_rpc_urls.is_empty()
                && self.send_rpc_urls.len() <= 8
                && (1..=8).contains(&self.concurrency),
            "INVALID_RPC_CONCURRENCY"
        );
        for endpoint in std::iter::once(&self.read_rpc)
            .chain(self.send_rpc_urls.iter())
            .chain(self.watch_rpc.iter())
        {
            let url = Url::parse(endpoint).map_err(|_| anyhow::anyhow!("INVALID_RPC_URL"))?;
            ensure!(
                url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none()
                    && endpoint.len() <= 4096,
                "INVALID_RPC_URL"
            );
            ensure!(
                !url.host_str().unwrap_or("").starts_with("feed."),
                "FEED_CANNOT_SUBMIT_TRANSACTIONS"
            );
            ensure!(
                if local {
                    loopback_url(endpoint)
                } else {
                    matches!(url.scheme(), "https" | "wss")
                },
                "INVALID_RPC_TRANSPORT"
            );
        }
        if let Some(endpoint) = &self.watch_rpc {
            crate::watch::validate_endpoint(endpoint)?;
            let url = Url::parse(endpoint).map_err(|_| anyhow::anyhow!("INVALID_WATCH_RPC_URL"))?;
            ensure!(
                url.scheme() == "wss" || (local && url.scheme() == "ws"),
                "WATCH_RPC_REQUIRES_WEBSOCKET"
            );
        }
        ensure!(
            (1_000..=20_000).contains(&self.request_timeout_ms)
                && (250..=5_000).contains(&self.poll_interval_ms),
            "INVALID_POLL_TIMEOUT"
        );
        ensure!(
            (1_000..=60_000).contains(&self.payload_refresh_ms)
                && self.max_payload_age_ms >= self.payload_refresh_ms
                && self.max_payload_age_ms <= 120_000,
            "INVALID_PAYLOAD_FRESHNESS"
        );
        ensure!(
            (250..=10_000).contains(&self.max_preflight_age_ms)
                && (1..=120).contains(&self.min_signature_remaining_secs),
            "INVALID_FINAL_FRESHNESS"
        );
        ensure!(
            (1..=172_800).contains(&self.wait_timeout_secs)
                && (1..=600).contains(&self.receipt_timeout_secs),
            "INVALID_WAIT_TIMEOUT"
        );
        ensure!(
            (100_000..=2_000_000).contains(&self.gas_per_child),
            "INVALID_CHILD_GAS_LIMIT"
        );
        let tx = decimal_units(&self.max_gas_cost_eth, 18)?;
        let total = decimal_units(&self.max_total_gas_cost_eth, 18)?;
        ensure!(
            tx > 0 && total >= tx && total <= decimal_units("1", 18)?,
            "INVALID_GAS_BUDGET"
        );
        let max_fee = decimal_units(&self.max_fee_per_gas_gwei, 9)?;
        ensure!(
            max_fee > 0
                && decimal_units(&self.max_priority_fee_per_gas_gwei, 9)? <= max_fee
                && (1..=20).contains(&self.max_fee_multiplier),
            "INVALID_GAS_FEES"
        );
        decimal_units(&self.reserve_eth, 18)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(serde_json::json!({"wallet":Address::repeat_byte(1)})).unwrap()
    }
    #[test]
    fn defaults_and_bounds() {
        let mut c = config();
        c.validate(false).unwrap();
        c.quantity = 101;
        assert!(c.validate(false).is_err());
        c.quantity = 1;
        c.recipient = Some(Address::repeat_byte(2));
        assert!(c.validate(false).is_err());
    }
    #[test]
    fn exact_decimal_fees() {
        assert_eq!(decimal_units("0.019", 18).unwrap(), 19_000_000_000_000_000);
        assert_eq!(decimal_units("0.1", 9).unwrap(), 100_000_000);
        for s in ["-1", "1e9", " 1", "1.2.3", "0.0000000001"] {
            assert!(decimal_units(s, 9).is_err());
        }
    }
    #[test]
    fn permits_bounded_two_day_wait() {
        let mut c = config();
        c.wait_timeout_secs = 172_800;
        c.validate(false).unwrap();
        c.wait_timeout_secs += 1;
        assert!(c.validate(false).is_err());
        c.wait_timeout_secs = 0;
        assert!(c.validate(false).is_err());
    }
    #[test]
    fn rejects_unknown_secret_config() {
        assert!(
            serde_json::from_value::<Config>(
                serde_json::json!({"wallet":Address::repeat_byte(1),"privateKey":"synthetic"})
            )
            .is_err()
        );
    }
    #[test]
    fn loopback_is_explicit() {
        assert!(loopback_url("http://127.0.0.1:8545"));
        assert!(!loopback_url("http://127.0.0.1.evil.example"));
        assert!(!loopback_url("http://user@127.0.0.1"));
    }
    #[test]
    fn watch_transport_is_validated_before_preparation() {
        let mut c = config();
        c.watch_rpc = Some("wss://robinhood-rpc.publicnode.com".into());
        c.validate(false).unwrap();
        for endpoint in [
            "https://robinhood-rpc.publicnode.com",
            "ws://127.0.0.1:8500",
            "wss://feed.mainnet.chain.robinhood.com",
            "wss://secret@example.invalid",
            "wss://example.invalid/#fragment",
            " wss://example.invalid",
            "wss://@example.invalid",
        ] {
            c.watch_rpc = Some(endpoint.into());
            assert!(c.validate(false).is_err(), "accepted {endpoint}");
        }
        c.read_rpc = "http://127.0.0.1:8500".into();
        c.send_rpc_urls = vec![c.read_rpc.clone()];
        c.watch_rpc = Some("ws://127.0.0.1:8501".into());
        c.validate(true).unwrap();
        c.watch_rpc = Some("wss://example.invalid".into());
        assert!(c.validate(true).is_err());
    }
}
