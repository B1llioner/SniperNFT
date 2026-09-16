//! One-owner orchestration. Preparation is replaceable until a signed intent is
//! durably recorded; after that, only receipt reconciliation can advance state.
use crate::{
    abi::{Factory, Nft},
    artifact::Artifact,
    chain::{self, ChildAddress, Quote},
    config::{CHAIN_ID, Config, Mode, Route, SEQUENCER},
    opensea::{ApiError, OpenSeaClient},
    payload::{self, ApprovedMint, MintKind, ValidatedPayload},
    state::{Action, Pending, Store},
};
use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{SolCall, SolEvent, SolValue};
use anyhow::{Result, ensure};
use futures_util::{StreamExt, stream};
use rust_mint_benchmark::{
    eth,
    rpc::RpcClient,
    signing::{Signer, TxRequest, predict_create},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Preflight,
    Prepare,
    Setup,
    Start,
    Recover,
    CheckChildren,
}
pub struct Options {
    pub command: Command,
    pub send: bool,
    pub local: bool,
}
pub struct Session {
    pub reader: RpcClient,
    senders: Vec<(usize, RpcClient)>,
    pub cfg: Config,
    pub local: bool,
}
struct PreparedChild {
    child: ChildAddress,
    route: Route,
    payload: ValidatedPayload,
    fetched: Instant,
}
struct Submission {
    to: Option<Address>,
    data: Vec<u8>,
    quote: Quote,
    action: Action,
    valid_until: Option<Instant>,
}
struct Batch {
    items: Vec<PreparedChild>,
    created: Instant,
}

async fn emit(store: &Store, value: Value) -> Result<()> {
    store.event(&value).await?;
    println!("{value}");
    Ok(())
}
fn approve(cfg: &Config, route: &Route, minter: Address) -> ApprovedMint {
    ApprovedMint {
        nft: cfg.nft,
        sea_drop: route.sea_drop,
        fee_recipient: route.fee_recipient,
        minter,
        chain_id: CHAIN_ID,
    }
}

