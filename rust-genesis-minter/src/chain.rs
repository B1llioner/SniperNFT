use crate::{
    abi::{Child, Factory, GasInfo, Nft, Sea},
    artifact::Artifact,
    config::{CHAIN_ID, Config, Route, decimal_units},
    payload::{MintKind, ValidatedPayload},
};
use alloy_primitives::{Address, B256, U256, keccak256};
use alloy_sol_types::{SolCall, SolValue};
use anyhow::{Result, ensure};
use rust_mint_benchmark::{eth, rpc::RpcClient};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct Head {
    pub number: u64,
    pub timestamp: u64,
    pub gas_limit: u64,
    pub base_fee: u128,
    pub tag: String,
}
pub struct Drop {
    pub route: Route,
    pub start: u64,
    pub end: u64,
    pub free: bool,
    pub wallet_limit: u16,
    pub fee_allowed: bool,
}
pub struct Snapshot {
    pub head: Head,
    pub remaining: u64,
    pub drops: Vec<Drop>,
}
pub struct ChildAddress {
    pub index: u64,
    pub address: Address,
}
pub struct Quote {
    pub gas_limit: u64,
    pub max_fee: u128,
    pub priority_fee: u128,
    pub max_cost: u128,
    pub nonce: u64,
}

pub async fn raw_call(
    rpc: &mut RpcClient,
    to: Address,
    data: Vec<u8>,
    tag: &str,
) -> Result<Vec<u8>> {
    eth::bytes(
        &rpc.call("eth_call", json!([{"to":to,"data":eth::hex(&data)},tag]))
            .await?,
    )
}
pub async fn head(rpc: &mut RpcClient) -> Result<Head> {
    ensure!(
        eth::quantity64(&rpc.call("eth_chainId", json!([])).await?)? == CHAIN_ID,
        "WRONG_CHAIN"
    );
    let b = rpc
        .call("eth_getBlockByNumber", json!(["latest", false]))
        .await?;
    let number = eth::quantity64(&b["number"])?;
    Ok(Head {
        number,
        timestamp: eth::quantity64(&b["timestamp"])?,
        gas_limit: eth::quantity64(&b["gasLimit"])?,
        base_fee: eth::quantity(&b["baseFeePerGas"])?,
        tag: format!("0x{number:x}"),
    })
}
pub async fn code(rpc: &mut RpcClient, address: Address, tag: &str) -> Result<Vec<u8>> {
    eth::bytes(&rpc.call("eth_getCode", json!([address, tag])).await?)
}
pub async fn stats(
    rpc: &mut RpcClient,
    nft: Address,
    minter: Address,
    tag: &str,
) -> Result<(U256, U256, U256)> {
    let b = raw_call(rpc, nft, Nft::getMintStatsCall { minter }.abi_encode(), tag).await?;
    <(U256, U256, U256)>::abi_decode_validate(&b).map_err(|_| anyhow::anyhow!("INVALID_NFT_STATS"))
}
pub async fn snapshot(rpc: &mut RpcClient, cfg: &Config) -> Result<Snapshot> {
    let h = head(rpc).await?;
    ensure!(
        keccak256(code(rpc, cfg.nft, &h.tag).await?) == cfg.nft_code_hash,
        "NFT_CODE_CHANGED"
    );
    ensure!(
        code(rpc, cfg.wallet, &h.tag).await?.is_empty(),
        "SIGNING_WALLET_MUST_BE_EOA"
    );
    let b = raw_call(
        rpc,
        cfg.nft,
        Nft::getAllowedSeaDropCall {}.abi_encode(),
        &h.tag,
    )
    .await?;
    let allowed = Vec::<Address>::abi_decode_validate(&b)
        .map_err(|_| anyhow::anyhow!("INVALID_ALLOWED_SEADROP"))?;
    ensure!(allowed.len() <= 32, "OVERSIZED_ALLOWED_SEADROP");
    let (_, minted, maximum) = stats(rpc, cfg.nft, Address::ZERO, &h.tag).await?;
    ensure!(
        minted <= maximum && maximum <= U256::from(1024),
        "UNEXPECTED_NFT_SUPPLY"
    );
    let mut drops = Vec::new();
    for route in &cfg.routes {
        if !allowed.contains(&route.sea_drop) {
            continue;
        }
        ensure!(
            keccak256(code(rpc, route.sea_drop, &h.tag).await?) == route.code_hash,
            "SEADROP_CODE_CHANGED"
        );
        let data = raw_call(
            rpc,
            route.sea_drop,
            Sea::getPublicDropCall {
                nftContract: cfg.nft,
            }
            .abi_encode(),
            &h.tag,
        )
        .await?;
        let d = Sea::PublicDrop::abi_decode_validate(&data)
            .map_err(|_| anyhow::anyhow!("INVALID_PUBLIC_DROP"))?;
        let b = raw_call(
            rpc,
            route.sea_drop,
            Sea::getFeeRecipientIsAllowedCall {
                nftContract: cfg.nft,
                feeRecipient: route.fee_recipient,
            }
            .abi_encode(),
            &h.tag,
        )
        .await?;
        let fee_allowed = bool::abi_decode_validate(&b)
            .map_err(|_| anyhow::anyhow!("INVALID_FEE_RECIPIENT_CHECK"))?;
        drops.push(Drop {
            route: route.clone(),
            start: d.startTime.to::<u64>(),
            end: d.endTime.to::<u64>(),
            free: d.mintPrice.is_zero(),
            wallet_limit: d.maxTotalMintableByWallet,
            fee_allowed: !d.restrictFeeRecipients || fee_allowed,
        });
    }
    ensure!(
        !drops.is_empty(),
        "NO_APPROVED_SEADROP_REMAINS_ALLOWED_UPDATE_ROUTE_CONFIG"
    );
    Ok(Snapshot {
        head: h,
        remaining: (maximum - minted).to::<u64>(),
        drops,
    })
}
impl Drop {
    pub fn active(&self, time: u64) -> bool {
        self.free
            && self.fee_allowed
            && self.wallet_limit > 0
            && self.start <= time
            && time <= self.end
            && self.end > 0
    }
}

