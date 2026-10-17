"""One fixed remaining48 capture. No native imports, retries or publication.

The original lead-zero and mask are reused, never fetched. Both genuine native
proofs must match exact captured originals. All48 worst-case reservations commit
before the first request; one monotonic1200second deadline includes later native
and static qualification. This local ledger is not a global traffic meter.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

from constant_original import (CATALOGUE_SHA, DAY, DAY_CAP, EXPIRES, HEADER_CAP,
    NoRedirect, Refused, SOURCE, RUN, bounded_json, fresh, fsync_dir, require, utc_now, write_json)

ATTEMPT = 'ncaled-20261017-00-h001-h048-complete-v1'
REQUESTS = 48
OBJECT_CAP = 16 * 1024**2
RESERVED = REQUESTS * OBJECT_CAP
PRIOR = 36211395
EXPECTED_TOTAL = 136003911
SECONDS = 20
WHOLE_SECONDS = 1200
H000_BYTES = 1373100
H000_SHA = '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'
H000_PROOF_SHA = '7ada4ab10937fb51b5efc14d8d565a8ef017118f0aa6b81fb6b7c42d2bdc2176'
MASK_BYTES = 44900
MASK_SHA = 'b7d5864f26d11f9c82997d8ca8cd16a499c95fd8d9d0adcaf24f1c33b85a4ae2'
MASK_PROOF_SHA = '45f91a998910c4439a8c116d6bf6b746ad363cd4ecd6ce107be4e0b772d261ec'
MASK_RESOURCE = 'https://www.data.gouv.fr/fr/datasets/r/8339b164-c9ef-411a-8109-82e2cd4be437'


def sha(raw): return hashlib.sha256(raw).hexdigest()


def catalogue_bytes(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 4 * 1024**2,
            'bounded original catalogue path')
    before = path.stat()
    raw = path.read_bytes()
    after = path.stat()
    stable = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(stable(before) == stable(after), 'catalogue changed while reading')
    return raw


def verified_file(path, size, digest):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == size, 'retained original size/path')
    before = path.stat()
    raw = path.read_bytes()
    after = path.stat()
    stable = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(stable(before) == stable(after) and sha(raw) == digest, 'retained original identity/hash changed')
    return raw


def admit_priors(h000_proof, mask_proof, now):
    fresh(now)
    require(type(h000_proof) is bytes and len(h000_proof) == 31834 and sha(h000_proof) == H000_PROOF_SHA,
            'actual h000 native proof changed')
    require(type(mask_proof) is bytes and len(mask_proof) == 6798 and sha(mask_proof) == MASK_PROOF_SHA,
            'actual mask native proof changed')
    h000, mask = json.loads(h000_proof), json.loads(mask_proof)
    require(h000['source'] == mask['scientificSource'] == SOURCE
            and h000['inputSha256'] == H000_SHA and mask['inputSha256'] == MASK_SHA
            and h000['originalRunUtc'] == mask['originalForecastRunUtc'] == RUN
            and h000['originalExpiresUtc'] == mask['originalForecastExpiresUtc'] == EXPIRES
            and h000['originalFiveFieldsAdmitted'] is True and mask['originalLandSeaMaskAdmitted'] is True
            and h000['full49HourCohortAdmitted'] is False and mask['full49HourCohortAdmitted'] is False
            and h000['published'] is False and mask['published'] is False, 'actual native prerequisites unavailable')


def plan_from(raw, now):
    fresh(now)
    require(type(raw) is bytes and len(raw) <= 4 * 1024**2 and sha(raw) == CATALOGUE_SHA, 'exact original catalogue changed')
    from catalogue import build_plan
    plan = build_plan(raw, 'NCALED', RUN, now)
    require(len(plan['packets']) == 49 and plan['packets'][0]['bytes'] == H000_BYTES
            and sum(row['bytes'] for row in plan['packets'][1:]) == EXPECTED_TOTAL
            and plan['constantResource'] == MASK_RESOURCE, 'fixed original declarations changed')
    return plan


def check_ticket(ticket, now):
    fresh(now)
    expected = {'schema': 1, 'attempt': ATTEMPT, 'day': DAY, 'source': SOURCE,
        'catalogueSha256': CATALOGUE_SHA, 'originalRunUtc': RUN, 'expiresAt': EXPIRES,
        'maximumRequests': REQUESTS, 'expectedDeclaredBytes': EXPECTED_TOTAL,
        'reservedBytes': RESERVED, 'priorReviewedApplicationBytes': PRIOR, 'dailyMaximumBytes': DAY_CAP,
        'otherAromeAcquisitionHeld': True, 'h000NativeProofSha256': H000_PROOF_SHA,
        'maskNativeProofSha256': MASK_PROOF_SHA, 'maskOriginalSha256': MASK_SHA,
        'fullAttemptSeconds': WHOLE_SECONDS, 'perReadSeconds': SECONDS, 'reviewRequired': True}
    require(type(ticket) is dict and set(ticket) == set(expected)
            and all(type(ticket[key]) is type(value) and ticket[key] == value for key, value in expected.items()),
            'unreviewed remaining48 ticket')
    require(PRIOR + RESERVED == 841517763 and PRIOR + RESERVED <= DAY_CAP, 'daily worst-case budget unavailable')


def within(deadline, now, monotonic=time.monotonic):
    fresh(now)
    require(type(deadline) in (int, float) and math.isfinite(deadline) and monotonic() < deadline,
            'absolute whole-cohort deadline')


def reserve(ledger, ticket, now):
    check_ticket(ticket, now)
    ledger = Path(ledger)
    require(not ledger.exists() and not ledger.is_symlink(), 'existing ledger never reset or retried')
    require(ledger.parent.is_dir() and not any(ledger.parent.iterdir()), 'orphan state never recreated')
    descriptor = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    db = sqlite3.connect(ledger, timeout=5, isolation_level=None)
    try:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE day(day TEXT PRIMARY KEY, prior INTEGER NOT NULL, reserved INTEGER NOT NULL)')
        db.execute('CREATE TABLE attempt(id TEXT PRIMARY KEY,ticket_sha TEXT NOT NULL,state TEXT NOT NULL)')
        db.execute('CREATE TABLE packet(offset INTEGER PRIMARY KEY,state TEXT NOT NULL,written INTEGER,raw_sha TEXT)')
        db.execute('INSERT INTO day VALUES(?,?,?)', (DAY, PRIOR, RESERVED))
        db.execute('INSERT INTO attempt VALUES(?,?,?)', (ATTEMPT, sha(json.dumps(ticket, sort_keys=True).encode()), 'reserved-before-first-get'))
        db.executemany('INSERT INTO packet VALUES(?,?,NULL,NULL)', ((offset, 'reserved') for offset in range(1, 49)))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    finally:
        db.close()
    with ledger.open('r+b') as stream: os.fsync(stream.fileno())
    fsync_dir(ledger.parent)


def transition(ledger, offset, before, after, size=None, digest=None):
    db = sqlite3.connect(ledger, timeout=5)
    try:
        with db:
            changed = db.execute('UPDATE packet SET state=?,written=?,raw_sha=? WHERE offset=? AND state=?',
                                (after, size, digest, offset, before)).rowcount
            require(changed == 1, 'packet transition changed; no retry')
    finally:
        db.close()


def receive(response, stream, expected, monotonic=time.monotonic):
    start = monotonic()
    size = 0
    while True:
        require(monotonic() - start < SECONDS, 'body deadline')
        chunk = response.read(min(65536, expected - size + 1))
        if not chunk: break
        size += len(chunk)
        require(size <= OBJECT_CAP, 'body cap')
        stream.write(chunk); stream.flush()
        require(size <= expected, 'original exceeds declaration')
    require(size == expected, 'original incomplete')
    return size


def download_child(output, offset, catalogue):
    require(type(offset) is int and 1 <= offset <= 48, 'no h000 or mask refetch')
    packet = plan_from(catalogue_bytes(catalogue), utc_now())['packets'][offset]
    url, expected = packet['url'], packet['bytes']
    facts = {'schema': 1, 'offsetHours': offset, 'method': 'GET', 'url': url,
        'startedAt': utc_now().isoformat(), 'redirects': 0, 'retries': 0, 'range': False, 'credentials': False}
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(url, method='GET', headers={'Accept-Encoding': 'identity',
            'User-Agent': 'Thalassa reviewed fixed remaining48 original pilot'})
        with opener.open(request, timeout=SECONDS) as response:
            facts['status'] = response.status
            require(sum(len(k.encode()) + len(v.encode()) + 4 for k, v in response.headers.raw_items()) + 2 <= HEADER_CAP,
                    'response header cap')
            facts['headers'] = {key: response.headers.get(key) for key in
                ('content-length', 'content-type', 'etag', 'last-modified', 'date', 'content-encoding')
                if response.headers.get(key) is not None}
            require(response.status == 200 and response.url == url, 'status/redirect refused')
            require(response.headers.get_all('Content-Length', []) == [str(expected)], 'exact declared Content-Length changed')
            require(response.headers.get('Content-Encoding', 'identity').lower() in ('', 'identity'), 'encoded original refused')
            with (output / 'original.grib2').open('xb') as stream:
                facts['bodyBytes'] = receive(response, stream, expected)
                os.fsync(stream.fileno())
        fresh(utc_now())
        facts['outcome'] = 'complete-exact-original'
    except BaseException as error:
        if isinstance(error, urllib.error.HTTPError): facts['status'] = error.code
        facts.update(outcome='failed-no-retry', errorType=type(error).__name__, error=str(error)[:512])
        write_json(output / 'transport.json', facts)
        raise
    write_json(output / 'transport.json', facts)


def run_transport(output, offset, catalogue, deadline):
    require(os.name == 'posix', 'actual Linux process groups required')
    remaining = min(SECONDS, deadline - time.monotonic())
    require(remaining > 0, 'whole attempt expired before transfer')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    with (output / 'transport-stdout.txt').open('xb') as stdout, (output / 'transport-stderr.txt').open('xb') as stderr:
        started = time.monotonic()
        child = subprocess.Popen([sys.executable, '-E', '-s', '-B', str(Path(__file__).resolve()),
            '_download', str(offset), str(catalogue), str(output)], env=env, stdin=subprocess.DEVNULL,
            stdout=stdout, stderr=stderr, close_fds=True, start_new_session=True)
        try:
            return child.wait(timeout=max(0, remaining - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
            raise Refused('absolute transfer/whole deadline; process group killed; no retry')


def capture_all(ledger, output, catalogue_path, ticket, h000, mask, h000_proof, mask_proof,
                clock=utc_now, monotonic=time.monotonic, transport=run_transport):
    now = clock()
    plan = plan_from(catalogue_bytes(catalogue_path), now)
    check_ticket(ticket, now)
    admit_priors(h000_proof, mask_proof, now)
    verified_file(h000, H000_BYTES, H000_SHA); verified_file(mask, MASK_BYTES, MASK_SHA)
    require(now <= datetime.fromisoformat(EXPIRES.replace('Z', '+00:00')) - timedelta(seconds=WHOLE_SECONDS),
            'insufficient original freshness window for whole attempt')
    output = Path(output)
    require(output.parent.is_dir() and not output.exists(), 'fresh output required')
    started = monotonic(); deadline = started + WHOLE_SECONDS
    reserve(ledger, ticket, now)
    output.mkdir(mode=0o700); fsync_dir(output.parent)
    reservation = {'schema': 1, 'source': SOURCE, 'attempt': ATTEMPT, 'ticket': ticket,
        'startedAtUtc': now.isoformat(), 'startedMonotonic': started, 'deadlineMonotonic': deadline,
        'all48WorstCaseBytesReservedBeforeGet': RESERVED, 'originalExpiresAt': EXPIRES}
    write_json(output / 'reservation.json', reservation)
    sources = [{**plan['packets'][0], 'sha256': H000_SHA, 'path': str(Path(h000).resolve())}]
    error = None
    requested = 0
    for offset in range(1, 49):
        hour = output / f'hour-{offset:03}'
        receiving = False
        try:
            within(deadline, clock(), monotonic)
            transition(ledger, offset, 'reserved', 'receiving'); receiving = True
            hour.mkdir(mode=0o700)
            requested += 1
            require(transport(hour, offset, catalogue_path, deadline) == 0, 'one fixed original transfer failed')
            facts = bounded_json(hour / 'transport.json', 131072)
            packet = plan['packets'][offset]
            path = hour / 'original.grib2'
            require(facts.get('outcome') == 'complete-exact-original' and facts.get('url') == packet['url']
                    and facts.get('offsetHours') == offset and facts.get('bodyBytes') == packet['bytes']
                    and facts.get('status') == 200, 'exact transfer outcome missing')
            require(path.is_file() and not path.is_symlink() and path.stat().st_size == packet['bytes'], 'exact captured original missing')
            digest = sha(path.read_bytes())
            within(deadline, clock(), monotonic)
            transition(ledger, offset, 'receiving', 'complete', packet['bytes'], digest); receiving = False
            sources.append({**packet, 'path': str(path.resolve()), 'sha256': digest})
        except BaseException as failure:
            path = hour / 'original.grib2'
            size = path.stat().st_size if path.is_file() and not path.is_symlink() else 0
            require(0 <= size <= OBJECT_CAP, 'partial original cap')
            digest = sha(path.read_bytes()) if size else None
            if receiving: transition(ledger, offset, 'receiving', 'failed-or-unknown', size, digest)
            error = {'offsetHours': offset, 'type': type(failure).__name__, 'message': str(failure)[:512]}
            break
    outcome = 'failed-or-unknown-never-retry'
    if error is None:
        try:
            within(deadline, clock(), monotonic)
            require(len(sources) == 49, 'original49 capture incomplete')
            write_json(output / 'sources.json', {'schema': 1, 'packets': sources,
                'mask': {'resource': MASK_RESOURCE, 'path': str(Path(mask).resolve()), 'bytes': MASK_BYTES, 'sha256': MASK_SHA}})
            outcome = 'all48-captured-native-unadmitted'
        except BaseException as failure:
            error = {'offsetHours': 49, 'type': type(failure).__name__, 'message': str(failure)[:512]}
    result = {'schema': 1, 'source': SOURCE, 'attempt': ATTEMPT, 'outcome': outcome, 'error': error,
        'maximumRequests': 48, 'transfersStartedConservative': requested, 'completedNewOriginals': len(sources) - 1,
        'newCapturedBytes': sum(row['bytes'] for row in sources[1:]), 'reservedWorstCaseBytesRetained': RESERVED,
        'priorReviewedBytes': PRIOR, 'originalRunUtc': RUN, 'originalExpiresAt': EXPIRES,
        'startedMonotonic': started, 'deadlineMonotonic': deadline, 'startedAtUtc': now.isoformat(),
        'h000Refetched': False, 'maskRefetched': False, 'full49HourCohortAdmitted': False, 'published': False}
    write_json(output / 'result.json', result)
    return result


def main():
    if len(sys.argv) == 5 and sys.argv[1] == '_download':
        download_child(Path(sys.argv[4]), int(sys.argv[2]), Path(sys.argv[3])); return
    parser = argparse.ArgumentParser()
    for name in ('ledger', 'output', 'catalogue', 'ticket', 'h000', 'mask', 'h000-proof', 'mask-proof'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    require(os.name == 'posix' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'first Linux GitHub attempt only')
    from corrected_original_native import readonly_file
    for path in (args.catalogue, args.ticket, args.h000, args.mask, args.h000_proof, args.mask_proof): readonly_file(path)
    require(args.catalogue.stat().st_size <= 4 * 1024**2 and args.h000_proof.stat().st_size == 31834
            and args.mask_proof.stat().st_size == 6798, 'fixed input proof bounds')
    result = capture_all(args.ledger, args.output, args.catalogue, bounded_json(args.ticket, 16384),
        args.h000, args.mask, args.h000_proof.read_bytes(), args.mask_proof.read_bytes())
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result['outcome'] == 'all48-captured-native-unadmitted' else 1)


if __name__ == '__main__': main()
