#!/usr/bin/env python3
"""Run the five read-only transport clients against pinned, freshly resolved IPv4s."""
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
HTTP_HOST = 'sequencer.mainnet.chain.robinhood.com'
WS_HOST = 'feed.mainnet.chain.robinhood.com'
NAMES = ('node-http', 'rust-http', 'node-ws', 'rust-ws-library', 'rust-ws-raw')


def iso(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def stamp(value):
    if not isinstance(value, str):
        raise ValueError('Invalid timestamp')
    parts = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})', value)
    if parts is None:
        raise ValueError('Timestamp requires RFC3339 with an explicit timezone')
    seconds, fraction, offset = parts.groups()
    # Rust emits up to nanoseconds. Python 3.9 fromisoformat accepts only 3 or 6
    # fraction digits; normalize to microseconds consistently on every Python.
    fraction = '.' + fraction[:6].ljust(6, '0') if fraction else ''
    parsed = dt.datetime.fromisoformat(seconds + fraction + ('+00:00' if offset == 'Z' else offset))
    return parsed.timestamp()


def save(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write('\n')


def read(path):
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Report exceeds 64 MiB')
    with path.open() as handle:
        return json.load(handle)


def percentiles(values):
    values = list(values)
    if not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in values):
        raise ValueError('Invalid latency')
    values.sort()
    return {'count': len(values), **{name: (values[max(0, math.ceil(q * len(values)) - 1)] if values else None)
            for name, q in [('p50', .5), ('p95', .95), ('p99', .99), ('max', 1)]}}


def metadata(name, report):
    """Validate the producer contract before comparing samples from different clients."""
    if not isinstance(report, dict) or not isinstance(report.get('settings'), dict) or not isinstance(report.get('samples'), list):
        raise ValueError('missing or malformed report')
    settings = report['settings']
    http = name in NAMES[:2]
    warmup = 'warmupSamples' if http else 'warmup'
    for key in ('durationSeconds', 'intervalMs', 'timeoutMs', warmup):
        value = settings.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value < (0 if key == warmup else 1):
            raise ValueError('invalid request settings')
    if report.get('schemaVersion') != 1 or type(report.get('completed')) is not bool:
        raise ValueError('invalid report schema or completion flag')
    reasons = []
    if http:
        identity = (report.get('endpointOrigin'), report.get('endpointId'), report.get('protocol'), report.get('method'), report.get('family'))
        expected_id = hashlib.sha256(('https://' + HTTP_HOST + '/').encode()).hexdigest()
        if identity != ('https://' + HTTP_HOST, expected_id, 'http/1.1', 'arb_checkPublisherHealth', 4):
            reasons.append('HTTP endpoint, method, protocol or family differs from benchmark')
        stamp(report['startedAt']); stamp(report['finishedAt'])
    else:
        identity = (report.get('endpoint', '').rstrip('/'), report.get('metric'), report.get('mode'), settings.get('family'))
        if identity != ('wss://' + WS_HOST, 'websocket-control-ping-round-trip', 'feed', 4):
            reasons.append('WebSocket endpoint, metric, mode or family differs from benchmark')
        if any(settings.get(key) is not False for key in ('autoReconnect', 'redirects', 'compression')):
            reasons.append('WebSocket reconnect, redirect or compression policy differs from benchmark')
        if name.startswith('rust-ws') and report.get('engine') != ('raw' if name.endswith('raw') else 'tungstenite'):
            reasons.append('WebSocket engine differs from requested client')
        if not isinstance(report.get('connection'), dict):
            raise ValueError('invalid WebSocket connection metadata')
        stamp(report['endedAt'])
        if report['connection'].get('openedAt'):
            stamp(report['connection']['openedAt'])
    return reasons, tuple(settings[key] for key in ('durationSeconds', 'intervalMs', 'timeoutMs', warmup))