pub async fn verify_factory(
    rpc: &mut RpcClient,
    cfg: &Config,
    factory: Address,
    tag: &str,
) -> Result<()> {
    let a = Artifact::load("GenesisChildFactory")?;
    let expected = a.runtime(&BTreeMap::from([
        ("owner", eth::address_word(cfg.wallet)),
        ("nft", eth::address_word(cfg.nft)),
        ("recipient", eth::address_word(cfg.recipient())),
    ]))?;
    ensure!(
        code(rpc, factory, tag).await? == expected,
        "FACTORY_RUNTIME_IDENTITY_MISMATCH"
    );
    Ok(())
}
pub async fn children(
    rpc: &mut RpcClient,
    cfg: &Config,
    factory: Address,
    tag: &str,
) -> Result<(u64, Vec<ChildAddress>)> {
    verify_factory(rpc, cfg, factory, tag).await?;
    let b = raw_call(rpc, factory, Factory::childCountCall {}.abi_encode(), tag).await?;
    let count =
        U256::abi_decode_validate(&b).map_err(|_| anyhow::anyhow!("INVALID_CHILD_COUNT"))?;
    ensure!(count <= U256::from(1024), "INVALID_CHILD_COUNT");
    let a = Artifact::load("GenesisMintChild")?;
    let expected = a.runtime(&BTreeMap::from([
        ("factory", eth::address_word(factory)),
        ("nft", eth::address_word(cfg.nft)),
        ("recipient", eth::address_word(cfg.recipient())),
    ]))?;
    let mut result = Vec::new();
    for index in 0..count.to::<u64>() {
        let b = raw_call(
            rpc,
            factory,
            Factory::childrenCall {
                index: U256::from(index),
            }
            .abi_encode(),
            tag,
        )
        .await?;
        let address = Address::abi_decode_validate(&b)
            .map_err(|_| anyhow::anyhow!("INVALID_CHILD_ADDRESS"))?;
        ensure!(
            code(rpc, address, tag).await? == expected,
            "CHILD_RUNTIME_MISMATCH"
        );
        let b = raw_call(rpc, address, Child::spentCall {}.abi_encode(), tag).await?;
        let spent =
            bool::abi_decode_validate(&b).map_err(|_| anyhow::anyhow!("INVALID_CHILD_SPENT"))?;
        if !spent {
            result.push(ChildAddress { index, address });
        }
        if result.len() >= usize::from(cfg.quantity) {
            break;
        }
    }
    Ok((count.to::<u64>(), result))
}

