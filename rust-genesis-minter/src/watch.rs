//! Read-only log hints. A wake never authorizes a mint, advances a trusted block
//! floor, or supplies a nonce: the caller must fetch a fresh authoritative state.
//! Geth subscriptions disappear with their socket, so every new subscription
//! session also wakes the reader to cover the gap. See geth's RPC pubsub docs.

use std::{collections::VecDeque, net::IpAddr, time::Duration};

use alloy_primitives::{Address, B256};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::{oneshot, watch},
    task::JoinHandle,
    time::Instant,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

const MAX_MESSAGE: usize = 4 * 1024 * 1024;
const MAX_HANDSHAKE_NOTIFICATIONS: usize = 32;
const MAX_RECENT_LOGS: usize = 256;
const MAX_MESSAGES_PER_SECOND: usize = 4096;
const MAX_BYTES_PER_SECOND: usize = 16 * 1024 * 1024;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WatchError {
    #[error("INVALID_WATCH_CONFIGURATION")]
    Configuration,
    #[error("WATCH_TIMEOUT")]
    Timeout,
    #[error("WATCH_TRANSPORT_ERROR")]
    Transport,
    #[error("INVALID_WATCH_PROTOCOL")]
    Protocol,
    #[error("WATCH_WRONG_CHAIN")]
    WrongChain,
    #[error("WATCH_REMOTE_ERROR_{code}")]
    Remote { code: i64 },
    #[error("WATCH_EVENT_LIMIT_EXCEEDED")]
    EventLimit,
    #[error("WATCH_REVISION_EXHAUSTED")]
    Revision,
    #[error("WATCH_TASK_FAILED")]
    Task,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchStatus {
    Connecting,
    Active,
    Degraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WatchUpdate {
    pub revision: u64,
    pub status: WatchStatus,
    pub failures: u8,
    pub error: Option<WatchError>,
}

/// Owns its task. The watch channel coalesces a burst into one current revision,
/// with constant storage even when a caller is busy simulating a transaction.
pub struct LogWatcher {
    receiver: watch::Receiver<WatchUpdate>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl LogWatcher {
    pub fn start(
        url: &str,
        nft: Address,
        routes: &[Address],
        timeout: Duration,
    ) -> Result<Self, WatchError> {
        let endpoint = endpoint(url)?;
        if nft.is_zero()
            || routes.is_empty()
            || routes.len() > 4
            || routes
                .iter()
                .enumerate()
                .any(|(i, a)| a.is_zero() || *a == nft || routes[..i].contains(a))
            || timeout.is_zero()
            || timeout > Duration::from_secs(60)
        {
            return Err(WatchError::Configuration);
        }
        let (sender, receiver) = watch::channel(WatchUpdate {
            revision: 0,
            status: WatchStatus::Connecting,
            failures: 0,
            error: None,
        });
        let (shutdown, stopped) = oneshot::channel();
        let filter = Filter {
            nft,
            routes: routes.to_vec(),
        };
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| WatchError::Configuration)?;
        let task = runtime.spawn(observe(endpoint, filter, timeout, sender, stopped));
        Ok(Self {
            receiver,
            shutdown: Some(shutdown),
            task: Some(task),
        })
    }

    pub fn updates(&self) -> watch::Receiver<WatchUpdate> {
        self.receiver.clone()
    }

    /// Gracefully close the read-only socket, then join the owned task.
    pub async fn stop(mut self) -> Result<(), WatchError> {
        if let Some(shutdown) = self.shutdown.take() {
            // A terminal degraded task may already have dropped its receiver.
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.as_mut() {
            match tokio::time::timeout(Duration::from_secs(1), &mut *task).await {
                Ok(result) => result.map_err(|_| WatchError::Task)?,
                Err(_) => {
                    task.abort();
                    match (&mut *task).await {
                        Err(error) if error.is_cancelled() => {}
                        Ok(()) => {}
                        Err(_) => return Err(WatchError::Task),
                    }
                }
            }
        }
        drop(self.task.take());
        Ok(())
    }
}

impl Drop for LogWatcher {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Validate at configuration load, before any paid preparation is possible.
pub fn validate_endpoint(input: &str) -> Result<(), WatchError> {
    endpoint(input).map(|_| ())
}

fn endpoint(input: &str) -> Result<Url, WatchError> {
    if input.len() > 4096 || input.bytes().any(|b| b.is_ascii_whitespace() || b == b'\\') {
        return Err(WatchError::Configuration);
    }
    let url = Url::parse(input).map_err(|_| WatchError::Configuration)?;
    let host = url.host_str().ok_or(WatchError::Configuration)?;
    let local = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    let authority = input
        .split_once("://")
        .map(|(_, tail)| tail.split(['/', '?', '#']).next().unwrap_or_default());
    if !(url.scheme() == "wss" || (url.scheme() == "ws" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authority.is_some_and(|a| a.contains('@'))
        || host.to_ascii_lowercase().starts_with("feed.")
        || url.port_or_known_default().is_none()
    {
        return Err(WatchError::Configuration);
    }
    Ok(url)
}

struct Filter {
    nft: Address,
    routes: Vec<Address>,
}
impl Filter {
    fn nft_topic(&self) -> String {
        let mut word = [0u8; 32];
        word[12..].copy_from_slice(self.nft.as_slice());
        B256::from(word).to_string()
    }
    fn subscriptions(&self) -> [Value; 2] {
        // SeaDropErrorsAndEvents.sol puts indexed nftContract first in all
        // its events, including PublicDropUpdated and fee/payer changes.
        [
            json!({"address":self.nft}),
            json!({"address":self.routes,"topics":[null,self.nft_topic()]}),
        ]
    }
}

fn publish(
    sender: &watch::Sender<WatchUpdate>,
    status: WatchStatus,
    failures: u8,
    error: Option<WatchError>,
) -> Result<(), WatchError> {
    let revision = sender
        .borrow()
        .revision
        .checked_add(1)
        .ok_or(WatchError::Revision)?;
    sender.send_replace(WatchUpdate {
        revision,
        status,
        failures,
        error,
    });
    Ok(())
}

async fn observe(
    url: Url,
    filter: Filter,
    timeout: Duration,
    sender: watch::Sender<WatchUpdate>,
    mut stopped: oneshot::Receiver<()>,
) {
    let mut failures = 0u8;
    loop {
        let mut active_since = None;
        let outcome = session(
            &url,
            &filter,
            timeout,
            &sender,
            &mut stopped,
            &mut active_since,
        )
        .await;
        let Err(error) = outcome else {
            return;
        };
        // A server repeatedly accepting and immediately dropping a subscription
        // must not reset the error budget indefinitely. Reset only after 30 s.
        if active_since.is_some_and(|began: Instant| began.elapsed() >= Duration::from_secs(30)) {
            failures = 0;
        }
        failures = failures.saturating_add(1);
        let status = if failures >= 3 {
            WatchStatus::Degraded
        } else {
            WatchStatus::Connecting
        };
        if publish(&sender, status, failures, Some(error)).is_err() || failures >= 3 {
            return;
        }
        tokio::select! {
            biased;
            _ = &mut stopped => return,
            _ = tokio::time::sleep(Duration::from_millis(250 * u64::from(failures))) => {},
        }
    }
}

async fn connect(url: &Url, timeout: Duration) -> Result<Socket, WatchError> {
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE + 1024)
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (socket, response) = tokio::time::timeout(
        timeout,
        connect_async_with_config(url.as_str(), Some(config), true),
    )
    .await
    .map_err(|_| WatchError::Timeout)?
    .map_err(|_| WatchError::Transport)?;
    if response.headers().contains_key("sec-websocket-extensions")
        || response.headers().contains_key("sec-websocket-protocol")
    {
        return Err(WatchError::Protocol);
    }
    Ok(socket)
}

async fn send(socket: &mut Socket, message: Message, timeout: Duration) -> Result<(), WatchError> {
    tokio::time::timeout(timeout, socket.send(message))
        .await
        .map_err(|_| WatchError::Timeout)?
        .map_err(|_| WatchError::Transport)
}

async fn response(
    socket: &mut Socket,
    id: u64,
    timeout: Duration,
    filter: &Filter,
    subscriptions: &[String],
) -> Result<Value, WatchError> {
    tokio::time::timeout(timeout, async {
        for _ in 0..MAX_HANDSHAKE_NOTIFICATIONS {
            let message = socket
                .next()
                .await
                .ok_or(WatchError::Transport)?
                .map_err(|_| WatchError::Transport)?;
            let value: Value = match message {
                Message::Text(text) => {
                    serde_json::from_str(&text).map_err(|_| WatchError::Protocol)?
                }
                Message::Ping(_) => {
                    socket.flush().await.map_err(|_| WatchError::Transport)?;
                    continue;
                }
                Message::Pong(_) => continue,
                Message::Close(_) => return Err(WatchError::Transport),
                _ => return Err(WatchError::Protocol),
            };
            if value.get("method").is_some() {
                // An already installed NFT subscription may emit before the
                // second subscription ACK. Active transition covers this hint.
                validate_log(&value, filter, subscriptions)?;
                continue;
            }
            let object = value.as_object().ok_or(WatchError::Protocol)?;
            if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                || object.get("id").and_then(Value::as_u64) != Some(id)
                || object.contains_key("result") == object.contains_key("error")
                || object.len() != 3
            {
                return Err(WatchError::Protocol);
            }
            if let Some(error) = object.get("error") {
                let code = error
                    .get("code")
                    .and_then(Value::as_i64)
                    .ok_or(WatchError::Protocol)?;
                if !error.get("message").is_some_and(Value::is_string) {
                    return Err(WatchError::Protocol);
                }
                return Err(WatchError::Remote { code });
            }
            return object.get("result").cloned().ok_or(WatchError::Protocol);
        }
        Err(WatchError::EventLimit)
    })
    .await
    .map_err(|_| WatchError::Timeout)?
}

async fn establish(
    url: &Url,
    filter: &Filter,
    timeout: Duration,
) -> Result<(Socket, Vec<String>), WatchError> {
    let mut socket = connect(url, timeout).await?;
    send(
        &mut socket,
        Message::Text(
            json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]})
                .to_string()
                .into(),
        ),
        timeout,
    )
    .await?;
    if quantity(&response(&mut socket, 1, timeout, filter, &[]).await?)? != 4663 {
        return Err(WatchError::WrongChain);
    }
    let mut subscriptions = Vec::with_capacity(2);
    for (index, subscription) in filter.subscriptions().into_iter().enumerate() {
        let id = u64::try_from(index).map_err(|_| WatchError::Protocol)? + 2;
        send(&mut socket, Message::Text(json!({"jsonrpc":"2.0","id":id,"method":"eth_subscribe","params":["logs",subscription]}).to_string().into()), timeout).await?;
        let ack = response(&mut socket, id, timeout, filter, &subscriptions).await?;
        let subscription = ack
            .as_str()
            .filter(|s| hex(s, 1, 64))
            .ok_or(WatchError::Protocol)?;
        if subscriptions.iter().any(|s| s == subscription) {
            return Err(WatchError::Protocol);
        }
        subscriptions.push(subscription.to_owned());
    }
    Ok((socket, subscriptions))
}

async fn session(
    url: &Url,
    filter: &Filter,
    timeout: Duration,
    sender: &watch::Sender<WatchUpdate>,
    stopped: &mut oneshot::Receiver<()>,
    active_since: &mut Option<Instant>,
) -> Result<(), WatchError> {
    let (mut socket, subscriptions) = tokio::select! {
        biased;
        _ = &mut *stopped => return Ok(()),
        result = establish(url, filter, timeout) => result?,
    };
    *active_since = Some(Instant::now());
    publish(sender, WatchStatus::Active, 0, None)?;
    let mut recent = VecDeque::with_capacity(MAX_RECENT_LOGS);
    let mut budget = Budget::new();
    let mut next_ping = Instant::now() + Duration::from_secs(10);
    let mut pending_pong: Option<(Vec<u8>, Instant)> = None;
    let mut ping_sequence = 0u64;
    loop {
        let timer = pending_pong.as_ref().map_or(next_ping, |(_, due)| *due);
        tokio::select! {
            biased;
            _ = &mut *stopped => {
                // Closing a read-only subscription is best effort. Dropping the
                // socket also removes its server subscriptions (Geth semantics).
                match tokio::time::timeout(Duration::from_millis(250), socket.close(None)).await {
                    Ok(Ok(())) | Ok(Err(_)) | Err(_) => {},
                }
                return Ok(());
            },
            _ = tokio::time::sleep_until(timer) => {
                if pending_pong.is_some() { return Err(WatchError::Timeout); }
                ping_sequence = ping_sequence.checked_add(1).ok_or(WatchError::Revision)?;
                let bytes = ping_sequence.to_be_bytes().to_vec();
                send(&mut socket, Message::Ping(bytes.clone().into()), timeout).await?;
                pending_pong = Some((bytes, Instant::now() + timeout));
            },
            message = socket.next() => {
                let message = message.ok_or(WatchError::Transport)?.map_err(|_| WatchError::Transport)?;
                budget.add(message.len())?;
                match message {
                    Message::Text(text) => {
                        let value = serde_json::from_str(&text).map_err(|_| WatchError::Protocol)?;
                        let key = validate_log(&value, filter, &subscriptions)?;
                        if !recent.contains(&key) {
                            if recent.len() == MAX_RECENT_LOGS { recent.pop_front(); }
                            recent.push_back(key);
                            publish(sender, WatchStatus::Active, 0, None)?;
                        }
                    },
                    Message::Ping(_) => {
                        tokio::time::timeout(timeout, socket.flush()).await.map_err(|_| WatchError::Timeout)?
                            .map_err(|_| WatchError::Transport)?;
                    },
                    Message::Pong(data) => {
                        if pending_pong.as_ref().is_some_and(|(expected, _)| expected.as_slice() == data.as_ref()) {
                            pending_pong = None;
                            next_ping = Instant::now() + Duration::from_secs(10);
                        }
                    },
                    Message::Close(_) => return Err(WatchError::Transport),
                    _ => return Err(WatchError::Protocol),
                }
            },
        }
    }
}

struct Budget {
    began: Instant,
    messages: usize,
    bytes: usize,
}
impl Budget {
    fn new() -> Self {
        Self {
            began: Instant::now(),
            messages: 0,
            bytes: 0,
        }
    }
    fn add(&mut self, bytes: usize) -> Result<(), WatchError> {
        if self.began.elapsed() >= Duration::from_secs(1) {
            *self = Self::new();
        }
        self.messages = self.messages.checked_add(1).ok_or(WatchError::EventLimit)?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(WatchError::EventLimit)?;
        if self.messages > MAX_MESSAGES_PER_SECOND || self.bytes > MAX_BYTES_PER_SECOND {
            return Err(WatchError::EventLimit);
        }
        Ok(())
    }
}

#[derive(PartialEq, Eq)]
struct LogKey {
    block: B256,
    transaction: B256,
    index: u64,
    removed: bool,
}
fn hex(value: &str, minimum: usize, maximum: usize) -> bool {
    value.starts_with("0x")
        && value.len() >= 2 + minimum * 2
        && value.len() <= 2 + maximum * 2
        && (value.len() - 2).is_multiple_of(2)
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}
fn quantity(value: &Value) -> Result<u64, WatchError> {
    let value = value.as_str().ok_or(WatchError::Protocol)?;
    let raw = value.strip_prefix("0x").ok_or(WatchError::Protocol)?;
    if raw.is_empty()
        || raw.len() > 16
        || (raw.len() > 1 && raw.starts_with('0'))
        || !raw.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(WatchError::Protocol);
    }
    u64::from_str_radix(raw, 16).map_err(|_| WatchError::Protocol)
}
fn hash(value: &Value) -> Result<B256, WatchError> {
    value
        .as_str()
        .filter(|s| hex(s, 32, 32))
        .ok_or(WatchError::Protocol)?
        .parse()
        .map_err(|_| WatchError::Protocol)
}
fn validate_log(
    value: &Value,
    filter: &Filter,
    subscriptions: &[String],
) -> Result<LogKey, WatchError> {
    let envelope = value.as_object().ok_or(WatchError::Protocol)?;
    if envelope.len() != 3 || value["jsonrpc"] != "2.0" || value["method"] != "eth_subscription" {
        return Err(WatchError::Protocol);
    }
    let params = value["params"]
        .as_object()
        .filter(|p| p.len() == 2)
        .ok_or(WatchError::Protocol)?;
    let subscription = params
        .get("subscription")
        .and_then(Value::as_str)
        .ok_or(WatchError::Protocol)?;
    let which = subscriptions
        .iter()
        .position(|s| s == subscription)
        .ok_or(WatchError::Protocol)?;
    let log = params
        .get("result")
        .and_then(Value::as_object)
        .ok_or(WatchError::Protocol)?;
    let get = |key: &str| log.get(key).ok_or(WatchError::Protocol);
    let emitter: Address = get("address")?
        .as_str()
        .filter(|s| hex(s, 20, 20))
        .ok_or(WatchError::Protocol)?
        .parse()
        .map_err(|_| WatchError::Protocol)?;
    let topics = get("topics")?
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 4)
        .ok_or(WatchError::Protocol)?;
    for topic in topics {
        hash(topic)?;
    }
    if (which == 0 && emitter != filter.nft)
        || (which == 1
            && (!filter.routes.contains(&emitter)
                || topics
                    .get(1)
                    .and_then(Value::as_str)
                    .is_none_or(|topic| !topic.eq_ignore_ascii_case(&filter.nft_topic()))))
    {
        return Err(WatchError::Protocol);
    }
    if !get("data")?
        .as_str()
        .is_some_and(|s| hex(s, 0, MAX_MESSAGE / 2))
    {
        return Err(WatchError::Protocol);
    }
    quantity(get("blockNumber")?)?;
    quantity(get("transactionIndex")?)?;
    if let Some(timestamp) = log.get("blockTimestamp") {
        quantity(timestamp)?;
    }
    let removed = match log.get("removed") {
        None => false,
        Some(value) => value.as_bool().ok_or(WatchError::Protocol)?,
    };
    Ok(LogKey {
        block: hash(get("blockHash")?)?,
        transaction: hash(get("transactionHash")?)?,
        index: quantity(get("logIndex")?)?,
        removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener};
    use tokio_tungstenite::accept_async;
    type TestSocket = WebSocketStream<TcpStream>;

    fn filter() -> Filter {
        Filter {
            nft: Address::repeat_byte(0x12),
            routes: vec![Address::repeat_byte(0x34)],
        }
    }
    fn log(subscription: &str, route: bool, index: u64, removed: bool) -> Value {
        let f = filter();
        let topics = if route {
            vec![json!(B256::repeat_byte(1)), json!(f.nft_topic())]
        } else {
            vec![json!(B256::repeat_byte(2))]
        };
        json!({"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":subscription,"result":{
            "address":if route {f.routes[0]} else {f.nft},"topics":topics,"data":"0x",
            "blockHash":B256::repeat_byte(3),"blockNumber":"0x12","transactionHash":B256::repeat_byte(4),
            "transactionIndex":"0x0","logIndex":format!("0x{index:x}"),"removed":removed}}})
    }
    async fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        (listener, url)
    }
    async fn request(socket: &mut TestSocket) -> Value {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(message, Message::Text(_)));
        serde_json::from_str(message.to_text().unwrap()).unwrap()
    }
    async fn reply(socket: &mut TestSocket, id: u64, result: Value) {
        socket
            .send(Message::Text(
                json!({"jsonrpc":"2.0","id":id,"result":result})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    }
    async fn subscribe(socket: &mut TestSocket) {
        let first = request(socket).await;
        assert_eq!(
            first,
            json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]})
        );
        reply(socket, 1, json!("0x1237")).await;
        for (index, expected) in filter().subscriptions().into_iter().enumerate() {
            let req = request(socket).await;
            assert_eq!(req["method"], "eth_subscribe");
            assert_eq!(req["id"], index + 2);
            assert_eq!(req["params"], json!(["logs", expected]));
            reply(
                socket,
                (index + 2) as u64,
                json!(if index == 0 { "0xaa" } else { "0xbb" }),
            )
            .await;
        }
    }
    async fn update(
        rx: &mut watch::Receiver<WatchUpdate>,
        status: WatchStatus,
        revision: u64,
    ) -> WatchUpdate {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = *rx.borrow_and_update();
                if value.status == status && value.revision >= revision {
                    return value;
                }
                rx.changed().await.unwrap();
            }
        })
        .await
        .unwrap()
    }
    fn start(url: &str, timeout: Duration) -> LogWatcher {
        LogWatcher::start(url, filter().nft, &filter().routes, timeout).unwrap()
    }

    #[test]
    fn only_secure_or_literal_loopback_ws_endpoints() {
        for good in [
            "wss://robinhood-rpc.publicnode.com",
            "ws://127.0.0.1:8080",
            "ws://[::1]:8080",
        ] {
            assert!(endpoint(good).is_ok(), "{good}");
        }
        for bad in [
            "https://example.org",
            "ws://example.org",
            "ws://localhost:8080",
            "wss://user:secret@example.org",
            "wss://@example.org",
            "wss://example.org#fragment",
            "wss://feed.mainnet.chain.robinhood.com",
            "wss://FEED.example.org",
            "wss://example.org\\@evil.test",
            "wss://example.org/a b",
        ] {
            assert_eq!(endpoint(bad).err(), Some(WatchError::Configuration));
        }
        // Public construction outside Tokio fails rather than panicking.
        assert!(
            LogWatcher::start(
                "ws://127.0.0.1:9",
                filter().nft,
                &filter().routes,
                Duration::from_secs(1)
            )
            .is_err()
        );
    }

    #[test]
    fn route_topics_are_nft_specific_and_event_fields_are_strict() {
        let f = filter();
        assert_eq!(
            f.nft_topic(),
            format!("0x{}{}", "0".repeat(24), "12".repeat(20))
        );
        let ids = vec!["0xaa".into(), "0xbb".into()];
        assert!(validate_log(&log("0xaa", false, 0, false), &f, &ids).is_ok());
        assert!(validate_log(&log("0xbb", true, 1, true), &f, &ids).is_ok());
        let base = log("0xaa", false, 0, false);
        let mut cases = Vec::new();
        for (field, value) in [
            ("address", json!(Address::repeat_byte(9))),
            ("blockHash", json!("0x01")),
            ("blockNumber", json!("0x01")),
            ("transactionIndex", json!(null)),
            ("logIndex", json!(-1)),
            ("removed", json!("false")),
            ("data", json!("0x0")),
            ("topics", json!([])),
            ("topics", json!(vec![B256::ZERO; 5])),
        ] {
            let mut changed = base.clone();
            changed["params"]["result"][field] = value;
            cases.push(changed);
        }
        let mut missing = base.clone();
        missing["params"]
            .as_object_mut()
            .unwrap()
            .remove("subscription");
        missing["params"]["unexpected"] = json!("0xaa");
        cases.push(missing);
        let mut stale_session = base.clone();
        stale_session["params"]["subscription"] = json!("0xff");
        cases.push(stale_session);
        let mut mixed_envelope = base.clone();
        mixed_envelope["id"] = json!(2);
        cases.push(mixed_envelope);
        let mut wrong_nft = log("0xbb", true, 1, false);
        wrong_nft["params"]["result"]["topics"][1] = json!(B256::ZERO);
        cases.push(wrong_nft);
        for invalid in cases {
            assert!(validate_log(&invalid, &f, &ids).is_err());
        }
    }

    #[test]
    fn flood_budget_bounds_messages_and_bytes() {
        let mut count = Budget::new();
        for _ in 0..MAX_MESSAGES_PER_SECOND {
            count.add(0).unwrap();
        }
        assert_eq!(count.add(0), Err(WatchError::EventLimit));
        let mut bytes = Budget::new();
        bytes.add(MAX_BYTES_PER_SECOND).unwrap();
        assert_eq!(bytes.add(1), Err(WatchError::EventLimit));
    }

    #[tokio::test]
    async fn bounded_address_configuration_and_timeout() {
        let nft = filter().nft;
        for routes in [
            vec![],
            vec![Address::ZERO],
            vec![nft],
            vec![filter().routes[0]; 2],
            (1..=5).map(Address::with_last_byte).collect(),
        ] {
            assert!(
                LogWatcher::start("ws://127.0.0.1:9", nft, &routes, Duration::from_secs(1))
                    .is_err()
            );
        }
        assert!(
            LogWatcher::start("ws://127.0.0.1:9", nft, &filter().routes, Duration::ZERO).is_err()
        );
    }

    #[tokio::test]
    async fn coalesces_duplicate_logs_but_wakes_for_reorg_and_closes_on_stop() {
        let (listener, url) = listener().await;
        let server = tokio::spawn(async move {
            let mut socket = accept_async(listener.accept().await.unwrap().0)
                .await
                .unwrap();
            subscribe(&mut socket).await;
            for notification in [
                log("0xaa", false, 0, false),
                log("0xaa", false, 0, false),
                log("0xbb", true, 1, false),
                log("0xaa", false, 0, true),
            ] {
                socket
                    .send(Message::Text(notification.to_string().into()))
                    .await
                    .unwrap();
            }
            let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(closed, Message::Close(_)));
        });
        let watcher = start(&url, Duration::from_secs(1));
        let mut rx = watcher.updates();
        let latest = update(&mut rx, WatchStatus::Active, 4).await;
        assert_eq!(
            latest.revision, 4,
            "One active transition and three distinct hints; duplicate does not wake."
        );
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn answers_server_ping_without_publishing_a_log_hint() {
        let (listener, url) = listener().await;
        let (pong_seen, pong_ready) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_async(listener.accept().await.unwrap().0)
                .await
                .unwrap();
            subscribe(&mut socket).await;
            let payload = b"synthetic server heartbeat";
            socket
                .send(Message::Ping(payload.to_vec().into()))
                .await
                .unwrap();
            let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(message, Message::Pong(payload.to_vec().into()));
            pong_seen.send(()).unwrap();
            let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(closed, Message::Close(_)));
        });
        let watcher = start(&url, Duration::from_secs(1));
        let mut rx = watcher.updates();
        update(&mut rx, WatchStatus::Active, 1).await;
        pong_ready.await.unwrap();
        assert_eq!(
            rx.borrow().revision,
            1,
            "Control frames cannot wake minting."
        );
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_messages_are_rejected_with_a_bounded_retry_budget() {
        let (listener, url) = listener().await;
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let mut socket = accept_async(listener.accept().await.unwrap().0)
                    .await
                    .unwrap();
                subscribe(&mut socket).await;
                let write = tokio::time::timeout(
                    Duration::from_secs(2),
                    socket.send(Message::Text("x".repeat(MAX_MESSAGE + 1).into())),
                )
                .await;
                // The client may close immediately on the oversized header,
                // before the kernel has accepted the complete payload.
                assert!(write.is_ok(), "The server write must stay bounded.");
            }
        });
        let watcher = start(&url, Duration::from_secs(1));
        let mut rx = watcher.updates();
        let last = update(&mut rx, WatchStatus::Degraded, 1).await;
        assert_eq!(last.failures, 3);
        assert_eq!(last.error, Some(WatchError::Transport));
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn old_subscription_notifications_degrade_after_three_fresh_sessions() {
        let (listener, url) = listener().await;
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let mut socket = accept_async(listener.accept().await.unwrap().0)
                    .await
                    .unwrap();
                subscribe(&mut socket).await;
                socket
                    .send(Message::Text(
                        log("0xdead", false, 0, false).to_string().into(),
                    ))
                    .await
                    .unwrap();
            }
        });
        let watcher = start(&url, Duration::from_secs(1));
        let mut rx = watcher.updates();
        let last = update(&mut rx, WatchStatus::Degraded, 1).await;
        assert_eq!(last.failures, 3);
        assert_eq!(last.error, Some(WatchError::Protocol));
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn immediate_disconnects_do_not_reset_the_three_failure_budget() {
        let (listener, url) = listener().await;
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let mut socket = accept_async(listener.accept().await.unwrap().0)
                    .await
                    .unwrap();
                subscribe(&mut socket).await;
                socket.close(None).await.unwrap();
            }
        });
        let watcher = start(&url, Duration::from_secs(1));
        let mut rx = watcher.updates();
        let last = update(&mut rx, WatchStatus::Degraded, 1).await;
        assert_eq!(last.failures, 3);
        assert_eq!(last.error, Some(WatchError::Transport));
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn wrong_chain_rpc_id_remote_error_and_duplicate_subscription_ids_fail_closed() {
        for fault in ["chain", "id", "remote", "duplicate"] {
            let (listener, url) = listener().await;
            let server = tokio::spawn(async move {
                for _ in 0..3 {
                    let mut socket = accept_async(listener.accept().await.unwrap().0)
                        .await
                        .unwrap();
                    assert_eq!(request(&mut socket).await["method"], "eth_chainId");
                    match fault {
                        "chain" => reply(&mut socket, 1, json!("0x1")).await,
                        "id" => reply(&mut socket, 9, json!("0x1237")).await,
                        "remote" => socket
                            .send(Message::Text(
                                json!({"jsonrpc":"2.0","id":1,"error":{"code":-32001,
                            "message":"SYNTHETIC_SECRET_MUST_NOT_ESCAPE"}})
                                .to_string()
                                .into(),
                            ))
                            .await
                            .unwrap(),
                        _ => {
                            reply(&mut socket, 1, json!("0x1237")).await;
                            request(&mut socket).await;
                            reply(&mut socket, 2, json!("0xaa")).await;
                            request(&mut socket).await;
                            reply(&mut socket, 3, json!("0xaa")).await;
                        }
                    }
                }
            });
            let watcher = start(&url, Duration::from_secs(1));
            let mut rx = watcher.updates();
            let last = update(&mut rx, WatchStatus::Degraded, 1).await;
            assert_eq!(last.failures, 3);
            assert_eq!(
                last.error,
                Some(match fault {
                    "chain" => WatchError::WrongChain,
                    "remote" => WatchError::Remote { code: -32001 },
                    _ => WatchError::Protocol,
                })
            );
            assert!(
                !serde_json::to_string(&last)
                    .unwrap()
                    .contains("SYNTHETIC_SECRET")
            );
            watcher.stop().await.unwrap();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn hanging_handshakes_timeout_three_times_then_allow_polling_fallback() {
        let (listener, url) = listener().await;
        let (release, wait) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            for _ in 0..3 {
                sockets.push(listener.accept().await.unwrap().0);
            }
            wait.await.unwrap();
            drop(sockets);
        });
        let watcher = start(&url, Duration::from_millis(200));
        let mut rx = watcher.updates();
        let last = update(&mut rx, WatchStatus::Degraded, 1).await;
        assert_eq!(last.failures, 3);
        assert_eq!(last.error, Some(WatchError::Timeout));
        release.send(()).unwrap();
        watcher.stop().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stop_interrupts_pending_handshake_and_drop_aborts_the_owned_task() {
        for explicit_stop in [true, false] {
            let (listener, url) = listener().await;
            let (accepted, ready) = oneshot::channel();
            let server = tokio::spawn(async move {
                let mut socket = listener.accept().await.unwrap().0;
                accepted.send(()).unwrap();
                let mut buffer = [0u8; 4096];
                loop {
                    if socket.read(&mut buffer).await.unwrap() == 0 {
                        break;
                    }
                }
            });
            let watcher = start(&url, Duration::from_secs(20));
            ready.await.unwrap();
            if explicit_stop {
                watcher.stop().await.unwrap();
            } else {
                drop(watcher);
            }
            tokio::time::timeout(Duration::from_secs(1), server)
                .await
                .unwrap()
                .unwrap();
        }
    }
}
