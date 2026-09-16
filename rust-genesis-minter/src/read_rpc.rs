//! Bounded read-only parallelism over independently warmed persistent clients.
//! A wave awaits every started request before returning an error. Cancellation
//! drops borrowed request futures and poisons the pool; reconnect explicitly.

use std::{io, time::Duration};

use anyhow::{Result, ensure};
use futures_util::future::join_all;
use rust_mint_benchmark::{
    eth,
    rpc::{RpcClient, RpcError},
};
use serde::Serialize;
use serde_json::{Value, json};

const MAX_REQUESTS: usize = 300;
const MAX_GROUP_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// Request contents intentionally have no Debug implementation.
pub struct ReadRequest {
    pub method: &'static str,
    pub params: Value,
}

impl ReadRequest {
    pub fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
}

/// The pool owns at most eight sequential transports. It owns no tasks or locks
/// and never retries requests, including calls whose result was ambiguous.
pub struct ReadRpc {
    lanes: Vec<RpcClient>,
    poisoned: bool,
}

impl ReadRpc {
    pub async fn connect(input: &str, timeout: Duration, concurrency: usize) -> Result<Self> {
        ensure!(
            (1..=8).contains(&concurrency),
            "INVALID_READ_RPC_CONCURRENCY"
        );
        let results = join_all((0..concurrency).map(|_| async {
            let mut client = RpcClient::connect(input, timeout).await?;
            let chain = client.call("eth_chainId", json!([])).await?;
            ensure!(
                eth::quantity64(&chain)? == crate::config::CHAIN_ID,
                "WRONG_READ_RPC_CHAIN"
            );
            Ok::<_, anyhow::Error>(client)
        }))
        .await;
        // All opened clients are dropped if any lane fails its warmup.
        let lanes = results.into_iter().collect::<Result<Vec<_>>>()?;
        Ok(Self {
            lanes,
            poisoned: false,
        })
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        validate(method, &params)?;
        if self.poisoned {
            return Err(RpcError::Closed);
        }
        let lane = self.lanes.first_mut().ok_or(RpcError::Closed)?;
        self.poisoned = true;
        let result = lane.call(method, params).await;
        if reusable(&result) {
            self.poisoned = false;
        }
        result
    }

    /// Results retain input order, regardless of network completion order.
    /// Validate the entire group before sending its first read. After any failed
    /// wave, do not schedule later waves. Remote RPC errors remain reusable only
    /// after all started operations have completed unambiguously.
    pub async fn calls(&mut self, requests: Vec<ReadRequest>) -> Result<Vec<Value>, RpcError> {
        if requests.len() > MAX_REQUESTS {
            return Err(RpcError::InvalidRequest);
        }
        let mut request_budget = ByteBudget::new(MAX_GROUP_BYTES);
        for request in &requests {
            validate(request.method, &request.params)?;
            // Count with a bounded writer, without allocating another copy of
            // calldata or request JSON. Reserve the longest possible RPC id.
            let mut individual = ByteBudget::new(MAX_REQUEST_BYTES.min(request_budget.remaining));
            serde_json::to_writer(
                &mut individual,
                &RequestSize {
                    jsonrpc: "2.0",
                    id: u64::MAX,
                    method: request.method,
                    params: &request.params,
                },
            )
            .map_err(|_| RpcError::InvalidRequest)?;
            request_budget
                .consume(individual.used())
                .map_err(|_| RpcError::InvalidRequest)?;
        }
        if self.poisoned || self.lanes.is_empty() {
            return Err(RpcError::Closed);
        }
        let count = requests.len();
        let mut pending = requests.into_iter();
        let mut values = Vec::with_capacity(count);
        let mut response_budget = ByteBudget::new(MAX_GROUP_BYTES);
        while pending.len() != 0 {
            // Set before polling any child future. Cancellation conservatively
            // invalidates the entire pool, even if one lane already completed.
            self.poisoned = true;
            let wave = join_all(self.lanes.iter_mut().zip(pending.by_ref()).map(
                |(lane, request)| async move { lane.call(request.method, request.params).await },
            ))
            .await;
            if wave.iter().all(reusable) {
                self.poisoned = false;
            }
            // join_all has already completed every lane; collect cannot cancel
            // another lane merely because an earlier-index result is an error.
            let wave = wave.into_iter().collect::<Result<Vec<_>, _>>()?;
            for value in &wave {
                serde_json::to_writer(&mut response_budget, value)
                    .map_err(|_| RpcError::ResponseTooLarge)?;
            }
            values.extend(wave);
        }
        Ok(values)
    }
}

