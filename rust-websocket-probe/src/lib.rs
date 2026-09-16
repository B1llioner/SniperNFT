pub mod config;
pub mod engine;
pub mod raw;
pub mod transport;

use std::{future::Future, time::Duration};

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::time::{Instant, sleep_until};

use config::{Args, Endpoint, MAX_MESSAGE_BYTES};
use engine::{Engine, Event};
use transport::Connection;

#[derive(Debug, Clone, Copy, thiserror::Error)]
pub enum ProbeError {
    #[error("DNS_ERROR")]
    Dns,
    #[error("CONNECT_ERROR")]
    Connect,
    #[error("TLS_ERROR")]
    Tls,
    #[error("NETWORK_ERROR")]
    Network,
    #[error("PROTOCOL_ERROR")]
    Protocol,
    #[error("HTTP_UPGRADE_REJECTED")]
    HttpStatus(u16),
    #[error("CONNECTION_CLOSED")]
    Closed,
    #[error("CONNECT_TIMEOUT")]
    ConnectTimeout,
    #[error("SEND_TIMEOUT")]
    SendTimeout,
    #[error("TIME_FORMAT_ERROR")]
    TimeFormat,
}

#[derive(Debug, Default, Serialize)]
pub struct Distribution {
    pub count: usize,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

pub fn percentiles(values: impl Iterator<Item = f64>) -> Distribution {
    let mut values: Vec<_> = values.filter(|value| value.is_finite()).collect();
    values.sort_unstable_by(f64::total_cmp);
    let n = values.len();
    let at = |p: f64| {
        values
            .get(((n as f64 * p).ceil() as usize).saturating_sub(1))
            .copied()
    };
    Distribution {
        count: n,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        min: values.first().copied(),
        max: values.last().copied(),
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub sent: u64,
    pub success: u64,
    pub timeout: u64,
    pub failure: u64,
    pub cancelled: u64,
    pub skipped: u64,
    pub unmatched_pongs: u64,
    pub server_pings: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStream {
    pub messages: u64,
    pub bytes: u64,
    pub first_message_after_open_ms: Option<f64>,
    pub first_message_from_start_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: u64,
    pub warmup: bool,
    pub sent_at: String,
    pub sent_after_open_ms: f64,
    pub ok: bool,
    pub rtt_ms: Option<f64>,
    pub error_code: Option<&'static str>,
}

struct Pending {
    payload: Vec<u8>,
    sent: Instant,
    sample: Sample,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub duration_seconds: u64,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub warmup: u64,
    pub family: u8,
    pub connect_ip: Option<String>,
    pub max_message_bytes: usize,
    pub auto_reconnect: bool,
    pub redirects: bool,
    pub compression: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema_version: u32,
    pub kind: &'static str,
    pub mode: &'static str,
    pub label: String,
    pub endpoint: String,
    pub engine: config::EngineKind,
    pub client_version: &'static str,
    pub metric: &'static str,
    pub limitation: &'static str,
    pub scheduled_start_at: Option<String>,
    pub started_at: String,
    pub ended_at: String,
    pub completed: bool,
    pub eligible_for_comparison: bool,
    pub finish_reason: String,
    pub elapsed_ms: f64,
    pub clock_drift_ms: f64,
    pub settings: Settings,
    pub connection: Connection,
    pub stream: FeedStream,
    pub counts: Counts,
    pub measured_counts: Counts,
    pub errors: Vec<String>,
    pub samples: Vec<Sample>,
    pub ping_rtt_ms: Distribution,
}

pub fn timestamp(value: OffsetDateTime) -> Result<String, ProbeError> {
    value.format(&Rfc3339).map_err(|_| ProbeError::TimeFormat)
}

impl Report {
    pub fn new(args: &Args, endpoint: &Endpoint) -> Result<Self, ProbeError> {
        let now = timestamp(OffsetDateTime::now_utc())?;
        Ok(Self {
            schema_version: 1,
            kind: "rust-websocket-probe",
            mode: "feed",
            label: args.label.clone(),
            endpoint: endpoint.url.clone(),
            engine: args.engine,
            client_version: env!("CARGO_PKG_VERSION"),
            metric: "websocket-control-ping-round-trip",
            limitation: "Feed ping RTT and stream arrival are not transaction acceptance or inclusion latency.",
            scheduled_start_at: args.start_at.clone(),
            started_at: now.clone(),
            ended_at: now,
            completed: false,
            eligible_for_comparison: false,
            finish_reason: "NOT_STARTED".to_owned(),
            elapsed_ms: 0.0,
            clock_drift_ms: 0.0,
            settings: Settings {
                duration_seconds: args.duration_seconds,
                interval_ms: args.interval_ms,
                timeout_ms: args.timeout_ms,
                warmup: args.warmup,
                family: 4,
                connect_ip: args.connect_ip.map(|ip| ip.to_string()),
                max_message_bytes: MAX_MESSAGE_BYTES,
                auto_reconnect: false,
                redirects: false,
                compression: false,
            },
            connection: Connection::default(),
            stream: FeedStream::default(),
            counts: Counts::default(),
            measured_counts: Counts::default(),
            errors: Vec::new(),
            samples: Vec::new(),
            ping_rtt_ms: Distribution::default(),
        })
    }

    fn error(&mut self, error: ProbeError) {
        if self.errors.len() < 16 {
            self.errors.push(error.to_string());
        }
        if let ProbeError::HttpStatus(status) = error {
            self.connection.http_status = Some(status);
        }
        self.finish_reason = error.to_string();
    }

    fn settle(&mut self, pending: &mut Option<Pending>, error: Option<&'static str>) {
        let Some(mut pending) = pending.take() else {
            return;
        };
        pending.sample.error_code = error;
        pending.sample.ok = error.is_none();
        match error {
            None => {
                pending.sample.rtt_ms = Some(pending.sent.elapsed().as_secs_f64() * 1000.0);
                self.counts.success += 1;
            }
            Some("TIMEOUT") => self.counts.timeout += 1,
            Some("CANCELLED") => self.counts.cancelled += 1,
            Some(_) => self.counts.failure += 1,
        }
        self.samples.push(pending.sample);
    }

    fn finalize(&mut self, start: Instant, wall: OffsetDateTime) -> Result<(), ProbeError> {
        self.elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let now = OffsetDateTime::now_utc();
        self.ended_at = timestamp(now)?;
        self.clock_drift_ms = (now - wall).as_seconds_f64() * 1000.0 - self.elapsed_ms;
        self.ping_rtt_ms = percentiles(
            self.samples
                .iter()
                .filter(|sample| !sample.warmup && sample.ok)
                .filter_map(|sample| sample.rtt_ms),
        );
        for sample in self.samples.iter().filter(|sample| !sample.warmup) {
            self.measured_counts.sent += 1;
            match sample.error_code {
                None => self.measured_counts.success += 1,
                Some("TIMEOUT") => self.measured_counts.timeout += 1,
                Some("CANCELLED") => self.measured_counts.cancelled += 1,
                _ => self.measured_counts.failure += 1,
            }
        }
        let measured = &self.measured_counts;
        let expected = (self.settings.duration_seconds * 1000)
            .div_ceil(self.settings.interval_ms)
            .saturating_sub(self.settings.warmup);
        self.eligible_for_comparison = self.completed
            && measured.success >= 100
            && measured.success * 100 >= measured.sent * 99
            && measured.sent * 100 >= expected * 80
            && self.clock_drift_ms.abs() <= 1000.0;
        Ok(())
    }
}

/// All network errors remain visible in the returned report; shutdown always keeps partial samples.
pub async fn run_probe(
    args: &Args,
    endpoint: Endpoint,
    scheduled: Option<OffsetDateTime>,
    report: &mut Report,
    shutdown: impl Future<Output = ()>,
) -> Result<(), ProbeError> {
    tokio::pin!(shutdown);
    if let Some(target) = scheduled {
        let remaining = target - OffsetDateTime::now_utc();
        if remaining.is_positive() {
            tokio::select! {
                _ = tokio::time::sleep(remaining.unsigned_abs()) => {},
                _ = &mut shutdown => { report.finish_reason = "CANCELLED_BEFORE_START".to_owned(); report.ended_at = timestamp(OffsetDateTime::now_utc())?; return Ok(()); }
            }
        }
    }
    let wall = OffsetDateTime::now_utc();
    let start = Instant::now();
    report.started_at = timestamp(wall)?;
    let timeout = Duration::from_millis(args.timeout_ms);
    let connection = async {
        let stream = transport::connect(&endpoint, args.connect_ip, &mut report.connection).await?;
        Engine::handshake(args.engine, stream, &endpoint).await
    };
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, connection) => result.unwrap_or(Err(ProbeError::ConnectTimeout)),
        _ = &mut shutdown => { report.finish_reason = "CANCELLED".to_owned(); return report.finalize(start, wall); }
    };
    let mut engine = match result {
        Ok(engine) => engine,
        Err(error) => {
            report.error(error);
            return report.finalize(start, wall);
        }
    };
    let opened = Instant::now();
    report.connection.opened = true;
    report.connection.http_status = Some(101);
    report.connection.opened_at = Some(timestamp(OffsetDateTime::now_utc())?);
    report.connection.open_latency_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
    let deadline = opened + Duration::from_secs(args.duration_seconds);
    let interval = Duration::from_millis(args.interval_ms);
    let mut next_ping = opened;
    let mut pending: Option<Pending> = None;
    loop {
        let pending_deadline = pending
            .as_ref()
            .map_or(deadline, |pending| pending.sent + timeout);
        tokio::select! {
            biased;
            _ = &mut shutdown => { report.finish_reason = "CANCELLED".to_owned(); break; }
            _ = sleep_until(deadline) => { report.completed = true; report.finish_reason = "DURATION_COMPLETE".to_owned(); break; }
            _ = sleep_until(pending_deadline), if pending.is_some() => { report.settle(&mut pending, Some("TIMEOUT")); }
            _ = sleep_until(next_ping) => {
                let now = Instant::now();
                next_ping += interval;
                while next_ping <= now { next_ping += interval; report.counts.skipped += 1; }
                if pending.is_some() { report.counts.skipped += 1; continue; }
                report.counts.sent += 1;
                let id = report.counts.sent;
                let payload = format!("vinos-ping-{id}").into_bytes();
                pending = Some(Pending { payload: payload.clone(), sent: now, sample: Sample { id, warmup: id <= args.warmup, sent_at: timestamp(wall + start.elapsed())?, sent_after_open_ms: opened.elapsed().as_secs_f64() * 1000.0, ok: false, rtt_ms: None, error_code: None } });
                let result = tokio::select! {
                    result = tokio::time::timeout_at((now + timeout).min(deadline), engine.send_ping(&payload)) => result.unwrap_or(Err(ProbeError::SendTimeout)),
                    _ = &mut shutdown => { report.finish_reason = "CANCELLED".to_owned(); break; }
                };
                if let Err(error) = result { report.settle(&mut pending, Some("SEND_ERROR")); report.error(error); break; }
            }
            event = engine.next_event() => match event {
                Ok(Event::Pong(payload)) => {
                    if pending.as_ref().is_some_and(|pending| pending.payload == payload) { report.settle(&mut pending, None); }
                    else { report.counts.unmatched_pongs += 1; }
                }
                Ok(Event::Message { bytes }) => {
                    report.stream.messages += 1;
                    report.stream.bytes += bytes as u64;
                    if report.stream.first_message_after_open_ms.is_none() {
                        report.stream.first_message_after_open_ms = Some(opened.elapsed().as_secs_f64() * 1000.0);
                        report.stream.first_message_from_start_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
                    }
                }
                Ok(Event::Ping(payload)) => {
                    report.counts.server_pings += 1;
                    let result = tokio::select! {
                        result = tokio::time::timeout_at((Instant::now() + timeout).min(deadline), engine.send_pong(&payload)) => result.unwrap_or(Err(ProbeError::SendTimeout)),
                        _ = &mut shutdown => { report.finish_reason = "CANCELLED".to_owned(); break; }
                    };
                    if let Err(error) = result { report.settle(&mut pending, Some("SEND_ERROR")); report.error(error); break; }
                }
                Ok(Event::Close) | Err(ProbeError::Closed) => { report.connection.disconnects += 1; report.settle(&mut pending, Some("CONNECTION_CLOSED")); report.error(ProbeError::Closed); break; }
                Err(error) => { report.settle(&mut pending, Some("CONNECTION_ERROR")); report.error(error); break; }
            }
        }
    }
    report.settle(&mut pending, Some("CANCELLED"));
    // Drop the owned socket immediately, matching the Node probe; no reconnect/close wait.
    drop(engine);
    report.finalize(start, wall)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nearest_rank_does_not_interpolate_tail() {
        let stats = percentiles((1..=101).map(f64::from));
        assert_eq!(stats.p50, Some(51.0));
        assert_eq!(stats.p95, Some(96.0));
        assert_eq!(stats.p99, Some(100.0));
        assert_eq!(percentiles(std::iter::empty()).p99, None);
    }
}
