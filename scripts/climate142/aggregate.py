"""Bounded on-disk monthly accumulation, exact replay seals and static tiles."""
from __future__ import annotations
from pathlib import Path
from array import array
import hashlib
import json
import sqlite3
import sys
from contract import CELL_COUNT, FIRST, LAST, KINDS, PLAN_SHA, DATASET, METHOD, TILE_LIMIT, canonical, cell_key, month_hours, original_id, request, sha, tile_key, utc_now


def checked_row(row: dict, year: int, month: int, kind: str, original_sha: str) -> None:
    expected = month_hours(year, month)
    if not isinstance(row, dict) or row.get('year') != year or row.get('month') != month or row.get('kind') != kind or row.get('originalSha256') != original_sha:
        raise ValueError('Monthly original association')
    for key in ('count', 'calm', 'exceeds'):
        if type(row.get(key)) is not int or not 0 <= row[key] <= expected:
            raise ValueError('Monthly count bound')
    rose = row.get('rose')
    if not isinstance(rose, list) or len(rose) != 128 or any(type(n) is not int or not 0 <= n <= expected for n in rose) or sum(rose) + row['calm'] != row['count']:
        raise ValueError('Monthly rose/count mismatch')
    threshold = 6 if kind == 'wind' else 4
    if sum(n for i, n in enumerate(rose) if i % 8 >= threshold) != row['exceeds']:
        raise ValueError('Monthly exceedance mismatch')
    tile_key(row.get('key', ''))


def packed(values: list[int]) -> bytes:
    data = array('I', values)
    if data.itemsize != 4:
        raise ValueError('uint32 representation')
    if sys.byteorder != 'little':
        data.byteswap()
    return data.tobytes()


def unpacked(data: bytes) -> list[int]:
    if len(data) != 512:
        raise ValueError('Stored climate plane size')
    result = array('I')
    result.frombytes(data)
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tolist()


