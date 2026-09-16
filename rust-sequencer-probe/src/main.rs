use std::{collections::BTreeMap, net::Ipv4Addr, process::ExitCode, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::Parser;
use rust_sequencer_probe::{
    Distribution,
    config::Args,
    distribution,
    probe::{ConnectionStats, Probe, ProbeError, Sample},
};
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    time::{Instant, sleep_until},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    at: String,
    elapsed_ms: f64,
    #[serde(flatten)]
    sample: Sample,
}

#[derive(Default, Serialize)]
struct Warmup {
    attempted: u64,
    success: u64,
    failed: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    duration_seconds: u64,
    interval_ms: u64,
    timeout_ms: u64,
    warmup_samples: u64,
    connect_ip: Option<Ipv4Addr>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    attempted: usize,
    success: usize,
    failed: usize,
    timeout: usize,
    reconnects: usize,
    skipped_slots: u64,
    success_reused: Distribution,
    success_fresh: Distribution,
    errors: BTreeMap<String, usize>,
    eligible_for_comparison: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    kind: &'static str,
    label: String,
    endpoint_id: String,
    endpoint_origin: String,
    family: u8,
    protocol: &'static str,
    method: &'static str,
    client_version: &'static str,
    os: &'static str,
    arch: &'static str,
    settings: Settings,
    scheduled_start_at: Option<String>,
    started_at: String,
    finished_at: String,
    completed: bool,
    interrupted: bool,
    clock_drift_ms: Option<f64>,
    warmup: Warmup,
    connection_stats: ConnectionStats,
    skipped_slots: u64,
    metrics: Option<Metrics>,
    samples: Vec<Observation>,
}

fn timestamp(value: OffsetDateTime) -> Result<String> {
    Ok(value.format(&Rfc3339)?)
}

fn metrics(report: &Report) -> Metrics {
    let samples = &report.samples;
    let success = samples.iter().filter(|value| value.sample.ok).count();
    let failed = samples.len() - success;
    let success_reused = distribution(
        samples
            .iter()
            .filter(|value| value.sample.ok && value.sample.reused_socket)
            .map(|value| value.sample.total_ms),
    );
    let success_fresh = distribution(
        samples
            .iter()
            .filter(|value| value.sample.ok && !value.sample.reused_socket)
            .map(|value| value.sample.total_ms),
    );
    let expected =
        (report.settings.duration_seconds * 1000).div_ceil(report.settings.interval_ms) as usize;
    let eligible_for_comparison = report.completed
        && success_reused.count >= 100
        && failed * 100 <= samples.len()
        && success_reused.count * 100 >= success * 95
        && samples.len() * 100 >= expected * 80
        && report
            .clock_drift_ms
            .is_some_and(|drift| drift.abs() <= 1000.0);
    let mut errors = BTreeMap::new();
    for error in samples.iter().filter_map(|value| value.sample.error_code) {
        *errors.entry(error.to_string()).or_insert(0) += 1;
    }
    Metrics {
        attempted: samples.len(),
        success,
        failed,
        timeout: samples
            .iter()
            .filter(|value| matches!(value.sample.error_code, Some(ProbeError::Timeout)))
            .count(),
        reconnects: samples
            .iter()
            .filter(|value| {
                !value.sample.reused_socket && value.sample.connection_id.is_some_and(|id| id > 1)
            })
            .count(),
        skipped_slots: report.skipped_slots,
        success_reused,
        success_fresh,
        errors,
        eligible_for_comparison,
    }
}

async fn warmup(probe: &mut Probe, report: &mut Report, id: &mut u64, interval: Duration) {
    let started = Instant::now();
    *id += 1;
    let sample = probe.sample(*id).await;
    report.warmup.attempted += 1;
    if sample.ok {
        report.warmup.success += 1;
    } else {
        report.warmup.failed += 1;
    }
    sleep_until(started + interval).await;
}

