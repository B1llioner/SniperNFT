use std::{future::pending, time::Duration};

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use rust_websocket_probe::{
    Report,
    config::{Args, EngineKind},
    run_probe,
};
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_tungstenite::{accept_async, tungstenite::Message};

fn args(endpoint: &str, engine: &str) -> Args {
    Args::try_parse_from([
        "probe",
        "--endpoint",
        endpoint,
        "--label",
        "test",
        "--output",
        "unused.json",
        "--duration-seconds",
        "1",
        "--interval-ms",
        "100",
        "--timeout-ms",
        "150",
        "--warmup",
        "1",
        "--engine",
        engine,
    ])
    .expect("args")
}

#[tokio::test(flavor = "current_thread")]
async fn both_engines_reuse_one_connection_drain_feed_match_pongs_and_answer_server_ping() {
    for name in ["tungstenite", "raw"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let endpoint = format!("ws://{}/", listener.local_addr().expect("address"));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("upgrade");
            socket
                .send(Message::Pong(b"unmatched".to_vec().into()))
                .await
                .expect("unsolicited pong");
            socket
                .send(Message::Ping(b"server-ping".to_vec().into()))
                .await
                .expect("server ping");
            let mut pongs = 0;
            let mut client_pings = 0;
            while let Some(Ok(message)) = socket.next().await {
                match message {
                    Message::Ping(payload) => {
                        client_pings += 1;
                        socket.send(Message::Pong(payload)).await.expect("pong");
                        socket
                            .send(Message::Text("feed".into()))
                            .await
                            .expect("feed");
                    }
                    Message::Pong(payload) if payload.as_ref() == b"server-ping" => pongs += 1,
                    _ => {}
                }
            }
            assert_eq!(pongs, 1);
            assert!(client_pings >= 8);
            assert!(
                tokio::time::timeout(Duration::from_millis(25), listener.accept())
                    .await
                    .is_err(),
                "must not reconnect"
            );
        });
        let args = args(&endpoint, name);
        let (endpoint, _) = args.validate().expect("validate");
        let mut report = Report::new(&args, &endpoint).expect("report");
        run_probe(&args, endpoint, None, &mut report, pending())
            .await
            .expect("probe");
        assert!(report.completed, "{name}: {}", report.finish_reason);
        assert_eq!(report.connection.attempts, 1);
        assert_eq!(report.connection.reconnects, 0);
        assert_eq!(report.connection.http_status, Some(101));
        assert!(report.connection.tcp_no_delay);
        assert!(report.measured_counts.success >= 7);
        assert_eq!(report.counts.timeout, 0);
        assert_eq!(report.counts.unmatched_pongs, 1);
        assert_eq!(report.counts.server_pings, 1);
        assert!(report.stream.messages >= 8);
        assert_eq!(report.stream.bytes, report.stream.messages * 4);
        assert_eq!(
            report.samples.iter().filter(|sample| sample.warmup).count(),
            1
        );
        assert_eq!(
            report.ping_rtt_ms.count as u64,
            report.measured_counts.success
        );
        assert!(
            report
                .samples
                .iter()
                .all(|sample| sample.rtt_ms.is_some() == sample.ok)
        );
        server.await.expect("server task");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn both_engines_count_timeouts_and_skip_pending_slots_without_reconnects() {
    for name in ["tungstenite", "raw"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let endpoint = format!("ws://{}/", listener.local_addr().expect("address"));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let socket = accept_async(stream).await.expect("upgrade");
            tokio::time::sleep(Duration::from_millis(1150)).await;
            drop(socket);
        });
        let mut args = args(&endpoint, name);
        args.warmup = 0;
        let (endpoint, _) = args.validate().expect("validate");
        let mut report = Report::new(&args, &endpoint).expect("report");
        run_probe(&args, endpoint, None, &mut report, pending())
            .await
            .expect("probe");
        assert!(report.completed);
        assert_eq!(report.counts.success, 0);
        assert!(report.counts.timeout >= 4);
        assert!(report.counts.skipped >= 4);
        assert_eq!(report.connection.reconnects, 0);
        assert!(!report.eligible_for_comparison);
        assert_eq!(report.ping_rtt_ms.count, 0);
        assert!(report.samples.iter().all(|sample| sample.rtt_ms.is_none()));
        server.await.expect("server task");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_preserves_pending_sample() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let endpoint = format!("ws://{}/", listener.local_addr().expect("address"));
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let socket = accept_async(stream).await.expect("upgrade");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(socket);
    });
    let mut args = args(&endpoint, "raw");
    args.timeout_ms = 5000;
    args.warmup = 0;
    let (endpoint, _) = args.validate().expect("validate");
    let mut report = Report::new(&args, &endpoint).expect("report");
    run_probe(
        &args,
        endpoint,
        None,
        &mut report,
        tokio::time::sleep(Duration::from_millis(100)),
    )
    .await
    .expect("probe");
    assert!(!report.completed);
    assert_eq!(report.finish_reason, "CANCELLED");
    assert_eq!(report.measured_counts.cancelled, 1);
    assert_eq!(report.samples[0].error_code, Some("CANCELLED"));
    server.await.expect("server task");
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_upgrade_is_reported_with_status_and_never_retried() {
    for name in ["tungstenite", "raw"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let endpoint = format!("ws://{}/", listener.local_addr().expect("address"));
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            stream
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("HTTP error");
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let args = args(&endpoint, name);
        let (endpoint, _) = args.validate().expect("validate");
        let mut report = Report::new(&args, &endpoint).expect("report");
        run_probe(&args, endpoint, None, &mut report, pending())
            .await
            .expect("probe");
        assert!(!report.completed);
        assert!(!report.connection.opened);
        assert_eq!(report.connection.http_status, Some(400));
        assert_eq!(report.connection.attempts, 1);
        assert_eq!(report.connection.reconnects, 0);
        assert_eq!(report.finish_reason, "HTTP_UPGRADE_REJECTED");
        assert!(report.samples.is_empty());
        server.await.expect("server task");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn connect_deadline_bounds_unresponsive_upgrade() {
    for engine in [EngineKind::Raw, EngineKind::Tungstenite] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let endpoint = format!("ws://{}/", listener.local_addr().expect("address"));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            tokio::time::sleep(Duration::from_millis(200)).await;
            drop(stream);
        });
        let mut args = args(&endpoint, "raw");
        args.engine = engine;
        args.timeout_ms = 50;
        let (endpoint, _) = args.validate().expect("validate");
        let mut report = Report::new(&args, &endpoint).expect("report");
        run_probe(&args, endpoint, None, &mut report, pending())
            .await
            .expect("probe");
        assert_eq!(report.finish_reason, "CONNECT_TIMEOUT");
        assert!(!report.completed);
        assert!(report.elapsed_ms < 190.0);
        server.await.expect("server task");
    }
}

#[test]
fn cli_refuses_overwrite_and_bad_output_directory_before_connecting() {
    let path = std::env::temp_dir().join(format!(
        "vinos-ws-existing-{}-{}.json",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    std::fs::write(&path, b"existing report").expect("fixture");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_rust-websocket-probe"))
        .args(["--label", "test", "--output"])
        .arg(&path)
        .output()
        .expect("CLI");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        std::fs::read(&path).expect("retained file"),
        b"existing report"
    );
    let invalid = std::process::Command::new(env!("CARGO_BIN_EXE_rust-websocket-probe"))
        .args(["--label", "test", "--output"])
        .arg(path.join("child"))
        .output()
        .expect("CLI invalid directory");
    assert_eq!(invalid.status.code(), Some(1));
    std::fs::remove_file(path).expect("cleanup");
}