class ClimateAccumulator:
    def __init__(self, path: Path):
        existed = path.exists()
        if path.is_symlink():
            raise ValueError('Accumulator symlink')
        self.db = sqlite3.connect(path, timeout=1)
        try:
            self._initialize(existed)
        except BaseException:
            self.db.close()
            raise

    def _initialize(self, existed):
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA journal_mode=DELETE')
        if self.db.execute('PRAGMA max_page_count=524288').fetchone()[0] > 524288:
            raise ValueError('Accumulator existing page budget')
        if self.db.execute('PRAGMA page_size').fetchone()[0] != 4096:
            raise ValueError('Accumulator page budget')
        self.db.executescript('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY,plan TEXT);'
                             'CREATE TABLE IF NOT EXISTS originals (id TEXT PRIMARY KEY,receipt TEXT NOT NULL);'
                             'CREATE TABLE IF NOT EXISTS climate (key TEXT,month INTEGER,kind TEXT,count INTEGER,calm INTEGER,exceeds INTEGER,years INTEGER,rose BLOB,PRIMARY KEY(key,month,kind));')
        identity = self.db.execute('SELECT plan FROM meta WHERE id=1').fetchone()
        if identity is None:
            if existed:
                raise ValueError('Missing accumulator identity')
            self.db.execute('INSERT INTO meta VALUES(1,?)', (PLAN_SHA,))
            self.db.commit()
        elif identity != (PLAN_SHA,):
            raise ValueError('Accumulator contract changed')

    def ingest(self, path: Path, receipt: dict) -> None:
        y, m, kind = receipt.get('year'), receipt.get('month'), receipt.get('kind')
        name = original_id(y, m, kind)
        digest = receipt.get('sha256')
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest) or receipt.get('requestSha256') != sha(canonical(request(y, m, kind))) or receipt.get('planSha256') != PLAN_SHA:
            raise ValueError('Unqualified original receipt')
        if self.db.execute('SELECT 1 FROM originals WHERE id=?', (name,)).fetchone():
            raise ValueError('Original already aggregated; replay held')
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024**2:
            raise ValueError('Monthly reduction bound')
        stable = lambda: (path.stat().st_dev, path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns, path.stat().st_ctime_ns)
        before, reduction_sha = stable(), hashlib.sha256()
        try:
            self.db.execute('BEGIN IMMEDIATE')
            with path.open('rb') as lines:
                for index in range(CELL_COUNT):
                    raw = lines.readline(4097)
                    if not raw.endswith(b'\n') or len(raw) > 4096:
                        raise ValueError('Monthly reduction line/missing cell')
                    reduction_sha.update(raw)
                    row = json.loads(raw)
                    checked_row(row, y, m, kind, digest)
                    if row['key'] != cell_key(index):
                        raise ValueError('Missing/duplicate/reordered climate cell')
                    previous = self.db.execute('SELECT count,calm,exceeds,years,rose FROM climate WHERE key=? AND month=? AND kind=?', (row['key'], m, kind)).fetchone()
                    count, calm, exceeds, years, rose = previous if previous else (0, 0, 0, 0, packed([0] * 128))
                    values = [a + b for a, b in zip(unpacked(rose), row['rose'])]
                    # The full-year bit is independent per variable/year/month.
                    bit = 1 << (y - FIRST) if row['count'] >= .9 * month_hours(y, m) else 0
                    self.db.execute('INSERT OR REPLACE INTO climate VALUES(?,?,?,?,?,?,?,?)', (row['key'], m, kind, count + row['count'], calm + row['calm'], exceeds + row['exceeds'], years | bit, packed(values)))
                if lines.read(1):
                    raise ValueError('Extra monthly climate cell')
            if stable() != before:
                raise ValueError('Monthly reduction replaced during aggregation')
            self.db.execute('INSERT INTO originals VALUES(?,?)', (name, canonical({**receipt, 'reductionSha256': reduction_sha.hexdigest()}).decode()))
            self.db.commit()  # The original seal and every count commit together.
        except BaseException:
            self.db.rollback()
            raise

    def export(self, destination: Path) -> dict:
        # Public seal contains fixed original identities/hashes, never private paths.
        receipts = {name: {key: value for key, value in json.loads(raw).items() if key != 'path'} for name, raw in self.db.execute('SELECT id,receipt FROM originals ORDER BY id')}
        expected = {original_id(y, m, k) for y in range(FIRST, LAST + 1) for m in range(1, 13) for k in KINDS}
        if receipts.keys() != expected:
            raise ValueError('All720 original seals required before publication')
        cohort_sha = sha(canonical(receipts))
        generation = sha(canonical({'plan': PLAN_SHA, 'cohort': cohort_sha}))
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        (destination / 'originals-seal.json').write_bytes(canonical({'schema': 1, 'planSha256': PLAN_SHA, 'originals': receipts}))
        # At most25 cells retained per tile, never the complete global geometry.
        tiles = {}
        for tile_y in range(37):
            for tile_x in range(72):
                key = f'{tile_y}_{tile_x}'
                cells = []
                for lat in range(max(-90, tile_y * 5 - 90), min(90, tile_y * 5 - 86) + 1):
                    for lon in range(tile_x * 5 - 180, tile_x * 5 - 175):
                        name, months = f'{lat},{lon}', []
                        for month in range(1, 13):
                            rows = {row[0]: row[1:] for row in self.db.execute('SELECT kind,count,calm,exceeds,years,rose FROM climate WHERE key=? AND month=?', (name, month))}
                            if set(rows) != set(KINDS):
                                raise ValueError('Missing retained climate cell')
                            wind, wave = rows['wind'], rows['wave']
                            months.append({'windCount': wind[0], 'waveCount': wave[0], 'windCalm': wind[1], 'waveCalm': wave[1], 'galeCount': wind[2], 'highWaveCount': wave[2], 'windYears': wind[3], 'waveYears': wave[3], 'windRose': unpacked(wind[4]), 'waveRose': unpacked(wave[4])})
                        cells.append({'key': name, 'months': months})
                if not cells:
                    continue
                data = canonical({'schema': 1, 'key': key, 'generation': generation, 'cells': cells})
                if len(cells) > 25 or len(data) > TILE_LIMIT:
                    raise ValueError('Public climate tile bound')
                (destination / f'tile-{key}.json').write_bytes(data)
                tiles[key] = {'bytes': len(data), 'sha256': sha(data)}
        manifest = {'schema': 1, 'kind': 'era5-climate', 'generation': generation, 'firstYear': FIRST, 'lastYear': LAST,
                    'gridDegrees': 1, 'originals': 720, 'dataset': DATASET, 'licence': 'CC-BY-4.0', 'method': METHOD,
                    'originalCohortSha256': cohort_sha, 'generatedAt': utc_now(), 'tiles': tiles}
        raw = canonical(manifest)
        if len(raw) > 524288:
            raise ValueError('Climate manifest byte limit')
        (destination / 'manifest.json').write_bytes(raw)
        pointer = {'schema': 1, 'generation': generation, 'manifest': {'bytes': len(raw), 'sha256': sha(raw)}}
        (destination / 'latest.json').write_bytes(canonical(pointer))
        return pointer

    def close(self):
        self.db.close()