def summarize(reports, exits, pins):
    """Only matching request START times enter each metric's common window."""
    result = {'kind': 'vinos-pinned-transport-comparison-v1', 'pins': pins, 'rows': [], 'windows': {},
              'notes': ['Health RPC and feed pong are different operations, neither is transaction inclusion.',
                        'Same destination IP need not mean the same backend behind a load balancer.',
                        'Node uses OpenSSL; Rust uses rustls. This compares complete client paths.',
                        'All five clients run together; feed traffic is additional shared host load.',
                        'Node HTTP includes two extra cold probes per 600-second run; these are excluded.',
                        'Nearest-rank percentiles; successful warm samples only; failures remain counted.',
                        'A 600-sample p99 is descriptive, not a statistical guarantee.']}
    usable, report_reasons, fingerprints = {}, {}, {}
    for name in NAMES:
        try:
            reasons, fingerprint = metadata(name, reports.get(name))
            usable[name], report_reasons[name], fingerprints[name] = reports[name], reasons, fingerprint
        except (ValueError, KeyError, TypeError, OverflowError, AttributeError):
            usable[name], report_reasons[name] = None, ['missing or malformed report metadata']
    for group, names in [('http', NAMES[:2]), ('websocket', NAMES[2:])]:
        if len({fingerprints[name] for name in names if name in fingerprints}) > 1:
            for name in names:
                report_reasons[name].append('duration, interval, timeout or warmup differs between clients')
        bounds = []
        for name in names:
            report = usable[name]
            if report is None:
                bounds.append((math.inf, -math.inf)); continue
            if group == 'http':
                start = stamp(report['startedAt'])
                end = min(stamp(report['finishedAt']), start + report['settings']['durationSeconds'])
            else:
                opened = report.get('connection', {}).get('openedAt')
                if not opened:
                    bounds.append((math.inf, -math.inf)); continue
                start = stamp(opened) + report['settings']['warmup'] * report['settings']['intervalMs'] / 1000
                end = min(stamp(report['endedAt']), stamp(opened) + report['settings']['durationSeconds'])
            bounds.append((start, end))
        start = max(pair[0] for pair in bounds)
        end = min(pair[1] for pair in bounds)
        duration = max(0, end - start)
        valid_window = math.isfinite(start) and math.isfinite(end) and duration > 0
        result['windows'][group] = {'start': iso(start) if valid_window else None,
                                    'end': iso(end) if valid_window else None, 'seconds': duration if valid_window else 0}
        for name in names:
            report = usable[name]
            if report is None:
                result['rows'].append({'client': name, 'group': group, 'attempts': 0, 'errors': 0,
                                       'timeouts': 0, 'ips': [], 'latencyMs': percentiles([]), 'eligible': False,
                                       'reasons': report_reasons[name], 'connectionStats': None})
                continue
            attempted, successes, addresses = [], [], set()
            reasons = list(report_reasons[name])
            for sample in report.get('samples', []):
                if not valid_window:
                    break
                try:
                    if not isinstance(sample, dict) or type(sample.get('ok')) is not bool:
                        raise ValueError('invalid sample')
                    if group == 'http':
                        if name == 'node-http' and sample.get('kind') != 'warm':
                            continue
                        when = stamp(sample['timestamp'] if name == 'node-http' else sample['at'])
                        latency = sample.get('timingsMs', {}).get('total') if name == 'node-http' else sample.get('totalMs')
                        used = sample.get('reusedSocket') is True
                        address = sample.get('remoteAddress')
                    else:
                        if sample.get('warmup'):
                            continue
                        offset = sample['sentAfterOpenMs']
                        if type(offset) not in (float, int) or not math.isfinite(offset) or offset < 0:
                            raise ValueError('invalid sample time')
                        when = stamp(report['connection']['openedAt']) + offset / 1000
                        latency, used = sample.get('rttMs'), True
                        address = report['connection'].get('remoteAddress')
                    if not start <= when < end:
                        continue
                    if address is not None and not isinstance(address, str):
                        raise ValueError('invalid address')
                    if sample['ok'] and used:
                        percentiles([latency])
                except (ValueError, KeyError, TypeError, OverflowError, AttributeError):
                    if 'malformed samples' not in reasons:
                        reasons.append('malformed samples')
                    continue
                attempted.append(sample)
                if address:
                    addresses.add(address)
                if sample.get('ok') and used:
                    successes.append(latency)
            failed = sum(not sample.get('ok') for sample in attempted)
            timeouts = sum(sample.get('errorCode') == 'TIMEOUT' for sample in attempted)
            drift = report.get('wallClockDriftMs', report.get('clockDriftMs'))
            expected = duration * 1000 / report['settings']['intervalMs'] if valid_window else 0
            pin = pins[group]
            configured_pin = report.get('connectIp') if name == 'node-http' else report['settings'].get('connectIp')
            if not report.get('completed') or exits.get(name) != 0:
                reasons.append('client did not complete successfully')
            if not valid_window or len(successes) < 300:
                reasons.append('need at least 300 successful samples in a common window')
            if len(attempted) < expected * .8:
                reasons.append('less than 80% cadence coverage')
            if failed > len(attempted) * .01:
                reasons.append('more than 1% failures')
            if len(successes) < (len(attempted) - failed) * .95:
                reasons.append('less than 95% reuse')
            if addresses != {pin} or configured_pin != pin:
                reasons.append('actual or configured destination differs from pin')
            if type(drift) not in (float, int) or not math.isfinite(drift) or abs(drift) > 1000:
                reasons.append('missing or excessive wall-clock drift')
            result['rows'].append({'client': name, 'group': group, 'attempts': len(attempted),
                                   'errors': failed, 'timeouts': timeouts, 'ips': sorted(addresses),
                                   'latencyMs': percentiles(successes), 'eligible': not reasons, 'reasons': reasons,
                                   'connectionStats': report.get('connectionStats', report.get('connection'))})
    result['allEligible'] = all(row['eligible'] for row in result['rows'])
    return result


