"""One original -> hourly monthly distributions, inside a reviewed Linux unit.

No GRIB/native module is imported until actual kernel admission. Production
native fixtures and a hash-locked runtime are still required before execution.
"""
from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta, timezone
import bisect
import hashlib
import json
import math
import os
import sqlite3
import sys
from contract import CELL_COUNT, KINDS, ORIGINAL_LIMIT, WIND_BINS, WAVE_BINS, cell_key, month_hours


def require_linux_bounds() -> None:
    if sys.platform != 'linux':
        raise RuntimeError('Native climate decoding needs admitted Linux cgroup')
    import resource
    thread_keys = {'OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'}
    if any(os.environ.get(key) != '1' for key in thread_keys):
        raise RuntimeError('Native thread caps missing')
    env = set(os.environ) - {'PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'PYTHONNOUSERSITE'} - thread_keys
    if env:
        raise RuntimeError('Unreviewed native environment')
    status = Path('/proc/self/status').read_text()
    if 'NoNewPrivs:\t1' not in status or not any(line.split()[1] == '0000000000000000' for line in status.splitlines() if line.startswith('CapEff:')):
        raise RuntimeError('Native privilege boundary missing')
    groups = Path('/proc/self/cgroup').read_text().splitlines()
    rel = next((line[3:] for line in groups if line.startswith('0::')), None)
    if not rel or '..' in rel.split('/'):
        raise RuntimeError('Native cgroup missing')
    cg = Path('/sys/fs/cgroup') / rel.lstrip('/')
    bounded = lambda name, cap: (lambda n: n.isdigit() and 0 < int(n) <= cap)((cg / name).read_text().strip())
    if not bounded('memory.max', 2 * 1024**3) or (cg / 'memory.swap.max').read_text().strip() != '0' or not bounded('pids.max', 16):
        raise RuntimeError('Native memory/task bounds missing')
    quota, period = (cg / 'cpu.max').read_text().split()
    if not quota.isdigit() or int(quota) / int(period) > .5:
        raise RuntimeError('Native CPU quota missing')
    for kind, cap in ((resource.RLIMIT_CPU, 3600), (resource.RLIMIT_FSIZE, 2 * 1024**3)):
        low, high = resource.getrlimit(kind)
        if min(low, high) < 0 or max(low, high) > cap:
            raise RuntimeError('Native kernel limits missing')
    # This check precedes opening any original/spool. No publisher credential FD.
    if any(int(p.name) > 2 for p in Path('/proc/self/fd').iterdir() if p.exists()):
        raise RuntimeError('Unexpected inherited descriptor')


def validate_header(header: dict, year: int, month: int, kind: str) -> tuple[int, int]:
    month_hours(year, month)
    if kind not in KINDS or header.get('paramId') not in KINDS[kind]:
        raise ValueError('Unexpected GRIB parameter')
    fixed = {'gridType': 'regular_ll', 'Ni': 360, 'Nj': 181, 'numberOfPoints': CELL_COUNT,
             'latitudeOfFirstGridPointInDegrees': 90, 'latitudeOfLastGridPointInDegrees': -90,
             'longitudeOfFirstGridPointInDegrees': 0, 'longitudeOfLastGridPointInDegrees': 359,
             'iDirectionIncrementInDegrees': 1, 'jDirectionIncrementInDegrees': 1,
             'iScansNegatively': 0, 'jScansPositively': 0, 'jPointsAreConsecutive': 0,
             'alternativeRowScanning': 0, 'dataType': 'an', 'step': 0,
             'marsClass': 'ea', 'marsStream': 'oper' if kind == 'wind' else 'wave', 'experimentVersionNumber': '0001'}
    if any(header.get(key) != value for key, value in fixed.items()):
        raise ValueError('Unreviewed GRIB grid/scanning/analysis')
    units = {165: 'm s**-1', 166: 'm s**-1', 140229: 'm', 140230: 'Degree true'}
    if header.get('units') != units[header['paramId']]:
        raise ValueError('Unreviewed GRIB units')
    date, hour = header.get('dataDate'), header.get('dataTime')
    if type(date) is not int or type(hour) is not int or hour % 100 or not 0 <= hour <= 2300:
        raise ValueError('Invalid GRIB original clock')
    instant = datetime.strptime(f'{date:08d}{hour:04d}', '%Y%m%d%H%M').replace(tzinfo=timezone.utc)
    if instant.year != year or instant.month != month or header.get('validityDate') != date or header.get('validityTime') != hour:
        raise ValueError('GRIB clock does not match requested month')
    return int(instant.timestamp()), header['paramId']


def observation(kind: str, first: float, second: float):
    """Pure one-cell fixture seam; from-bearing is never a motion-to bearing."""
    if not all(math.isfinite(v) for v in (first, second)):
        return None
    if kind == 'wind':
        if abs(first) > 130 or abs(second) > 130:
            raise ValueError('Wind outside decoder bound')
        magnitude = math.hypot(first, second) * 1.9438444924406
        bearing, bins, calm, threshold = math.degrees(math.atan2(-first, -second)) % 360, WIND_BINS, 1, 34
    elif kind == 'wave':
        if not 0 <= first <= 60 or not 0 <= second <= 360:
            raise ValueError('Wave outside decoder bound')
        magnitude, bearing, bins, calm, threshold = first, second % 360, WAVE_BINS, .1, 3
    else:
        raise ValueError('Climate kind')
    return {'calm': magnitude < calm, 'exceeds': magnitude >= threshold,
            'bin': int((bearing + 11.25) // 22.5) % 16 * 8 + bisect.bisect_right(bins, magnitude) - 1}


def decode_original(original: Path, expected_sha: str, year: int, month: int, kind: str, output: Path, spool: Path) -> None:
    require_linux_bounds()
    # Deliberately after guard: these load native libraries.
    import numpy as np
    import eccodes as ec
    import zlib
    if original.is_symlink() or not original.is_file() or not 0 < original.stat().st_size <= ORIGINAL_LIMIT or output.exists() or spool.exists() or output.is_symlink() or spool.is_symlink():
        raise ValueError('Original/output identity')
    stable = lambda p: (p.stat().st_dev, p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns)
    before = stable(original)
    digest = hashlib.sha256()
    with original.open('rb') as body:
        for chunk in iter(lambda: body.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        raise ValueError('Original GRIB checksum')
    hours = month_hours(year, month)
    db = sqlite3.connect(spool)
    try:
        db.execute('PRAGMA journal_mode=DELETE')
        if db.execute('PRAGMA max_page_count=262144').fetchone()[0] > 262144:
            raise ValueError('Spool existing page budget')
        if db.execute('PRAGMA page_size').fetchone()[0] != 4096:
            raise ValueError('Spool page budget')
        db.execute('CREATE TABLE fields(time INTEGER,param INTEGER,body BLOB,PRIMARY KEY(time,param))')
        keys = ['gridType', 'Ni', 'Nj', 'numberOfPoints', 'latitudeOfFirstGridPointInDegrees', 'latitudeOfLastGridPointInDegrees',
                'longitudeOfFirstGridPointInDegrees', 'longitudeOfLastGridPointInDegrees', 'iDirectionIncrementInDegrees',
                'jDirectionIncrementInDegrees', 'iScansNegatively', 'jScansPositively', 'jPointsAreConsecutive',
                'alternativeRowScanning', 'dataType', 'step', 'units', 'paramId', 'dataDate', 'dataTime', 'validityDate', 'validityTime', 'marsClass', 'marsStream', 'experimentVersionNumber']
        messages = 0
        with original.open('rb') as body:
            while (gid := ec.codes_grib_new_from_file(body)) is not None:
                try:
                    messages += 1
                    if messages > hours * 2:
                        raise ValueError('Extra GRIB message')
                    time, param = validate_header({key: ec.codes_get(gid, key) for key in keys}, year, month, kind)
                    values = np.asarray(ec.codes_get_array(gid, 'values'), dtype='<f4')
                    if values.shape != (CELL_COUNT,):
                        raise ValueError('GRIB value plane bound')
                    if ec.codes_get(gid, 'bitmapPresent'):
                        bitmap = ec.codes_get_array(gid, 'bitmap')
                        if len(bitmap) != CELL_COUNT:
                            raise ValueError('GRIB bitmap bound')
                        masked = np.asarray(bitmap) == 0
                        if np.any(~np.isfinite(values[~masked])):
                            raise ValueError('Nonfinite original value outside missing bitmap')
                        values[masked] = np.nan
                    elif np.any(~np.isfinite(values)):
                        raise ValueError('Nonfinite original value without missing bitmap')
                    db.execute('INSERT INTO fields VALUES(?,?,?)', (time, param, zlib.compress(values.tobytes(), 1)))
                finally:
                    ec.codes_release(gid)
        if messages != hours * 2 or stable(original) != before:
            raise ValueError('Incomplete/replaced GRIB original')
        db.commit()
        histogram = np.zeros((CELL_COUNT, 128), dtype=np.uint32)
        counts, calm, exceeds = (np.zeros(CELL_COUNT, dtype=np.uint32) for _ in range(3))
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        for hour in range(hours):
            time = int((start + timedelta(hours=hour)).timestamp())
            rows = db.execute('SELECT param,body FROM fields WHERE time=? ORDER BY param', (time,)).fetchall()
            if [row[0] for row in rows] != list(KINDS[kind]):
                raise ValueError('Unpaired original hourly fields')
            arrays = []
            for _, blob in rows:
                decoder = zlib.decompressobj()
                plane = decoder.decompress(blob, CELL_COUNT * 4 + 1)
                if len(plane) != CELL_COUNT * 4 or not decoder.eof or decoder.unused_data:
                    raise ValueError('Bounded spool plane')
                arrays.append(np.frombuffer(plane, dtype='<f4'))
            a, b = arrays
            valid = np.isfinite(a) & np.isfinite(b)
            # True from-bearing is undefined at the exact poles: keep these
            # cells missing, rather than certify an arbitrary directional rose.
            valid[:360] = False
            valid[-360:] = False
            if kind == 'wind':
                if np.any(valid & ((np.abs(a) > 130) | (np.abs(b) > 130))):
                    raise ValueError('Original wind value bound')
                magnitude = np.hypot(a, b) * 1.9438444924406
                bearing = np.degrees(np.arctan2(-a, -b)) % 360
                bins, minimum, threshold = WIND_BINS, 1, 34
            else:
                if np.any(valid & ((a < 0) | (a > 60) | (b < 0) | (b > 360))):
                    raise ValueError('Original wave value bound')
                magnitude, bearing = a, b % 360
                bins, minimum, threshold = WAVE_BINS, .1, 3
            counts += valid
            calm += valid & (magnitude < minimum)
            exceeds += valid & (magnitude >= threshold)
            use = np.flatnonzero(valid & (magnitude >= minimum))
            direction = ((bearing[use] + 11.25) // 22.5).astype(np.int32) % 16
            index = direction * 8 + np.searchsorted(bins, magnitude[use], side='right') - 1
            histogram[use, index] += 1
        with output.open('x', encoding='utf-8', newline='\n') as out:
            for i in range(CELL_COUNT):
                row = {'key': cell_key(i), 'year': year, 'month': month, 'kind': kind,
                       'count': int(counts[i]), 'calm': int(calm[i]), 'exceeds': int(exceeds[i]),
                       'rose': histogram[i].tolist(), 'originalSha256': expected_sha}
                out.write(json.dumps(row, separators=(',', ':')) + '\n')
            out.flush()
            os.fsync(out.fileno())
    finally:
        db.close()
