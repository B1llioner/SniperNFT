//! Read-only readiness check for live, timed sends on the Linux benchmark host.
//! Chrony's error estimate assumes its reference source is accurate. The bound
//! follows https://chrony-project.org/doc/4.6/chronyc.html#tracking with negative
//! root delay clamped to zero, so it cannot reduce our estimated uncertainty.

use std::{process::Stdio, time::Duration};

use anyhow::Result;
use serde_json::{Value, json};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};

const OUTPUT_LIMIT: usize = 8 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_ERROR_SECONDS: f64 = 0.020;

#[derive(Debug, thiserror::Error)]
enum ClockError {
    #[error("CLOCK_CHECK_REQUIRES_LINUX")]
    UnsupportedPlatform,
    #[error("CLOCK_CHECK_CHRONYC_UNAVAILABLE")]
    Unavailable,
    #[error("CLOCK_CHECK_CHRONYC_FAILED")]
    CommandFailed,
    #[error("CLOCK_CHECK_CHRONYC_TIMEOUT")]
    Timeout,
    #[error("CLOCK_CHECK_OUTPUT_TOO_LARGE")]
    OutputTooLarge,
    #[error("CLOCK_CHECK_INVALID_REPORT")]
    InvalidReport,
    #[error("CLOCK_CHECK_NOT_SYNCHRONIZED")]
    NotSynchronized,
    #[error("CLOCK_CHECK_ERROR_EXCEEDS_20MS")]
    ExcessiveError,
    #[error("CLOCK_CHECK_PROCESS_CLEANUP_FAILED")]
    CleanupFailed,
}

fn finite(input: &str) -> std::result::Result<f64, ClockError> {
    let value = input
        .parse::<f64>()
        .map_err(|_| ClockError::InvalidReport)?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(ClockError::InvalidReport)
    }
}

fn seconds(input: &str) -> std::result::Result<f64, ClockError> {
    finite(
        input
            .strip_suffix(" seconds")
            .ok_or(ClockError::InvalidReport)?,
    )
}

fn parse_tracking(input: &str) -> std::result::Result<Value, ClockError> {
    if input.len() > OUTPUT_LIMIT {
        return Err(ClockError::OutputTooLarge);
    }
    let mut reference = None;
    let mut stratum = None;
    let mut system = None;
    let mut delay = None;
    let mut dispersion = None;
    let mut leap = None;
    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        let (name, value) = line.split_once(':').ok_or(ClockError::InvalidReport)?;
        let value = value.trim();
        let field = match name.trim() {
            "Reference ID" => &mut reference,
            "Stratum" => &mut stratum,
            "System time" => &mut system,
            "Root delay" => &mut delay,
            "Root dispersion" => &mut dispersion,
            "Leap status" => &mut leap,
            _ => continue,
        };
        if field.replace(value).is_some() {
            return Err(ClockError::InvalidReport);
        }
    }
    if leap.ok_or(ClockError::InvalidReport)? != "Normal" {
        return Err(ClockError::NotSynchronized);
    }
    let reference = reference
        .ok_or(ClockError::InvalidReport)?
        .split_whitespace()
        .next()
        .ok_or(ClockError::InvalidReport)?;
    if reference.len() != 8 || !reference.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ClockError::InvalidReport);
    }
    let reference = u32::from_str_radix(reference, 16).map_err(|_| ClockError::InvalidReport)?;
    // 7F7F0101 is chrony's unsynchronised local-reference mode; accepting its
    // small offset would incorrectly treat a free-running clock as UTC-ready.
    if matches!(reference, 0 | 0x7f7f_0101) {
        return Err(ClockError::NotSynchronized);
    }
    let stratum = stratum
        .ok_or(ClockError::InvalidReport)?
        .parse::<u8>()
        .map_err(|_| ClockError::InvalidReport)?;
    if !(1..=15).contains(&stratum) {
        return Err(ClockError::NotSynchronized);
    }
    let system = system.ok_or(ClockError::InvalidReport)?;
    let (offset, direction) = if let Some(value) = system.strip_suffix(" seconds fast of NTP time")
    {
        (finite(value)?, "fast")
    } else if let Some(value) = system.strip_suffix(" seconds slow of NTP time") {
        (finite(value)?, "slow")
    } else {
        return Err(ClockError::InvalidReport);
    };
    let delay = seconds(delay.ok_or(ClockError::InvalidReport)?)?;
    let dispersion = seconds(dispersion.ok_or(ClockError::InvalidReport)?)?;
    if dispersion < 0.0 {
        return Err(ClockError::InvalidReport);
    }
    let conservative_error = offset.abs() + delay.max(0.0) / 2.0 + dispersion;
    let root_delay_ms = delay * 1000.0;
    if !root_delay_ms.is_finite() {
        return Err(ClockError::InvalidReport);
    }
    if !conservative_error.is_finite() || conservative_error > MAX_ERROR_SECONDS {
        return Err(ClockError::ExcessiveError);
    }
    Ok(json!({
        "source":"chronyc tracking",
        "leapStatus":"Normal",
        "stratum":stratum,
        "systemOffsetAbsMs":offset.abs()*1000.0,
        "systemTimeDirection":direction,
        "rootDelayMs":root_delay_ms,
        "rootDispersionMs":dispersion*1000.0,
        "conservativeErrorMs":conservative_error*1000.0,
        "maxAllowedErrorMs":MAX_ERROR_SECONDS*1000.0,
        "formula":"abs(system_time) + max(root_delay, 0)/2 + root_dispersion",
        "synchronized":true
    }))
}