#[derive(Serialize)]
struct RequestSize<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: &'a Value,
}

/// Serialized-size accounting without accumulating output. At most one wave
/// (eight individually bounded responses) can exist beyond the retained budget.
struct ByteBudget {
    initial: usize,
    remaining: usize,
}
impl ByteBudget {
    fn new(limit: usize) -> Self {
        Self {
            initial: limit,
            remaining: limit,
        }
    }
    fn used(&self) -> usize {
        self.initial - self.remaining
    }
    fn consume(&mut self, bytes: usize) -> io::Result<()> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or_else(|| io::Error::from(io::ErrorKind::FileTooLarge))?;
        Ok(())
    }
}
impl io::Write for ByteBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.consume(bytes.len())?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn reusable(result: &Result<Value, RpcError>) -> bool {
    result.is_ok() || matches!(result, Err(RpcError::Remote { .. }))
}

fn validate(method: &str, params: &Value) -> Result<(), RpcError> {
    if !matches!(
        method,
        "eth_chainId"
            | "eth_getBlockByNumber"
            | "eth_getCode"
            | "eth_call"
            | "eth_estimateGas"
            | "eth_gasPrice"
            | "eth_getBalance"
            | "eth_getTransactionCount"
            | "eth_getTransactionReceipt"
    ) || (!params.is_array() && !params.is_object())
    {
        return Err(RpcError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::{JoinHandle, JoinSet},
    };
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[derive(Clone, Copy)]
    enum Fault {
        None,
        WrongChain,
        Remote,
        Timeout,
        Large,
    }

    #[derive(Default)]
    struct Stats {
        connections: AtomicUsize,
        requests: AtomicUsize,
        active: AtomicUsize,
        maximum: AtomicUsize,
        completed: Mutex<Vec<u64>>,
    }

    struct Server {
        url: String,
        stats: Arc<Stats>,
        stop: Option<oneshot::Sender<()>>,
        task: Option<JoinHandle<()>>,
    }

    impl Server {
        async fn start(websocket: bool, fault: Fault) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "{}://{}",
                if websocket { "ws" } else { "http" },
                listener.local_addr().unwrap()
            );
            let stats = Arc::new(Stats::default());
            let shared = stats.clone();
            let (stop, mut stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let mut jobs = JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut stopped => break,
                        result = jobs.join_next(), if !jobs.is_empty() => { result.unwrap().unwrap(); },
                        accepted = listener.accept() => {
                            let (socket, _) = accepted.unwrap();
                            let number = shared.connections.fetch_add(1, Ordering::SeqCst);
                            let shared = shared.clone();
                            jobs.spawn(async move {
                                if websocket { serve_ws(socket, shared, fault, number).await; }
                                else { serve_http(socket, shared, fault, number).await; }
                            });
                        }
                    }
                }
                jobs.abort_all();
                while let Some(result) = jobs.join_next().await {
                    if let Err(error) = result {
                        assert!(error.is_cancelled());
                    }
                }
            });
            Self {
                url,
                stats,
                stop: Some(stop),
                task: Some(task),
            }
        }
        async fn stop(mut self) {
            self.stop.take().unwrap().send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), self.task.as_mut().unwrap())
                .await
                .unwrap()
                .unwrap();
            drop(self.task.take());
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(task) = &self.task {
                task.abort();
            }
        }
    }

    async fn answer(request: Value, stats: &Stats, fault: Fault, lane: usize) -> Value {
        stats.requests.fetch_add(1, Ordering::SeqCst);
        let id = request["id"].clone();
        assert_eq!(request["jsonrpc"], "2.0");
        if request["method"] == "eth_chainId" {
            return json!({"jsonrpc":"2.0","id":id,"result":
                if matches!(fault, Fault::WrongChain) && lane == 1 { "0x1" } else { "0x1237" }});
        }
        assert_eq!(
            request["method"], "eth_call",
            "No write may reach the fixture."
        );
        let index = request["params"][0].as_u64().unwrap();
        let active = stats.active.fetch_add(1, Ordering::SeqCst) + 1;
        stats.maximum.fetch_max(active, Ordering::SeqCst);
        let delay = if matches!(fault, Fault::Timeout) && index == 0 {
            1500
        } else {
            request["params"][1].as_u64().unwrap()
        };
        tokio::time::sleep(Duration::from_millis(delay)).await;
        stats.active.fetch_sub(1, Ordering::SeqCst);
        stats.completed.lock().unwrap().push(index);
        if matches!(fault, Fault::Remote) && index == 0 {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32055,
                "message":"SYNTHETIC_SECRET_DO_NOT_LOG","data":"SYNTHETIC_PRIVATE_PAYLOAD"}})
        } else if matches!(fault, Fault::Large) {
            json!({"jsonrpc":"2.0","id":id,"result":"x".repeat(3 * 1024 * 1024)})
        } else {
            json!({"jsonrpc":"2.0","id":id,"result":index})
        }
    }

    async fn serve_http(socket: TcpStream, stats: Arc<Stats>, fault: Fault, lane: usize) {
        let mut stream = BufReader::new(socket);
        loop {
            let mut line = String::new();
            if stream.read_line(&mut line).await.unwrap() == 0 {
                return;
            }
            assert!(line.starts_with("POST / HTTP/1.1"));
            let mut header_bytes = line.len();
            let mut length = None;
            loop {
                line.clear();
                let n = stream.read_line(&mut line).await.unwrap();
                assert!(n > 0);
                header_bytes += n;
                assert!(header_bytes <= 8192);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let length = length.unwrap();
            assert!(length <= 4 * 1024 * 1024);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            let response = answer(serde_json::from_slice(&body).unwrap(), &stats, fault, lane)
                .await
                .to_string();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                response.len()
            );
            if stream.get_mut().write_all(header.as_bytes()).await.is_err() {
                return;
            }
            if stream
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    }

    async fn serve_ws(socket: TcpStream, stats: Arc<Stats>, fault: Fault, lane: usize) {
        let mut socket = accept_async(socket).await.unwrap();
        while let Some(message) = socket.next().await {
            let Ok(message) = message else {
                return;
            };
            match message {
                Message::Text(text) => {
                    let response =
                        answer(serde_json::from_str(&text).unwrap(), &stats, fault, lane).await;
                    if socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Message::Close(_) => return,
                Message::Ping(_) => {
                    if socket.flush().await.is_err() {
                        return;
                    }
                }
                other => panic!("unexpected synthetic frame: {other:?}"),
            }
        }
    }

    fn reads(count: u64, delay: u64) -> Vec<ReadRequest> {
        (0..count)
            .map(|i| ReadRequest::new("eth_call", json!([i, delay])))
            .collect()
    }

    #[tokio::test]
    async fn http_and_websocket_reuse_bounded_lanes_and_preserve_input_order() {
        for websocket in [false, true] {
            let server = Server::start(websocket, Fault::None).await;
            let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(2), 3)
                .await
                .unwrap();
            assert_eq!(server.stats.requests.load(Ordering::SeqCst), 3);
            for _ in 0..2 {
                let requests = (0..8)
                    .map(|index| ReadRequest::new("eth_call", json!([index, (2 - index % 3) * 60])))
                    .collect();
                let results = pool.calls(requests).await.unwrap();
                assert_eq!(
                    results,
                    (0..8).map(|index| json!(index)).collect::<Vec<_>>()
                );
            }
            assert_eq!(server.stats.connections.load(Ordering::SeqCst), 3);
            assert_eq!(server.stats.maximum.load(Ordering::SeqCst), 3);
            assert_eq!(&server.stats.completed.lock().unwrap()[..3], &[2, 1, 0]);
            assert_eq!(
                pool.call("eth_call", json!([99, 0])).await.unwrap(),
                json!(99)
            );
            assert_eq!(server.stats.connections.load(Ordering::SeqCst), 3);
            drop(pool);
            server.stop().await;
        }
    }

    #[tokio::test]
    async fn rejects_entire_group_before_network_when_a_late_request_is_a_write() {
        let server = Server::start(false, Fault::None).await;
        let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(1), 2)
            .await
            .unwrap();
        for forbidden in [
            "eth_sendRawTransaction",
            "eth_sendTransaction",
            "eth_subscribe",
            "eth_unsubscribe",
            "evm_mine",
            "debug_traceCall",
            "personal_unlockAccount",
            "ETH_call",
        ] {
            assert_eq!(
                pool.call(forbidden, json!([])).await,
                Err(RpcError::InvalidRequest)
            );
            let mut requests = reads(5, 0);
            requests.push(ReadRequest::new(forbidden, json!([])));
            assert_eq!(pool.calls(requests).await, Err(RpcError::InvalidRequest));
        }
        let mut requests = reads(5, 0);
        requests.push(ReadRequest::new("eth_call", Value::Null));
        assert_eq!(pool.calls(requests).await, Err(RpcError::InvalidRequest));
        assert_eq!(
            pool.calls(reads(301, 0)).await,
            Err(RpcError::InvalidRequest)
        );
        assert!(pool.calls(vec![]).await.unwrap().is_empty());
        assert_eq!(server.stats.requests.load(Ordering::SeqCst), 2);
        drop(pool);
        server.stop().await;
    }

    #[test]
    fn serialized_budget_counts_escaped_bytes_without_allocating_output() {
        let value = json!("\n");
        let mut exact = ByteBudget::new(4);
        serde_json::to_writer(&mut exact, &value).unwrap();
        assert_eq!(exact.remaining, 0);
        assert_eq!(exact.used(), 4);
        let mut short = ByteBudget::new(3);
        assert!(serde_json::to_writer(&mut short, &value).is_err());
    }

    #[tokio::test]
    async fn aggregate_or_individual_request_overflow_rejects_before_any_network_read() {
        let server = Server::start(false, Fault::None).await;
        let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(1), 2)
            .await
            .unwrap();
        let requests = (0..17)
            .map(|_| ReadRequest::new("eth_call", json!(["x".repeat(1024 * 1024)])))
            .collect();
        assert_eq!(pool.calls(requests).await, Err(RpcError::InvalidRequest));
        let mut requests = reads(4, 0);
        requests.push(ReadRequest::new(
            "eth_call",
            json!(["x".repeat(MAX_REQUEST_BYTES)]),
        ));
        assert_eq!(pool.calls(requests).await, Err(RpcError::InvalidRequest));
        assert_eq!(server.stats.requests.load(Ordering::SeqCst), 2);
        assert_eq!(
            pool.call("eth_call", json!([9, 0])).await.unwrap(),
            json!(9)
        );
        drop(pool);
        server.stop().await;
    }

    #[tokio::test]
    async fn aggregate_response_budget_stops_before_scheduling_additional_waves() {
        let server = Server::start(false, Fault::Large).await;
        let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(5), 3)
            .await
            .unwrap();
        assert_eq!(
            pool.calls(reads(9, 0)).await,
            Err(RpcError::ResponseTooLarge)
        );
        // Six individually valid 3 MiB responses exceed 16 MiB together.
        // The final three requests were never scheduled.
        assert_eq!(server.stats.requests.load(Ordering::SeqCst), 3 + 6);
        assert_eq!(server.stats.completed.lock().unwrap().len(), 6);
        drop(pool);
        server.stop().await;
    }

    #[tokio::test]
    async fn invalid_concurrency_does_not_connect_and_every_lane_checks_chain_id() {
        let server = Server::start(false, Fault::WrongChain).await;
        for concurrency in [0, 9, usize::MAX] {
            assert!(
                ReadRpc::connect(&server.url, Duration::from_secs(1), concurrency)
                    .await
                    .is_err()
            );
        }
        assert_eq!(server.stats.connections.load(Ordering::SeqCst), 0);
        let error = ReadRpc::connect(&server.url, Duration::from_secs(1), 3)
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "WRONG_READ_RPC_CHAIN");
        assert_eq!(server.stats.connections.load(Ordering::SeqCst), 3);
        assert_eq!(server.stats.requests.load(Ordering::SeqCst), 3);
        server.stop().await;
    }

    #[tokio::test]
    async fn remote_error_waits_for_started_reads_and_does_not_schedule_next_wave() {
        for websocket in [false, true] {
            let server = Server::start(websocket, Fault::Remote).await;
            let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(1), 2)
                .await
                .unwrap();
            let mut requests = reads(5, 0);
            requests[1].params = json!([1, 150]);
            let result = pool.calls(requests).await;
            assert_eq!(result, Err(RpcError::Remote { code: -32055 }));
            assert!(!result.unwrap_err().to_string().contains("SYNTHETIC"));
            assert_eq!(*server.stats.completed.lock().unwrap(), vec![0, 1]);
            assert_eq!(server.stats.requests.load(Ordering::SeqCst), 4);
            assert_eq!(
                pool.call("eth_call", json!([8, 0])).await.unwrap(),
                json!(8)
            );
            assert_eq!(server.stats.connections.load(Ordering::SeqCst), 2);
            drop(pool);
            server.stop().await;
        }
    }

    #[tokio::test]
    async fn timed_out_lane_poisoning_stops_later_waves_and_reuse() {
        for websocket in [false, true] {
            let server = Server::start(websocket, Fault::Timeout).await;
            let mut pool = ReadRpc::connect(&server.url, Duration::from_millis(300), 2)
                .await
                .unwrap();
            assert_eq!(pool.calls(reads(4, 40)).await, Err(RpcError::Timeout));
            assert_eq!(*server.stats.completed.lock().unwrap(), vec![1]);
            assert_eq!(
                pool.call("eth_call", json!([9, 0])).await,
                Err(RpcError::Closed)
            );
            assert_eq!(pool.calls(reads(1, 0)).await, Err(RpcError::Closed));
            assert_eq!(server.stats.requests.load(Ordering::SeqCst), 4);
            drop(pool);
            server.stop().await;
        }
    }

    #[tokio::test]
    async fn cancellation_keeps_the_pool_poisoned_without_detached_requests() {
        for websocket in [false, true] {
            let server = Server::start(websocket, Fault::None).await;
            let mut pool = ReadRpc::connect(&server.url, Duration::from_secs(2), 3)
                .await
                .unwrap();
            let result =
                tokio::time::timeout(Duration::from_millis(150), pool.calls(reads(8, 1000))).await;
            assert!(result.is_err());
            assert_eq!(pool.calls(reads(1, 0)).await, Err(RpcError::Closed));
            assert_eq!(
                pool.call("eth_call", json!([9, 0])).await,
                Err(RpcError::Closed)
            );
            assert_eq!(server.stats.requests.load(Ordering::SeqCst), 6);
            assert!(server.stats.completed.lock().unwrap().is_empty());
            drop(pool);
            server.stop().await;
        }
    }
}