pub async fn validate_live(
    rpc: &mut RpcClient,
    cfg: &Config,
    route: &Route,
    minter: Address,
    factory: Option<Address>,
    p: &ValidatedPayload,
    h: &Head,
) -> Result<()> {
    let (wallet, minted, maximum) = stats(rpc, cfg.nft, minter, &h.tag).await?;
    ensure!(minted < maximum, "SOLD_OUT");
    if p.kind == MintKind::Signed {
        let params = p
            .params
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("MISSING_SIGNED_PARAMS"))?;
        let time = U256::from(h.timestamp);
        ensure!(
            params.startTime <= time
                && params.endTime >= time + U256::from(cfg.min_signature_remaining_secs),
            "SIGNED_WINDOW_NOT_READY_OR_EXPIRING"
        );
        ensure!(
            wallet < params.maxTotalMintableByWallet && minted < params.maxTokenSupplyForStage,
            "SIGNED_MINT_LIMIT_REACHED"
        );
        let signer = p.signer.ok_or_else(|| anyhow::anyhow!("MISSING_SIGNER"))?;
        let b = raw_call(
            rpc,
            route.sea_drop,
            Sea::getSignedMintValidationParamsCall {
                nftContract: cfg.nft,
                signer,
            }
            .abi_encode(),
            &h.tag,
        )
        .await?;
        let v = Sea::Validation::abi_decode_validate(&b)
            .map_err(|_| anyhow::anyhow!("INVALID_SIGNER_VALIDATION"))?;
        ensure!(
            v.maxMaxTotalMintableByWallet.to::<u64>() > 0
                && params.mintPrice >= U256::from(v.minMintPrice)
                && params.maxTotalMintableByWallet <= U256::from(v.maxMaxTotalMintableByWallet)
                && params.startTime >= U256::from(v.minStartTime)
                && params.endTime <= U256::from(v.maxEndTime)
                && params.maxTokenSupplyForStage <= U256::from(v.maxMaxTokenSupplyForStage)
                && params.feeBps >= U256::from(v.minFeeBps)
                && params.feeBps <= U256::from(v.maxFeeBps),
            "SIGNER_REVOKED_OR_PARAMS_CHANGED"
        );
    }
    // Exact per-minter eth_call additionally verifies replay protection and current fee/payer restrictions.
    let simulation = if let Some(factory) = factory {
        tx(
            factory,
            Some(minter),
            &Child::mintCall {
                seaDrop: route.sea_drop,
                feeRecipient: route.fee_recipient,
                payload: p.data.clone().into(),
            }
            .abi_encode(),
            Some(cfg.gas_per_child),
        )
    } else {
        tx(minter, Some(route.sea_drop), &p.data, None)
    };
    rpc.call("eth_call", json!([simulation, h.tag])).await?;
    Ok(())
}

