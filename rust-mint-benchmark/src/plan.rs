use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use alloy_primitives::{Address, B256};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

use crate::{
    artifact::Artifact,
    config::{Args, CHAIN_ID, Mode, ROUNDS, ether},
    eth,
    metrics::Header,
    rpc::RpcClient,
    signing::predict_create,
};

pub const DEPLOY_GAS: u64 = 2_000_000;
pub const ARM_GAS: u64 = 150_000;

pub struct Deployment {
    pub mode: Mode,
    pub run_id: B256,
    pub nonce: u64,
    pub nft: Address,
    pub factory: Address,
    pub nft_init: Vec<u8>,
    pub factory_init: Vec<u8>,
    pub nft_runtime: Vec<u8>,
    pub factory_runtime: Vec<u8>,
    pub start_slot: String,
    pub simulation: Value,
}

pub struct Plan {
    pub clock: Value,
    pub fee: u128,
    pub balance: u128,
    pub maximum_cost: u128,
    pub deployments: Vec<Deployment>,
}

pub fn wall_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

pub async fn call_uint(
    reader: &mut RpcClient,
    contract: Address,
    signature: &str,
    words: &[[u8; 32]],
) -> Result<u128> {
    let value = reader
        .call(
            "eth_call",
            json!([{"to":contract,"data":eth::hex(&eth::call(signature,words))},"latest"]),
        )
        .await?;
    eth::decode_word(&eth::bytes(&value)?)
}

pub async fn header(reader: &mut RpcClient, tag: Value) -> Result<Header> {
    Header::parse(
        &reader
            .call("eth_getBlockByNumber", json!([tag, false]))
            .await?,
    )
}

pub async fn nonce(reader: &mut RpcClient, wallet: Address) -> Result<u64> {
    let latest = eth::quantity64(
        &reader
            .call("eth_getTransactionCount", json!([wallet, "latest"]))
            .await?,
    )?;
    let pending = eth::quantity64(
        &reader
            .call("eth_getTransactionCount", json!([wallet, "pending"]))
            .await?,
    )?;
    ensure!(
        latest == pending,
        "Wallet has pending transactions; reconcile them before testing"
    );
    Ok(latest)
}

pub async fn balance(reader: &mut RpcClient, wallet: Address) -> Result<u128> {
    eth::quantity(
        &reader
            .call("eth_getBalance", json!([wallet, "latest"]))
            .await?,
    )
}

pub async fn warm(sender: &mut RpcClient, mode: Mode) -> Result<()> {
    if mode == Mode::Https {
        ensure!(
            sender
                .call("arb_checkPublisherHealth", json!([]))
                .await?
                .is_null(),
            "Sequencer health response invalid"
        );
    } else {
        ensure!(
            eth::quantity64(&sender.call("eth_chainId", json!([])).await?)? == CHAIN_ID,
            "WSS chain ID mismatch"
        );
    }
    Ok(())
}

pub async fn connect_sender(args: &Args, mode: Mode) -> Result<RpcClient> {
    let url = if mode == Mode::Https {
        &args.https_url
    } else {
        &args.wss_url
    };
    let mut sender = RpcClient::connect(url, Duration::from_millis(1500)).await?;
    warm(&mut sender, mode).await?;
    Ok(sender)
}

pub fn budget_check(balance: u128, maximum_cost: u128, budget: u128, reserve: u128) -> Result<()> {
    ensure!(
        maximum_cost <= budget,
        "Worst-case fee reservation exceeds total cost limit"
    );
    ensure!(
        maximum_cost
            .checked_add(reserve)
            .is_some_and(|v| v <= balance),
        "Balance cannot cover the worst-case gas cost and reserve"
    );
    Ok(())
}

