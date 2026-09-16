//! Receipt visibility observer for a bounded ten-transaction sampling window.
//! Registration never waits for a receipt. One owned task reuses a read client
//! and polls one pending hash per 100 ms, in round-robin order. Its latency is
//! RPC-visible latency including polling, not the precise inclusion timestamp.
//! With ten pending hashes and fast RPC replies, a hash is revisited roughly
//! once per second; slow reads add further delay.

use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};

use alloy_primitives::B256;
use serde::Serialize;
use serde_json::json;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{Instant, sleep_until},
};

use crate::{
    metrics::Receipt,
    rpc::{RpcClient, RpcError},
};

const CAPACITY: usize = 10;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const RPC_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum ObserverError {
    #[error("INVALID_RECEIPT_TIMEOUT")]
    InvalidTimeout,
    #[error("RECEIPT_OBSERVER_CAPACITY_10")]
    Capacity,
    #[error("RECEIPT_HASH_ALREADY_REGISTERED")]
    Duplicate,
    #[error("RECEIPT_OBSERVER_CLOSED")]
    Closed,
    #[error("INVALID_RECEIPT_START_TIME")]
    InvalidStart,
    #[error("RECEIPT_OBSERVER_TASK_FAILED")]
    TaskFailed,
    #[error("RECEIPT_OBSERVER_UPDATES_ALREADY_TAKEN")]
    UpdatesAlreadyTaken,
    #[error("RECEIPT_OBSERVER_UPDATES_CAPACITY_INVARIANT")]
    UpdatesOverflow,
    #[error("RECEIPT_OBSERVER_CONNECT: {0}")]
    Connect(#[from] RpcError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObservationError {
    ReceiptTimeout,
    InvalidReceipt,
    RpcTimeout,
    RpcNetwork,
    RpcHttpStatus { status: u16 },
    RpcProtocol,
    RpcResponseTooLarge,
    RpcRemote { code: i64 },
    RpcClosed,
    ObserverStopped,
}

impl From<RpcError> for ObservationError {
    fn from(error: RpcError) -> Self {
        match error {
            RpcError::Timeout => Self::RpcTimeout,
            RpcError::Network => Self::RpcNetwork,
            RpcError::HttpStatus(status) => Self::RpcHttpStatus { status },
            RpcError::ResponseTooLarge => Self::RpcResponseTooLarge,
            RpcError::Remote { code } => Self::RpcRemote { code },
            RpcError::Closed => Self::RpcClosed,
            RpcError::Protocol | RpcError::InvalidRequest | RpcError::InvalidUrl => {
                Self::RpcProtocol
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub hash: B256,
    pub receipt: Option<Receipt>,
    pub observed_after_send_ms: Option<f64>,
    pub error: Option<ObservationError>,
}

struct Watch {
    hash: B256,
    started: Instant,
    deadline: Instant,
    order: usize,
}

impl Watch {
    fn failure(&self, error: ObservationError) -> (usize, Observation) {
        (
            self.order,
            Observation {
                hash: self.hash,
                receipt: None,
                observed_after_send_ms: None,
                error: Some(error),
            },
        )
    }
}

/// Owns the task and its only sender. The small mutex guards registration from
/// concurrent callers; its guard never crosses an await. No task is detached,
/// including when the future returned by `finish` is itself cancelled.
pub struct ReceiptWatcher {
    sender: Option<mpsc::Sender<Watch>>,
    updates: Option<mpsc::Receiver<Observation>>,
    task: Option<JoinHandle<Result<Vec<Observation>, ObserverError>>>,
    registered: Mutex<HashSet<B256>>,
    receipt_timeout: Duration,
}

impl ReceiptWatcher {
    /// `receipt_timeout` applies separately from each supplied send instant.
    /// Read requests have a five-second cap and never outlive that watch's
    /// deadline. This constructor does not send any blockchain transaction.
    pub async fn start(read_url: &str, receipt_timeout: Duration) -> Result<Self, ObserverError> {
        Self::start_with_interval(read_url, receipt_timeout, POLL_INTERVAL).await
    }

    async fn start_with_interval(
        read_url: &str,
        receipt_timeout: Duration,
        interval: Duration,
    ) -> Result<Self, ObserverError> {
        if receipt_timeout.is_zero()
            || receipt_timeout > Duration::from_secs(120)
            || interval.is_zero()
        {
            return Err(ObserverError::InvalidTimeout);
        }
        let client = RpcClient::connect(read_url, RPC_TIMEOUT).await?;
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let (updates_sender, updates) = mpsc::channel(CAPACITY);
        let task = tokio::spawn(observe(client, receiver, updates_sender, interval));
        Ok(Self {
            sender: Some(sender),
            updates: Some(updates),
            task: Some(task),
            registered: Mutex::new(HashSet::with_capacity(CAPACITY)),
            receipt_timeout,
        })
    }

    /// Take the single terminal-update receiver. Updates arrive in completion
    /// order, once per accepted hash, and include both receipts and errors.
    /// The ten-item buffer holds the entire window, so leaving this receiver
    /// untaken or unread never stalls receipt polling. Dropping or closing the
    /// receiver intentionally opts out of updates; `finish` still collects all
    /// results in registration order. This method may only be called once.
    pub fn take_updates(&mut self) -> Result<mpsc::Receiver<Observation>, ObserverError> {
        self.updates
            .take()
            .ok_or(ObserverError::UpdatesAlreadyTaken)
    }

    /// Register just before or immediately after submitting the signed bytes.
    /// At most ten unique hashes may be registered over this watcher's lifetime.
    /// The call is nonblocking; full or closed input is reported to the sender.
    pub fn watch(&self, hash: B256, started: Instant) -> Result<(), ObserverError> {
        if started > Instant::now() {
            return Err(ObserverError::InvalidStart);
        }
        let deadline = started
            .checked_add(self.receipt_timeout)
            .ok_or(ObserverError::InvalidStart)?;
        let sender = self.sender.as_ref().ok_or(ObserverError::Closed)?;
        if sender.is_closed() {
            return Err(ObserverError::Closed);
        }
        let mut registered = self.registered.lock().map_err(|_| ObserverError::Closed)?;
        if registered.contains(&hash) {
            return Err(ObserverError::Duplicate);
        }
        if registered.len() >= CAPACITY {
            return Err(ObserverError::Capacity);
        }
        let order = registered.len();
        sender
            .try_send(Watch {
                hash,
                started,
                deadline,
                order,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ObserverError::Capacity,
                mpsc::error::TrySendError::Closed(_) => ObserverError::Closed,
            })?;
        registered.insert(hash);
        Ok(())
    }

    /// Close registration and collect every accepted hash in registration order.
    /// A failed read connection yields explicit errors for remaining hashes.
    pub async fn finish(mut self) -> Result<Vec<Observation>, ObserverError> {
        drop(self.sender.take());
        // Keep the handle inside self across await: dropping this finish future
        // then runs Drop below and aborts the owned task instead of detaching it.
        let result = self
            .task
            .as_mut()
            .ok_or(ObserverError::Closed)?
            .await
            .map_err(|_| ObserverError::TaskFailed);
        drop(self.task.take());
        result?
    }
}

impl Drop for ReceiptWatcher {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn observe(
    mut client: RpcClient,
    mut receiver: mpsc::Receiver<Watch>,
    updates: mpsc::Sender<Observation>,
    interval: Duration,
) -> Result<Vec<Observation>, ObserverError> {
    let mut pending = VecDeque::<Watch>::with_capacity(CAPACITY);
    let mut observations = Vec::with_capacity(CAPACITY);
    let mut input_closed = false;
    let mut next_poll = Instant::now();
    loop {
        while let Ok(watch) = receiver.try_recv() {
            pending.push_back(watch);
        }
        input_closed |= receiver.is_closed();
        let now = Instant::now();
        for _ in 0..pending.len() {
            let Some(watch) = pending.pop_front() else {
                break;
            };
            if watch.deadline <= now {
                record(
                    &mut observations,
                    &updates,
                    watch.failure(ObservationError::ReceiptTimeout),
                )?;
            } else {
                pending.push_back(watch);
            }
        }
        if pending.is_empty() {
            if input_closed {
                break;
            }
            match receiver.recv().await {
                Some(watch) => pending.push_back(watch),
                None => input_closed = true,
            }
            continue;
        }
        if now < next_poll {
            let wake = pending
                .iter()
                .map(|watch| watch.deadline)
                .min()
                .map_or(next_poll, |deadline| deadline.min(next_poll));
            tokio::select! {
                incoming = receiver.recv(), if !input_closed => match incoming {
                    Some(watch) => pending.push_back(watch),
                    None => input_closed = true,
                },
                _ = sleep_until(wake) => {},
            }
            continue;
        }
        let Some(watch) = pending.pop_front() else {
            continue;
        };
        next_poll = Instant::now() + interval;
        let result = tokio::time::timeout_at(
            watch.deadline,
            client.call("eth_getTransactionReceipt", json!([watch.hash])),
        )
        .await;
        match result {
            Ok(Ok(value)) if value.is_null() => pending.push_back(watch),
            Ok(Ok(value)) => {
                let observation = if Instant::now() >= watch.deadline {
                    watch.failure(ObservationError::ReceiptTimeout)
                } else {
                    match Receipt::parse(&value, watch.hash) {
                        Ok(receipt) => (
                            watch.order,
                            Observation {
                                hash: watch.hash,
                                receipt: Some(receipt),
                                observed_after_send_ms: Some(
                                    watch.started.elapsed().as_secs_f64() * 1000.0,
                                ),
                                error: None,
                            },
                        ),
                        Err(_) => watch.failure(ObservationError::InvalidReceipt),
                    }
                };
                record(&mut observations, &updates, observation)?;
            }
            Ok(Err(RpcError::Remote { code })) => {
                record(
                    &mut observations,
                    &updates,
                    watch.failure(ObservationError::RpcRemote { code }),
                )?;
            }
            failure => {
                let error = match failure {
                    Err(_) => ObservationError::ReceiptTimeout,
                    Ok(Err(error)) => ObservationError::from(error),
                    Ok(Ok(_)) => ObservationError::RpcProtocol,
                };
                record(&mut observations, &updates, watch.failure(error))?;
                // Timeout cancellation and transport/protocol failures poison
                // RpcClient. Stop here; never silently reconnect or report
                // queued watches as observed. Closing first prevents new input.
                receiver.close();
                while let Ok(watch) = receiver.try_recv() {
                    pending.push_back(watch);
                }
                for watch in pending.drain(..) {
                    record(
                        &mut observations,
                        &updates,
                        watch.failure(if watch.deadline <= Instant::now() {
                            ObservationError::ReceiptTimeout
                        } else {
                            ObservationError::ObserverStopped
                        }),
                    )?;
                }
                break;
            }
        }
    }
    observations.sort_by_key(|(order, _)| *order);
    Ok(observations
        .into_iter()
        .map(|(_, observation)| observation)
        .collect())
}

fn record(
    observations: &mut Vec<(usize, Observation)>,
    updates: &mpsc::Sender<Observation>,
    observation: (usize, Observation),
) -> Result<(), ObserverError> {
    match updates.try_send(observation.1.clone()) {
        Ok(()) => {}
        // The consumer may intentionally stop listening; final collection is
        // independent and must continue without backpressure from that choice.
        Err(mpsc::error::TrySendError::Closed(_)) => {}
        // Every accepted hash produces exactly one terminal update, and both
        // lifetime registrations and channel capacity are capped at ten. A full
        // channel therefore signals a programming invariant failure: surface it
        // through finish instead of silently losing feedback or blocking here.
        Err(mpsc::error::TrySendError::Full(_)) => return Err(ObserverError::UpdatesOverflow),
    }
    observations.push(observation);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::{TcpListener, TcpStream},
        sync::oneshot,
    };

    async fn request(reader: &mut BufReader<TcpStream>) -> Option<Value> {
        let mut length = None;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                return None;
            }
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = Some(value.trim().parse::<usize>().unwrap());
            }
        }
        let mut body = vec![0_u8; length.unwrap()];
        reader.read_exact(&mut body).await.unwrap();
        Some(serde_json::from_slice(&body).unwrap())
    }

    async fn reply(reader: &mut BufReader<TcpStream>, body: Value) {
        let body = body.to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
            body.len()
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    }

    fn receipt(hash: B256) -> Value {
        json!({"transactionHash":hash,"blockHash":B256::repeat_byte(9),"blockNumber":"0xa",
            "transactionIndex":"0x0","status":"0x1","gasUsed":"0x5208",
            "effectiveGasPrice":"0x1","contractAddress":null,"logs":[]})
    }

    async fn watcher(address: std::net::SocketAddr, timeout: Duration) -> ReceiptWatcher {
        ReceiptWatcher::start_with_interval(
            &format!("http://{address}/"),
            timeout,
            Duration::from_millis(5),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn delayed_receipts_round_robin_reuse_connection_and_preserve_registration_order() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let first = B256::repeat_byte(1);
        let second = B256::repeat_byte(2);
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut seen = Vec::new();
            for index in 0..3 {
                let call = request(&mut reader).await.unwrap();
                assert_eq!(call["method"], "eth_getTransactionReceipt");
                let hash: B256 = call["params"][0].as_str().unwrap().parse().unwrap();
                seen.push(hash);
                reply(&mut reader, json!({"jsonrpc":"2.0","id":call["id"],"result":if index == 0 { Value::Null } else { receipt(hash) }})).await;
            }
            seen
        });
        let mut watcher = watcher(address, Duration::from_secs(1)).await;
        let mut updates = watcher.take_updates().unwrap();
        assert!(matches!(
            watcher.take_updates(),
            Err(ObserverError::UpdatesAlreadyTaken)
        ));
        let started = Instant::now();
        watcher.watch(first, started).unwrap();
        watcher.watch(second, started).unwrap();
        // Observe completion without closing registration or invoking finish.
        // The first hash deliberately needs an extra poll and finishes second.
        let second_update = tokio::time::timeout(Duration::from_secs(1), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second_update.hash, second);
        assert!(second_update.error.is_none());
        assert!(second_update.receipt.as_ref().unwrap().success);
        assert!(!watcher.task.as_ref().unwrap().is_finished());
        let first_update = tokio::time::timeout(Duration::from_secs(1), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first_update.hash, first);
        let observations = tokio::time::timeout(Duration::from_secs(2), watcher.finish())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observations
                .iter()
                .map(|result| result.hash)
                .collect::<Vec<_>>(),
            vec![first, second]
        );
        for observation in &observations {
            assert!(observation.error.is_none());
            assert!(observation.receipt.as_ref().unwrap().success);
            assert!(observation.observed_after_send_ms.unwrap() >= 0.0);
        }
        assert!(
            observations[0].observed_after_send_ms.unwrap()
                >= observations[1].observed_after_send_ms.unwrap()
        );
        assert_eq!(
            serde_json::to_value(&observations).unwrap(),
            serde_json::to_value([first_update, second_update]).unwrap()
        );
        assert!(updates.recv().await.is_none());
        assert_eq!(server.await.unwrap(), vec![first, second, first]);
    }

    #[tokio::test]
    async fn missing_receipt_has_deadline_and_no_fabricated_latency() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            while let Some(call) = request(&mut reader).await {
                reply(
                    &mut reader,
                    json!({"jsonrpc":"2.0","id":call["id"],"result":null}),
                )
                .await;
            }
        });
        let watcher = watcher(address, Duration::from_millis(40)).await;
        watcher.watch(B256::repeat_byte(1), Instant::now()).unwrap();
        let observations = tokio::time::timeout(Duration::from_millis(500), watcher.finish())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0].error,
            Some(ObservationError::ReceiptTimeout)
        );
        assert!(observations[0].receipt.is_none());
        assert!(observations[0].observed_after_send_ms.is_none());
        tokio::time::timeout(Duration::from_millis(500), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn poisoned_read_client_marks_all_accepted_hashes_and_closes_registration() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let _call = request(&mut reader).await.unwrap();
            reply(&mut reader, json!({"jsonrpc":"2.0","id":999,"result":null})).await;
        });
        let mut watcher = watcher(address, Duration::from_secs(1)).await;
        let mut updates = watcher.take_updates().unwrap();
        watcher.watch(B256::repeat_byte(1), Instant::now()).unwrap();
        watcher.watch(B256::repeat_byte(2), Instant::now()).unwrap();
        tokio::time::timeout(Duration::from_millis(500), async {
            while !watcher.task.as_ref().unwrap().is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            watcher.watch(B256::repeat_byte(3), Instant::now()),
            Err(ObserverError::Closed)
        ));
        let mut feedback = Vec::new();
        while let Some(update) = updates.recv().await {
            feedback.push(update);
        }
        assert_eq!(feedback.len(), 2);
        assert_eq!(feedback[0].error, Some(ObservationError::RpcProtocol));
        assert_eq!(feedback[1].error, Some(ObservationError::ObserverStopped));
        let observations = watcher.finish().await.unwrap();
        assert_eq!(
            serde_json::to_value(&feedback).unwrap(),
            serde_json::to_value(&observations).unwrap()
        );
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].error, Some(ObservationError::RpcProtocol));
        assert_eq!(
            observations[1].error,
            Some(ObservationError::ObserverStopped)
        );
        assert!(
            observations
                .iter()
                .all(|observation| observation.receipt.is_none()
                    && observation.observed_after_send_ms.is_none())
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn remote_error_is_recorded_and_healthy_read_connection_continues() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            for index in 0..2 {
                let call = request(&mut reader).await.unwrap();
                let body = if index == 0 {
                    json!({"jsonrpc":"2.0","id":call["id"],"error":{"code":-32000,"message":"synthetic-secret"}})
                } else {
                    json!({"jsonrpc":"2.0","id":call["id"],"result":receipt(B256::repeat_byte(2))})
                };
                reply(&mut reader, body).await;
            }
        });
        let watcher = watcher(address, Duration::from_secs(1)).await;
        watcher.watch(B256::repeat_byte(1), Instant::now()).unwrap();
        watcher.watch(B256::repeat_byte(2), Instant::now()).unwrap();
        let observations = watcher.finish().await.unwrap();
        assert_eq!(
            observations[0].error,
            Some(ObservationError::RpcRemote { code: -32000 })
        );
        assert!(observations[1].receipt.is_some());
        assert!(
            !serde_json::to_string(&observations)
                .unwrap()
                .contains("synthetic-secret")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn full_duplicate_and_future_registrations_fail_without_waiting() {
        // HTTPS-style lazy HTTP setup does not open a connection before the task
        // is scheduled. No server or external endpoint is needed for this test.
        let watcher = ReceiptWatcher::start("http://127.0.0.1:1", Duration::from_secs(30))
            .await
            .unwrap();
        for number in 1..=CAPACITY {
            watcher
                .watch(B256::repeat_byte(number as u8), Instant::now())
                .unwrap();
        }
        assert!(matches!(
            watcher.watch(B256::repeat_byte(11), Instant::now()),
            Err(ObserverError::Capacity)
        ));
        assert!(matches!(
            watcher.watch(B256::repeat_byte(1), Instant::now()),
            Err(ObserverError::Duplicate)
        ));
        assert!(matches!(
            watcher.watch(
                B256::repeat_byte(12),
                Instant::now() + Duration::from_secs(1)
            ),
            Err(ObserverError::InvalidStart)
        ));
        drop(watcher);
    }

    #[tokio::test]
    async fn unread_updates_hold_all_ten_timeouts_and_can_be_taken_later() {
        let mut watcher = ReceiptWatcher::start("http://127.0.0.1:1", Duration::from_secs(1))
            .await
            .unwrap();
        let expired = Instant::now().checked_sub(Duration::from_secs(2)).unwrap();
        for number in 1..=CAPACITY {
            watcher
                .watch(B256::repeat_byte(number as u8), expired)
                .unwrap();
        }
        assert!(matches!(
            watcher.watch(B256::repeat_byte(11), expired),
            Err(ObserverError::Capacity)
        ));
        // No consumer has taken the update channel, yet every watch terminates
        // without blocking or making a request to the unavailable endpoint.
        tokio::time::timeout(Duration::from_millis(500), async {
            while watcher.updates.as_ref().unwrap().len() != CAPACITY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut updates = watcher.take_updates().unwrap();
        let observations = watcher.finish().await.unwrap();
        let mut feedback = Vec::new();
        while let Some(update) = updates.recv().await {
            assert_eq!(update.error, Some(ObservationError::ReceiptTimeout));
            assert!(update.receipt.is_none());
            assert!(update.observed_after_send_ms.is_none());
            feedback.push(update);
        }
        assert_eq!(feedback.len(), CAPACITY);
        assert_eq!(
            serde_json::to_value(feedback).unwrap(),
            serde_json::to_value(observations).unwrap()
        );
    }

    #[tokio::test]
    async fn closing_update_consumer_does_not_change_final_results() {
        let mut watcher = ReceiptWatcher::start("http://127.0.0.1:1", Duration::from_secs(1))
            .await
            .unwrap();
        let mut updates = watcher.take_updates().unwrap();
        updates.close();
        let expired = Instant::now().checked_sub(Duration::from_secs(2)).unwrap();
        watcher.watch(B256::repeat_byte(1), expired).unwrap();
        let observations = watcher.finish().await.unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].hash, B256::repeat_byte(1));
        assert_eq!(
            observations[0].error,
            Some(ObservationError::ReceiptTimeout)
        );
        assert!(updates.recv().await.is_none());
    }

    #[test]
    fn impossible_full_update_channel_is_an_explicit_error() {
        // Deliberately violate the production invariant by using capacity one
        // for two accepted terminal events. This must neither wait nor succeed.
        let (sender, mut receiver) = mpsc::channel(1);
        let mut observations = Vec::new();
        let failed = |number: u8| {
            (
                usize::from(number),
                Observation {
                    hash: B256::repeat_byte(number),
                    receipt: None,
                    observed_after_send_ms: None,
                    error: Some(ObservationError::ReceiptTimeout),
                },
            )
        };
        record(&mut observations, &sender, failed(1)).unwrap();
        assert!(matches!(
            record(&mut observations, &sender, failed(2)),
            Err(ObserverError::UpdatesOverflow)
        ));
        assert_eq!(observations.len(), 1);
        assert_eq!(receiver.try_recv().unwrap().hash, B256::repeat_byte(1));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn dropping_watcher_or_cancelling_finish_aborts_inflight_task() {
        for cancel_finish in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (started_tx, started_rx) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let _call = request(&mut reader).await.unwrap();
                started_tx.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            let mut watcher = Some(watcher(address, Duration::from_secs(120)).await);
            let handle = watcher
                .as_ref()
                .unwrap()
                .task
                .as_ref()
                .unwrap()
                .abort_handle();
            watcher
                .as_ref()
                .unwrap()
                .watch(B256::repeat_byte(1), Instant::now())
                .unwrap();
            if cancel_finish {
                let mut finish = Box::pin(watcher.take().unwrap().finish());
                tokio::select! {
                    _ = &mut finish => panic!("finish unexpectedly completed before the reply"),
                    result = started_rx => result.unwrap(),
                }
                drop(finish);
            } else {
                started_rx.await.unwrap();
                drop(watcher.take());
            }
            tokio::time::timeout(Duration::from_millis(300), async {
                while !handle.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
        }
    }

    #[tokio::test]
    async fn malformed_receipt_is_not_marked_observed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let call = request(&mut reader).await.unwrap();
            reply(
                &mut reader,
                json!({"jsonrpc":"2.0","id":call["id"],"result":receipt(B256::repeat_byte(99))}),
            )
            .await;
        });
        let watcher = watcher(address, Duration::from_secs(1)).await;
        watcher.watch(B256::repeat_byte(1), Instant::now()).unwrap();
        let observations = watcher.finish().await.unwrap();
        assert_eq!(
            observations[0].error,
            Some(ObservationError::InvalidReceipt)
        );
        assert!(observations[0].receipt.is_none());
        assert!(observations[0].observed_after_send_ms.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn hung_read_respects_watch_deadline_and_stops_remaining_work() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let _call = request(&mut reader).await.unwrap();
            std::future::pending::<()>().await;
        });
        let watcher = watcher(address, Duration::from_millis(300)).await;
        let now = Instant::now();
        watcher
            .watch(
                B256::repeat_byte(1),
                now.checked_sub(Duration::from_millis(200)).unwrap(),
            )
            .unwrap();
        watcher.watch(B256::repeat_byte(2), now).unwrap();
        let observations = tokio::time::timeout(Duration::from_millis(500), watcher.finish())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observations.len(), 2);
        assert_eq!(
            observations[0].error,
            Some(ObservationError::ReceiptTimeout)
        );
        assert_eq!(
            observations[1].error,
            Some(ObservationError::ObserverStopped)
        );
        assert!(
            observations
                .iter()
                .all(|observation| observation.receipt.is_none()
                    && observation.observed_after_send_ms.is_none())
        );
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