async fn run(
    args: &Args,
    probe: &mut Probe,
    scheduled: Option<OffsetDateTime>,
    report: &mut Report,
) -> Result<()> {
    let interval = Duration::from_millis(args.interval_ms);
    let mut id = 0;
    for _ in 0..args.warmup {
        warmup(probe, report, &mut id, interval).await;
    }
    if let Some(target) = scheduled {
        ensure!(
            OffsetDateTime::now_utc() <= target,
            "Scheduled start passed during warmup; choose a later --start-at"
        );
        while (target - OffsetDateTime::now_utc()).whole_milliseconds()
            > i128::from(args.timeout_ms + args.interval_ms)
        {
            warmup(probe, report, &mut id, interval).await;
        }
        let remaining = target - OffsetDateTime::now_utc();
        if remaining.is_positive() {
            tokio::time::sleep(remaining.unsigned_abs()).await;
        }
    }
    let wall_start = OffsetDateTime::now_utc();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(args.duration_seconds);
    let mut next_slot = started;
    let mut next_progress = started + Duration::from_secs(30);
    report.started_at = timestamp(wall_start)?;
    while next_slot < deadline {
        sleep_until(next_slot).await;
        if Instant::now() >= deadline {
            break;
        }
        let elapsed = started.elapsed();
        id += 1;
        let sample = probe.sample(id).await;
        report.samples.push(Observation {
            at: timestamp(wall_start + elapsed)?,
            elapsed_ms: elapsed.as_secs_f64() * 1000.0,
            sample,
        });
        next_slot += interval;
        // Skip slots missed by a slow call. Never catch up by sending a burst.
        let now = Instant::now();
        while next_slot < now && next_slot < deadline {
            next_slot += interval;
            report.skipped_slots += 1;
        }
        if now >= next_progress {
            let summary = metrics(report);
            println!(
                "{}: {} samples, {} errors; warm p50/p95/p99 = {:?}/{:?}/{:?} ms",
                report.label,
                summary.attempted,
                summary.failed,
                summary.success_reused.p50,
                summary.success_reused.p95,
                summary.success_reused.p99
            );
            next_progress = now + Duration::from_secs(30);
        }
    }
    let elapsed = started.elapsed();
    let anchored_finish = wall_start + elapsed;
    report.finished_at = timestamp(anchored_finish)?;
    report.clock_drift_ms =
        Some((OffsetDateTime::now_utc() - anchored_finish).as_seconds_f64() * 1000.0);
    report.completed = true;
    Ok(())
}

async fn save(file: &mut tokio::fs::File, report: &Report) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(report)?;
    bytes.push(b'\n');
    file.rewind().await?;
    file.write_all(&bytes).await?;
    file.set_len(bytes.len() as u64).await?;
    file.sync_all().await?;
    Ok(())
}

async fn interrupted() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn execute(args: Args) -> Result<ExitCode> {
    let (endpoint, scheduled) = args.validate()?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options.open(&args.output).await.context(
        "Cannot create report exclusively; choose a new output path in an existing directory",
    )?;
    let now = timestamp(OffsetDateTime::now_utc())?;
    let mut report = Report {
        schema_version: 1,
        kind: "rust-sequencer-probe",
        label: args.label.clone(),
        endpoint_id: endpoint.id.clone(),
        endpoint_origin: endpoint.origin.clone(),
        family: 4,
        protocol: "http/1.1",
        method: "arb_checkPublisherHealth",
        client_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        settings: Settings {
            duration_seconds: args.duration_seconds,
            interval_ms: args.interval_ms,
            timeout_ms: args.timeout_ms,
            warmup_samples: args.warmup,
            connect_ip: args.connect_ip,
        },
        scheduled_start_at: args.start_at.clone(),
        started_at: now.clone(),
        finished_at: now,
        completed: false,
        interrupted: false,
        clock_drift_ms: None,
        warmup: Warmup::default(),
        connection_stats: ConnectionStats::default(),
        skipped_slots: 0,
        metrics: None,
        samples: Vec::new(),
    };
    save(&mut output, &report).await?;
    println!(
        "{}: warm HTTP/1.1, IPv4, {} s, interval {} ms; {}",
        args.label, args.duration_seconds, args.interval_ms, report.endpoint_origin
    );
    let mut probe = Probe::new(endpoint, Duration::from_millis(args.timeout_ms))
        .with_connect_ip(args.connect_ip);
    if let Some(address) = args.connect_ip {
        println!(
            "TCP destination pinned to {address}; original Host and verified TLS identity retained"
        );
    }
    let result = tokio::select! {
        result = run(&args, &mut probe, scheduled, &mut report) => result,
        signal = interrupted() => { signal?; report.interrupted = true; Ok(()) }
    };
    report.connection_stats = probe.connection_stats();
    if !report.completed {
        report.finished_at = timestamp(OffsetDateTime::now_utc())?;
    }
    let summary = metrics(&report);
    println!(
        "{}: attempted={} success={} failed={} timeouts={} reconnects={} skipped={}",
        report.label,
        summary.attempted,
        summary.success,
        summary.failed,
        summary.timeout,
        summary.reconnects,
        summary.skipped_slots
    );
    println!(
        "Warm reused: n={} p50={:?} ms p95={:?} ms p99={:?} ms; eligibleForComparison={}",
        summary.success_reused.count,
        summary.success_reused.p50,
        summary.success_reused.p95,
        summary.success_reused.p99,
        summary.eligible_for_comparison
    );
    let connections = report.connection_stats;
    println!(
        "Transport including warmup: TCP opened={} TLS completed={} HTTP opened={} reused requests={}/{} DNS lookups={}",
        connections.tcp_connections_opened,
        connections.tls_handshakes_completed,
        connections.http_connections_opened,
        connections.requests_on_reused_connection,
        connections.requests_attempted,
        connections.dns_lookups
    );
    let exit = if summary.eligible_for_comparison {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    };
    report.metrics = Some(summary);
    save(&mut output, &report).await?;
    result?;
    Ok(exit)
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
