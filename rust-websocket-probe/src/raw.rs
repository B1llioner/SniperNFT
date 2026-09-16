//! Small RFC 6455 client codec: one persistent stream, no JSON parsing or feed
//! payload allocations. TLS, DNS, deadlines and the ping schedule belong to the
//! caller. `next_event` is cancellation-safe; interrupted writes poison the
//! writer because an incomplete frame cannot safely be retried on that stream.

use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::{Buf, BufMut, BytesMut};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const HEADER_LIMIT: usize = 16 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const MESSAGE_LIMIT: usize = 8 * 1024 * 1024;
const FRAGMENT_LIMIT: usize = 4096;
const GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

#[derive(Debug, thiserror::Error)]
pub enum RawError {
    #[error("WebSocket I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("WebSocket entropy source failed: {0}")]
    Entropy(String),
    #[error("WebSocket upgrade rejected with HTTP {0}")]
    HttpStatus(u16),
    #[error("Invalid WebSocket upgrade: {0}")]
    Handshake(&'static str),
    #[error("Invalid WebSocket protocol: {0}")]
    Protocol(&'static str),
    #[error("WebSocket stream is closed or an earlier write was interrupted")]
    Closed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RawEvent {
    Pong(Vec<u8>),
    Ping(Vec<u8>),
    Message { bytes: usize },
    Close,
}

#[derive(Debug)]
struct Frame {
    opcode: u8,
    fin: bool,
    remaining: usize,
    control: Vec<u8>,
}

#[derive(Debug)]
struct Message {
    text: bool,
    bytes: usize,
    fragments: usize,
    utf8: Utf8,
}

/// UTF-8 state spans both network reads and WebSocket fragments. The first
/// continuation range rejects overlong forms, surrogates and values > U+10FFFF.
#[derive(Debug, Default)]
struct Utf8 {
    remaining: u8,
    low: u8,
    high: u8,
}

impl Utf8 {
    fn feed(&mut self, input: &[u8]) -> Result<(), RawError> {
        for &byte in input {
            if self.remaining != 0 {
                if byte < self.low || byte > self.high {
                    return Err(RawError::Protocol("invalid UTF-8"));
                }
                self.remaining -= 1;
                self.low = 0x80;
                self.high = 0xbf;
                continue;
            }
            (self.remaining, self.low, self.high) = match byte {
                0x00..=0x7f => (0, 0, 0),
                0xc2..=0xdf => (1, 0x80, 0xbf),
                0xe0 => (2, 0xa0, 0xbf),
                0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
                0xed => (2, 0x80, 0x9f),
                0xf0 => (3, 0x90, 0xbf),
                0xf1..=0xf3 => (3, 0x80, 0xbf),
                0xf4 => (3, 0x80, 0x8f),
                _ => return Err(RawError::Protocol("invalid UTF-8")),
            };
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), RawError> {
        if self.remaining == 0 {
            Ok(())
        } else {
            Err(RawError::Protocol("incomplete UTF-8 at end of message"))
        }
    }
}

pub struct RawWebSocket<S> {
    stream: S,
    input: BytesMut,
    frame: Option<Frame>,
    message: Option<Message>,
    max_message_bytes: usize,
    read_closed: bool,
    write_closed: bool,
    write_in_progress: bool,
}

fn accept_key(key: &str) -> String {
    // SHA-1 is mandated by RFC 6455 for upgrade validation, not authentication.
    let mut hash = Sha1::new();
    hash.update(key.as_bytes());
    hash.update(GUID);
    STANDARD.encode(hash.finalize())
}

fn token_contains(value: &[u8], expected: &[u8]) -> bool {
    value
        .split(|&byte| byte == b',')
        .any(|token| trim_ows(token).eq_ignore_ascii_case(expected))
}

fn trim_ows(mut input: &[u8]) -> &[u8] {
    while matches!(input.first(), Some(b' ' | b'\t')) {
        input = &input[1..];
    }
    while matches!(input.last(), Some(b' ' | b'\t')) {
        input = &input[..input.len() - 1];
    }
    input
}

fn validate_response(input: &[u8], expected: &str) -> Result<Option<usize>, RawError> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    let parsed = response
        .parse(input)
        .map_err(|_| RawError::Handshake("malformed HTTP response or too many headers"))?;
    let httparse::Status::Complete(consumed) = parsed else {
        return Ok(None);
    };
    if response.version != Some(1) {
        return Err(RawError::Handshake("HTTP/1.1 is required"));
    }
    let status = response
        .code
        .ok_or(RawError::Handshake("missing HTTP status"))?;
    if status != 101 {
        return Err(RawError::HttpStatus(status));
    }
    let mut upgrade = false;
    let mut connection = false;
    let mut accept = None;
    for header in response.headers {
        if header.name.eq_ignore_ascii_case("upgrade") {
            upgrade |= token_contains(header.value, b"websocket");
        } else if header.name.eq_ignore_ascii_case("connection") {
            connection |= token_contains(header.value, b"upgrade");
        } else if header.name.eq_ignore_ascii_case("sec-websocket-accept") {
            if accept.is_some() {
                return Err(RawError::Handshake("duplicate Sec-WebSocket-Accept"));
            }
            accept = Some(trim_ows(header.value));
        } else if header.name.eq_ignore_ascii_case("sec-websocket-extensions")
            || header.name.eq_ignore_ascii_case("sec-websocket-protocol")
        {
            return Err(RawError::Handshake("unsolicited extension or subprotocol"));
        }
    }
    if !upgrade || !connection || accept != Some(expected.as_bytes()) {
        return Err(RawError::Handshake(
            "upgrade headers or accept key do not match",
        ));
    }
    Ok(Some(consumed))
}

/// Upgrade an already connected TCP/TLS stream. The caller applies an overall
/// timeout and discards this future/stream if it is cancelled during upgrade.
pub async fn handshake<S>(
    mut stream: S,
    host: &str,
    path: &str,
    max_message_bytes: usize,
) -> Result<RawWebSocket<S>, RawError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if max_message_bytes == 0 || max_message_bytes > MESSAGE_LIMIT {
        return Err(RawError::Handshake(
            "message limit must be within 1..=8 MiB",
        ));
    }
    if host.is_empty()
        || host.len() > 1024
        || host
            .bytes()
            .any(|b| !(0x21..=0x7e).contains(&b) || b"/\\?#@".contains(&b))
        || !path.starts_with('/')
        || path.len() > 8192
        || path
            .bytes()
            .any(|b| !(0x21..=0x7e).contains(&b) || b == b'#')
    {
        return Err(RawError::Handshake("invalid Host or request target"));
    }
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| RawError::Entropy(error.to_string()))?;
    let key = STANDARD.encode(nonce);
    let expected = accept_key(&key);
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: vinos-rust-websocket-probe\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    let mut input = BytesMut::with_capacity(READ_CHUNK);
    loop {
        if let Some(consumed) = validate_response(&input, &expected)? {
            input.advance(consumed);
            return Ok(RawWebSocket {
                stream,
                input,
                frame: None,
                message: None,
                max_message_bytes,
                read_closed: false,
                write_closed: false,
                write_in_progress: false,
            });
        }
        if input.len() == HEADER_LIMIT {
            return Err(RawError::Handshake("HTTP response headers exceed 16 KiB"));
        }
        let limit = (HEADER_LIMIT - input.len()).min(READ_CHUNK);
        let count = stream.read_buf(&mut (&mut input).limit(limit)).await?;
        if count == 0 {
            return Err(RawError::Handshake("EOF before HTTP upgrade completed"));
        }
    }
}

fn parse_frame(input: &[u8], limit: usize) -> Result<Option<(Frame, usize)>, RawError> {
    if input.len() < 2 {
        return Ok(None);
    }
    let opcode = input[0] & 0x0f;
    let fin = input[0] & 0x80 != 0;
    if input[0] & 0x70 != 0 {
        return Err(RawError::Protocol("RSV bits set without an extension"));
    }
    if !matches!(opcode, 0 | 1 | 2 | 8 | 9 | 10) {
        return Err(RawError::Protocol("reserved opcode"));
    }
    if input[1] & 0x80 != 0 {
        return Err(RawError::Protocol("server frame must not be masked"));
    }
    let length_code = input[1] & 0x7f;
    if opcode >= 8 && (!fin || length_code > 125) {
        return Err(RawError::Protocol(
            "control frames must be final and <=125 bytes",
        ));
    }
    let (length, consumed) = match length_code {
        126 if input.len() < 4 => return Ok(None),
        126 => {
            let length = u16::from_be_bytes([input[2], input[3]]);
            if length < 126 {
                return Err(RawError::Protocol("non-minimal 16-bit frame length"));
            }
            (u64::from(length), 4)
        }
        127 if input.len() < 10 => return Ok(None),
        127 => {
            let length = u64::from_be_bytes([
                input[2], input[3], input[4], input[5], input[6], input[7], input[8], input[9],
            ]);
            if length < 65536 || length & (1 << 63) != 0 {
                return Err(RawError::Protocol(
                    "invalid or non-minimal 64-bit frame length",
                ));
            }
            (length, 10)
        }
        length => (u64::from(length), 2),
    };
    let remaining = usize::try_from(length)
        .map_err(|_| RawError::Protocol("frame length exceeds platform size"))?;
    if opcode < 8 && remaining > limit {
        return Err(RawError::Protocol("frame exceeds message size limit"));
    }
    Ok(Some((
        Frame {
            opcode,
            fin,
            remaining,
            control: Vec::new(),
        },
        consumed,
    )))
}

fn validate_close(payload: &[u8]) -> Result<(), RawError> {
    if payload.len() == 1 {
        return Err(RawError::Protocol(
            "close payload must be empty or contain a status",
        ));
    }
    if payload.len() >= 2 {
        let code = u16::from_be_bytes([payload[0], payload[1]]);
        if !matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999) {
            return Err(RawError::Protocol("invalid close status"));
        }
        std::str::from_utf8(&payload[2..])
            .map_err(|_| RawError::Protocol("invalid UTF-8 close reason"))?;
    }
    Ok(())
}