async fn terminate(child: &mut Child) -> std::result::Result<(), ClockError> {
    if child
        .try_wait()
        .map_err(|_| ClockError::CleanupFailed)?
        .is_some()
    {
        return Ok(());
    }
    child.start_kill().map_err(|_| ClockError::CleanupFailed)?;
    tokio::time::timeout(CLEANUP_TIMEOUT, child.wait())
        .await
        .map_err(|_| ClockError::CleanupFailed)?
        .map_err(|_| ClockError::CleanupFailed)?;
    Ok(())
}

/// Verify local chronyd reports normal synchronization and a conservative clock
/// error no greater than 20 ms. No clock adjustment command is ever executed.
/// Stdout is limited to 8 KiB, stderr is discarded, and failures never include
/// raw chrony output or reference-source addresses. Command + cleanup is capped
/// at five seconds; cancellation kills the child through kill_on_drop.
pub async fn verify() -> Result<Value> {
    if !cfg!(target_os = "linux") {
        return Err(ClockError::UnsupportedPlatform.into());
    }
    let mut child = Command::new("chronyc")
        .args(["-n", "tracking"])
        // The clock reader needs no wallet/RPC environment or user PATH entries.
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ClockError::Unavailable)?;
    let stdout = child.stdout.take().ok_or(ClockError::CommandFailed)?;
    let result = tokio::time::timeout(COMMAND_TIMEOUT, async {
        let mut output = Vec::with_capacity(1024);
        stdout
            .take((OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut output)
            .await
            .map_err(|_| ClockError::CommandFailed)?;
        if output.len() > OUTPUT_LIMIT {
            return Err(ClockError::OutputTooLarge);
        }
        let status = child.wait().await.map_err(|_| ClockError::CommandFailed)?;
        if !status.success() {
            return Err(ClockError::CommandFailed);
        }
        let output = std::str::from_utf8(&output).map_err(|_| ClockError::InvalidReport)?;
        parse_tracking(output)
    })
    .await;
    match result {
        Ok(Ok(metrics)) => Ok(metrics),
        Ok(Err(error)) => {
            terminate(&mut child).await?;
            Err(error.into())
        }
        Err(_) => {
            terminate(&mut child).await?;
            Err(ClockError::Timeout.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACKING: &str = "Reference ID    : A9FEA97B (169.254.169.123)\n\
Stratum         : 3\n\
Ref time (UTC)  : Wed Sep 16 09:49:17 2026\n\
System time     : 0.001000000 seconds slow of NTP time\n\
Last offset     : -0.000006747 seconds\n\
RMS offset      : 0.000035822 seconds\n\
Frequency       : 3.225 ppm slow\n\
Residual freq   : -0.000 ppm\n\
Skew            : 0.129 ppm\n\
Root delay      : 0.010000000 seconds\n\
Root dispersion : 0.002000000 seconds\n\
Update interval : 64.2 seconds\n\
Leap status     : Normal\n";

    #[test]
    fn synchronized_report_uses_full_error_bound_and_omits_source_address() {
        let result = parse_tracking(TRACKING).unwrap();
        assert_eq!(result["synchronized"], true);
        assert_eq!(result["stratum"], 3);
        assert_eq!(result["conservativeErrorMs"], 8.0);
        assert_eq!(result["maxAllowedErrorMs"], 20.0);
        assert!(!result.to_string().contains("169.254.169.123"));
        assert!(!result.to_string().contains("A9FEA97B"));
    }

    #[test]
    fn large_system_skew_cannot_pass_with_good_root_metrics() {
        for direction in ["slow", "fast"] {
            let value = TRACKING.replace(
                "0.001000000 seconds slow",
                &format!("2.000000000 seconds {direction}"),
            );
            assert!(matches!(
                parse_tracking(&value),
                Err(ClockError::ExcessiveError)
            ));
        }
    }

    #[test]
    fn half_delay_and_dispersion_can_independently_exceed_limit() {
        for report in [
            TRACKING.replace("0.010000000 seconds", "0.050000000 seconds"),
            TRACKING.replace("0.002000000 seconds", "0.025000000 seconds"),
        ] {
            assert!(matches!(
                parse_tracking(&report),
                Err(ClockError::ExcessiveError)
            ));
        }
    }

    #[test]
    fn negative_root_delay_cannot_cancel_real_clock_uncertainty() {
        let report = TRACKING.replace("0.010000000 seconds", "-10.000000000 seconds");
        assert_eq!(parse_tracking(&report).unwrap()["conservativeErrorMs"], 3.0);
        let report = report.replace("0.001000000 seconds slow", "0.021000000 seconds slow");
        assert!(matches!(
            parse_tracking(&report),
            Err(ClockError::ExcessiveError)
        ));
    }

    #[test]
    fn unsynchronized_leap_local_reference_and_invalid_stratum_fail_closed() {
        for leap in [
            "Not synchronised",
            "Insert second",
            "Delete second",
            "normal",
        ] {
            assert!(matches!(
                parse_tracking(&TRACKING.replace("Normal", leap)),
                Err(ClockError::NotSynchronized)
            ));
        }
        for reference in ["00000000", "7F7F0101"] {
            assert!(matches!(
                parse_tracking(&TRACKING.replace("A9FEA97B", reference)),
                Err(ClockError::NotSynchronized)
            ));
        }
        for stratum in ["0", "16"] {
            assert!(matches!(
                parse_tracking(&TRACKING.replace(
                    "Stratum         : 3",
                    &format!("Stratum         : {stratum}")
                )),
                Err(ClockError::NotSynchronized)
            ));
        }
    }

    #[test]
    fn missing_duplicate_malformed_and_nonfinite_fields_are_rejected() {
        let fields = [
            "System time",
            "Root delay",
            "Root dispersion",
            "Leap status",
            "Stratum",
            "Reference ID",
        ];
        for field in fields {
            let missing = TRACKING
                .lines()
                .filter(|line| !line.starts_with(field))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(parse_tracking(&missing).is_err(), "{field}");
            let duplicate = format!(
                "{TRACKING}{}\n",
                TRACKING
                    .lines()
                    .find(|line| line.starts_with(field))
                    .unwrap()
            );
            assert!(matches!(
                parse_tracking(&duplicate),
                Err(ClockError::InvalidReport)
            ));
        }
        for original in ["0.001000000", "0.010000000", "0.002000000"] {
            for invalid in ["NaN", "inf", "-inf", "not-a-number", "1e999"] {
                assert!(matches!(
                    parse_tracking(&TRACKING.replace(original, invalid)),
                    Err(ClockError::InvalidReport)
                ));
            }
        }
        assert!(matches!(
            parse_tracking(&TRACKING.replace("0.002000000", "-0.002000000")),
            Err(ClockError::InvalidReport)
        ));
        assert!(matches!(
            parse_tracking(&TRACKING.replace("0.010000000", "-1e308")),
            Err(ClockError::InvalidReport)
        ));
        assert!(matches!(
            parse_tracking(&TRACKING.replace("0.010000000 seconds", "0.010000000 milliseconds")),
            Err(ClockError::InvalidReport)
        ));
        assert!(matches!(
            parse_tracking("tracking unavailable"),
            Err(ClockError::InvalidReport)
        ));
        assert!(matches!(
            parse_tracking(&"x".repeat(OUTPUT_LIMIT + 1)),
            Err(ClockError::OutputTooLarge)
        ));
    }

    #[test]
    fn exact_twenty_millisecond_boundary_is_accepted() {
        let report = TRACKING
            .replace("0.001000000", "-0.020000000")
            .replace("0.010000000", "0.000000000")
            .replace("0.002000000", "0.000000000");
        assert_eq!(
            parse_tracking(&report).unwrap()["conservativeErrorMs"],
            20.0
        );
        assert!(matches!(
            parse_tracking(&report.replace("-0.020000000", "-0.020000001")),
            Err(ClockError::ExcessiveError)
        ));
    }

    #[tokio::test]
    #[cfg(not(target_os = "linux"))]
    async fn live_check_rejects_non_linux_without_running_commands() {
        assert_eq!(
            verify().await.unwrap_err().to_string(),
            "CLOCK_CHECK_REQUIRES_LINUX"
        );
    }
}
