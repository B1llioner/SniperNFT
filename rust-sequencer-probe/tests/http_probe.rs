use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use rust_sequencer_probe::{
    config::Endpoint,
    probe::{Probe, ProbeError},
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

#[derive(Clone, Copy)]
enum Reply {
    Good,
    WrongId,
    RpcError,
    TooLarge,
    Redirect,
    Stall,
    Close,
}

async fn mock(replies: Vec<Reply>) -> Result<(Endpoint, JoinHandle<Result<usize>>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = Endpoint::parse(&format!("http://{}", listener.local_addr()?))?;
    let handle = tokio::spawn(async move {
        let mut index = 0;
        let mut connections = 0;
        while index < replies.len() {
            let (socket, _) = listener.accept().await?;
            connections += 1;
            let mut socket = BufReader::new(socket);
            loop {
                let mut first = String::new();
                if socket.read_line(&mut first).await? == 0 {
                    break;
                }
                assert_eq!(first, "POST / HTTP/1.1\r\n");
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    socket.read_line(&mut line).await?;
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse()?;
                    }
                }
                let mut bytes = vec![0; length];
                socket.read_exact(&mut bytes).await?;
                let request: Value = serde_json::from_slice(&bytes)?;
                assert_eq!(request["method"], "arb_checkPublisherHealth");
                assert_eq!(request["params"], serde_json::json!([]));
                let reply = replies[index];
                index += 1;
                if matches!(reply, Reply::Stall) {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    break;
                }
                let body = match reply {
                    Reply::WrongId => serde_json::json!({"jsonrpc":"2.0","id":"other","result":null}).to_string(),
                    Reply::RpcError => serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601}}).to_string(),
                    Reply::TooLarge => "x".repeat(65537),
                    _ => serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":null}).to_string(),
                };
                let status = if matches!(reply, Reply::Redirect) {
                    "302 Found"
                } else {
                    "200 OK"
                };
                let close = matches!(reply, Reply::Close);
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: {}\r\n\r\n{body}",
                    body.len(),
                    if close { "close" } else { "keep-alive" }
                );
                socket.write_all(response.as_bytes()).await?;
                if index == replies.len() || close {
                    break;
                }
            }
        }
        Ok(connections)
    });
    Ok((endpoint, handle))
}

#[tokio::test]
async fn observes_real_socket_reuse_and_reconnect() -> Result<()> {
    let (endpoint, server) = mock(vec![Reply::Good, Reply::Close, Reply::Good]).await?;
    let mut probe = Probe::new(endpoint, Duration::from_secs(1));
    let first = probe.sample(1).await;
    let second = probe.sample(2).await;
    let third = probe.sample(3).await;
    assert!(first.ok && second.ok && third.ok);
    assert!(!first.reused_socket && second.reused_socket && !third.reused_socket);
    assert_eq!(first.connection_id, second.connection_id);
    assert_ne!(first.connection_id, third.connection_id);
    assert_eq!(server.await??, 2);
    Ok(())
}

#[tokio::test]
async fn rejects_protocol_failures_without_following_redirects() -> Result<()> {
    for (reply, expected) in [
        (Reply::WrongId, "INVALID_RESPONSE"),
        (Reply::RpcError, "RPC_METHOD_NOT_FOUND"),
        (Reply::TooLarge, "RESPONSE_TOO_LARGE"),
        (Reply::Redirect, "HTTP_REDIRECT"),
    ] {
        let (endpoint, server) = mock(vec![reply]).await?;
        let mut probe = Probe::new(endpoint, Duration::from_secs(1));
        let sample = probe.sample(1).await;
        assert!(!sample.ok);
        assert_eq!(
            sample.error_code.map(|error| error.to_string()).as_deref(),
            Some(expected)
        );
        assert_eq!(server.await??, 1);
    }
    Ok(())
}

#[tokio::test]
async fn timeout_is_bounded_and_failed_connection_is_discarded() -> Result<()> {
    let (endpoint, server) = mock(vec![Reply::Stall]).await?;
    let mut probe = Probe::new(endpoint, Duration::from_millis(30));
    let sample = probe.sample(1).await;
    assert!(!sample.ok && matches!(sample.error_code, Some(ProbeError::Timeout)));
    assert!(sample.total_ms >= 20.0 && sample.total_ms < 180.0);
    assert_eq!(server.await??, 1);
    Ok(())
}

fn output_path() -> Result<PathBuf> {
    Ok(std::env::temp_dir().join(format!(
        "rust-probe-test-{}-{}.json",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    )))
}

#[test]
fn refuses_to_overwrite_existing_output_before_network() -> Result<()> {
    let path = output_path()?;
    std::fs::write(&path, b"keep this")?;
    let result = Command::new(env!("CARGO_BIN_EXE_rust-sequencer-probe"))
        .args([
            "--label",
            "test",
            "--endpoint",
            "http://127.0.0.1:9",
            "--output",
        ])
        .arg(&path)
        .output()?;
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(std::fs::read(&path)?, b"keep this");
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(unix)]
#[test]
fn sigint_saves_valid_partial_report() -> Result<()> {
    let path = output_path()?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_rust-sequencer-probe"))
        .args([
            "--label",
            "test",
            "--endpoint",
            "http://127.0.0.1:9",
            "--duration-seconds",
            "10",
            "--warmup",
            "0",
            "--interval-ms",
            "100",
            "--output",
        ])
        .arg(&path)
        .stdout(std::process::Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Missing child stdout"))?;
    let mut stdout = std::io::BufReader::new(stdout);
    let mut ready = String::new();
    std::io::BufRead::read_line(&mut stdout, &mut ready)?;
    assert!(ready.contains("warm HTTP/1.1"));
    std::thread::sleep(Duration::from_millis(150));
    let killed = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()?;
    assert!(killed.success());
    assert_eq!(child.wait()?.code(), Some(2));
    let report: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert_eq!(report["interrupted"], true);
    assert_eq!(report["completed"], false);
    assert!(
        report["samples"]
            .as_array()
            .is_some_and(|samples| !samples.is_empty())
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o600
    );
    std::fs::remove_file(path)?;
    Ok(())
}
