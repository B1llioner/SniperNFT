"""Local fixtures for the five-client runner; no RPC calls or real subprocesses."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('transport_benchmark', Path(__file__).resolve().parents[1] / 'transport-benchmark.py')
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)
BASE = 1_800_000_000
PINS = {'http': '192.0.2.1', 'websocket': '192.0.2.2'}


def fixtures():
    reports = {}
    for name in BENCH.NAMES:
        http = name.endswith('http')
        settings = {'durationSeconds': 600, 'intervalMs': 1000, 'timeoutMs': 5000,
                    ('warmupSamples' if http else 'warmup'): 5}
        report = {'schemaVersion': 1, 'completed': True, 'settings': settings, 'samples': [],
                  'startedAt': BENCH.iso(BASE), 'clockDriftMs': 0}
        if http:
            report.update(endpointOrigin='https://' + BENCH.HTTP_HOST,
                          endpointId=hashlib.sha256(('https://' + BENCH.HTTP_HOST + '/').encode()).hexdigest(),
                          protocol='http/1.1', method='arb_checkPublisherHealth', family=4,
                          finishedAt=BENCH.iso(BASE + 600))
            if name == 'node-http':
                report['connectIp'] = PINS['http']
            else:
                settings['connectIp'] = PINS['http']
        else:
            report.update(endpoint='wss://' + BENCH.WS_HOST + '/', mode='feed',
                          metric='websocket-control-ping-round-trip', endedAt=BENCH.iso(BASE + 600),
                          connection={'openedAt': BENCH.iso(BASE), 'remoteAddress': PINS['websocket']})
            settings.update(connectIp=PINS['websocket'], family=4, autoReconnect=False, redirects=False, compression=False)
            if name != 'node-ws':
                report['engine'] = 'raw' if name.endswith('raw') else 'tungstenite'
        for index in range(600):
            sample = {'ok': True}
            if http:
                sample.update(reusedSocket=True, remoteAddress=PINS['http'])
                if name == 'node-http':
                    sample.update(kind='warm', timestamp=BENCH.iso(BASE + index), timingsMs={'total': 2})
                else:
                    sample.update(at=BENCH.iso(BASE + index), totalMs=2)
            else:
                sample.update(warmup=index < 5, sentAfterOpenMs=index * 1000, rttMs=3)
            report['samples'].append(sample)
        reports[name] = report
    return reports, dict.fromkeys(BENCH.NAMES, 0)


def rows(summary):
    return {row['client']: row for row in summary['rows']}


class SummaryTests(unittest.TestCase):
    def test_complete_matching_fixtures_are_eligible(self):
        reports, exits = fixtures()
        summary = BENCH.summarize(reports, exits, PINS)
        self.assertTrue(summary['allEligible'])
        self.assertEqual(rows(summary)['node-http']['latencyMs']['count'], 600)
        self.assertEqual(rows(summary)['rust-ws-raw']['latencyMs']['count'], 595)

    def test_failures_are_counted_without_zero_latency(self):
        reports, exits = fixtures()
        for name in BENCH.NAMES:
            sample = reports[name]['samples'][10]
            sample.update(ok=False, errorCode='TIMEOUT')
            sample.pop('rttMs', None)
            sample.pop('totalMs', None)
            sample.pop('timingsMs', None)
        for row in BENCH.summarize(reports, exits, PINS)['rows']:
            self.assertEqual(row['errors'], 1)
            self.assertEqual(row['timeouts'], 1)
            self.assertGreater(row['latencyMs']['p50'], 0)
            self.assertEqual(row['latencyMs']['count'], row['attempts'] - 1)

    def test_late_answer_stays_in_request_start_window(self):
        reports, exits = fixtures()
        reports['rust-http']['startedAt'] = BENCH.iso(BASE + .5)
        reports['rust-http']['finishedAt'] = BENCH.iso(BASE + 605)
        reports['node-http']['samples'][-1]['timingsMs']['total'] = 5000
        reports['node-http']['samples'].append({'kind': 'warm', 'ok': True, 'reusedSocket': True,
                                               'timestamp': BENCH.iso(BASE + 600), 'timingsMs': {'total': 9000},
                                               'remoteAddress': PINS['http']})
        row = rows(BENCH.summarize(reports, exits, PINS))['node-http']
        self.assertEqual(row['latencyMs']['max'], 5000)
        self.assertEqual(row['attempts'], 599)

    def test_actual_and_configured_pin_mismatch_are_rejected(self):
        for field in ('actual', 'configured'):
            with self.subTest(field=field):
                reports, exits = fixtures()
                if field == 'actual':
                    reports['rust-http']['samples'][10]['remoteAddress'] = '192.0.2.9'
                else:
                    reports['rust-http']['settings']['connectIp'] = '192.0.2.9'
                row = rows(BENCH.summarize(reports, exits, PINS))['rust-http']
                self.assertFalse(row['eligible'])
                self.assertIn('actual or configured destination differs from pin', row['reasons'])

    def test_http_metadata_must_match(self):
        for key, value in [('method', 'eth_chainId'), ('family', 6), ('protocol', 'h2'),
                           ('endpointOrigin', 'https://other.example')]:
            with self.subTest(key=key):
                reports, exits = fixtures()
                reports['rust-http'][key] = value
                self.assertFalse(rows(BENCH.summarize(reports, exits, PINS))['rust-http']['eligible'])
        for key, value in [('durationSeconds', 599), ('intervalMs', 999), ('timeoutMs', 4000), ('warmupSamples', 4)]:
            with self.subTest(key=key):
                reports, exits = fixtures()
                reports['rust-http']['settings'][key] = value
                result = rows(BENCH.summarize(reports, exits, PINS))
                self.assertFalse(result['node-http']['eligible'])
                self.assertFalse(result['rust-http']['eligible'])

    def test_ws_metadata_and_engine_must_match(self):
        for key, value in [('engine', 'tungstenite'), ('mode', 'capability'), ('metric', 'rpc'), ('endpoint', 'wss://other.example/')]:
            with self.subTest(key=key):
                reports, exits = fixtures()
                reports['rust-ws-raw'][key] = value
                self.assertFalse(rows(BENCH.summarize(reports, exits, PINS))['rust-ws-raw']['eligible'])

    def test_missing_report_keeps_all_five_rows_and_other_group(self):
        reports, exits = fixtures()
        del reports['rust-http']
        summary = BENCH.summarize(reports, exits, PINS)
        self.assertFalse(summary['allEligible'])
        self.assertEqual(len(summary['rows']), 5)
        self.assertEqual(summary['windows']['http']['seconds'], 0)
        self.assertIsNone(rows(summary)['rust-http']['latencyMs']['p99'])
        self.assertTrue(rows(summary)['node-ws']['eligible'])
        json.dumps(summary, allow_nan=False)

    def test_incomplete_exit_and_bad_sample_make_run_ineligible(self):
        reports, exits = fixtures()
        reports['node-http']['completed'] = False
        exits['rust-http'] = 2
        reports['node-ws']['samples'][10]['rttMs'] = float('nan')
        result = rows(BENCH.summarize(reports, exits, PINS))
        for name in ('node-http', 'rust-http', 'node-ws'):
            self.assertFalse(result[name]['eligible'])
        self.assertIn('malformed samples', result['node-ws']['reasons'])

    def test_percentiles_and_timestamps_reject_ambiguous_values(self):
        self.assertEqual(BENCH.percentiles([]), dict(count=0, p50=None, p95=None, p99=None, max=None))
        self.assertEqual(BENCH.percentiles(range(1, 101))['p99'], 99)
        for value in (None, True, -1, float('inf'), float('nan'), '2'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BENCH.percentiles([2, value])
        with self.assertRaises(ValueError):
            BENCH.stamp('2026-09-16T12:00:00')


class RunnerTests(unittest.TestCase):
    def test_missing_and_malformed_reports_are_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'node-http.json').write_text('{bad')
            reports, errors = BENCH.collect_reports(path)
            self.assertEqual(set(reports), set(BENCH.NAMES))
            self.assertTrue(all(value is None for value in reports.values()))
            self.assertEqual(errors['node-http'], 'JSONDecodeError')
            self.assertEqual(errors['rust-http'], 'FileNotFoundError')

    def test_stop_reaps_every_child_despite_exit_race_and_forces_stalled_child(self):
        first, second = Mock(pid=101), Mock(pid=102)
        first.poll.return_value = second.poll.return_value = None
        first.wait.return_value = 0
        second.wait.side_effect = [subprocess.TimeoutExpired('test', 7), 0]
        with patch.object(BENCH.os, 'killpg', side_effect=[ProcessLookupError(), None, None]) as kill:
            BENCH.stop_processes({'first': first, 'second': second})
        first.wait.assert_called_once_with(timeout=7)
        self.assertEqual(second.wait.call_count, 2)
        self.assertEqual(kill.call_args_list[-1].args, (102, signal.SIGKILL))

    def test_cancelled_run_saves_reports_and_cannot_be_eligible(self):
        reports, _ = fixtures()
        handlers = {}
        def fake_signal(sig, handler):
            previous = handlers.get(sig)
            handlers[sig] = handler
            return previous
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'run'
            def popen(command, **_kwargs):
                name = command[command.index('--label') + 1]
                BENCH.save(out / (name + '.json'), reports[name])
                handlers[signal.SIGTERM](signal.SIGTERM, None)
                child = Mock(pid=100 + BENCH.NAMES.index(name), returncode=0)
                child.poll.return_value = None
                child.wait.return_value = 0
                return child
            args = argparse.Namespace(output_dir=str(out), node=sys.executable,
                                      rust_http_bin=sys.executable, rust_ws_bin=sys.executable,
                                      duration_seconds=600, http_ip=None, ws_ip=None)
            with patch.object(BENCH, 'resolve_pin', side_effect=[(PINS['http'], [PINS['http']]), (PINS['websocket'], [PINS['websocket']])]), \
                 patch.object(BENCH.signal, 'signal', side_effect=fake_signal), \
                 patch.object(BENCH.subprocess, 'Popen', side_effect=popen) as launch, \
                 patch.object(BENCH.os, 'killpg'), patch.object(sys, 'stdout', io.StringIO()):
                self.assertEqual(BENCH.run(args), 2)
                self.assertEqual(launch.call_count, 1, 'cancellation must stop launching further clients')
            summary = BENCH.read(out / 'comparison.json')
            self.assertTrue(summary['interrupted'])
            self.assertFalse(summary['allEligible'])
            self.assertTrue(all(not row['eligible'] for row in summary['rows']))
            self.assertEqual(set(BENCH.read(out / 'exits.json')), set(BENCH.NAMES))


if __name__ == '__main__':
    unittest.main()
