"""One reviewed conditional constant original, no scheduler or publisher.

The separate root-issued ticket reserves this pilot's worst-case16MiB within
the reviewed daily envelope. This local ledger does not discover other services'
traffic. A partial/unknown outcome keeps the full reservation and cannot retry.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SOURCE = 'cf21a611c6b22db62449bc1658e7ae8b931476be'
RUN = '2026-10-17T00:00:00Z'
EXPIRES = '2026-10-17T18:00:00Z'
CATALOGUE_SHA = '62b72c941a8598d712a550ef0bf1020a6a34a9f199c7d09d50d8affb358e3383'
URL = 'https://static.data.gouv.fr/resources/champs-constant-1/20250217-090714/constant-ncaled0025.grib2'
ETAG = '"9ce9149bbab869fdf81088046daa695c"'
EXPECTED = 44900
CAP = 16 * 1024**2
DAY_CAP = 2_500_000_000
DAY = '2026-10-17'
ATTEMPT = 'ncaled-20261017-00-constant-conditional-v1'
SECONDS = 20
HEADER_CAP = 32768
H000_PROOF_BYTES = 31834
H000_PROOF_SHA = '7ada4ab10937fb51b5efc14d8d565a8ef017118f0aa6b81fb6b7c42d2bdc2176'


class Refused(ValueError):
    pass


def require(ok, why):
    if not ok:
        raise Refused(why)


def utc_now():
    return datetime.now(timezone.utc)


def fresh(now):
    require(now.tzinfo is not None, 'UTC clock required')
    require(datetime.fromisoformat(RUN.replace('Z', '+00:00')) <= now <
            datetime.fromisoformat(EXPIRES.replace('Z', '+00:00')), 'fixed original run future/stale; no latest fallback')


def bounded_json(path, cap):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= cap,
            'missing/unsafe/oversized reviewed metadata')
    return json.loads(path.read_bytes())


def check_catalogue(raw, now):
    fresh(now)
    require(type(raw) is bytes and len(raw) <= 4 * 1024**2 and hashlib.sha256(raw).hexdigest() == CATALOGUE_SHA,
            'captured original catalogue changed')
    # Exact corrected pure catalogue admission; all49 declarations and rights remain required.
    from catalogue import build_plan
    plan = build_plan(raw, 'NCALED', RUN, now)
    require(plan['constantResource'] == 'https://www.data.gouv.fr/fr/datasets/r/8339b164-c9ef-411a-8109-82e2cd4be437',
            'fixed original constant declaration changed')
    return plan


def check_ticket(ticket, now):
    fresh(now)
    require(type(ticket) is dict and set(ticket) == {'schema', 'attempt', 'day', 'source', 'catalogueSha256',
            'maximumRequests', 'expectedDeclaredBytes', 'conditionalETag', 'staticHeadSha256', 'reservedBytes', 'priorReviewedApplicationBytes',
            'dailyMaximumBytes', 'otherAromeAcquisitionHeld', 'expiresAt', 'reviewRequired'}, 'ticket fields changed')
    expected = {'schema': 1, 'attempt': ATTEMPT, 'day': DAY, 'source': SOURCE, 'catalogueSha256': CATALOGUE_SHA,
                'maximumRequests': 1, 'expectedDeclaredBytes': EXPECTED, 'conditionalETag': ETAG,
                'staticHeadSha256': '64901305e76aedc2ed71fce770a3ee0535ce0b9059d6ab82e42144ae011c094d', 'reservedBytes': CAP,
                'dailyMaximumBytes': DAY_CAP, 'otherAromeAcquisitionHeld': True, 'expiresAt': EXPIRES,
                'reviewRequired': True}
    require(all(type(ticket.get(k)) is type(v) and ticket[k] == v for k, v in expected.items()), 'unreviewed pilot ticket')
    prior = ticket['priorReviewedApplicationBytes']
    require(type(prior) is int and prior == 19434179 and prior + CAP + 48 * CAP <= DAY_CAP,
            'reviewed prior or held remaining48 budget changed')


def check_h000_proof(raw, now):
    fresh(now)
    require(type(raw) is bytes and len(raw) == H000_PROOF_BYTES
            and hashlib.sha256(raw).hexdigest() == H000_PROOF_SHA, 'actual retained h000 native proof changed')
    proof = json.loads(raw)
    require(proof['source'] == SOURCE and proof['inputSha256'] == '4e2e34400535158f696f1684c74bebb6d08126e37f9f713f29f94a30498bd733'
            and proof['originalRunUtc'] == RUN and proof['originalExpiresUtc'] == EXPIRES
            and proof['originalFiveFieldsAdmitted'] is True
            and proof['originalLandSeaMaskAdmitted'] is False and proof['full49HourCohortAdmitted'] is False
            and proof['published'] is False, 'actual retained h000 admission unavailable')


def fsync_dir(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def reserve(ledger, ticket, now):
    check_ticket(ticket, now)
    ledger = Path(ledger)
    if ledger.exists():
        require(ledger.is_file() and not ledger.is_symlink() and 0 < ledger.stat().st_size <= 1024**2,
                'invalid durable ledger; never reset')
        raise Refused('pilot ledger already exists; never reset or retry')
    else:
        require(ledger.parent.is_dir() and not any(ledger.parent.iterdir()), 'orphaned state; never recreate ledger')
        fd = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    db = sqlite3.connect(ledger, timeout=5, isolation_level=None)
    try:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('BEGIN IMMEDIATE')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not tables:
            db.execute('CREATE TABLE day(day TEXT PRIMARY KEY, prior INTEGER NOT NULL, reserved INTEGER NOT NULL)')
            db.execute('CREATE TABLE attempt(id TEXT PRIMARY KEY, ticket_sha TEXT NOT NULL, state TEXT NOT NULL, written INTEGER, raw_sha TEXT)')
            db.execute('INSERT INTO day VALUES(?,?,0)', (DAY, ticket['priorReviewedApplicationBytes']))
        else:
            require(tables == {'day', 'attempt'}, 'unexpected ledger schema')
        rows = db.execute('SELECT day,prior,reserved FROM day').fetchall()
        require(len(rows) == 1 and rows[0][0] == DAY and rows[0][1] == ticket['priorReviewedApplicationBytes']
                and type(rows[0][2]) is int and rows[0][2] >= 0, 'daily ledger identity changed')
        require(db.execute('SELECT COUNT(*) FROM attempt').fetchone()[0] == 0, 'pilot already reserved; no retry')
        require(rows[0][1] + rows[0][2] + CAP <= DAY_CAP, 'daily body budget exhausted')
        db.execute('UPDATE day SET reserved=reserved+? WHERE day=?', (CAP, DAY))
        db.execute('INSERT INTO attempt VALUES(?,?,?,NULL,NULL)',
                   (ATTEMPT, hashlib.sha256(json.dumps(ticket, sort_keys=True).encode()).hexdigest(), 'reserved-before-get'))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()
    with ledger.open('r+b') as stream:
        os.fsync(stream.fileno())
    fsync_dir(ledger.parent)


def record(ledger, state, size, digest):
    db = sqlite3.connect(ledger, timeout=5)
    try:
        with db:
            changed = db.execute('UPDATE attempt SET state=?,written=?,raw_sha=? WHERE id=? AND state=?',
                                 (state, size, digest, ATTEMPT, 'reserved-before-get')).rowcount
            require(changed == 1, 'attempt transition changed')
    finally:
        db.close()


def write_json(path, value):
    raw = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    require(len(raw) <= 128 * 1024, 'receipt bound')
    with Path(path).open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def receive_body(response, stream, monotonic=time.monotonic):
    start = monotonic()
    size = 0
    while True:
        require(monotonic() - start < SECONDS, 'body deadline')
        chunk = response.read(min(65536, EXPECTED - size + 1))
        if not chunk:
            break
        size += len(chunk)
        # Preserve unexpected bytes too, up to the fixed original cap.
        require(size <= CAP, 'original body exceeded16MiB')
        stream.write(chunk)
        stream.flush()
        require(size <= EXPECTED, 'original body exceeds declared catalogue bytes')
    require(size == EXPECTED, 'original body is incomplete')
    return size


def download_child(output):
    # The only network-capable path. No caller URL, proxy, auth or cookie input.
    facts = {'schema': 1, 'method': 'GET', 'url': URL, 'startedAt': utc_now().isoformat(),
             'redirects': 0, 'retries': 0, 'range': False, 'credentials': False, 'ifMatch': ETAG}
    try:
        fresh(utc_now())
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(URL, method='GET', headers={'Accept-Encoding': 'identity',
                                         'If-Match': ETAG, 'User-Agent': 'Thalassa reviewed conditional constant pilot'})
        with opener.open(request, timeout=SECONDS) as response:
            facts['status'] = response.status
            headers = list(response.headers.raw_items())
            require(sum(len(k.encode()) + len(v.encode()) + 4 for k, v in headers) + 2 <= HEADER_CAP,
                    'original response headers oversized')
            facts['headers'] = {k: response.headers.get(k) for k in
                                ('content-length', 'content-type', 'etag', 'last-modified', 'date', 'content-encoding')
                                if response.headers.get(k) is not None}
            require(response.status == 200 and response.url == URL, 'original status/redirect refused')
            require(response.headers.get('Content-Encoding', 'identity').lower() in ('', 'identity'), 'encoded original refused')
            lengths = response.headers.get_all('Content-Length', [])
            require(len(lengths) == 1 and lengths[0] == str(EXPECTED), 'exact constant Content-Length changed')
            tags = response.headers.get_all('ETag', [])
            require(tags == [ETAG], 'exact strong conditional ETag changed')
            with (output / 'original.grib2').open('xb') as stream:
                facts['bodyBytes'] = receive_body(response, stream)
                os.fsync(stream.fileno())
        fresh(utc_now())
        facts['outcome'] = 'complete-exact-original'
    except BaseException as error:
        if isinstance(error, urllib.error.HTTPError):
            facts['status'] = error.code
        facts['outcome'] = 'failed-no-retry'
        facts['errorType'] = type(error).__name__
        facts['error'] = str(error)[:512]
        write_json(output / 'transport.json', facts)
        raise
    write_json(output / 'transport.json', facts)


def run_transport(output, python=sys.executable):
    require(os.name == 'posix', 'production controller requires Linux process groups')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    # All inherited provider/storage/auth/proxy/loader variables and FDs disappear.
    with (output / 'transport-stdout.txt').open('xb') as stdout, (output / 'transport-stderr.txt').open('xb') as stderr:
        started = time.monotonic()
        child = subprocess.Popen([python, '-E', '-s', '-B', str(Path(__file__).resolve()), '_download', str(output)],
                                 env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                 close_fds=True, start_new_session=True)
        try:
            return child.wait(timeout=max(0, SECONDS - (time.monotonic() - started)))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
            raise Refused('absolute20s transport deadline; group killed; no retry')


def capture(ledger, output, catalogue, ticket, now=None, transport=run_transport, *, h000_proof):
    actual_clock = now is None
    now = now or utc_now()
    check_catalogue(catalogue, now)
    check_ticket(ticket, now)
    check_h000_proof(h000_proof, now)
    output = Path(output)
    require(output.parent.is_dir() and not output.exists(), 'fresh attempt output required')
    reserve(ledger, ticket, now)
    output.mkdir(mode=0o700)
    fsync_dir(output.parent)
    write_json(output / 'reservation.json', {'ticket': ticket, 'requestsReservedBeforeGet': 1,
               'maximumBodyReservationBytes': CAP, 'catalogueSha256': CATALOGUE_SHA, 'source': SOURCE,
               'actualRetainedH000ProofSha256': H000_PROOF_SHA})
    outcome = 'failed-or-unknown-no-retry'
    error = None
    try:
        require(transport(output) == 0, 'one original transfer failed')
        facts = bounded_json(output / 'transport.json', 128 * 1024)
        raw = output / 'original.grib2'
        require(facts.get('outcome') == 'complete-exact-original' and raw.is_file()
                and not raw.is_symlink() and raw.stat().st_size == EXPECTED, 'exact original outcome missing')
        fresh(utc_now() if actual_clock else now)
        outcome = 'download-complete-native-unadmitted'
    except BaseException as failure:
        error = {'type': type(failure).__name__, 'message': str(failure)[:512]}
    original = output / 'original.grib2'
    size = original.stat().st_size if original.is_file() and not original.is_symlink() else 0
    require(0 <= size <= CAP, 'preserved original exceeds cap')
    sha = hashlib.sha256(original.read_bytes()).hexdigest() if size else None
    record(ledger, outcome, size, sha)
    receipt = {'schema': 1, 'source': SOURCE, 'attempt': ATTEMPT, 'outcome': outcome, 'writtenOriginalBytes': size,
               'originalSha256': sha, 'error': error, 'nativeAdmitted': False, 'published': False,
               'full16MiBReservationRetained': True, 'partialOrUnknownNeverRetried': True}
    write_json(output / 'result.json', receipt)
    return receipt


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_download':
        download_child(Path(sys.argv[2])); return
    parser = argparse.ArgumentParser()
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--catalogue', type=Path, required=True)
    parser.add_argument('--ticket', type=Path, required=True)
    parser.add_argument('--h000-proof', type=Path, required=True)
    args = parser.parse_args()
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'exact first GitHub attempt required')
    require(args.catalogue.is_file() and not args.catalogue.is_symlink()
            and args.catalogue.stat().st_size <= 4 * 1024**2, 'catalogue original byte cap')
    catalogue = args.catalogue.read_bytes()
    require(args.h000_proof.is_file() and not args.h000_proof.is_symlink()
            and args.h000_proof.stat().st_size == H000_PROOF_BYTES, 'actual retained h000 proof path/size')
    result = capture(args.ledger, args.output, catalogue, bounded_json(args.ticket, 16384),
                     h000_proof=args.h000_proof.read_bytes())
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result['outcome'] == 'download-complete-native-unadmitted' else 1)


if __name__ == '__main__':
    main()
