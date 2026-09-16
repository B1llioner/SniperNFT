use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Parser;
use rust_websocket_probe::{Report, config::Args, run_probe};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

async fn save(file: &mut tokio::fs::File, report: &Report) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(report)?;
    bytes.push(b'\n');
    file.rewind().await?;
    file.write_all(&bytes).await?;
    file.set_len(bytes.len() as u64).await?;
    file.sync_all().await?;
    Ok(())
}

async fn execute(args: Args) -> Result<ExitCode> {
    let (endpoint, scheduled) = args.validate()?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&args.output)
        .await
        .context("Cannot create report; choose a new path in an existing directory")?;
    let mut report = Report::new(&args, &endpoint)?;
    save(&mut file, &report).await?;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown = async {
        #[cfg(unix)]
        tokio::select! {
            result = tokio::signal::ctrl_c() => { if let Err(error) = result { eprintln!("Cannot receive interrupt signal: {error}"); } }
            _ = terminate.recv() => {}
        }
        #[cfg(not(unix))]
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("Cannot receive interrupt signal: {error}");
        }
    };
    println!(
        "{}: {:?}, persistent IPv4 WebSocket; {} s at {} ms; {}",
        args.label, args.engine, args.duration_seconds, args.interval_ms, endpoint.url
    );
    let result = run_probe(&args, endpoint, scheduled, &mut report, shutdown).await;
    // An interrupted/failed run still persists every settled sample and its reason.
    save(&mut file, &report).await?;
    println!(
        "{}: success={} timeouts={} failures={} cancelled={} reconnects={} feedMessages={} feedBytes={}",
        args.label,
        report.measured_counts.success,
        report.measured_counts.timeout,
        report.measured_counts.failure,
        report.measured_counts.cancelled,
        report.connection.reconnects,
        report.stream.messages,
        report.stream.bytes
    );
    println!(
        "Ping RTT: p50={:?} ms p95={:?} ms p99={:?} ms; completed={} eligibleForComparison={} reason={}",
        report.ping_rtt_ms.p50,
        report.ping_rtt_ms.p95,
        report.ping_rtt_ms.p99,
        report.completed,
        report.eligible_for_comparison,
        report.finish_reason
    );
    result?;
    // A short healthy smoke test is successful but explicitly not statistically eligible.
    let healthy = report.completed
        && report.measured_counts.success > 0
        && report.counts.failure == 0
        && report.counts.timeout == 0;
    Ok(if healthy {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match execute(Args::parse()).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}