def collect_reports(directory):
    reports, errors = {}, {}
    for name in NAMES:
        try:
            reports[name] = read(directory / (name + '.json'))
        except (OSError, ValueError) as error:
            reports[name] = None
            errors[name] = type(error).__name__
    return reports, errors


def stop_processes(processes):
    """Always reap all children, including children exiting between poll and killpg."""
    for process in processes.values():
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass  # It exited after poll; wait still reaps it below.
    for process in processes.values():
        try:
            process.wait(timeout=7)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)


def print_summary(summary):
    print('CLIENT                 N       p50 ms     p95 ms     p99 ms    errors  eligible', flush=True)
    for row in summary['rows']:
        p = row['latencyMs']
        times = ' '.join(f'{p[k]:10.3f}' if p[k] is not None else '       n/a' for k in ('p50', 'p95', 'p99'))
        print(f"{row['client']:22s} {p['count']:5d} {times} {row['errors']:8d}  {row['eligible']}", flush=True)
        if row['reasons']:
            print('  ' + '; '.join(row['reasons']), flush=True)
    print('HTTP health and feed ping are separate metrics; no transactions are sent.', flush=True)


def resolve_pin(host, requested):
    # This is orchestration setup, outside measured request windows.
    addresses = sorted({v[4][0] for v in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)})
    if not addresses:
        raise ValueError('Endpoint has no resolved IPv4 addresses')
    if requested is not None:
        ipaddress.IPv4Address(requested)
        if requested not in addresses:
            raise ValueError('Requested pin is not in the endpoint current DNS IPv4 set')
    return requested or addresses[0], addresses


