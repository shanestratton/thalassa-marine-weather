"""Durable one-at-a-time reservations. The live CDS transport is not admitted.

The injected transport must submit exactly the fixed request and yield original
bytes once. No default SDK (whose retries/queue/download hosts need admission)
is constructed. An incomplete reservation holds; it never silently retries.
"""
from __future__ import annotations
from pathlib import Path
import hashlib
import os
import json
import re
import sqlite3
from datetime import datetime, timezone
from contract import canonical, DATASET, PLAN_SHA, ORIGINAL_LIMIT, TRANSFER_LIMIT, STATE_LIMIT, original_id, request, utc_now


class ClimateLedger:
    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        if directory.is_symlink():
            raise ValueError('Climate state symlink')
        db_path = directory / 'ledger.sqlite'
        existed = db_path.exists()
        if not existed and any(directory.iterdir()):
            raise ValueError('Orphan climate state')
        if db_path.is_symlink():
            raise ValueError('Climate ledger symlink')
        self.db = sqlite3.connect(db_path, timeout=1, isolation_level=None)
        try:
            self._initialize(existed)
        except BaseException:
            self.db.close()
            raise

    def _initialize(self, existed):
        directory = self.directory
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), plan TEXT NOT NULL);'
                             'CREATE TABLE IF NOT EXISTS originals (id TEXT PRIMARY KEY, year INTEGER, month INTEGER, kind TEXT, state TEXT NOT NULL, charged INTEGER NOT NULL, bytes INTEGER, sha TEXT, request_sha TEXT NOT NULL, received_at TEXT);')
        row = self.db.execute('SELECT plan FROM meta WHERE id=1').fetchone()
        if row is None:
            if existed:
                raise ValueError('Missing recorded climate plan identity')
            if self.db.execute('SELECT count(*) FROM originals').fetchone()[0]:
                raise ValueError('Missing climate plan identity')
            self.db.execute('INSERT INTO meta VALUES(1,?)', (PLAN_SHA,))
        elif row[0] != PLAN_SHA:
            raise ValueError('Climate plan changed')
        expected = {row[0] + '.grib' for row in self.db.execute('SELECT id FROM originals')}
        allowed = {'ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'} | expected
        if any(p.name not in allowed for p in directory.iterdir()):
            raise ValueError('Unowned climate state file')
        charged_total = 0
        for name, year, month, kind, state, charged, size, digest, request_sha, received_at in self.db.execute('SELECT * FROM originals'):
            if name != original_id(year, month, kind) or request_sha != hashlib.sha256(canonical(request(year, month, kind))).hexdigest():
                raise ValueError('Recorded original request changed')
            charged_total += charged
            body = directory / (name + '.grib')
            if body.is_symlink():
                raise ValueError('Recorded original is a symlink')
            if state == 'reserved':
                if charged != ORIGINAL_LIMIT or size is not None or digest is not None or received_at is not None or (body.exists() and body.stat().st_size > ORIGINAL_LIMIT):
                    raise ValueError('Recorded reservation changed')
                continue
            if state not in ('downloaded', 'retired') or body.is_symlink() or type(size) is not int or not 0 < size <= ORIGINAL_LIMIT or charged != size or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest) or not isinstance(received_at, str) or not received_at.endswith('Z'):
                raise ValueError('Recorded climate original invalid or retirement incomplete')
            clock = datetime.fromisoformat(received_at.replace('Z', '+00:00'))
            if clock.tzinfo != timezone.utc or clock.year < 2021 or clock.timestamp() > datetime.now(timezone.utc).timestamp() + 60:
                raise ValueError('Recorded original receipt clock')
            if (state == 'downloaded' and (not body.is_file() or body.stat().st_size != size)) or (state == 'retired' and body.exists()):
                raise ValueError('Recorded climate original missing or invalid')
        if charged_total > TRANSFER_LIMIT:
            raise ValueError('Recorded transfer budget exceeded')

    def reserve(self, year: int, month: int, kind: str) -> str:
        name = original_id(year, month, kind)
        raw_path = self.directory / (name + '.grib')
        if raw_path.exists() or raw_path.is_symlink():
            raise ValueError('Existing original cannot be replaced')
        if sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file()) + ORIGINAL_LIMIT > STATE_LIMIT:
            raise ValueError('Climate staging capacity unavailable')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.db.execute('SELECT 1 FROM originals WHERE state IN ("reserved","retiring")').fetchone():
                raise ValueError('Prior incomplete reservation requires review')
            charged = self.db.execute('SELECT coalesce(sum(charged),0) FROM originals').fetchone()[0]
            if charged + ORIGINAL_LIMIT > TRANSFER_LIMIT:
                raise ValueError('Climate transfer budget exhausted')
            self.db.execute('INSERT INTO originals VALUES(?,?,?,?,?,?,?,?,?,?)',
                            (name, year, month, kind, 'reserved', ORIGINAL_LIMIT, None, None, hashlib.sha256(canonical(request(year, month, kind))).hexdigest(), None))
            self.db.execute('COMMIT')  # Durable BEFORE invoking transport or creating body.
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        return name

    def acquire(self, year: int, month: int, kind: str, transport) -> dict:
        name = self.reserve(year, month, kind)
        digest, size = hashlib.sha256(), 0
        path = self.directory / (name + '.grib')
        # A transport exception/body interruption leaves a charged reservation.
        with path.open('xb') as out:
            for chunk in transport(DATASET, request(year, month, kind)):
                if not isinstance(chunk, bytes) or len(chunk) > 1024 * 1024:
                    raise ValueError('Climate transport chunk bound')
                size += len(chunk)
                if size > ORIGINAL_LIMIT:
                    raise ValueError('Climate original byte limit')
                out.write(chunk)
                digest.update(chunk)
            out.flush()
            os.fsync(out.fileno())
        if not size:
            raise ValueError('Empty climate original')
        with path.open('rb') as body:
            if body.read(4) != b'GRIB':
                raise ValueError('Climate original is not GRIB')
        received_at = utc_now()
        self._sync_directory()
        self.db.execute('UPDATE originals SET state="downloaded",charged=?,bytes=?,sha=?,received_at=? WHERE id=? AND state="reserved"',
                        (size, size, digest.hexdigest(), received_at, name))
        return self.read_receipt(name)

    def read_receipt(self, name: str) -> dict:
        row = self.db.execute('SELECT year,month,kind,bytes,sha,request_sha,received_at,state FROM originals WHERE id=?', (name,)).fetchone()
        if not row or row[-1] not in ('downloaded', 'retired'):
            raise ValueError('No completed original receipt')
        year, month, kind, size, digest, request_sha, received_at, _ = row
        return {'id': name, 'path': str(self.directory / (name + '.grib')), 'year': year, 'month': month, 'kind': kind, 'bytes': size, 'sha256': digest, 'planSha256': PLAN_SHA, 'requestSha256': request_sha, 'receivedAt': received_at}

    def retire_original(self, name: str, accumulator_path: Path, *, managed_retention=False):
        if not managed_retention:
            raise ValueError('Climate managed retention is not admitted')
        receipt = self.read_receipt(name)
        if accumulator_path.is_symlink() or not accumulator_path.is_file():
            raise ValueError('Retained accumulator missing')
        retained = sqlite3.connect(accumulator_path.resolve().as_uri() + '?mode=ro', uri=True)
        try:
            identity = retained.execute('SELECT plan FROM meta WHERE id=1').fetchone()
            row = retained.execute('SELECT receipt FROM originals WHERE id=?', (name,)).fetchone()
            seal = json.loads(row[0]) if row else None
            if identity != (PLAN_SHA,) or not isinstance(seal, dict) or any(seal.get(key) != value for key, value in receipt.items() if key != 'path') or not re.fullmatch('[a-f0-9]{64}', seal.get('reductionSha256', '')):
                raise ValueError('Original has no exact durable aggregation seal')
        finally:
            retained.close()
        body = self.directory / (name + '.grib')
        if body.is_symlink() or not body.is_file() or body.stat().st_size != receipt['bytes']:
            raise ValueError('Retirement original changed')
        stable = lambda: (body.stat().st_dev, body.stat().st_ino, body.stat().st_size, body.stat().st_mtime_ns, body.stat().st_ctime_ns)
        before, digest = stable(), hashlib.sha256()
        with body.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != receipt['sha256'] or stable() != before:
            raise ValueError('Retirement original checksum changed')
        self.db.execute('UPDATE originals SET state="retiring" WHERE id=? AND state="downloaded"', (name,))
        if self.db.execute('SELECT changes()').fetchone()[0] != 1:
            raise ValueError('Original is not available for retirement')
        body.unlink()  # Exactly one verified recorded original; no recursive cleanup.
        self._sync_directory()
        self.db.execute('UPDATE originals SET state="retired" WHERE id=? AND state="retiring"', (name,))

    def _sync_directory(self):
        if os.name == 'posix':
            fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def close(self):
        self.db.close()
