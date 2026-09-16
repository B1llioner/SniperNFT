//! Classifies terminal receipts away from the timed sender. Failure streaks use
//! round order, never receipt-arrival order. Stop decisions are irreversible.

use std::{collections::HashSet, time::Duration};

use alloy_primitives::{Address, B256};
use anyhow::{Result, ensure};
use clap::ValueEnum;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use crate::{
    metrics::{self, Header},
    observer::Observation,
    rpc::RpcClient,
};

const MAX_ROUNDS: usize = 10;
const FAILURE_LIMIT: usize = 3;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailurePolicy {
    FirstBlock,
    NoMint,
}

pub struct MonitorConfig {
    pub factory: Address,
    pub collection: Address,
    pub recipient: Address,
    pub quantity: u64,
    pub start_time: u64,
    pub hashes: Vec<B256>,
    pub policy: FailurePolicy,
}

impl MonitorConfig {
    fn validate(&self) -> Result<()> {
        ensure!(
            (1..=MAX_ROUNDS).contains(&self.hashes.len()),
            "MONITOR_INVALID_ROUND_COUNT"
        );
        ensure!(
            (1..=10).contains(&self.quantity),
            "MONITOR_INVALID_QUANTITY"
        );
        ensure!(
            self.start_time > 0 && self.start_time.checked_add(MAX_ROUNDS as u64).is_some(),
            "MONITOR_INVALID_START_TIME"
        );
        ensure!(
            self.factory != Address::ZERO
                && self.collection != Address::ZERO
                && self.recipient != Address::ZERO
                && self.factory != self.collection
                && self.recipient != self.factory
                && self.recipient != self.collection,
            "MONITOR_INVALID_ADDRESSES"
        );
        let unique: HashSet<_> = self.hashes.iter().copied().collect();
        ensure!(
            unique.len() == self.hashes.len() && !unique.contains(&B256::ZERO),
            "MONITOR_INVALID_HASHES"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    /// Number of contiguous rounds with a known policy outcome. Unknowns do not
    /// advance this prefix or manufacture failures.
    pub evaluated_prefix: usize,
    pub consecutive_failures: usize,
    pub stop: Option<Value>,
    /// Fixed round-indexed array; null means no terminal classification yet.
    pub outcomes: Vec<Value>,
}

struct State {
    snapshot: MonitorSnapshot,
    classified: Vec<Option<bool>>,
    received: Vec<bool>,
    policy: FailurePolicy,
}

impl State {
    fn new(count: usize, policy: FailurePolicy) -> Self {
        Self {
            snapshot: MonitorSnapshot {
                evaluated_prefix: 0,
                consecutive_failures: 0,
                stop: None,
                outcomes: vec![Value::Null; count],
            },
            classified: vec![None; count],
            received: vec![false; count],
            policy,
        }
    }

    fn stop_observation(&mut self, round: Option<usize>, hash: B256, code: &str) {
        if self.snapshot.stop.is_none() {
            self.snapshot.stop = Some(
                json!({"kind":"OBSERVATION_FAILURE","round":round,"hash":hash,"code":code,"policy":self.policy}),
            );
        }
    }

    fn record(&mut self, round: usize, outcome: Value, success: Option<bool>) {
        self.snapshot.outcomes[round] = outcome;
        self.classified[round] = success;
        while let Some(Some(success)) = self.classified.get(self.snapshot.evaluated_prefix) {
            if *success {
                self.snapshot.consecutive_failures = 0;
            } else {
                self.snapshot.consecutive_failures += 1;
            }
            self.snapshot.evaluated_prefix += 1;
            if self.snapshot.consecutive_failures >= FAILURE_LIMIT && self.snapshot.stop.is_none() {
                self.snapshot.stop = Some(
                    json!({"kind":"THREE_CONSECUTIVE_FAILURES","round":self.snapshot.evaluated_prefix-1,
                    "evaluatedPrefix":self.snapshot.evaluated_prefix,"consecutiveFailures":self.snapshot.consecutive_failures,"policy":self.policy}),
                );
            }
        }
    }
}

/// The only worker owns its read client. Snapshot access never awaits network
/// work. Finish the receipt watcher first, so its updates channel closes.
pub struct RoundMonitor {
    updates: watch::Receiver<MonitorSnapshot>,
    task: Option<JoinHandle<()>>,
}

impl RoundMonitor {
    pub async fn start(
        read_url: &str,
        updates: mpsc::Receiver<Observation>,
        config: MonitorConfig,
    ) -> Result<Self> {
        config.validate()?;
        let reader = RpcClient::connect(read_url, READ_TIMEOUT).await?;
        let initial = State::new(config.hashes.len(), config.policy);
        let (sender, snapshots) = watch::channel(initial.snapshot.clone());
        let task = tokio::spawn(observe(reader, updates, config, initial, sender));
        Ok(Self {
            updates: snapshots,
            task: Some(task),
        })
    }

    pub fn snapshot(&self) -> MonitorSnapshot {
        self.updates.borrow().clone()
    }

    pub async fn finish(mut self) -> Result<MonitorSnapshot> {
        // Keep ownership through await, so cancelling finish aborts this task.
        self.task
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("MONITOR_ALREADY_FINISHED"))?
            .await
            .map_err(|_| anyhow::anyhow!("MONITOR_TASK_FAILED"))?;
        drop(self.task.take());
        Ok(self.snapshot())
    }
}

impl Drop for RoundMonitor {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn block(reader: &mut RpcClient, number: u64) -> Result<Header> {
    let value = reader
        .call(
            "eth_getBlockByNumber",
            json!([format!("0x{number:x}"), false]),
        )
        .await?;
    let header = Header::parse(&value).map_err(|_| anyhow::anyhow!("INVALID_BLOCK_HEADER"))?;
    ensure!(header.number == number, "BLOCK_NUMBER_MISMATCH");
    Ok(header)
}

fn first_block(included: &Header, previous: &Header, target: u64) -> Result<bool> {
    ensure!(
        previous.number.checked_add(1) == Some(included.number)
            && included.parent_hash == previous.hash
            && previous.timestamp <= included.timestamp,
        "INVALID_BLOCK_PARENT_PROOF"
    );
    Ok(included.timestamp == target && previous.timestamp < target)
}

async fn classify(
    reader: &mut RpcClient,
    observation: &Observation,
    config: &MonitorConfig,
    round: usize,
) -> Result<(Value, bool)> {
    ensure!(observation.error.is_none(), "RECEIPT_OBSERVATION_ERROR");
    let receipt = observation
        .receipt
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("RECEIPT_UNAVAILABLE"))?;
    ensure!(receipt.hash == observation.hash, "RECEIPT_HASH_MISMATCH");
    ensure!(
        observation
            .observed_after_send_ms
            .is_none_or(|value| value.is_finite() && value >= 0.0),
        "INVALID_OBSERVATION_TIME"
    );
    let target = config
        .start_time
        .checked_add(round as u64)
        .ok_or_else(|| anyhow::anyhow!("INVALID_TARGET_TIME"))?;
    let (minted, status) = if receipt.success {
        let result = metrics::batch_result(
            receipt,
            config.factory,
            config.collection,
            config.recipient,
            round as u64,
            config.quantity,
        )
        .map_err(|_| anyhow::anyhow!("INVALID_BATCH_RECEIPT"))?;
        (result.minted, result.status_name)
    } else {
        ensure!(receipt.logs.is_empty(), "REVERTED_RECEIPT_HAS_LOGS");
        (0, "reverted")
    };
    let included = block(reader, receipt.block_number).await?;
    ensure!(
        included.hash == receipt.block_hash,
        "RECEIPT_BLOCK_HASH_MISMATCH"
    );
    let mut previous = None;
    let mut first_hit = None;
    let success = match config.policy {
        FailurePolicy::NoMint => minted > 0,
        FailurePolicy::FirstBlock => {
            if minted != config.quantity || included.timestamp != target {
                // A partial batch may have reached the first block. Its
                // quantity already fails this policy, so avoid a second read
                // without inventing a block miss.
                if minted == 0 || included.timestamp != target {
                    first_hit = Some(false);
                }
                false
            } else {
                let predecessor = included
                    .number
                    .checked_sub(1)
                    .ok_or_else(|| anyhow::anyhow!("MISSING_PREVIOUS_BLOCK"))?;
                let header = block(reader, predecessor).await?;
                let hit = first_block(&included, &header, target)?;
                first_hit = Some(hit);
                previous = Some(header);
                hit
            }
        }
    };
    Ok((
        json!({"round":round,"hash":observation.hash,"policy":config.policy,"targetTimestamp":target,
        "outcome":status,"minted":minted,"receiptSuccess":receipt.success,"policySuccess":success,
        "firstBlockHit":first_hit,"includedBlock":included,"previousBlock":previous}),
        success,
    ))
}

async fn observe(
    mut reader: RpcClient,
    mut updates: mpsc::Receiver<Observation>,
    config: MonitorConfig,
    mut state: State,
    snapshots: watch::Sender<MonitorSnapshot>,
) {
    let mut received_count = 0_usize;
    while let Some(observation) = updates.recv().await {
        received_count += 1;
        if received_count > config.hashes.len() {
            state.stop_observation(None, observation.hash, "TOO_MANY_OBSERVATIONS");
            snapshots.send_replace(state.snapshot.clone());
            break;
        }
        let Some(round) = config
            .hashes
            .iter()
            .position(|hash| *hash == observation.hash)
        else {
            state.stop_observation(None, observation.hash, "UNEXPECTED_TRANSACTION_HASH");
            snapshots.send_replace(state.snapshot.clone());
            continue;
        };
        if state.received[round] {
            state.stop_observation(Some(round), observation.hash, "DUPLICATE_OBSERVATION");
            snapshots.send_replace(state.snapshot.clone());
            continue;
        }
        state.received[round] = true;
        match classify(&mut reader, &observation, &config, round).await {
            Ok((outcome, success)) => state.record(round, outcome, Some(success)),
            Err(error) => {
                // All errors crossing these boundaries are fixed labels or the
                // RPC module's redacted codes; no raw RPC body enters reports.
                let code = error.to_string();
                state.stop_observation(Some(round), observation.hash, &code);
                state.record(round,json!({"round":round,"hash":observation.hash,"policy":config.policy,
                    "outcome":"observation_failure","minted":null,"policySuccess":null,"firstBlockHit":null,
                    "code":code,"observationError":observation.error}),None);
            }
        }
        snapshots.send_replace(state.snapshot.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{eth, metrics::Receipt, observer::ObservationError};
    use alloy_primitives::keccak256;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        time::timeout,
    };

    fn config(count: usize, policy: FailurePolicy) -> MonitorConfig {
        MonitorConfig {
            factory: Address::repeat_byte(0xf1),
            collection: Address::repeat_byte(0xf2),
            recipient: Address::repeat_byte(0xf3),
            quantity: 10,
            start_time: 100,
            hashes: (0..count)
                .map(|i| B256::from(eth::word(i as u128 + 1)))
                .collect(),
            policy,
        }
    }

    fn header(number: u64, timestamp: u64) -> Header {
        Header {
            number,
            timestamp,
            hash: B256::from(eth::word(u128::from(number) + 1000)),
            parent_hash: B256::from(eth::word(u128::from(number) + 999)),
        }
    }

    fn observation(
        config: &MonitorConfig,
        round: usize,
        header: &Header,
        minted: u64,
        reverted: bool,
    ) -> Observation {
        let mut logs = Vec::new();
        let first = if minted == 0 {
            0
        } else if minted < config.quantity {
            10001 - minted
        } else {
            round as u64 * config.quantity + 1
        };
        for offset in 0..minted {
            let helper = Address::repeat_byte(offset as u8 + 1);
            for (from, to) in [(Address::ZERO, helper), (helper, config.recipient)] {
                logs.push(json!({"address":config.collection,"topics":[keccak256(b"Transfer(address,address,uint256)"),
                    eth::hex(&eth::address_word(from)),eth::hex(&eth::address_word(to)),eth::hex(&eth::word(u128::from(first+offset)))],"data":"0x"}));
            }
        }
        if !reverted {
            let status = if minted == config.quantity {
                0
            } else if minted == 0 {
                5
            } else {
                1
            };
            let remaining = if minted == 0 {
                10000
            } else {
                10001 - first - minted
            };
            let data = [status, config.quantity, minted, remaining, first]
                .into_iter()
                .flat_map(|v| eth::word(u128::from(v)))
                .collect::<Vec<_>>();
            logs.push(json!({"address":config.factory,"topics":[keccak256(b"BatchResult(uint256,uint8,uint256,uint256,uint256,uint256)"),
                eth::hex(&eth::word(round as u128))],"data":eth::hex(&data)}));
        }
        Observation {
            hash: config.hashes[round],
            receipt: Some(Receipt {
                hash: config.hashes[round],
                block_hash: header.hash,
                block_number: header.number,
                transaction_index: 0,
                success: !reverted,
                gas_used: 21000,
                effective_gas_price_wei: "1".into(),
                gas_cost_wei: "21000".into(),
                contract_address: None,
                logs,
            }),
            observed_after_send_ms: Some(1.0),
            error: None,
        }
    }

    #[test]
    fn ordered_prefix_resets_streak_and_stop_is_sticky() {
        let mut state = State::new(7, FailurePolicy::FirstBlock);
        for (round, success) in [false, false, true, false, false, false, true]
            .into_iter()
            .enumerate()
        {
            state.record(round, json!({"policySuccess":success}), Some(success));
            if round < 5 {
                assert!(state.snapshot.stop.is_none());
            }
        }
        assert_eq!(state.snapshot.evaluated_prefix, 7);
        assert_eq!(state.snapshot.consecutive_failures, 0);
        let stop = state.snapshot.stop.clone().unwrap();
        assert_eq!(stop["kind"], "THREE_CONSECUTIVE_FAILURES");
        assert_eq!(stop["round"], 5);
        state.stop_observation(None, B256::ZERO, "LATER_ERROR");
        assert_eq!(state.snapshot.stop, Some(stop));
    }

    #[test]
    fn out_of_order_failure_cannot_skip_unclassified_round() {
        let mut state = State::new(3, FailurePolicy::FirstBlock);
        state.record(2, json!(false), Some(false));
        assert_eq!(state.snapshot.evaluated_prefix, 0);
        state.record(0, json!(false), Some(false));
        assert_eq!(state.snapshot.evaluated_prefix, 1);
        assert!(state.snapshot.stop.is_none());
        state.record(1, json!(false), Some(false));
        assert_eq!(state.snapshot.evaluated_prefix, 3);
        assert_eq!(state.snapshot.consecutive_failures, 3);
        assert_eq!(state.snapshot.stop.as_ref().unwrap()["round"], 2);
    }

    #[test]
    fn unknown_stops_without_advancing_or_counting_as_failure() {
        let mut state = State::new(3, FailurePolicy::NoMint);
        state.stop_observation(Some(1), B256::repeat_byte(1), "RECEIPT_UNAVAILABLE");
        state.record(1, json!({"policySuccess":null}), None);
        state.record(2, json!(false), Some(false));
        state.record(0, json!(true), Some(true));
        assert_eq!(state.snapshot.evaluated_prefix, 1);
        assert_eq!(state.snapshot.consecutive_failures, 0);
        assert_eq!(
            state.snapshot.stop.as_ref().unwrap()["kind"],
            "OBSERVATION_FAILURE"
        );
    }

    #[test]
    fn first_block_proof_requires_parent_and_timestamp_boundary() {
        let included = header(11, 100);
        let mut previous = header(10, 99);
        assert!(first_block(&included, &previous, 100).unwrap());
        previous.timestamp = 100;
        assert!(!first_block(&included, &previous, 100).unwrap());
        previous.timestamp = 101;
        assert!(first_block(&included, &previous, 100).is_err());
        previous = header(9, 99);
        assert!(first_block(&included, &previous, 100).is_err());
        previous = header(10, 99);
        previous.hash = B256::ZERO;
        assert!(first_block(&included, &previous, 100).is_err());
    }

    #[test]
    fn config_rejects_unbounded_and_ambiguous_inputs() {
        let mut cfg = config(10, FailurePolicy::FirstBlock);
        cfg.validate().unwrap();
        cfg.hashes[1] = cfg.hashes[0];
        assert!(cfg.validate().is_err());
        cfg = config(11, FailurePolicy::FirstBlock);
        assert!(cfg.validate().is_err());
        cfg = config(0, FailurePolicy::FirstBlock);
        assert!(cfg.validate().is_err());
        cfg = config(1, FailurePolicy::FirstBlock);
        cfg.hashes[0] = B256::ZERO;
        assert!(cfg.validate().is_err());
        cfg = config(1, FailurePolicy::FirstBlock);
        cfg.start_time = u64::MAX;
        assert!(cfg.validate().is_err());
        cfg.start_time = 100;
        cfg.quantity = 11;
        assert!(cfg.validate().is_err());
        cfg.quantity = 10;
        cfg.recipient = cfg.factory;
        assert!(cfg.validate().is_err());
    }

    async fn request(stream: &mut BufReader<TcpStream>) -> Value {
        let mut length = None;
        loop {
            let mut line = String::new();
            assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = Some(value.trim().parse::<usize>().unwrap());
            }
        }
        let mut body = vec![0; length.unwrap()];
        stream.read_exact(&mut body).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn serve_headers(headers: Vec<Header>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            for header in headers {
                let call = request(&mut stream).await;
                assert_eq!(call["method"], "eth_getBlockByNumber");
                assert_eq!(
                    call["params"],
                    json!([format!("0x{:x}", header.number), false])
                );
                let body = json!({"jsonrpc":"2.0","id":call["id"],"result":{
                    "number":format!("0x{:x}",header.number),"timestamp":format!("0x{:x}",header.timestamp),
                    "hash":header.hash,"parentHash":header.parent_hash}}).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
                    body.len()
                );
                stream.get_mut().write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn full_mint_proves_first_block_and_later_same_second_misses() {
        for (previous_time, expected) in [(99, true), (100, false)] {
            let cfg = config(1, FailurePolicy::FirstBlock);
            let included = header(11, 100);
            let obs = observation(&cfg, 0, &included, 10, false);
            let (url, server) = serve_headers(vec![included, header(10, previous_time)]).await;
            let mut reader = RpcClient::connect(&url, READ_TIMEOUT).await.unwrap();
            let (outcome, success) = classify(&mut reader, &obs, &cfg, 0).await.unwrap();
            assert_eq!(success, expected);
            assert_eq!(outcome["firstBlockHit"], expected);
            assert_eq!(outcome["minted"], 10);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn partial_has_unknown_first_block_and_only_no_mint_policy_accepts_it() {
        for policy in [FailurePolicy::FirstBlock, FailurePolicy::NoMint] {
            let cfg = config(1, policy);
            let included = header(11, 100);
            let obs = observation(&cfg, 0, &included, 2, false);
            let (url, server) = serve_headers(vec![included]).await;
            let mut reader = RpcClient::connect(&url, READ_TIMEOUT).await.unwrap();
            let (outcome, success) = classify(&mut reader, &obs, &cfg, 0).await.unwrap();
            assert_eq!(success, policy == FailurePolicy::NoMint);
            assert!(outcome["firstBlockHit"].is_null());
            assert_eq!(outcome["outcome"], "partial");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn zero_mint_and_revert_are_known_failures_for_both_policies() {
        for policy in [FailurePolicy::FirstBlock, FailurePolicy::NoMint] {
            for reverted in [false, true] {
                let cfg = config(1, policy);
                let included = header(11, 100);
                let obs = observation(&cfg, 0, &included, 0, reverted);
                let (url, server) = serve_headers(vec![included]).await;
                let mut reader = RpcClient::connect(&url, READ_TIMEOUT).await.unwrap();
                let (outcome, success) = classify(&mut reader, &obs, &cfg, 0).await.unwrap();
                assert!(!success);
                assert_eq!(outcome["minted"], 0);
                assert_eq!(
                    outcome["outcome"],
                    if reverted { "reverted" } else { "expired" }
                );
                server.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn noncanonical_receipt_and_parent_are_unknown_not_misses() {
        for bad_parent in [false, true] {
            let cfg = config(1, FailurePolicy::FirstBlock);
            let mut included = header(11, 100);
            let obs = observation(&cfg, 0, &included, 10, false);
            let headers = if bad_parent {
                let mut previous = header(10, 99);
                previous.hash = B256::ZERO;
                vec![included, previous]
            } else {
                included.hash = B256::ZERO;
                vec![included]
            };
            let (url, server) = serve_headers(headers).await;
            let (tx, rx) = mpsc::channel(10);
            let monitor = RoundMonitor::start(&url, rx, cfg).await.unwrap();
            tx.send(obs).await.unwrap();
            drop(tx);
            let snapshot = monitor.finish().await.unwrap();
            assert_eq!(snapshot.evaluated_prefix, 0);
            assert_eq!(snapshot.consecutive_failures, 0);
            assert_eq!(snapshot.stop.unwrap()["kind"], "OBSERVATION_FAILURE");
            assert!(snapshot.outcomes[0]["minted"].is_null());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn terminal_unknown_and_invalid_batch_need_no_header_rpc() {
        let cfg = config(3, FailurePolicy::FirstBlock);
        let h = header(11, 100);
        let mut missing = observation(&cfg, 0, &h, 0, true);
        missing.receipt = None;
        let mut error = observation(&cfg, 1, &h, 0, true);
        error.error = Some(ObservationError::ReceiptTimeout);
        let mut malformed = observation(&cfg, 2, &h, 10, false);
        malformed.receipt.as_mut().unwrap().logs.clear();
        let (tx, rx) = mpsc::channel(10);
        let monitor = RoundMonitor::start("http://127.0.0.1:9", rx, cfg)
            .await
            .unwrap();
        for obs in [missing, error, malformed] {
            tx.send(obs).await.unwrap();
        }
        drop(tx);
        let snapshot = monitor.finish().await.unwrap();
        assert_eq!(snapshot.evaluated_prefix, 0);
        assert_eq!(snapshot.consecutive_failures, 0);
        assert_eq!(snapshot.stop.unwrap()["code"], "RECEIPT_UNAVAILABLE");
        assert_eq!(snapshot.outcomes[1]["code"], "RECEIPT_OBSERVATION_ERROR");
        assert_eq!(snapshot.outcomes[2]["code"], "INVALID_BATCH_RECEIPT");
    }

    #[tokio::test]
    async fn monitor_publishes_ordered_stop_before_finish_on_one_connection() {
        let cfg = config(4, FailurePolicy::FirstBlock);
        let h = header(11, 100);
        let observations = [2, 0, 1, 3].map(|round| observation(&cfg, round, &h, 0, true));
        let (url, server) = serve_headers(vec![h.clone(), h.clone(), h.clone(), h]).await;
        let (tx, rx) = mpsc::channel(10);
        let mut monitor = RoundMonitor::start(&url, rx, cfg).await.unwrap();
        for obs in observations {
            tx.send(obs).await.unwrap();
        }
        timeout(Duration::from_secs(2), async {
            while monitor.snapshot().evaluated_prefix != 4 {
                monitor.updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.stop.as_ref().unwrap()["round"], 2);
        assert_eq!(snapshot.stop.as_ref().unwrap()["consecutiveFailures"], 3);
        assert_eq!(snapshot.consecutive_failures, 4);
        drop(tx);
        assert_eq!(monitor.finish().await.unwrap().stop, snapshot.stop);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_finish_aborts_inflight_read_and_closes_connection() {
        let cfg = config(1, FailurePolicy::FirstBlock);
        let obs = observation(&cfg, 0, &header(11, 100), 0, true);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (ready_tx, ready_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            request(&mut stream).await;
            ready_tx.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(
                timeout(Duration::from_secs(2), stream.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let (tx, rx) = mpsc::channel(10);
        let monitor = RoundMonitor::start(&url, rx, cfg).await.unwrap();
        tx.send(obs).await.unwrap();
        drop(tx);
        timeout(Duration::from_secs(2), ready_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            timeout(Duration::from_millis(10), monitor.finish())
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}
