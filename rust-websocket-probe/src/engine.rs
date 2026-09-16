use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use crate::{
    ProbeError,
    config::{Endpoint, EngineKind, MAX_MESSAGE_BYTES},
    raw::{self, RawEvent, RawWebSocket},
    transport::Stream,
};

pub enum Event {
    Pong(Vec<u8>),
    Ping(Vec<u8>),
    Message { bytes: usize },
    Close,
}

pub enum Engine {
    Tungstenite(Box<WebSocketStream<Stream>>),
    Raw(RawWebSocket<Stream>),
}

impl Engine {
    pub async fn handshake(
        kind: EngineKind,
        stream: Stream,
        endpoint: &Endpoint,
    ) -> Result<Self, ProbeError> {
        match kind {
            EngineKind::Raw => raw::handshake(
                stream,
                &endpoint.authority,
                &endpoint.path,
                MAX_MESSAGE_BYTES,
            )
            .await
            .map(Self::Raw)
            .map_err(map_raw),
            EngineKind::Tungstenite => {
                let config = WebSocketConfig::default()
                    .read_buffer_size(16 * 1024)
                    .write_buffer_size(0)
                    .max_write_buffer_size(4096)
                    .max_message_size(Some(MAX_MESSAGE_BYTES))
                    .max_frame_size(Some(MAX_MESSAGE_BYTES));
                let (ws, response) =
                    client_async_with_config(endpoint.url.as_str(), stream, Some(config))
                        .await
                        .map_err(map_library)?;
                if response.headers().contains_key("sec-websocket-extensions")
                    || response.headers().contains_key("sec-websocket-protocol")
                {
                    return Err(ProbeError::Protocol);
                }
                Ok(Self::Tungstenite(Box::new(ws)))
            }
        }
    }

    pub async fn send_ping(&mut self, payload: &[u8]) -> Result<(), ProbeError> {
        match self {
            Self::Raw(ws) => ws.send_ping(payload).await.map_err(map_raw),
            Self::Tungstenite(ws) => ws
                .send(Message::Ping(payload.to_vec().into()))
                .await
                .map_err(map_library),
        }
    }

    pub async fn send_pong(&mut self, payload: &[u8]) -> Result<(), ProbeError> {
        match self {
            Self::Raw(ws) => ws.send_pong(payload).await.map_err(map_raw),
            // Explicit Pong replaces the matching queued automatic pong; send also flushes it.
            Self::Tungstenite(ws) => ws
                .send(Message::Pong(payload.to_vec().into()))
                .await
                .map_err(map_library),
        }
    }

    /// Both readers preserve partial input in their owned state when this future is cancelled.
    pub async fn next_event(&mut self) -> Result<Event, ProbeError> {
        match self {
            Self::Raw(ws) => match ws.next_event().await.map_err(map_raw)? {
                RawEvent::Pong(payload) => Ok(Event::Pong(payload)),
                RawEvent::Ping(payload) => Ok(Event::Ping(payload)),
                RawEvent::Message { bytes } => Ok(Event::Message { bytes }),
                RawEvent::Close => Ok(Event::Close),
            },
            Self::Tungstenite(ws) => match ws
                .next()
                .await
                .ok_or(ProbeError::Closed)?
                .map_err(map_library)?
            {
                Message::Pong(payload) => Ok(Event::Pong(payload.to_vec())),
                Message::Ping(payload) => Ok(Event::Ping(payload.to_vec())),
                Message::Text(payload) => Ok(Event::Message {
                    bytes: payload.len(),
                }),
                Message::Binary(payload) => Ok(Event::Message {
                    bytes: payload.len(),
                }),
                Message::Close(_) => Ok(Event::Close),
                Message::Frame(_) => Err(ProbeError::Protocol),
            },
        }
    }
}

fn map_library(error: tokio_tungstenite::tungstenite::Error) -> ProbeError {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Http(response) => ProbeError::HttpStatus(response.status().as_u16()),
        Error::Io(_) => ProbeError::Network,
        Error::ConnectionClosed | Error::AlreadyClosed => ProbeError::Closed,
        _ => ProbeError::Protocol,
    }
}

fn map_raw(error: raw::RawError) -> ProbeError {
    match error {
        raw::RawError::Io(_) => ProbeError::Network,
        raw::RawError::HttpStatus(status) => ProbeError::HttpStatus(status),
        raw::RawError::Closed => ProbeError::Closed,
        _ => ProbeError::Protocol,
    }
}
