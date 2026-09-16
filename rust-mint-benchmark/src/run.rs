use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use alloy_primitives::{Address, B256};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep, sleep_until};

use crate::{
    config::{Args, CHAIN_ID, ROUNDS, ether},
    eth,
    journal::Journal,
    metrics::{self, Header, Receipt},
    observer::ReceiptWatcher,
    plan::{self, ARM_GAS, DEPLOY_GAS, Deployment, Plan},
    rpc::RpcClient,
    signing::{SignedTx, Signer, TxRequest},
};

fn request(nonce: u64, to: Option<Address>, input: Vec<u8>, gas: u64, fee: u128) -> TxRequest {
    TxRequest {
        chain_id: CHAIN_ID,
        nonce,
        gas_limit: gas,
        max_fee_per_gas: fee,
        max_priority_fee_per_gas: 0,
        to,
        input,
    }
}

async fn intent(
    journal: &mut Journal,
    label: &str,
    tx: &TxRequest,
    signed: &SignedTx,
) -> Result<()> {
    journal.append(json!({"type":"intent","phase":label,"hash":signed.hash,"nonce":tx.nonce,"chainId":tx.chain_id,
        "to":tx.to,"gasLimit":tx.gas_limit,"maxFeePerGasWei":tx.max_fee_per_gas.to_string(),"valueWei":"0",
        "calldataHash":alloy_primitives::keccak256(&tx.input),"preparedAtUnixMs":plan::wall_ms()?})).await
}

async fn send(sender: &mut RpcClient, signed: &SignedTx) -> Result<()> {
    let result = sender
        .call("eth_sendRawTransaction", json!([signed.raw]))
        .await?;
    ensure!(
        eth::hash(&result)? == signed.hash,
        "Send RPC returned a different hash; outcome is ambiguous"
    );
    Ok(())
}

async fn receipt(reader: &mut RpcClient, hash: B256, timeout: Duration) -> Result<Receipt> {
    let deadline = Instant::now() + timeout;
    loop {
        ensure!(
            Instant::now() < deadline,
            "Receipt timeout; reconcile journal hashes before any further run"
        );
        let value = reader
            .call("eth_getTransactionReceipt", json!([hash]))
            .await?;
        if !value.is_null() {
            return Receipt::parse(&value, hash);
        }
        sleep(Duration::from_millis(100)).await;
    }
}

fn check_receipt_cost(receipt: &Receipt, gas_limit: u64, fee: u128) -> Result<u128> {
    ensure!(
        receipt.gas_used <= gas_limit,
        "Receipt gas used exceeds signed gas limit"
    );
    let price: u128 = receipt.effective_gas_price_wei.parse()?;
    ensure!(
        price <= fee,
        "Receipt effective price exceeds signed fee limit"
    );
    receipt.cost()
}

struct Execution<'a> {
    reader: &'a mut RpcClient,
    sender: &'a mut RpcClient,
    signer: &'a Signer,
    journal: &'a mut Journal,
    timeout: Duration,
}

impl Execution<'_> {
    async fn setup_tx(&mut self, label: &str, tx: TxRequest) -> Result<Receipt> {
        let signed = self.signer.sign(&tx)?;
        intent(self.journal, label, &tx, &signed).await?;
        let start = Instant::now();
        if let Err(error) = send(self.sender, &signed).await {
            self.journal.append(json!({"type":"ambiguous_send","phase":label,"hash":signed.hash,"error":error.to_string(),
                "action":"stop; inspect this hash; no automatic resend or new nonce"})).await?;
            match receipt(self.reader,signed.hash,self.timeout).await {
                Ok(observed) => self.journal.append(json!({"type":"reconciled_receipt","phase":label,"receipt":observed})).await?,
                Err(reconcile_error) => self.journal.append(json!({"type":"reconciliation_unresolved","phase":label,"hash":signed.hash,"error":reconcile_error.to_string()})).await?,
            }
            return Err(error);
        }
        let ack_ms = start.elapsed().as_secs_f64() * 1000.0;
        self.journal
            .append(json!({"type":"ack","phase":label,"hash":signed.hash,"rpcAckMs":ack_ms}))
            .await?;
        let receipt = receipt(self.reader, signed.hash, self.timeout).await?;
        self.journal.append(json!({"type":"setup_receipt","phase":label,"receipt":receipt,"observedAfterSendMs":start.elapsed().as_secs_f64()*1000.0})).await?;
        check_receipt_cost(&receipt, tx.gas_limit, tx.max_fee_per_gas)?;
        ensure!(
            receipt.success,
            "Setup transaction reverted; no further sends"
        );
        Ok(receipt)
    }
}