impl Session {
    pub async fn open(cfg: Config, local: bool) -> Result<Self> {
        let reader = RpcClient::connect(&cfg.read_rpc, cfg.timeout()).await?;
        Ok(Self {
            reader,
            senders: Vec::new(),
            cfg,
            local,
        })
    }
    async fn warm_senders(&mut self) -> Result<()> {
        self.senders.clear();
        for (index, url) in self.cfg.send_rpc_urls.iter().enumerate() {
            let mut client = match RpcClient::connect(url, self.cfg.timeout()).await {
                Ok(c) => c,
                Err(e) => {
                    println!(
                        "{}",
                        json!({"event":"sender_unavailable","index":index,"reason":e.to_string()})
                    );
                    continue;
                }
            };
            let result = if url.trim_end_matches('/') == SEQUENCER {
                client
                    .call("arb_checkPublisherHealth", json!([]))
                    .await
                    .map(|v| v.is_null())
            } else {
                client
                    .call("eth_chainId", json!([]))
                    .await
                    .map(|v| eth::quantity64(&v).is_ok_and(|id| id == CHAIN_ID))
            };
            match result {
                Ok(true) => self.senders.push((index, client)),
                Ok(false) => println!(
                    "{}",
                    json!({"event":"sender_wrong_chain_or_health","index":index})
                ),
                Err(e) => println!(
                    "{}",
                    json!({"event":"sender_unavailable","index":index,"reason":e.to_string()})
                ),
            }
        }
        ensure!(!self.senders.is_empty(), "NO_SUBMISSION_ENDPOINT_AVAILABLE");
        Ok(())
    }
    async fn heartbeat(&mut self) -> Result<()> {
        let mut kept = Vec::new();
        for (index, mut client) in self.senders.drain(..) {
            let url = &self.cfg.send_rpc_urls[index];
            let result = if url.trim_end_matches('/') == SEQUENCER {
                client
                    .call("arb_checkPublisherHealth", json!([]))
                    .await
                    .map(|v| v.is_null())
            } else {
                client
                    .call("eth_chainId", json!([]))
                    .await
                    .map(|v| eth::quantity64(&v).is_ok_and(|id| id == CHAIN_ID))
            };
            if matches!(result, Ok(true)) {
                kept.push((index, client));
            } else {
                println!("{}", json!({"event":"sender_removed","index":index}));
            }
        }
        self.senders = kept;
        ensure!(!self.senders.is_empty(), "ALL_WARMED_SENDERS_UNAVAILABLE");
        Ok(())
    }
    pub async fn preflight(&mut self, store: &Store) -> Result<()> {
        let snapshot = chain::snapshot(&mut self.reader, &self.cfg).await?;
        if let Some(factory) = store.state.factory {
            chain::verify_factory(&mut self.reader, &self.cfg, factory, &snapshot.head.tag).await?;
        }
        emit(
            store,
            json!({"event":"preflight","chainId":CHAIN_ID,"wallet":self.cfg.wallet,"nft":self.cfg.nft,"factory":store.state.factory,"quantity":self.cfg.quantity,"remaining":snapshot.remaining,"block":snapshot.head.number,"chainTimestamp":snapshot.head.timestamp,"pendingHash":store.state.pending.as_ref().map(|p|p.hash),"publicWindows":snapshot.drops.iter().map(|d|json!({"seaDrop":d.route.sea_drop,"start":d.start,"end":d.end,"active":d.active(snapshot.head.timestamp)})).collect::<Vec<_>>() }),
        )
        .await
    }
    pub async fn recover(&mut self, store: &mut Store, wait: bool) -> Result<Option<Value>> {
        let Some(pending) = store.state.pending.clone() else {
            return Ok(None);
        };
        ensure!(
            eth::quantity64(&self.reader.call("eth_chainId", json!([])).await?)? == CHAIN_ID,
            "WRONG_CHAIN"
        );
        let began = Instant::now();
        let receipt = loop {
            let receipt = self
                .reader
                .call("eth_getTransactionReceipt", json!([pending.hash]))
                .await?;
            if !receipt.is_null() {
                break receipt;
            }
            ensure!(
                wait && began.elapsed() < Duration::from_secs(self.cfg.receipt_timeout_secs),
                "UNRESOLVED_TRANSACTION_NO_AUTOMATIC_REDEPLOY_OR_RESEND"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        let cost = chain::receipt_cost(
            &receipt,
            pending.hash,
            self.cfg.wallet,
            pending.gas_limit,
            pending.max_fee_per_gas,
        )?;
        let block = self
            .reader
            .call(
                "eth_getBlockByNumber",
                json!([receipt["blockNumber"], false]),
            )
            .await?;
        ensure!(
            eth::hash(&block["hash"])? == eth::hash(&receipt["blockHash"])?
                && block["number"] == receipt["blockNumber"],
            "RECEIPT_BLOCK_NOT_CANONICAL_KEEP_PENDING"
        );
        let receipt_to = if receipt["to"].is_null() {
            None
        } else {
            Some(
                receipt["to"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("INVALID_RECEIPT_DESTINATION"))?
                    .parse::<Address>()
                    .map_err(|_| anyhow::anyhow!("INVALID_RECEIPT_DESTINATION"))?,
            )
        };
        ensure!(receipt_to == pending.to, "RECEIPT_DESTINATION_MISMATCH");
        let status = eth::quantity64(&receipt["status"])?;
        ensure!(status <= 1, "INVALID_RECEIPT_STATUS");
        if status == 1
            && let Action::Mint {
                requested,
                factory,
                minters,
                ..
            } = &pending.action
        {
            let minted = verify_mint_receipt(&receipt, &self.cfg, *factory, minters, *requested)?;
            emit(
                store,
                json!({"event":"mint_receipt_verified","minted":minted,"requested":requested,"hash":pending.hash}),
            ).await?;
        }
        let factory = if status == 1 {
            match &pending.action {
                Action::DeployFactory { predicted } => {
                    let deployed: Address = receipt["contractAddress"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("DEPLOYMENT_ADDRESS_MISSING"))?
                        .parse()
                        .map_err(|_| anyhow::anyhow!("INVALID_DEPLOYMENT_ADDRESS"))?;
                    ensure!(deployed == *predicted, "DEPLOYMENT_ADDRESS_MISMATCH");
                    chain::verify_factory(
                        &mut self.reader,
                        &self.cfg,
                        deployed,
                        receipt["blockNumber"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("RECEIPT_BLOCK_MISSING"))?,
                    )
                    .await?;
                    Some(deployed)
                }
                _ => None,
            }
        } else {
            None
        };
        emit(
            store,
            json!({"event":"receipt","hash":pending.hash,"status":status,"gasCostWei":cost.to_string(),"block":receipt["blockNumber"]}),
        ).await?;
        store.resolve(pending.hash, cost, factory).await?;
        ensure!(status == 1, "TRANSACTION_REVERTED_GAS_COST_RECORDED");
        Ok(Some(receipt))
    }
    async fn submit(
        &mut self,
        store: &mut Store,
        signer: &Signer,
        submission: Submission,
    ) -> Result<Value> {
        let Submission {
            to,
            data,
            quote,
            action,
            valid_until,
        } = submission;
        ensure!(
            store.state.pending.is_none(),
            "UNRESOLVED_TRANSACTION_RECOVER_FIRST"
        );
        ensure!(
            signer.address() == self.cfg.wallet,
            "SIGNER_WALLET_MISMATCH"
        );
        let signing = Instant::now();
        let signed = signer.sign(&TxRequest {
            chain_id: CHAIN_ID,
            nonce: quote.nonce,
            gas_limit: quote.gas_limit,
            max_fee_per_gas: quote.max_fee,
            max_priority_fee_per_gas: quote.priority_fee,
            to,
            input: data,
        })?;
        let signing_ms = signing.elapsed().as_secs_f64() * 1_000.;
        ensure!(
            valid_until.is_none_or(|t| Instant::now() < t),
            "PREPARATION_EXPIRED_BEFORE_SIGNING_COMPLETED"
        );
        store
            .intent(Pending {
                hash: signed.hash,
                nonce: quote.nonce,
                to,
                action,
                gas_limit: quote.gas_limit,
                max_fee_per_gas: quote.max_fee,
                max_cost_wei: quote.max_cost,
            })
            .await?;
        if valid_until.is_some_and(|t| Instant::now() >= t) {
            // No send future has been created or polled, so clearing this local
            // intent is safe. A cancellation AFTER send never follows this path.
            store.resolve(signed.hash, 0, None).await?;
            anyhow::bail!("PREPARATION_EXPIRED_DURING_DURABLE_INTENT_NO_SEND");
        }
        emit(
            store,
            json!({"event":"signed_intent","hash":signed.hash,"signingMs":signing_ms,"gasLimit":quote.gas_limit,"maxFeePerGasWei":quote.max_fee.to_string(),"maxGasCostWei":quote.max_cost.to_string()}),
        ).await?;
        if valid_until.is_some_and(|t| Instant::now() >= t) {
            store.resolve(signed.hash, 0, None).await?;
            anyhow::bail!("PREPARATION_EXPIRED_DURING_LOG_WRITE_NO_SEND");
        }
        let started = Instant::now();
        let raw = &signed.raw;
        let hash = signed.hash;
        let sends = stream::iter(self.senders.iter_mut().map(|(index, client)| async move {
            let t = Instant::now();
            if valid_until.is_some_and(|deadline| t >= deadline) {
                return (
                    *index,
                    false,
                    0.,
                    Some("PREPARATION_EXPIRED_QUEUED_SEND_SKIPPED".to_owned()),
                );
            }
            let result = client.call("eth_sendRawTransaction", json!([raw])).await;
            let accepted = matches!(&result,Ok(v)if eth::hash(v).is_ok_and(|h|h==hash));
            (
                *index,
                accepted,
                t.elapsed().as_secs_f64() * 1_000.,
                result.err().map(|e| e.to_string()),
            )
        }))
        .buffer_unordered(self.cfg.concurrency);
        let outcomes = sends.collect::<Vec<_>>().await;
        for (index, accepted, ack_ms, error) in &outcomes {
            emit(
                store,
                json!({"event":"rpc_ack","endpointIndex":index,"accepted":accepted,"roundTripMs":ack_ms,"error":error}),
            ).await?;
        }
        // Even total ACK loss may be a successful broadcast. Resolve the SAME
        // hash; never increment nonce, rebuild or retry a deployment blindly.
        let receipt = self
            .recover(store, true)
            .await?
            .ok_or_else(|| anyhow::anyhow!("MISSING_SUBMITTED_RECEIPT"))?;
        emit(
            store,
            json!({"event":"submission_complete","hash":hash,"receiptObservedMs":started.elapsed().as_secs_f64()*1_000.}),
        ).await?;
        Ok(receipt)
    }
    async fn prepare(
        &mut self,
        store: &mut Store,
        signer: Option<&Signer>,
        send: bool,
    ) -> Result<bool> {
        if self.cfg.quantity == 1 {
            return Ok(true);
        }
        let snap = chain::snapshot(&mut self.reader, &self.cfg).await?;
        ensure!(
            snap.remaining >= u64::from(self.cfg.min_quantity),
            "INSUFFICIENT_REMAINING_SUPPLY"
        );
        if store.state.factory.is_none() {
            let artifact = Artifact::load("GenesisChildFactory")?;
            let mut data = artifact.init;
            data.extend((self.cfg.nft, self.cfg.recipient()).abi_encode());
            let transaction = chain::tx(self.cfg.wallet, None, &data, None);
            let q = chain::quote(
                &mut self.reader,
                &self.cfg,
                &transaction,
                0,
                store.state.gas_cost_wei,
                self.local,
            )
            .await?;
            emit(
                store,
                json!({"event":"factory_plan","gasLimit":q.gas_limit,"maxGasCostWei":q.max_cost.to_string(),"send":send}),
            ).await?;
            if !send {
                return Ok(false);
            }
            let predicted = predict_create(self.cfg.wallet, q.nonce);
            self.submit(
                store,
                signer.ok_or_else(|| anyhow::anyhow!("SIGNER_REQUIRED"))?,
                Submission {
                    to: None,
                    data,
                    quote: q,
                    action: Action::DeployFactory { predicted },
                    valid_until: None,
                },
            )
            .await?;
        }
        let factory = store
            .state
            .factory
            .ok_or_else(|| anyhow::anyhow!("FACTORY_REQUIRED"))?;
        let h = chain::head(&mut self.reader).await?;
        let (count, unused) = chain::children(&mut self.reader, &self.cfg, factory, &h.tag).await?;
        let desired = u64::from(self.cfg.quantity).min(snap.remaining);
        let missing = desired.saturating_sub(unused.len().try_into()?);
        if missing > 0 {
            ensure!(count + missing <= 1024, "FACTORY_CHILD_LIMIT_REACHED");
            let data = Factory::prepareChildrenCall {
                count: U256::from(missing),
            }
            .abi_encode();
            let transaction = chain::tx(self.cfg.wallet, Some(factory), &data, None);
            let q = chain::quote(
                &mut self.reader,
                &self.cfg,
                &transaction,
                0,
                store.state.gas_cost_wei,
                self.local,
            )
            .await?;
            emit(
                store,
                json!({"event":"children_plan","factory":factory,"existingUnused":unused.len(),"additional":missing,"gasLimit":q.gas_limit,"send":send}),
            ).await?;
            if !send {
                return Ok(false);
            }
            self.submit(
                store,
                signer.ok_or_else(|| anyhow::anyhow!("SIGNER_REQUIRED"))?,
                Submission {
                    to: Some(factory),
                    data,
                    quote: q,
                    action: Action::PrepareChildren {
                        count: missing.try_into()?,
                    },
                    valid_until: None,
                },
            )
            .await?;
        }
        let h = chain::head(&mut self.reader).await?;
        let (_, unused) = chain::children(&mut self.reader, &self.cfg, factory, &h.tag).await?;
        ensure!(
            unused.len() >= usize::try_from(desired)?,
            "CHILD_PREPARATION_INCOMPLETE"
        );
        emit(
            store,
            json!({"event":"children_ready","factory":factory,"children":unused.iter().map(|c|json!({"index":c.index,"address":c.address})).collect::<Vec<_>>()}),
        ).await?;
        Ok(true)
    }
    async fn fetch_batch(
        &mut self,
        store: &Store,
        api: Option<&OpenSeaClient>,
        children: &[ChildAddress],
        snapshot: &chain::Snapshot,
        api_failures: &mut u8,
    ) -> Result<Option<Batch>> {
        let active = snapshot
            .drops
            .iter()
            .find(|d| d.active(snapshot.head.timestamp));
        if self.cfg.mode != Mode::Signed
            && let Some(drop) = active
        {
            let mut items = Vec::new();
            for child in children
                .iter()
                .take(usize::try_from(snapshot.remaining)?.min(usize::from(self.cfg.quantity)))
            {
                let expected = approve(&self.cfg, &drop.route, child.address);
                let input = payload::build_public(&expected)?;
                items.push(PreparedChild {
                    child: ChildAddress {
                        index: child.index,
                        address: child.address,
                    },
                    route: drop.route.clone(),
                    payload: payload::validate(&input, &expected)?,
                    fetched: Instant::now(),
                });
            }
            return Ok(Some(Batch {
                items,
                created: Instant::now(),
            }));
        }
        if self.cfg.mode == Mode::Public {
            return Ok(None);
        }
        let api = api.ok_or_else(|| anyhow::anyhow!("OPENSEA_API_KEY_REQUIRED_FOR_SIGNED_MODE"))?;
        let cfg = &self.cfg;
        let mut pending = stream::iter(children.iter().map(|child| async move {
            let fetched = Instant::now();
            (
                child,
                fetched,
                api.mint(&cfg.collection_slug, child.address).await,
            )
        }))
        .buffer_unordered(self.cfg.concurrency);
        let mut items = Vec::new();
        while let Some((child, fetched, result)) = pending.next().await {
            match result {
                Ok(raw) => {
                    let route = self
                        .cfg
                        .routes
                        .iter()
                        .find(|r| r.sea_drop == raw.target)
                        .ok_or_else(|| {
                            anyhow::anyhow!("API_ROUTE_NOT_APPROVED_UPDATE_CONFIG_BEFORE_RETRY")
                        })?;
                    ensure!(
                        snapshot
                            .drops
                            .iter()
                            .any(|d| d.route.sea_drop == route.sea_drop),
                        "API_ROUTE_NO_LONGER_ALLOWED_BY_NFT"
                    );
                    let validated =
                        payload::validate(&raw, &approve(&self.cfg, route, child.address))?;
                    ensure!(
                        self.cfg.mode != Mode::Signed || validated.kind == MintKind::Signed,
                        "API_RETURNED_DIFFERENT_STAGE_MODE"
                    );
                    *api_failures = 0;
                    items.push(PreparedChild {
                        child: ChildAddress {
                            index: child.index,
                            address: child.address,
                        },
                        route: route.clone(),
                        payload: validated,
                        fetched,
                    });
                }
                Err(ApiError::NotActive) => {
                    emit(
                        store,
                        json!({"event":"api_wait","reason":"stage_not_active"}),
                    )
                    .await?;
                    return Ok(None);
                }
                Err(ApiError::RateLimited {
                    retry_after_seconds,
                }) => {
                    *api_failures = api_failures.saturating_add(1);
                    emit(
                        store,
                        json!({"event":"api_rate_limited","retryAfterSeconds":retry_after_seconds,"consecutiveFailures":*api_failures}),
                    ).await?;
                    ensure!(*api_failures < 3, "THREE_CONSECUTIVE_API_FAILURES_STOPPED");
                    // Cancel other read-only requests before respecting the server's delay.
                    drop(pending);
                    tokio::time::sleep(Duration::from_secs(retry_after_seconds)).await;
                    return Ok(None);
                }
                Err(e @ ApiError::NotEligible)
                | Err(e @ ApiError::Timeout)
                | Err(e @ ApiError::Transport)
                | Err(e @ ApiError::Http { .. }) => {
                    *api_failures = api_failures.saturating_add(1);
                    emit(
                        store,
                        json!({"event":"child_payload_unavailable","child":child.address,"reason":e.to_string(),"consecutiveFailures":*api_failures}),
                    ).await?;
                    ensure!(*api_failures < 3, "THREE_CONSECUTIVE_API_FAILURES_STOPPED");
                }
                Err(error) => return Err(error.into()),
            }
        }
        items.sort_by_key(|p| p.child.index);
        if items.len() < usize::from(self.cfg.min_quantity) {
            return Ok(None);
        }
        let target = items[0].route.sea_drop;
        ensure!(
            items.iter().all(|p| p.route.sea_drop == target
                && p.route.fee_recipient == items[0].route.fee_recipient),
            "API_ROUTE_CHANGED_DURING_BATCH_REFRESH"
        );
        emit(
            store,
            json!({"event":"payloads_ready","count":items.len(),"seaDrop":target,"refreshMs":self.cfg.payload_refresh_ms}),
        ).await?;
        Ok(Some(Batch {
            items,
            created: Instant::now(),
        }))
    }
    async fn wait_mint(
        &mut self,
        store: &mut Store,
        signer: Option<&Signer>,
        api: Option<&OpenSeaClient>,
        send: bool,
    ) -> Result<u8> {
        let h = chain::head(&mut self.reader).await?;
        let children = if self.cfg.quantity == 1 {
            vec![ChildAddress {
                index: 0,
                address: self.cfg.wallet,
            }]
        } else {
            let factory = store
                .state
                .factory
                .ok_or_else(|| anyhow::anyhow!("EXISTING_FACTORY_REQUIRED"))?;
            let (_, children) =
                chain::children(&mut self.reader, &self.cfg, factory, &h.tag).await?;
            ensure!(
                children.len() >= usize::from(self.cfg.min_quantity),
                "INSUFFICIENT_UNUSED_CHILDREN_RUN_PREPARE"
            );
            children
        };
        let factory = if self.cfg.quantity == 1 {
            None
        } else {
            store.state.factory
        };
        let started = Instant::now();
        let mut last_heartbeat = Instant::now();
        let mut last_progress = Instant::now();
        let mut batch: Option<Batch> = None;
        let mut api_failures = 0u8;
        let mut simulation_failures = 0u8;
        loop {
            ensure!(
                started.elapsed() < Duration::from_secs(self.cfg.wait_timeout_secs),
                "MINT_WAIT_TIMEOUT"
            );
            let snapshot = chain::snapshot(&mut self.reader, &self.cfg).await?;
            ensure!(
                snapshot.remaining >= u64::from(self.cfg.min_quantity),
                "SOLD_OUT_OR_BELOW_MINIMUM"
            );
            if send && last_heartbeat.elapsed() >= Duration::from_secs(10) {
                self.heartbeat().await?;
                last_heartbeat = Instant::now();
            }
            let active_public = if self.cfg.mode != Mode::Signed {
                snapshot
                    .drops
                    .iter()
                    .find(|d| d.active(snapshot.head.timestamp))
                    .map(|d| d.route.sea_drop)
            } else {
                None
            };
            let stale = batch.as_ref().is_none_or(|b| {
                b.created.elapsed() >= Duration::from_millis(self.cfg.payload_refresh_ms)
                    || b.items.iter().any(|p| {
                        p.fetched.elapsed() >= Duration::from_millis(self.cfg.max_payload_age_ms)
                    })
                    || active_public.is_some_and(|a| {
                        b.items
                            .iter()
                            .any(|p| p.payload.kind != MintKind::Public || p.route.sea_drop != a)
                    })
            });
            if stale {
                batch = self
                    .fetch_batch(store, api, &children, &snapshot, &mut api_failures)
                    .await?;
            }
            let released = self
                .cfg
                .wait_until_timestamp
                .is_none_or(|t| snapshot.head.timestamp >= t)
                && self
                    .cfg
                    .wait_until_block
                    .is_none_or(|b| snapshot.head.number >= b);
            let time_ready = batch.as_ref().is_some_and(|b| {
                !b.items.is_empty()
                    && b.items.iter().all(|p| {
                        p.payload.params.as_ref().is_none_or(|v| {
                            v.startTime <= U256::from(snapshot.head.timestamp)
                                && v.endTime
                                    >= U256::from(snapshot.head.timestamp)
                                        + U256::from(self.cfg.min_signature_remaining_secs)
                        })
                    })
            });
            if !released || !time_ready {
                if last_progress.elapsed() >= Duration::from_secs(10) {
                    emit(
                        store,
                        json!({"event":"waiting","block":snapshot.head.number,"chainTimestamp":snapshot.head.timestamp,"remaining":snapshot.remaining,"payloadCount":batch.as_ref().map_or(0,|b|b.items.len())}),
                    ).await?;
                    last_progress = Instant::now();
                }
                tokio::time::sleep(Duration::from_millis(self.cfg.poll_interval_ms)).await;
                continue;
            }
            let ready = batch
                .take()
                .ok_or_else(|| anyhow::anyhow!("MISSING_PREPARED_BATCH"))?;
            let outcome = self
                .finalize_batch(store, signer, ready, factory, send)
                .await;
            match outcome {
                Ok(code) => return Ok(code),
                Err(error) => {
                    // Once any send could have occurred, state/pending controls recovery.
                    // Only explicitly classified pre-broadcast stale state is refreshed.
                    if error.downcast_ref::<RefreshRequired>().is_none() {
                        return Err(error);
                    }
                    simulation_failures = simulation_failures.saturating_add(1);
                    emit(
                        store,
                        json!({"event":"preparation_invalidated","reason":error.to_string(),"consecutiveFailures":simulation_failures}),
                    ).await?;
                    ensure!(
                        simulation_failures < 3,
                        "THREE_CONSECUTIVE_PREFLIGHT_FAILURES_STOPPED"
                    );
                    tokio::time::sleep(Duration::from_millis(self.cfg.payload_refresh_ms)).await;
                }
            }
        }
    }
    async fn finalize_batch(
        &mut self,
        store: &mut Store,
        signer: Option<&Signer>,
        mut batch: Batch,
        factory: Option<Address>,
        send: bool,
    ) -> Result<u8> {
        let snapshot = chain::snapshot(&mut self.reader, &self.cfg).await?;
        let count = usize::try_from(snapshot.remaining)?
            .min(usize::from(self.cfg.quantity))
            .min(batch.items.len());
        ensure!(
            count >= usize::from(self.cfg.min_quantity),
            "INSUFFICIENT_AVAILABLE_BATCH"
        );
        batch.items.truncate(count);
        for item in &batch.items {
            if item.fetched.elapsed() >= Duration::from_millis(self.cfg.max_payload_age_ms) {
                return Err(RefreshRequired("PAYLOAD_MAX_AGE_EXCEEDED".into()).into());
            }
            if !snapshot
                .drops
                .iter()
                .any(|d| d.route.sea_drop == item.route.sea_drop)
            {
                return Err(RefreshRequired("SEADROP_ROUTE_REMOVED".into()).into());
            }
            if let Err(error) = chain::validate_live(
                &mut self.reader,
                &self.cfg,
                &item.route,
                item.child.address,
                factory,
                &item.payload,
                &snapshot.head,
            )
            .await
            {
                return Err(RefreshRequired(format!("CHILD_VALIDATION_FAILED: {error}")).into());
            }
        }
        let route = &batch.items[0].route;
        let (to, data, minimum_gas) = if let Some(factory) = factory {
            (
                factory,
                Factory::mintBatchCall {
                    seaDrop: route.sea_drop,
                    feeRecipient: route.fee_recipient,
                    childIndices: batch
                        .items
                        .iter()
                        .map(|p| U256::from(p.child.index))
                        .collect(),
                    payloads: batch
                        .items
                        .iter()
                        .map(|p| p.payload.data.clone().into())
                        .collect(),
                    maxCount: U256::from(count),
                    gasPerChild: U256::from(self.cfg.gas_per_child),
                }
                .abi_encode(),
                chain::batch_gas(count, self.cfg.gas_per_child)?,
            )
        } else {
            (route.sea_drop, batch.items[0].payload.data.clone(), 0)
        };
        let transaction = chain::tx(
            self.cfg.wallet,
            Some(to),
            &data,
            (minimum_gas > 0).then_some(minimum_gas),
        );
        let q = chain::quote(
            &mut self.reader,
            &self.cfg,
            &transaction,
            minimum_gas,
            store.state.gas_cost_wei,
            self.local,
        )
        .await?;
        // Fee/nonce checks finish BEFORE the final exact-gas eth_call. The gas
        // floor is essential: this factory intentionally returns0 on low gas.
        let final_start = Instant::now();
        let fresh = chain::snapshot(&mut self.reader, &self.cfg).await?;
        ensure!(
            self.cfg
                .wait_until_timestamp
                .is_none_or(|t| fresh.head.timestamp >= t)
                && self
                    .cfg
                    .wait_until_block
                    .is_none_or(|b| fresh.head.number >= b),
            "RPC_BELOW_REQUESTED_START_BOUNDARY"
        );
        for p in &batch.items {
            if p.fetched.elapsed() >= Duration::from_millis(self.cfg.max_payload_age_ms)
                || p.payload.params.as_ref().is_some_and(|v| {
                    v.endTime
                        < U256::from(fresh.head.timestamp)
                            + U256::from(self.cfg.min_signature_remaining_secs)
                })
            {
                return Err(RefreshRequired("PAYLOAD_AGE_OR_SIGNATURE_EXPIRY".into()).into());
            }
        }
        let final_tx = chain::tx(self.cfg.wallet, Some(to), &data, Some(q.gas_limit));
        let result = self
            .reader
            .call("eth_call", json!([final_tx, fresh.head.tag]))
            .await
            .map_err(|error| RefreshRequired(format!("FINAL_SIMULATION_FAILED: {error}")))?;
        let result = eth::bytes(&result)?;
        let predicted = if factory.is_some() {
            let value = U256::abi_decode_validate(&result)
                .map_err(|_| anyhow::anyhow!("INVALID_BATCH_SIMULATION"))?;
            ensure!(
                value <= U256::from(count),
                "UNEXPECTED_SIMULATED_MINT_COUNT"
            );
            value.to::<u64>()
        } else {
            ensure!(result.is_empty(), "INVALID_DIRECT_SIMULATION");
            1
        };
        if predicted < u64::from(self.cfg.min_quantity) {
            return Err(RefreshRequired("SIMULATED_COUNT_BELOW_MINIMUM".into()).into());
        }
        ensure!(
            predicted <= u64::from(self.cfg.quantity),
            "UNEXPECTED_SIMULATED_MINT_COUNT"
        );
        let valid_until = batch.items.iter().fold(
            final_start + Duration::from_millis(self.cfg.max_preflight_age_ms),
            |deadline, p| {
                deadline.min(p.fetched + Duration::from_millis(self.cfg.max_payload_age_ms))
            },
        );
        if Instant::now() >= valid_until {
            return Err(RefreshRequired("FINAL_PREPARATION_DEADLINE_EXCEEDED".into()).into());
        }
        emit(
            store,
            json!({"event":"mint_preflight","route":if factory.is_some(){"children"}else{"direct"},"predicted":predicted,"requested":self.cfg.quantity,"gasLimit":q.gas_limit,"maxGasCostWei":q.max_cost.to_string(),"finalPreflightMs":final_start.elapsed().as_secs_f64()*1_000.,"send":send}),
        ).await?;
        if !send {
            return Ok(0);
        }
        let receipt = self
            .submit(
                store,
                signer.ok_or_else(|| anyhow::anyhow!("SIGNER_REQUIRED"))?,
                Submission {
                    to: Some(to),
                    data,
                    quote: q,
                    action: Action::Mint {
                        requested: count.try_into()?,
                        minimum: self.cfg.min_quantity,
                        factory,
                        minters: batch.items.iter().map(|p| p.child.address).collect(),
                    },
                    valid_until: Some(valid_until),
                },
            )
            .await?;
        let minted = verify_mint_receipt(
            &receipt,
            &self.cfg,
            factory,
            &batch
                .items
                .iter()
                .map(|p| p.child.address)
                .collect::<Vec<_>>(),
            count.try_into()?,
        )?;
        emit(
            store,
            json!({"event":"mint_result","minted":minted,"requested":self.cfg.quantity,"minimum":self.cfg.min_quantity,"totalGasCostWei":store.state.gas_cost_wei.to_string(),"hash":receipt["transactionHash"]}),
        ).await?;
        Ok(if minted >= u64::from(self.cfg.min_quantity) {
            0
        } else {
            2
        })
    }
    pub async fn execute(
        &mut self,
        store: &mut Store,
        signer: Option<&Signer>,
        api: Option<&OpenSeaClient>,
        options: &Options,
    ) -> Result<u8> {
        if options.command == Command::Recover {
            let pending = store.state.pending.clone();
            if let Some(receipt) = self.recover(store, false).await?
                && let Some(Pending {
                    action:
                        Action::Mint {
                            requested,
                            minimum,
                            factory,
                            minters,
                        },
                    ..
                }) = pending
            {
                let minted =
                    verify_mint_receipt(&receipt, &self.cfg, factory, &minters, requested)?;
                emit(
                    store,
                    json!({"event":"recovered_existing_mint_no_new_submission",
                    "minted":minted,"requested":requested,"hash":receipt["transactionHash"]}),
                )
                .await?;
                return Ok(if minted >= u64::from(minimum) { 0 } else { 2 });
            }
            return Ok(0);
        }
        if options.command == Command::Preflight {
            self.preflight(store).await?;
            return Ok(0);
        }
        if let Some(pending) = store.state.pending.clone() {
            let receipt = self.recover(store, false).await?;
            if let Action::Mint {
                requested,
                minimum,
                factory,
                minters,
            } = pending.action
            {
                let receipt = receipt.ok_or_else(|| anyhow::anyhow!("RECOVERY_RECEIPT_MISSING"))?;
                let minted =
                    verify_mint_receipt(&receipt, &self.cfg, factory, &minters, requested)?;
                emit(
                    store,
                    json!({"event":"recovered_existing_mint_no_new_submission","minted":minted,"requested":requested,"hash":pending.hash}),
                ).await?;
                ensure!(
                    options.command != Command::CheckChildren,
                    "PENDING_MINT_RECOVERED_CHILD_CHECK_NOT_PERFORMED_RERUN_CHECK"
                );
                return Ok(if minted >= u64::from(minimum) { 0 } else { 2 });
            }
        }
        self.preflight(store).await?;
        if options.send {
            self.warm_senders().await?;
        }
        if options.command == Command::CheckChildren {
            ensure!(
                self.cfg.quantity == 2
                    && self.cfg.min_quantity == 2
                    && self.cfg.mode == Mode::Signed,
                "CHILD_CHECK_REQUIRES_QUANTITY_2_MINIMUM_2_SIGNED_MODE"
            );
            if !self.prepare(store, signer, options.send).await? {
                anyhow::bail!("CHILD_CHECK_NEEDS_PREPARED_CHILDREN_USE_SEND_FOR_PREPARATION_ONLY");
            }
            // This path never passes `send = true` to mint orchestration. Only
            // deployment/preparation above may broadcast. Limit the API probe
            // to one batch: two minters, no key rotation or repeated polling.
            let checked = match tokio::time::timeout(
                Duration::from_secs(self.cfg.wait_timeout_secs),
                self.check_children(store, api),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("CHILD_CHECK_TIMEOUT_MINT_NOT_SENT")),
            };
            if let Err(error) = &checked {
                emit(
                    store,
                    json!({"event":"child_check_result","passed":false,"mintSent":false,
                    "reason":error.to_string(),"factory":store.state.factory}),
                )
                .await?;
            }
            return checked;
        }
        if matches!(options.command, Command::Prepare | Command::Setup) {
            if !self.prepare(store, signer, options.send).await? {
                emit(
                    store,
                    json!({"event":"dry_run_prepare_only","reason":"real_factory_or_children_required_for_later_mint_simulation"}),
                ).await?;
                return Ok(0);
            }
            if options.command == Command::Prepare {
                return Ok(0);
            }
        }
        tokio::time::timeout(
            Duration::from_secs(self.cfg.wait_timeout_secs),
            self.wait_mint(store, signer, api, options.send),
        )
        .await
        .map_err(|_| anyhow::anyhow!("MINT_WAIT_TIMEOUT_CHECK_PENDING_HASH"))?
    }
    async fn check_children(
        &mut self,
        store: &mut Store,
        api: Option<&OpenSeaClient>,
    ) -> Result<u8> {
        let factory = store
            .state
            .factory
            .ok_or_else(|| anyhow::anyhow!("EXISTING_FACTORY_REQUIRED"))?;
        let snapshot = chain::snapshot(&mut self.reader, &self.cfg).await?;
        ensure!(snapshot.remaining >= 2, "FEWER_THAN_TWO_NFT_AVAILABLE");
        let (_, children) =
            chain::children(&mut self.reader, &self.cfg, factory, &snapshot.head.tag).await?;
        ensure!(children.len() == 2, "TWO_UNUSED_CHILDREN_REQUIRED");
        let mut failures = 0;
        let batch = self
            .fetch_batch(store, api, &children, &snapshot, &mut failures)
            .await?
            .ok_or_else(|| anyhow::anyhow!("CHILD_ELIGIBILITY_INCONCLUSIVE_CHECK_API_EVENTS"))?;
        self.finalize_batch(store, None, batch, Some(factory), false)
            .await?;
        emit(
            store,
            json!({"event":"child_check_result","passed":true,"mintSent":false,
            "simulatedMintCount":2,"factory":factory,
            "children":children.iter().map(|c|c.address).collect::<Vec<_>>(),
            "totalGasCostWei":store.state.gas_cost_wei.to_string()}),
        )
        .await?;
        println!(
            "CHECK PASSED: OpenSea authorized both children; both mints and transfers simulated successfully. No mint transaction was sent."
        );
        Ok(0)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("MINT_PREPARATION_REFRESH_REQUIRED: {0}")]
struct RefreshRequired(String);

fn verify_mint_receipt(
    receipt: &Value,
    cfg: &Config,
    factory: Option<Address>,
    minters: &[Address],
    requested: u16,
) -> Result<u64> {
    ensure!(
        !minters.is_empty() && minters.len() <= 100 && minters.len() == usize::from(requested),
        "INVALID_SAVED_MINT_INTENT"
    );
    let logs = receipt["logs"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("RECEIPT_LOGS_MISSING"))?;
    let mut minted = BTreeSet::new();
    let mut received = BTreeSet::new();
    let mut summaries = Vec::new();
    for value in logs {
        let address: Address = value["address"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("INVALID_LOG_ADDRESS"))?
            .parse()
            .map_err(|_| anyhow::anyhow!("INVALID_LOG_ADDRESS"))?;
        let topics = value["topics"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("INVALID_LOG_TOPICS"))?
            .iter()
            .map(eth::hash)
            .collect::<Result<Vec<B256>>>()?;
        let data = eth::bytes(&value["data"])?;
        if address == cfg.nft && topics.first() == Some(&Nft::Transfer::SIGNATURE_HASH) {
            let event = Nft::Transfer::decode_raw_log_validate(topics.iter().copied(), &data)
                .map_err(|_| anyhow::anyhow!("INVALID_TRANSFER_EVENT"))?;
            if event.from == Address::ZERO && minters.contains(&event.to) {
                minted.insert(event.tokenId);
            }
            if event.to == cfg.recipient() {
                received.insert(event.tokenId);
            }
        }
        if Some(address) == factory && topics.first() == Some(&Factory::BatchResult::SIGNATURE_HASH)
        {
            let e = Factory::BatchResult::decode_raw_log_validate(topics.iter().copied(), &data)
                .map_err(|_| anyhow::anyhow!("INVALID_BATCH_RESULT_EVENT"))?;
            summaries.push((e.minted, e.attempted));
        }
    }
    ensure!(
        minted.is_subset(&received),
        "MINTED_NFT_TRANSFER_NOT_CONFIRMED"
    );
    let count = u64::try_from(minted.len())?;
    ensure!(
        count <= u64::from(requested),
        "UNEXPECTED_RECEIPT_MINT_COUNT"
    );
    if factory.is_some() {
        ensure!(
            summaries.len() == 1
                && summaries[0].0 == U256::from(count)
                && summaries[0].1 <= U256::from(minters.len()),
            "BATCH_EVENT_COUNT_MISMATCH"
        );
    } else {
        ensure!(count == 1, "DIRECT_MINT_EVENT_MISSING");
    }
    Ok(count)
}
