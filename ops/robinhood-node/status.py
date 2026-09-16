#!/usr/bin/env python3
"""Read-only status on the dedicated Robinhood node; no wallet or AWS credentials."""
import concurrent.futures
import datetime
import json
import os
import pathlib
import stat
import subprocess
import time
import urllib.request

MOUNT = pathlib.Path('/srv/robinhood')


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=8)
        if result.returncode:
            return {'available': False, 'exitCode': result.returncode}
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': type(error).__name__}


def rpc(url, method, params):
    started = time.monotonic()
    request = urllib.request.Request(url, data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params,
    }).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}, method='POST')
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=8) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            return {'ok': False, 'reason': 'response_too_large'}
        body = json.loads(raw)
        if body.get('error') is not None or 'result' not in body:
            return {'ok': False, 'reason': 'rpc_error'}
        return {'ok': True, 'result': body['result'],
                'elapsedMs': round((time.monotonic() - started) * 1000, 2)}
    except (OSError, ValueError) as error:
        return {'ok': False, 'reason': type(error).__name__}


def main():
    report = {'observedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'loadAverage': os.getloadavg(),
              'service': command(['systemctl', 'show', 'vinos-robinhood-node.service',
                                  '--property=ActiveState,SubState,NRestarts,Result']),
              'snapshotService': command(['systemctl', 'show', 'vinos-robinhood-snapshot.service',
                                          '--property=ActiveState,SubState,Result']),
              'mount': command(['findmnt', '--mountpoint', str(MOUNT), '--noheadings',
                               '--output=SOURCE,FSTYPE,TARGET'])}
    if os.path.ismount(MOUNT):
        fs = os.statvfs(MOUNT)
        total, free = fs.f_blocks * fs.f_frsize, fs.f_bavail * fs.f_frsize
        report['disk'] = {'totalBytes': total, 'availableBytes': free,
                          'usedBytes': (fs.f_blocks - fs.f_bfree) * fs.f_frsize,
                          'availableDecimalTB': round(free / 1e12, 3)}
        snapshot = {}
        for name in ('full-path.tar.part0000', 'full-path.tar.part0001', 'full-path.tar', 'complete.json'):
            try:
                info = (MOUNT / 'snapshot' / name).lstat()
                if stat.S_ISREG(info.st_mode):
                    snapshot[name] = {'bytes': info.st_size}
            except FileNotFoundError:
                pass
        written = sum(snapshot.get(name, {}).get('bytes', 0)
                      for name in ('full-path.tar.part0000', 'full-path.tar.part0001'))
        report['snapshotFiles'] = snapshot
        report['snapshotPartBytesWritten'] = written
        report['snapshotExpectedBytes'] = 786984437760
        report['snapshotNote'] = 'File sizes show transfer progress, not checksum verification or sync completion; parts are removed after assembly.'
    local = 'http://127.0.0.1:8547'
    calls = {'chainId': (local, 'eth_chainId', []),
             'syncing': (local, 'eth_syncing', []),
             'localHead': (local, 'eth_getBlockByNumber', ['latest', False]),
             'referenceHead': ('https://rpc.mainnet.chain.robinhood.com',
                               'eth_getBlockByNumber', ['latest', False])}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {name: pool.submit(rpc, *args) for name, args in calls.items()}
        values = {name: future.result() for name, future in futures.items()}
    for name, value in values.items():
        if name.endswith('Head') and value.get('ok'):
            block = value['result']
            if isinstance(block, dict):
                value['result'] = {key: block.get(key) for key in ('number', 'hash', 'timestamp')}
        report[name] = value
    try:
        own = values['localHead']['result']
        reference = values['referenceHead']['result']
        report['referenceMinusLocalBlocks'] = int(reference['number'], 16) - int(own['number'], 16)
        report['localHeadAgeSeconds'] = round(time.time() - int(own['timestamp'], 16), 1)
    except (KeyError, TypeError, ValueError):
        pass
    report['note'] = 'One observation only; repeated fresh heads and successful simulations are required before switching the minter.'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