pub async fn preflight(args: &Args) -> Result<Plan> {
    args.validate()?;
    let clock = if args.send && !args.local() {
        crate::clock_check::verify().await?
    } else {
        Value::Null
    };
    let mut reader = RpcClient::connect(&args.read_rpc, Duration::from_secs(5)).await?;
    ensure!(
        eth::quantity64(&reader.call("eth_chainId", json!([])).await?)? == CHAIN_ID,
        "Read RPC chain ID mismatch"
    );
    ensure!(
        eth::bytes(
            &reader
                .call("eth_getCode", json!([args.wallet, "latest"]))
                .await?
        )?
        .is_empty(),
        "Benchmark wallet must be an EOA without delegated code"
    );
    let first_nonce = nonce(&mut reader, args.wallet).await?;
    let balance = balance(&mut reader, args.wallet).await?;
    let block_value = reader
        .call("eth_getBlockByNumber", json!(["latest", false]))
        .await?;
    let block = Header::parse(&block_value)?;
    let now = wall_ms()? / 1000;
    ensure!(
        now.abs_diff(block.timestamp) <= 5,
        "Local clock and chain timestamp differ by more than five seconds"
    );
    let gas_price = eth::quantity(&reader.call("eth_gasPrice", json!([])).await?)?;
    let base_fee = eth::quantity(&block_value["baseFeePerGas"])?;
    let fee = gas_price
        .max(base_fee)
        .checked_mul(args.fee_multiplier)
        .ok_or_else(|| anyhow::anyhow!("Fee overflow"))?;
    ensure!(fee > 0, "Invalid zero gas price");
    let gas_per_run = DEPLOY_GAS
        .checked_mul(2)
        .and_then(|v| v.checked_add(ARM_GAS))
        .and_then(|v| {
            args.batch_gas_limit
                .checked_mul(ROUNDS)
                .and_then(|b| v.checked_add(b))
        })
        .ok_or_else(|| anyhow::anyhow!("Gas reservation overflow"))?;
    let maximum_cost = u128::from(gas_per_run)
        .checked_mul(args.transport.routes().len() as u128)
        .and_then(|v| v.checked_mul(fee))
        .ok_or_else(|| anyhow::anyhow!("Fee reservation overflow"))?;
    budget_check(
        balance,
        maximum_cost,
        ether(&args.max_total_cost_eth)?,
        ether(&args.reserve_eth)?,
    )?;
    let block_limit = eth::quantity64(&block_value["gasLimit"])?;
    let max_tx = if args.local() {
        block_limit
    } else {
        let gas_info: Address = "0x000000000000000000000000000000000000006c".parse()?;
        u64::try_from(call_uint(&mut reader, gas_info, "getMaxTxGasLimit()", &[]).await?)?
    };
    ensure!(
        args.batch_gas_limit.max(DEPLOY_GAS).max(ARM_GAS) <= block_limit.min(max_tx),
        "Configured gas limit exceeds chain limits"
    );
    let nft_artifact = Artifact::load("TimedBenchmarkNFT")?;
    let factory_artifact = Artifact::load("TimedBenchmarkBatchMinter")?;
    let mut deployments = Vec::new();
    for (index, mode) in args.transport.routes().iter().copied().enumerate() {
        // A separate collection and factory per route avoids sharing eligibility
        // or the same nonces across two competing transport implementations.
        let nonce = first_nonce
            .checked_add((index as u64) * (ROUNDS + 3))
            .ok_or_else(|| anyhow::anyhow!("Nonce overflow"))?;
        let nft = predict_create(args.wallet, nonce);
        let factory = predict_create(
            args.wallet,
            nonce
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Nonce overflow"))?,
        );
        for address in [nft, factory] {
            ensure!(
                eth::bytes(
                    &reader
                        .call("eth_getCode", json!([address, "latest"]))
                        .await?
                )?
                .is_empty(),
                "Predicted deployment address is occupied"
            );
        }
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| anyhow::anyhow!("OS randomness unavailable"))?;
        let run_id = B256::from(random);
        let nft_runtime = nft_artifact.runtime(&BTreeMap::from([
            ("owner", eth::address_word(args.wallet)),
            ("runId", random),
        ]))?;
        let factory_runtime = factory_artifact.runtime(&BTreeMap::from([
            ("owner", eth::address_word(args.wallet)),
            ("collection", eth::address_word(nft)),
            ("recipient", eth::address_word(args.wallet)),
        ]))?;
        let mut nft_init = nft_artifact.init.clone();
        nft_init.extend_from_slice(&random);
        let mut factory_init = factory_artifact.init.clone();
        factory_init.extend_from_slice(&eth::address_word(nft));
        factory_init.extend_from_slice(&eth::address_word(args.wallet));
        let start_slot = nft_artifact
            .start_time_slot
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No verified start-time storage slot"))?;
        let mut deployment = Deployment {
            mode,
            run_id,
            nonce,
            nft,
            factory,
            nft_init,
            factory_init,
            nft_runtime,
            factory_runtime,
            start_slot,
            simulation: Value::Null,
        };
        deployment.simulation = simulate(&mut reader, args, &deployment, &block, fee, true).await?;
        let mut sender = connect_sender(args, mode).await?;
        warm(&mut sender, mode).await?;
        deployments.push(deployment);
    }
    Ok(Plan {
        clock,
        fee,
        balance,
        maximum_cost,
        deployments,
    })
}