pub fn tx(from: Address, to: Option<Address>, data: &[u8], gas: Option<u64>) -> Value {
    let mut value = json!({"from":from,"value":"0x0","data":eth::hex(data)});
    if let Some(to) = to {
        value["to"] = json!(to);
    }
    if let Some(gas) = gas {
        value["gas"] = json!(format!("0x{gas:x}"));
    }
    value
}
pub fn batch_gas(count: usize, gas_per_child: u64) -> Result<u64> {
    let per = gas_per_child
        .checked_add(gas_per_child / 63)
        .and_then(|v| v.checked_add(80_000))
        .ok_or_else(|| anyhow::anyhow!("GAS_OVERFLOW"))?;
    per.checked_mul(u64::try_from(count)?)
        .and_then(|v| v.checked_add(180_000))
        .ok_or_else(|| anyhow::anyhow!("GAS_OVERFLOW"))
}
pub async fn quote(
    rpc: &mut RpcClient,
    cfg: &Config,
    transaction: &Value,
    min_gas: u64,
    already_spent: u128,
    local: bool,
) -> Result<Quote> {
    let h = head(rpc).await?;
    let estimate = eth::quantity64(
        &rpc.call("eth_estimateGas", json!([transaction, h.tag]))
            .await?,
    )?;
    let gas_limit = estimate
        .checked_mul(120)
        .and_then(|v| v.checked_add(99))
        .map(|v| v / 100)
        .ok_or_else(|| anyhow::anyhow!("GAS_OVERFLOW"))?
        .max(min_gas);
    let max_tx = if local {
        h.gas_limit
    } else {
        let b = raw_call(
            rpc,
            Address::with_last_byte(0x6c),
            GasInfo::getMaxTxGasLimitCall {}.abi_encode(),
            &h.tag,
        )
        .await?;
        u64::abi_decode_validate(&b).map_err(|_| anyhow::anyhow!("NITRO_GAS_LIMIT_UNAVAILABLE"))?
    };
    ensure!(
        gas_limit >= 21_000 && gas_limit <= h.gas_limit && gas_limit <= max_tx,
        "BATCH_EXCEEDS_NETWORK_GAS_LIMIT_REDUCE_QUANTITY"
    );
    let cap = decimal_units(&cfg.max_fee_per_gas_gwei, 9)?;
    let priority = decimal_units(&cfg.max_priority_fee_per_gas_gwei, 9)?;
    let needed = h
        .base_fee
        .checked_add(priority)
        .ok_or_else(|| anyhow::anyhow!("FEE_OVERFLOW"))?;
    ensure!(needed <= cap, "BASE_FEE_EXCEEDS_CONFIGURED_GAS_PRICE");
    let suggested = eth::quantity(&rpc.call("eth_gasPrice", json!([])).await?)?;
    let max_fee = h
        .base_fee
        .max(suggested)
        .checked_mul(u128::from(cfg.max_fee_multiplier))
        .and_then(|v| v.checked_add(priority))
        .ok_or_else(|| anyhow::anyhow!("FEE_OVERFLOW"))?
        .min(cap)
        .max(needed);
    let max_cost = u128::from(gas_limit)
        .checked_mul(max_fee)
        .ok_or_else(|| anyhow::anyhow!("COST_OVERFLOW"))?;
    let total_cap = decimal_units(&cfg.max_total_gas_cost_eth, 18)?;
    ensure!(
        max_cost <= decimal_units(&cfg.max_gas_cost_eth, 18)?
            && already_spent
                .checked_add(max_cost)
                .is_some_and(|n| n <= total_cap),
        "GAS_BUDGET_EXCEEDED"
    );
    let balance = eth::quantity(
        &rpc.call("eth_getBalance", json!([cfg.wallet, "pending"]))
            .await?,
    )?;
    ensure!(
        balance
            >= max_cost
                .checked_add(decimal_units(&cfg.reserve_eth, 18)?)
                .ok_or_else(|| anyhow::anyhow!("COST_OVERFLOW"))?,
        "BALANCE_CANNOT_COVER_GAS_AND_RESERVE"
    );
    let latest = eth::quantity64(
        &rpc.call("eth_getTransactionCount", json!([cfg.wallet, "latest"]))
            .await?,
    )?;
    let pending = eth::quantity64(
        &rpc.call("eth_getTransactionCount", json!([cfg.wallet, "pending"]))
            .await?,
    )?;
    ensure!(latest == pending, "WALLET_HAS_PENDING_TRANSACTION");
    Ok(Quote {
        gas_limit,
        max_fee,
        priority_fee: priority,
        max_cost,
        nonce: pending,
    })
}
pub fn receipt_cost(
    receipt: &Value,
    hash: B256,
    wallet: Address,
    gas_limit: u64,
    max_fee: u128,
) -> Result<u128> {
    ensure!(
        eth::hash(&receipt["transactionHash"])? == hash,
        "RECEIPT_HASH_MISMATCH"
    );
    let from: Address = receipt["from"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("RECEIPT_FROM_MISSING"))?
        .parse()
        .map_err(|_| anyhow::anyhow!("INVALID_RECEIPT_FROM"))?;
    ensure!(from == wallet, "RECEIPT_WALLET_MISMATCH");
    let gas = eth::quantity64(&receipt["gasUsed"])?;
    let fee = eth::quantity(&receipt["effectiveGasPrice"])?;
    ensure!(
        gas <= gas_limit && fee <= max_fee,
        "RECEIPT_COST_EXCEEDS_SIGNED_LIMITS"
    );
    u128::from(gas)
        .checked_mul(fee)
        .ok_or_else(|| anyhow::anyhow!("RECEIPT_COST_OVERFLOW"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gas_floor_accounts_for_forwarding() {
        assert!(batch_gas(10, 1_000_000).unwrap() > 10_000_000);
        assert!(batch_gas(100, u64::MAX).is_err());
    }
}
