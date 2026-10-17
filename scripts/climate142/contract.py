"""Fixed hourly ERA5 climate contract. No credentials or acquisition on import."""
from __future__ import annotations
import calendar
import hashlib
import json
from datetime import datetime, timezone

FIRST, LAST = 1991, 2020
DATASET = 'reanalysis-era5-complete'
METHOD = 'hourly-uv-swh-mwd-v1'
CELL_COUNT = 181 * 360
ORIGINAL_LIMIT = 2 * 1024**3
TRANSFER_LIMIT = 280 * 1024**3
STATE_LIMIT = 8 * 1024**3
TILE_LIMIT = 524288
KINDS = {'wind': (165, 166), 'wave': (140229, 140230)}
WIND_BINS = (0, 5, 10, 15, 20, 25, 34, 48)
WAVE_BINS = (0, .5, 1, 2, 3, 4, 6, 9)


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def month_hours(year: int, month: int) -> int:
    if type(year) is not int or not FIRST <= year <= LAST or type(month) is not int or not 1 <= month <= 12:
        raise ValueError('Unreviewed climate period')
    return calendar.monthrange(year, month)[1] * 24


def request(year: int, month: int, kind: str) -> dict:
    month_hours(year, month)
    if kind not in KINDS:
        raise ValueError('Unreviewed climate variable')
    return {'class': 'ea', 'date': f'{year}-{month:02d}-01/to/{year}-{month:02d}-{calendar.monthrange(year, month)[1]}',
            'expver': '1', 'levtype': 'sfc', 'param': '/'.join(map(str, KINDS[kind])),
            'stream': 'oper' if kind == 'wind' else 'wave', 'time': '00/to/23/by/1',
            'type': 'an', 'grid': '1.0/1.0', 'format': 'grib'}


def original_id(year: int, month: int, kind: str) -> str:
    request(year, month, kind)
    return f'{year}-{month:02d}-{kind}'


def plan() -> dict:
    return {'schema': 1, 'dataset': DATASET, 'method': METHOD, 'licence': 'CC-BY-4.0',
            'firstYear': FIRST, 'lastYear': LAST, 'gridDegrees': 1,
            'originalLimit': ORIGINAL_LIMIT, 'transferLimit': TRANSFER_LIMIT,
            'requests': [{'id': original_id(y, m, k), 'year': y, 'month': m, 'kind': k, 'request': request(y, m, k)}
                         for y in range(FIRST, LAST + 1) for m in range(1, 13) for k in KINDS]}


PLAN_SHA = sha(canonical(plan()))


def cell_key(index: int) -> str:
    if type(index) is not int or not 0 <= index < CELL_COUNT:
        raise ValueError('Climate cell index')
    lat, lon = 90 - index // 360, index % 360
    return f'{lat},{lon if lon < 180 else lon - 360}'


def tile_key(key: str) -> str:
    lat, lon = map(int, key.split(','))
    if not -90 <= lat <= 90 or not -180 <= lon < 180 or key != f'{lat},{lon}':
        raise ValueError('Climate cell identity')
    return f'{(lat + 90) // 5}_{(lon + 180) // 5}'


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