pub async fn simulate(
    reader: &mut RpcClient,
    args: &Args,
    deployment: &Deployment,
    block: &Header,
    fee: u128,
    include_setup: bool,
) -> Result<Value> {
    // Exactly the embedded runtimes, with constructor immutables patched. State
    // exists only within these RPC simulations; no contract is deployed here.
    let slot = eth::hex(&eth::word(deployment.start_slot.parse()?));
    let mut overrides = json!({
        deployment.nft.to_string(): {"code":eth::hex(&deployment.nft_runtime),"nonce":"0x1","balance":"0x0","state":{slot:eth::hex(&eth::word(u128::from(block.timestamp))) }},
        deployment.factory.to_string(): {"code":eth::hex(&deployment.factory_runtime),"nonce":"0x1","balance":"0x0","state":{}}
    });
    let tx = json!({"from":args.wallet,"to":deployment.factory,"data":eth::hex(&eth::call("mintBatch(uint256,uint256)",&[eth::word(0),eth::word(u128::from(args.quantity))])),
        "gas":format!("0x{:x}",args.batch_gas_limit),"maxFeePerGas":format!("0x{fee:x}"),"maxPriorityFeePerGas":"0x0","value":"0x0"});
    let tag = format!("0x{:x}", block.number);
    let result = reader.call("eth_call", json!([tx, tag, overrides])).await?;
    let output = eth::bytes(&result)?;
    ensure!(
        output.len() == 64
            && eth::decode_word(&output[..32])? == u128::from(args.quantity)
            && eth::decode_word(&output[32..])? == 0,
        "Full-batch simulation did not actually mint the requested NFTs"
    );
    let batch_estimate = eth::quantity64(
        &reader
            .call("eth_estimateGas", json!([tx, tag, overrides]))
            .await?,
    )?;
    ensure!(
        batch_estimate
            .checked_mul(120)
            .is_some_and(|gas| gas.div_ceil(100) <= args.batch_gas_limit),
        "Batch estimate plus 20% margin exceeds the fixed gas limit"
    );
    if !include_setup {
        return Ok(
            json!({"pinnedBlock":block,"fullBatchMinted":args.quantity,"batchEstimateGas":batch_estimate,"stateOverride":true,"liveDeployment":false}),
        );
    }
    let nft_estimate = eth::quantity64(&reader.call("eth_estimateGas",json!([{"from":args.wallet,"data":eth::hex(&deployment.nft_init),"value":"0x0"},tag])).await?)?;
    let mut factory_creation_overrides = overrides.clone();
    factory_creation_overrides
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid simulation overrides"))?
        .remove(&deployment.factory.to_string());
    let factory_nonce = deployment
        .nonce
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Nonce overflow"))?;
    factory_creation_overrides[args.wallet.to_string()] =
        json!({"nonce":format!("0x{factory_nonce:x}")});
    let factory_estimate = eth::quantity64(&reader.call("eth_estimateGas",json!([{"from":args.wallet,"nonce":format!("0x{factory_nonce:x}"),"data":eth::hex(&deployment.factory_init),"value":"0x0"},tag,factory_creation_overrides])).await?)?;
    overrides[deployment.nft.to_string()]["state"] = json!({});
    let arm_estimate = eth::quantity64(&reader.call("eth_estimateGas",json!([{"from":args.wallet,"to":deployment.nft,"data":eth::hex(&eth::call("arm(uint256)",&[eth::word(u128::from(block.timestamp)+60)])),"value":"0x0"},tag,overrides])).await?)?;
    for (estimate, limit) in [
        (nft_estimate, DEPLOY_GAS),
        (factory_estimate, DEPLOY_GAS),
        (arm_estimate, ARM_GAS),
    ] {
        ensure!(
            estimate
                .checked_mul(120)
                .is_some_and(|gas| gas.div_ceil(100) <= limit),
            "Setup estimate plus margin exceeds fixed gas limit"
        );
    }
    Ok(
        json!({"pinnedBlock":block,"fullBatchMinted":args.quantity,"batchEstimateGas":batch_estimate,"nftDeployEstimateGas":nft_estimate,
        "factoryDeployEstimateGas":factory_estimate,"armEstimateGas":arm_estimate,"stateOverride":true,"liveDeployment":false}),
    )
}

impl Plan {
    pub fn report(&self, args: &Args) -> Value {
        json!({"kind":"rust-timed-mint-plan-v1","clock":self.clock,"chainId":CHAIN_ID,"wallet":args.wallet,"routes":args.transport.routes().iter().map(|m|m.label()).collect::<Vec<_>>(),
            "roundsPerRoute":ROUNDS,"nftsPerRoundMaximum":args.quantity,"balanceWei":self.balance.to_string(),"maxFeePerGasWei":self.fee.to_string(),
            "maximumGasCostWei":self.maximum_cost.to_string(),"budgetEth":args.max_total_cost_eth,
            "reserveEth":args.reserve_eth,"batchGasLimit":args.batch_gas_limit,"consecutiveFailureLimit":3,"failurePolicy":args.failure_policy,
            "deployments":self.deployments.iter().map(|d|json!({"route":d.mode.label(),"runId":d.run_id,"nonce":d.nonce,"collection":d.nft,"factory":d.factory,"simulation":d.simulation})).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn total_budget_and_reserve_are_independent_guards() -> Result<()> {
        budget_check(20, 18, 19, 1)?;
        assert!(budget_check(20, 20, 19, 0).is_err());
        assert!(budget_check(20, 19, 19, 2).is_err());
        assert!(budget_check(u128::MAX, u128::MAX, u128::MAX, 1).is_err());
        Ok(())
    }
}