impl<S: AsyncRead + AsyncWrite + Unpin> RawWebSocket<S> {
    /// Exactly one masked control frame. Cancellation poisons this writer; the
    /// caller must discard the stream rather than retrying a partial frame.
    async fn write_control(&mut self, opcode: u8, payload: &[u8]) -> Result<(), RawError> {
        if self.write_closed || self.write_in_progress {
            return Err(RawError::Closed);
        }
        if payload.len() > 125 {
            return Err(RawError::Protocol("control payload exceeds 125 bytes"));
        }
        let mut mask = [0_u8; 4];
        getrandom::fill(&mut mask).map_err(|error| RawError::Entropy(error.to_string()))?;
        let mut frame = [0_u8; 131];
        frame[0] = 0x80 | opcode;
        frame[1] = 0x80 | (payload.len() as u8);
        frame[2..6].copy_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            frame[index + 6] = byte ^ mask[index % 4];
        }
        self.write_in_progress = true;
        self.stream.write_all(&frame[..payload.len() + 6]).await?;
        self.stream.flush().await?;
        self.write_in_progress = false;
        self.write_closed = opcode == 8;
        Ok(())
    }

    pub async fn send_ping(&mut self, payload: &[u8]) -> Result<(), RawError> {
        self.write_control(9, payload).await
    }

    pub async fn send_pong(&mut self, payload: &[u8]) -> Result<(), RawError> {
        self.write_control(10, payload).await
    }

    pub async fn close(&mut self) -> Result<(), RawError> {
        self.write_control(8, &1000_u16.to_be_bytes()).await
    }

    fn start_frame(&mut self, frame: &Frame) -> Result<(), RawError> {
        match frame.opcode {
            1 | 2 => {
                if self.message.is_some() {
                    return Err(RawError::Protocol("new message during fragmented message"));
                }
                self.message = Some(Message {
                    text: frame.opcode == 1,
                    bytes: frame.remaining,
                    fragments: 1,
                    utf8: Utf8::default(),
                });
            }
            0 => {
                let message = self.message.as_mut().ok_or(RawError::Protocol(
                    "continuation without a fragmented message",
                ))?;
                message.fragments += 1;
                if message.fragments > FRAGMENT_LIMIT {
                    return Err(RawError::Protocol("too many fragments"));
                }
                message.bytes = message
                    .bytes
                    .checked_add(frame.remaining)
                    .filter(|&bytes| bytes <= self.max_message_bytes)
                    .ok_or(RawError::Protocol("fragmented message exceeds size limit"))?;
            }
            _ => {}
        }
        Ok(())
    }

    fn consume_payload(&mut self) -> Result<Option<RawEvent>, RawError> {
        let frame = self
            .frame
            .as_mut()
            .ok_or(RawError::Protocol("missing frame state"))?;
        let count = self.input.len().min(frame.remaining);
        if frame.opcode >= 8 {
            frame.control.extend_from_slice(&self.input[..count]);
        } else {
            let message = self
                .message
                .as_mut()
                .ok_or(RawError::Protocol("missing message state"))?;
            if message.text {
                message.utf8.feed(&self.input[..count])?;
            }
        }
        self.input.advance(count);
        frame.remaining -= count;
        if frame.remaining != 0 {
            return Ok(None);
        }
        let frame = self
            .frame
            .take()
            .ok_or(RawError::Protocol("missing completed frame"))?;
        match frame.opcode {
            8 => {
                validate_close(&frame.control)?;
                self.read_closed = true;
                Ok(Some(RawEvent::Close))
            }
            9 => Ok(Some(RawEvent::Ping(frame.control))),
            10 => Ok(Some(RawEvent::Pong(frame.control))),
            _ if frame.fin => {
                let message = self
                    .message
                    .take()
                    .ok_or(RawError::Protocol("missing completed message"))?;
                if message.text {
                    message.utf8.finish()?;
                }
                Ok(Some(RawEvent::Message {
                    bytes: message.bytes,
                }))
            }
            _ => Ok(None),
        }
    }

    /// All partial bytes and fragment state belong to `self`, so a select!
    /// timer can cancel this future at any await without losing consumed bytes.
    pub async fn next_event(&mut self) -> Result<RawEvent, RawError> {
        if self.read_closed || self.write_in_progress {
            return Err(RawError::Closed);
        }
        let result = self.next_event_inner().await;
        if result.is_err() {
            self.read_closed = true;
        }
        result
    }

    async fn next_event_inner(&mut self) -> Result<RawEvent, RawError> {
        loop {
            if self.frame.is_none()
                && let Some((frame, consumed)) = parse_frame(&self.input, self.max_message_bytes)?
            {
                self.start_frame(&frame)?;
                self.input.advance(consumed);
                self.frame = Some(frame);
            }
            if self.frame.is_some() {
                if let Some(event) = self.consume_payload()? {
                    return Ok(event);
                }
                if !self.input.is_empty() {
                    continue;
                }
            }
            let count = self
                .stream
                .read_buf(&mut (&mut self.input).limit(READ_CHUNK))
                .await?;
            if count == 0 {
                return Err(RawError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "connection ended without a WebSocket close frame",
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{DuplexStream, duplex};

    fn socket(stream: DuplexStream, max_message_bytes: usize) -> RawWebSocket<DuplexStream> {
        RawWebSocket {
            stream,
            input: BytesMut::new(),
            frame: None,
            message: None,
            max_message_bytes,
            read_closed: false,
            write_closed: false,
            write_in_progress: false,
        }
    }

    fn frame(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mut output = vec![opcode | if fin { 0x80 } else { 0 }];
        if payload.len() < 126 {
            output.push(payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            output.push(126);
            output.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            output.push(127);
            output.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        output.extend_from_slice(payload);
        output
    }

    #[test]
    fn rfc_accept_key_and_response_validation() {
        let accept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), accept);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUPGRADE: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        assert_eq!(
            validate_response(response.as_bytes(), accept).unwrap(),
            Some(response.len())
        );
        for end in 0..response.len() {
            assert_eq!(
                validate_response(&response.as_bytes()[..end], accept).unwrap(),
                None
            );
        }
        let invalid = [
            response.replace("101 Switching Protocols", "400 Bad Request"),
            response.replace("HTTP/1.1", "HTTP/1.0"),
            response.replace("WebSocket", "other"),
            response.replace("keep-alive, Upgrade", "keep-alive"),
            response.replace(accept, "wrong"),
            response.replace("\r\n\r\n", "\r\nSec-WebSocket-Protocol: foo\r\n\r\n"),
            response.replace(
                "\r\n\r\n",
                "\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
            ),
            response.replace(
                "\r\n\r\n",
                &format!("\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"),
            ),
        ];
        for input in invalid {
            assert!(
                validate_response(input.as_bytes(), accept).is_err(),
                "{input}"
            );
        }
    }

    #[test]
    fn invalid_frame_headers_are_rejected_before_payload_allocation() {
        let invalid: &[&[u8]] = &[
            &[0xc2, 0],           // RSV without negotiated extensions.
            &[0x83, 0],           // Reserved opcode.
            &[0x89, 0x80],        // A server must not mask.
            &[0x09, 0],           // Fragmented control.
            &[0x8a, 126],         // Extended control length.
            &[0x82, 126, 0, 125], // Non-minimal extended length.
            &[0x82, 127, 0, 0, 0, 0, 0, 0, 0xff, 0xff],
            &[0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 0],
            &[0x82, 127, 0, 0, 0, 0, 0, 0x80, 0, 1], // 8MiB+1.
        ];
        for input in invalid {
            assert!(parse_frame(input, MESSAGE_LIMIT).is_err(), "{input:?}");
        }
        assert!(
            parse_frame(&[0x82, 126, 0], MESSAGE_LIMIT)
                .unwrap()
                .is_none()
        );
        assert!(
            parse_frame(&[0x82, 127, 0, 0], MESSAGE_LIMIT)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn utf8_streaming_matches_standard_for_all_two_byte_inputs() {
        for first in 0_u8..=255 {
            for second in 0_u8..=255 {
                let input = [first, second];
                let expected = std::str::from_utf8(&input).is_ok();
                let mut validator = Utf8::default();
                let actual = validator
                    .feed(&input[..1])
                    .and_then(|()| validator.feed(&input[1..]))
                    .and_then(|()| validator.finish())
                    .is_ok();
                assert_eq!(actual, expected, "{input:?}");
            }
        }
    }

    #[test]
    fn utf8_streaming_matches_standard_for_generated_longer_inputs() {
        let mut seed = 123456789_u64;
        for length in 0..=12 {
            for _ in 0..5000 {
                let mut input = [0_u8; 12];
                for byte in &mut input[..length] {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    *byte = (seed >> 32) as u8;
                }
                let input = &input[..length];
                let mut validator = Utf8::default();
                let actual = input
                    .chunks(1)
                    .try_for_each(|part| validator.feed(part))
                    .and_then(|()| validator.finish())
                    .is_ok();
                assert_eq!(actual, std::str::from_utf8(input).is_ok(), "{input:?}");
            }
        }
        for input in ["€", "😀", "\u{10ffff}", "\u{800}", "\u{d7ff}", "\u{e000}"] {
            let mut validator = Utf8::default();
            for byte in input.as_bytes().chunks(1) {
                validator.feed(byte).unwrap();
            }
            validator.finish().unwrap();
        }
    }

    #[test]
    fn close_payload_checks_status_and_utf8() {
        for code in [1000_u16, 1001, 1003, 1007, 1014, 3000, 4999] {
            assert!(validate_close(&code.to_be_bytes()).is_ok());
        }
        for code in [0_u16, 999, 1004, 1005, 1006, 1015, 2000, 5000] {
            assert!(validate_close(&code.to_be_bytes()).is_err());
        }
        assert!(validate_close(&[]).is_ok());
        assert!(validate_close(&[0]).is_err());
        assert!(validate_close(&[3, 232, 0xff]).is_err());
    }

    #[tokio::test]
    async fn fragmented_utf8_accepts_interleaved_control_frames() {
        let (client, mut server) = duplex(1024);
        let mut ws = socket(client, MESSAGE_LIMIT);
        let mut input = frame(1, false, &[0xf0, 0x9f]);
        input.extend(frame(9, true, b"server-ping"));
        input.extend(frame(0, true, &[0x98, 0x80]));
        input.extend(frame(10, true, b"our-ping"));
        server.write_all(&input).await.unwrap();
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Ping(b"server-ping".to_vec())
        );
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Message { bytes: 4 }
        );
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Pong(b"our-ping".to_vec())
        );
    }

    #[tokio::test]
    async fn invalid_fragment_sequences_and_message_utf8_fail() {
        let cases = [
            frame(0, true, b"orphan"),
            [frame(1, false, b"first"), frame(2, true, b"second")].concat(),
            frame(1, true, &[0xc0, 0xaf]),
            frame(1, true, &[0xed, 0xa0, 0x80]),
            frame(1, true, &[0xf4, 0x90, 0x80, 0x80]),
            frame(1, true, &[0xe2, 0x82]),
            [frame(1, false, &[0xe2]), frame(0, true, b"x")].concat(),
        ];
        for input in cases {
            let (client, mut server) = duplex(1024);
            let mut ws = socket(client, MESSAGE_LIMIT);
            server.write_all(&input).await.unwrap();
            assert!(
                matches!(ws.next_event().await, Err(RawError::Protocol(_))),
                "{input:?}"
            );
            assert!(matches!(ws.next_event().await, Err(RawError::Closed)));
        }
    }

    #[tokio::test]
    async fn aggregate_message_limit_is_checked_across_fragments() {
        let (client, mut server) = duplex(1024);
        let mut ws = socket(client, 4);
        server
            .write_all(&[frame(2, false, b"abc"), frame(0, true, b"de")].concat())
            .await
            .unwrap();
        assert!(matches!(
            ws.next_event().await,
            Err(RawError::Protocol("fragmented message exceeds size limit"))
        ));
    }

    #[tokio::test]
    async fn empty_fragment_flood_is_bounded() {
        let (client, mut server) = duplex(FRAGMENT_LIMIT * 2 + 8);
        let mut ws = socket(client, MESSAGE_LIMIT);
        let mut input = frame(2, false, &[]);
        for _ in 0..FRAGMENT_LIMIT {
            input.extend(frame(0, false, &[]));
        }
        server.write_all(&input).await.unwrap();
        assert!(matches!(
            ws.next_event().await,
            Err(RawError::Protocol("too many fragments"))
        ));
    }

    #[tokio::test]
    async fn cancellation_preserves_partial_headers_and_payloads() {
        let (client, mut server) = duplex(1024);
        let mut ws = socket(client, MESSAGE_LIMIT);
        let input = frame(1, true, &[b'a'; 130]);
        server.write_all(&input[..3]).await.unwrap(); // Incomplete extended header.
        assert!(
            tokio::time::timeout(Duration::from_millis(5), ws.next_event())
                .await
                .is_err()
        );
        server.write_all(&input[3..10]).await.unwrap(); // Header and partial payload.
        assert!(
            tokio::time::timeout(Duration::from_millis(5), ws.next_event())
                .await
                .is_err()
        );
        ws.send_ping(b"interrupt").await.unwrap();
        server.write_all(&input[10..]).await.unwrap();
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Message { bytes: 130 }
        );
        let input = frame(1, true, "😀".as_bytes());
        server.write_all(&input[..4]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), ws.next_event())
                .await
                .is_err()
        );
        server.write_all(&input[4..]).await.unwrap();
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Message { bytes: 4 }
        );
        let input = frame(10, true, b"pong");
        server.write_all(&input[..3]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), ws.next_event())
                .await
                .is_err()
        );
        server.write_all(&input[3..]).await.unwrap();
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Pong(b"pong".to_vec())
        );
    }

    #[tokio::test]
    async fn outbound_controls_are_masked_and_have_expected_payloads() {
        let (client, mut server) = duplex(1024);
        let mut ws = socket(client, MESSAGE_LIMIT);
        for (opcode, payload) in [
            (9, b"ping".as_slice()),
            (10, b"pong".as_slice()),
            (8, &[3, 232]),
        ] {
            match opcode {
                9 => ws.send_ping(payload).await.unwrap(),
                10 => ws.send_pong(payload).await.unwrap(),
                _ => ws.close().await.unwrap(),
            }
            let mut header = [0_u8; 6];
            server.read_exact(&mut header).await.unwrap();
            assert_eq!(header[0], 0x80 | opcode);
            assert_eq!(header[1], 0x80 | payload.len() as u8);
            let mut data = vec![0; payload.len()];
            server.read_exact(&mut data).await.unwrap();
            for (index, byte) in data.iter_mut().enumerate() {
                *byte ^= header[2 + index % 4];
            }
            assert_eq!(data, payload);
        }
        assert!(matches!(
            ws.send_ping(b"closed").await,
            Err(RawError::Closed)
        ));
    }

    #[tokio::test]
    async fn interrupted_write_cannot_be_retried_on_same_stream() {
        let (client, _server) = duplex(1);
        let mut ws = socket(client, MESSAGE_LIMIT);
        assert!(
            tokio::time::timeout(Duration::from_millis(5), ws.send_ping(b"ping"))
                .await
                .is_err()
        );
        assert!(matches!(
            ws.send_ping(b"retry").await,
            Err(RawError::Closed)
        ));
    }

    #[tokio::test]
    async fn oversized_control_does_not_poison_writer() {
        let (client, _server) = duplex(1024);
        let mut ws = socket(client, MESSAGE_LIMIT);
        assert!(matches!(
            ws.send_ping(&[0; 126]).await,
            Err(RawError::Protocol(_))
        ));
        ws.send_ping(b"valid").await.unwrap();
    }

    #[tokio::test]
    async fn eof_is_an_error_and_close_event_can_be_answered() {
        let (client, server) = duplex(64);
        let mut ws = socket(client, MESSAGE_LIMIT);
        drop(server);
        assert!(matches!(ws.next_event().await, Err(RawError::Io(_))));
        let (client, mut server) = duplex(64);
        let mut ws = socket(client, MESSAGE_LIMIT);
        server.write_all(&frame(8, true, &[3, 232])).await.unwrap();
        assert_eq!(ws.next_event().await.unwrap(), RawEvent::Close);
        ws.close().await.unwrap();
        assert!(matches!(ws.next_event().await, Err(RawError::Closed)));
    }

    #[tokio::test]
    async fn large_binary_payload_is_discarded_with_bounded_input_buffer() {
        let (client, mut server) = duplex(1024);
        let mut ws = socket(client, MESSAGE_LIMIT);
        let producer = tokio::spawn(async move {
            server
                .write_all(&frame(2, true, &vec![0xff; 128 * 1024]))
                .await
                .unwrap();
        });
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Message { bytes: 128 * 1024 }
        );
        assert!(ws.input.capacity() <= READ_CHUNK * 4);
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_preserves_coalesced_first_frame_and_host_target() {
        let (client, mut server) = duplex(8192);
        let producer = tokio::spawn(async move {
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8; 1];
                server.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /feed?x=1 HTTP/1.1\r\nHost: localhost:443\r\n"));
            assert!(!request.to_lowercase().contains("sec-websocket-extensions"));
            let key = request
                .lines()
                .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
                .unwrap();
            assert_eq!(STANDARD.decode(key).unwrap().len(), 16);
            let mut response = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", accept_key(key)).into_bytes();
            response.extend(frame(10, true, b"early"));
            server.write_all(&response).await.unwrap();
        });
        let mut ws = handshake(client, "localhost:443", "/feed?x=1", MESSAGE_LIMIT)
            .await
            .unwrap();
        assert_eq!(
            ws.next_event().await.unwrap(),
            RawEvent::Pong(b"early".to_vec())
        );
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn handshake_rejects_injection_eof_and_oversized_headers() {
        for (host, path) in [
            ("evil\r\nHeader: x", "/"),
            ("localhost", "/x y"),
            ("localhost", "/#fragment"),
        ] {
            let (client, _server) = duplex(1024);
            assert!(matches!(
                handshake(client, host, path, MESSAGE_LIMIT).await,
                Err(RawError::Handshake(_))
            ));
        }
        let (client, mut server) = duplex(HEADER_LIMIT * 2);
        let mut oversized = b"HTTP/1.1 101 Switching Protocols\r\nX-Long: ".to_vec();
        oversized.resize(HEADER_LIMIT, b'x');
        server.write_all(&oversized).await.unwrap();
        assert!(matches!(
            handshake(client, "localhost", "/", MESSAGE_LIMIT).await,
            Err(RawError::Handshake("HTTP response headers exceed 16 KiB"))
        ));
        let (client, mut server) = duplex(1024);
        server.shutdown().await.unwrap();
        assert!(matches!(
            handshake(client, "localhost", "/", MESSAGE_LIMIT).await,
            Err(RawError::Handshake(_))
        ));
    }
}