def run(args):
    out = Path(args.output_dir).resolve()
    node = shutil.which(args.node)
    http_bin, ws_bin = Path(args.rust_http_bin).resolve(), Path(args.rust_ws_bin).resolve()
    for executable in (node, http_bin, ws_bin):
        if not executable or not os.access(executable, os.X_OK):
            raise ValueError('Build both Rust release binaries and make Node available before running')
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    http_ip, http_addresses = resolve_pin(HTTP_HOST, args.http_ip)
    ws_ip, ws_addresses = resolve_pin(WS_HOST, args.ws_ip)
    pins = {'http': http_ip, 'websocket': ws_ip}
    start = time.time() + 20
    common = ['--duration-seconds', str(args.duration_seconds), '--interval-ms', '1000', '--timeout-ms', '5000']
    commands = {
        'node-http': [node, str(ROOT / 'az-benchmark.mjs'), 'probe', '--family', '4', '--connect-ip', http_ip,
                      '--warmup-samples', '5', '--cold-interval-ms', '300000', '--start-at', iso(start)],
        'rust-http': [str(http_bin), '--connect-ip', http_ip, '--warmup', '5', '--start-at', iso(start + .5)],
        'node-ws': [node, str(ROOT / 'websocket-sequencer-probe/probe.mjs'), 'probe', '--family', '4',
                    '--connect-ip', ws_ip, '--warmup', '5', '--start-at', iso(start + .25)],
        'rust-ws-library': [str(ws_bin), '--engine', 'tungstenite', '--connect-ip', ws_ip, '--warmup', '5', '--start-at', iso(start + .4)],
        'rust-ws-raw': [str(ws_bin), '--engine', 'raw', '--connect-ip', ws_ip, '--warmup', '5', '--start-at', iso(start + .65)],
    }
    for name, command in commands.items():
        command += common + ['--label', name, '--output', str(out / (name + '.json'))]
    manifest = {'kind': 'vinos-pinned-transport-run-v1', 'createdAt': iso(time.time()), 'startAt': iso(start),
                'durationSeconds': args.duration_seconds, 'pins': pins,
                'dns': {'http': http_addresses, 'websocket': ws_addresses}, 'commands': commands,
                'hostname': socket.gethostname(), 'binarySha256': {
                    name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for name, path in [('rust-http', http_bin), ('rust-ws', ws_bin)]}}
    save(out / 'manifest.json', manifest)
    print(json.dumps({'output': str(out), 'startAt': iso(start), 'pins': pins}), flush=True)
    processes, logs = {}, {}
    interrupted = []

    def stop(signum, _frame):
        interrupted.append(signum)

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        for name, command in commands.items():
            if interrupted:
                break
            logs[name] = (out / (name + '.log')).open('x')
            processes[name] = subprocess.Popen(command, stdout=logs[name], stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + args.duration_seconds + 60
        next_progress = time.monotonic() + 30
        while any(p.poll() is None for p in processes.values()) and time.monotonic() < deadline and not interrupted:
            if time.monotonic() >= next_progress:
                print(json.dumps({'running': [n for n, p in processes.items() if p.poll() is None],
                                  'secondsUntilLimit': round(deadline - time.monotonic())}), flush=True)
                next_progress += 30
            time.sleep(.2)
    finally:
        try:
            stop_processes(processes)
        finally:
            for log in logs.values():
                log.close()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            save(out / 'exits.json', {name: processes[name].returncode if name in processes else None for name in NAMES})
    reports, report_errors = collect_reports(out)
    summary = summarize(reports, read(out / 'exits.json'), pins)
    summary['reportErrors'] = report_errors
    summary['interrupted'] = bool(interrupted)
    if interrupted:
        summary['allEligible'] = False
        for row in summary['rows']:
            row['eligible'] = False
            row['reasons'].append('runner interrupted')
    save(out / 'comparison.json', summary)
    print_summary(summary)
    return 0 if summary['allEligible'] else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, help='New directory; existing directories are refused')
    parser.add_argument('--duration-seconds', type=int, default=600)
    parser.add_argument('--node', default='node')
    parser.add_argument('--rust-http-bin', default=str(ROOT / 'rust-sequencer-probe/target/release/rust-sequencer-probe'))
    parser.add_argument('--rust-ws-bin', default=str(ROOT / 'rust-websocket-probe/target/release/rust-websocket-probe'))
    parser.add_argument('--http-ip', help='Optional IPv4; must appear in current endpoint DNS')
    parser.add_argument('--ws-ip', help='Optional IPv4; must appear in current endpoint DNS')
    args = parser.parse_args()
    if not 10 <= args.duration_seconds <= 3600:
        parser.error('duration-seconds must be 10..3600; use 600+ for useful p99 samples')
    try:
        return run(args)
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('Transport comparison failed: ' + type(error).__name__ + '; inspect saved reports/logs.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