pub async fn execute(
    args: &Args,
    plan: Plan,
    signer: &Signer,
    journal: &mut Journal,
) -> Result<Value> {
    ensure!(
        signer.address() == args.wallet,
        "Entered key does not match the expected wallet"
    );
    let mut reader = RpcClient::connect(&args.read_rpc, Duration::from_secs(5)).await?;
    let mut results = Vec::new();
    let mut actual_cost = 0_u128;
    for deployment in &plan.deployments {
        if !args.local() {
            let clock = crate::clock_check::verify().await?;
            journal.append(json!({"type":"clock_before_deploy","route":deployment.mode.label(),"clock":clock})).await?;
        }
        ensure!(
            plan::nonce(&mut reader, args.wallet).await? == deployment.nonce,
            "Wallet nonce changed since preflight; no further sends"
        );
        let current_balance = plan::balance(&mut reader, args.wallet).await?;
        let remaining_reservation = plan
            .maximum_cost
            .checked_sub(actual_cost)
            .ok_or_else(|| anyhow::anyhow!("Actual cost exceeds reservation"))?;
        ensure!(
            current_balance
                >= remaining_reservation
                    .checked_add(ether(&args.reserve_eth)?)
                    .ok_or_else(|| anyhow::anyhow!("Balance reservation overflow"))?,
            "Balance changed since preflight"
        );
        let mut sender = plan::connect_sender(args, deployment.mode).await?;
        let report = run_route(
            args,
            &mut reader,
            &mut sender,
            signer,
            journal,
            deployment,
            plan.fee,
        )
        .await?;
        let cost: u128 = report["gasCostWei"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing route cost"))?
            .parse()?;
        actual_cost = actual_cost
            .checked_add(cost)
            .ok_or_else(|| anyhow::anyhow!("Total fee overflow"))?;
        ensure!(
            actual_cost <= ether(&args.max_total_cost_eth)?,
            "Total fee exceeds budget"
        );
        journal
            .save(&format!("{}.json", deployment.mode.label()), &report)
            .await?;
        print_report(&report);
        let complete = report["allTransactionsResolved"].as_bool() == Some(true);
        results.push(report);
        ensure!(
            complete,
            "Some transactions are unresolved or unsent; stop before the next route and reconcile the journal"
        );
    }
    let final_balance = plan::balance(&mut reader, args.wallet).await?;
    ensure!(
        final_balance >= ether(&args.reserve_eth)?,
        "Final balance below configured reserve"
    );
    let all_first = results
        .iter()
        .all(|r| r["allTenFullBatchesInFirstBlock"] == true);
    Ok(
        json!({"kind":"rust-timed-mint-result-v1","chainId":CHAIN_ID,"wallet":args.wallet,"completed":true,
        "allTenFullBatchesInFirstBlock":all_first,"gasCostWei":actual_cost.to_string(),"finalBalanceWei":final_balance.to_string(),"routes":results,
        "limitations":["RPC acknowledgement is not execution or finality.","Receipt observer issues at most one query per 100ms; with ten pending hashes each is revisited roughly once per second, plus RPC latency.",
            "First eligible L2 block is proved by adjacent block timestamps; transaction position is reported separately.",
            "HTTPS direct sequencer and WSS provider are different network routes.","Ten transactions cannot establish a stable p95/p99 tail."]}),
    )
}

#[allow(clippy::too_many_arguments)]
async fn run_route(
    args: &Args,
    reader: &mut RpcClient,
    sender: &mut RpcClient,
    signer: &Signer,
    journal: &mut Journal,
    deployment: &Deployment,
    fee: u128,
) -> Result<Value> {
    let timeout = Duration::from_secs(args.receipt_timeout_seconds);
    let mut execution = Execution {
        reader,
        sender,
        signer,
        journal,
        timeout,
    };
    let mut setup_receipts = Vec::new();
    let nft_receipt = execution
        .setup_tx(
            "deploy_collection",
            request(
                deployment.nonce,
                None,
                deployment.nft_init.clone(),
                DEPLOY_GAS,
                fee,
            ),
        )
        .await?;
    ensure!(
        nft_receipt.contract_address == Some(deployment.nft),
        "Collection deployment address mismatch"
    );
    ensure!(
        eth::bytes(
            &execution
                .reader
                .call("eth_getCode", json!([deployment.nft, "latest"]))
                .await?
        )? == deployment.nft_runtime,
        "Collection runtime verification failed"
    );
    setup_receipts.push(nft_receipt);
    let factory_receipt = execution
        .setup_tx(
            "deploy_factory",
            request(
                deployment.nonce + 1,
                None,
                deployment.factory_init.clone(),
                DEPLOY_GAS,
                fee,
            ),
        )
        .await?;
    ensure!(
        factory_receipt.contract_address == Some(deployment.factory),
        "Factory deployment address mismatch"
    );
    ensure!(
        eth::bytes(
            &execution
                .reader
                .call("eth_getCode", json!([deployment.factory, "latest"]))
                .await?
        )? == deployment.factory_runtime,
        "Factory runtime verification failed"
    );
    setup_receipts.push(factory_receipt);
    // Repeat the real mint-path simulation immediately before arming; the
    // one-second gate is moved only inside the fixed-block state override.
    let recent = plan::header(execution.reader, json!("latest")).await?;
    let final_simulation =
        plan::simulate(execution.reader, args, deployment, &recent, fee, false).await?;
    execution.journal.append(json!({"type":"final_simulation","route":deployment.mode.label(),"result":final_simulation})).await?;
    if !args.local() {
        let clock = crate::clock_check::verify().await?;
        execution
            .journal
            .append(
                json!({"type":"clock_before_arm","route":deployment.mode.label(),"clock":clock}),
            )
            .await?;
    }
    let start_time = plan::wall_ms()?
        .div_ceil(1000)
        .checked_add(args.start_delay_seconds)
        .ok_or_else(|| anyhow::anyhow!("Start time overflow"))?;
    let arm_receipt = execution
        .setup_tx(
            "arm",
            request(
                deployment.nonce + 2,
                Some(deployment.nft),
                eth::call("arm(uint256)", &[eth::word(u128::from(start_time))]),
                ARM_GAS,
                fee,
            ),
        )
        .await?;
    let anchor = plan::header(
        execution.reader,
        json!(format!("0x{:x}", arm_receipt.block_number)),
    )
    .await?;
    ensure!(
        anchor.hash == arm_receipt.block_hash && anchor.timestamp < start_time,
        "Invalid arming block anchor"
    );
    ensure!(
        plan::call_uint(execution.reader, deployment.nft, "startTime()", &[]).await?
            == u128::from(start_time),
        "Armed time mismatch"
    );
    ensure!(
        plan::nonce(execution.reader, args.wallet).await? == deployment.nonce + 3,
        "Wallet nonce changed before timed batch"
    );
    setup_receipts.push(arm_receipt);
    let mut signed = Vec::new();
    for round in 0..ROUNDS {
        let tx = request(
            deployment.nonce + 3 + round,
            Some(deployment.factory),
            eth::call(
                "mintBatch(uint256,uint256)",
                &[
                    eth::word(u128::from(round)),
                    eth::word(u128::from(args.quantity)),
                ],
            ),
            args.batch_gas_limit,
            fee,
        );
        let value = signer.sign(&tx)?;
        intent(
            execution.journal,
            &format!("{}-round-{round}", deployment.mode.label()),
            &tx,
            &value,
        )
        .await?;
        signed.push(value);
    }
    ensure!(
        plan::wall_ms()?
            .checked_add(5000)
            .is_some_and(|v| v < start_time * 1000),
        "Preparation missed the safety lead; no timed transactions sent"
    );
    let watcher = ReceiptWatcher::start(&args.read_rpc, timeout).await?;
    let anchor_wall = plan::wall_ms()?;
    let anchor_instant = Instant::now();
    let first_deadline = anchor_instant
        + Duration::from_millis(start_time * 1000 + args.send_offset_ms - anchor_wall);
    while Instant::now() + Duration::from_secs(2) < first_deadline {
        plan::warm(execution.sender, deployment.mode).await?;
        sleep_until(
            (Instant::now() + Duration::from_secs(2)).min(first_deadline - Duration::from_secs(1)),
        )
        .await;
    }
    execution.journal.append(json!({"type":"armed_ready","route":deployment.mode.label(),"collection":deployment.nft,"factory":deployment.factory,
        "startTimestamp":start_time,"rounds":ROUNDS,"quantity":args.quantity})).await?;
    println!(
        "{} armed: ten mint windows begin at Unix second {}",
        deployment.mode.label(),
        start_time
    );
    let mut attempts = vec![Value::Null; ROUNDS as usize];
    let mut send_failed = false;
    for round in 0..ROUNDS {
        let deadline = first_deadline + Duration::from_secs(round);
        sleep_until(deadline).await;
        let now = Instant::now();
        let target = start_time + round;
        let send_wall = plan::wall_ms()?;
        let current_drift =
            send_wall as f64 - anchor_wall as f64 - anchor_instant.elapsed().as_secs_f64() * 1000.0;
        if current_drift.abs() > 20.0 {
            execution.journal.append(json!({"type":"clock_changed","round":round,"driftMs":current_drift,"action":"stop timed sends"})).await?;
            send_failed = true;
            break;
        }
        let jitter = now.saturating_duration_since(deadline).as_secs_f64() * 1000.0;
        if send_wall >= (target + 1) * 1000 || jitter + args.send_offset_ms as f64 >= 1000.0 {
            execution.journal.append(json!({"type":"missed_send_deadline","round":round,"targetTimestamp":target,"action":"stop; do not create a nonce gap"})).await?;
            send_failed = true;
            break;
        }
        let value = &signed[round as usize];
        watcher.watch(value.hash, now)?;
        let result = send(execution.sender, value).await;
        let ack = now.elapsed().as_secs_f64() * 1000.0;
        let error = result.as_ref().err().map(ToString::to_string);
        attempts[round as usize] = json!({"round":round,"targetTimestamp":target,"hash":value.hash,"nonce":deployment.nonce+3+round,
            "sentAtUnixMs":send_wall,"sendJitterMs":jitter,"rpcAckMs":if result.is_ok(){Some(ack)}else{None},"sendError":error});
        execution.journal.append(json!({"type":"timed_send","route":deployment.mode.label(),"attempt":attempts[round as usize]})).await?;
        if result.is_err() {
            send_failed = true;
            break;
        }
    }
    let drift = plan::wall_ms()? as f64
        - anchor_wall as f64
        - anchor_instant.elapsed().as_secs_f64() * 1000.0;
    let observations = watcher.finish().await?;
    execution.journal.append(json!({"type":"receipt_observations","route":deployment.mode.label(),"observations":observations})).await?;
    let mut headers = BTreeMap::from([(anchor.number, anchor.clone())]);
    let latest = plan::header(execution.reader, json!("latest")).await?;
    ensure!(
        latest.number >= anchor.number && latest.number - anchor.number <= 4096,
        "Observation range exceeds bounded block scan"
    );
    headers.insert(latest.number, latest.clone());
    let mut rows = Vec::new();
    let mut all_helpers = BTreeSet::new();
    let mut cost = setup_receipts.iter().try_fold(0_u128, |sum, receipt| {
        sum.checked_add(receipt.cost()?)
            .ok_or_else(|| anyhow::anyhow!("Cost overflow"))
    })?;
    for round in 0..ROUNDS {
        let target = start_time + round;
        let attempt = &attempts[round as usize];
        let found = observations
            .iter()
            .find(|o| o.hash == signed[round as usize].hash);
        let mut row = json!({"round":round,"targetTimestamp":target,"hash":signed[round as usize].hash,"attempt":attempt,
            "hitFirstBlock":false,"minted":0,"outcome":"not_sent"});
        if let Some(observation) = found {
            row["hitFirstBlock"] = Value::Null;
            row["minted"] = Value::Null;
            row["receiptObservedAfterSendMs"] = json!(observation.observed_after_send_ms);
            row["observationError"] = json!(observation.error);
            row["outcome"] = json!("receipt_unresolved");
            if let Some(receipt) = &observation.receipt {
                cost = cost
                    .checked_add(check_receipt_cost(receipt, args.batch_gas_limit, fee)?)
                    .ok_or_else(|| anyhow::anyhow!("Cost overflow"))?;
                let included =
                    cached_header(execution.reader, &mut headers, receipt.block_number).await?;
                ensure!(
                    included.hash == receipt.block_hash,
                    "Receipt no longer matches canonical block"
                );
                row["receipt"] = json!(receipt);
                row["includedBlockTimestamp"] = json!(included.timestamp);
                row["transactionIndexZeroBased"] = json!(receipt.transaction_index);
                row["outcome"] = json!("reverted");
                row["hitFirstBlock"] = json!(false);
                row["minted"] = json!(0);
                if receipt.success {
                    let result = metrics::batch_result(
                        receipt,
                        deployment.factory,
                        deployment.nft,
                        args.wallet,
                        round,
                        args.quantity,
                    )?;
                    for helper in &result.helpers {
                        ensure!(
                            all_helpers.insert(*helper),
                            "Helper address reused across rounds"
                        );
                    }
                    for token in result.first_token_id..result.first_token_id + result.minted {
                        // Verification is outside the timed send window. Bound
                        // public reader load rather than bursting 100 ownerOf calls.
                        sleep(Duration::from_millis(100)).await;
                        let owner = execution.reader.call("eth_call",json!([{"to":deployment.nft,"data":eth::hex(&eth::call("ownerOf(uint256)",&[eth::word(u128::from(token))]))},format!("0x{:x}",receipt.block_number)])).await?;
                        ensure!(
                            eth::bytes(&owner)? == eth::address_word(args.wallet),
                            "Minted token ownership differs from recipient"
                        );
                    }
                    row["minted"] = json!(result.minted);
                    row["outcome"] = json!(result.status_name);
                    row["batchResult"] = json!(result);
                }
                if latest.timestamp >= target {
                    let (previous, first) =
                        first_block(execution.reader, &mut headers, &anchor, &latest, target)
                            .await?;
                    row["firstEligibleBlock"] = json!(first);
                    row["previousBlock"] = json!(previous);
                    row["blocksAfterFirstEligible"] =
                        json!(i128::from(receipt.block_number) - i128::from(first.number));
                    row["hitFirstBlock"] = json!(
                        row["minted"].as_u64().is_some_and(|v| v > 0)
                            && receipt.block_number == first.number
                            && included.timestamp == target
                    );
                }
            }
        }
        rows.push(row);
    }
    let full_batches = rows.iter().filter(|r| r["minted"] == args.quantity).count();
    let hits = rows.iter().filter(|r| r["hitFirstBlock"] == true).count();
    let all_resolved = !send_failed
        && observations.len() == ROUNDS as usize
        && observations.iter().all(|o| o.receipt.is_some());
    let ack_ms = attempts
        .iter()
        .filter_map(|r| r["rpcAckMs"].as_f64())
        .collect::<Vec<_>>();
    let receipt_ms = observations
        .iter()
        .filter_map(|o| o.observed_after_send_ms)
        .collect::<Vec<_>>();
    let current_anchor =
        plan::header(execution.reader, json!(format!("0x{:x}", anchor.number))).await?;
    ensure!(
        current_anchor.hash == anchor.hash,
        "Anchor reorged during analysis"
    );
    let clock_valid = drift.abs() <= 20.0;
    Ok(
        json!({"kind":"rust-timed-mint-route-v1","route":deployment.mode.label(),"runId":deployment.run_id,"collection":deployment.nft,"factory":deployment.factory,
        "senderHost":args.sender_host(deployment.mode)?,"uniqueHelpers":all_helpers.len(),"startTimestamp":start_time,"rounds":rows,"fullBatches":full_batches,"firstBlockHits":hits,"allTransactionsResolved":all_resolved,
        "allTenFullBatchesInFirstBlock":hits==10&&full_batches==10&&all_resolved&&clock_valid,"unknownOutcomes":rows.iter().filter(|r| r["minted"].is_null()).count(),"gasCostWei":cost.to_string(),"clockDriftMs":drift,"clockValid":clock_valid,
        "rpcAck":metrics::latency_summary(&ack_ms),"receiptObserved":metrics::latency_summary(&receipt_ms),"setupReceipts":setup_receipts,
        "receiptObservationNote":"First RPC-visible receipt; includes polling and provider propagation, not exact execution latency.","canonicalityNote":"Observed unfinalized branch snapshot; a shallow reorg after a header was read can change inclusion."}),
    )
}

async fn cached_header(
    reader: &mut RpcClient,
    cache: &mut BTreeMap<u64, Header>,
    number: u64,
) -> Result<Header> {
    if let Some(value) = cache.get(&number) {
        return Ok(value.clone());
    }
    ensure!(cache.len() < 512, "Header cache limit exceeded");
    sleep(Duration::from_millis(100)).await;
    let result = plan::header(reader, json!(format!("0x{number:x}"))).await?;
    ensure!(
        result.number == number,
        "RPC returned a different block number"
    );
    cache.insert(number, result.clone());
    Ok(result)
}

async fn first_block(
    reader: &mut RpcClient,
    cache: &mut BTreeMap<u64, Header>,
    anchor: &Header,
    latest: &Header,
    target: u64,
) -> Result<(Header, Header)> {
    ensure!(
        anchor.timestamp < target && latest.timestamp >= target,
        "Target is outside observed block range"
    );
    let (mut low, mut high) = (anchor.number, latest.number);
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        let h = cached_header(reader, cache, middle).await?;
        if h.timestamp >= target {
            high = middle;
        } else {
            low = middle;
        }
    }
    let previous = cached_header(reader, cache, low).await?;
    let first = cached_header(reader, cache, high).await?;
    metrics::first_block_proof(&previous, &first, target)?;
    Ok((previous, first))
}

fn print_report(report: &Value) {
    println!(
        "{}: full batches {}/10, first-block hits {}/10",
        report["route"], report["fullBatches"], report["firstBlockHits"]
    );
    println!("round | minted | first L2 block | actual L2 block | tx index | outcome");
    if let Some(rows) = report["rounds"].as_array() {
        for row in rows {
            println!(
                "{} | {} | {} | {} | {} | {}",
                row["round"],
                row["minted"],
                row["firstEligibleBlock"]["number"],
                row["receipt"]["blockNumber"],
                row["transactionIndexZeroBased"],
                row["outcome"]
            );
        }
    }
    println!("RPC ack ms: {}", report["rpcAck"]);
    println!("RPC-visible receipt ms: {}", report["receiptObserved"]);
}
