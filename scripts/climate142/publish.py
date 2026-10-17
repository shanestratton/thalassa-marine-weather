"""Publish only a complete sealed local packet; immutable children before pointer.

The injected store must restrict its credential to the existing weather bucket.
There is no CLI, live credential lookup or automatic publication on import.
"""
from pathlib import Path
import json
import re
from contract import canonical, sha, TILE_LIMIT, PLAN_SHA, DATASET, METHOD, FIRST, LAST, KINDS, original_id, request

PREFIX = 'climate/era5-v1/'


def bounded(path: Path, cap: int) -> bytes:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= cap:
        raise ValueError('Climate local file bound')
    with path.open('rb') as body:
        data = body.read(cap + 1)
    if len(data) > cap:
        raise ValueError('Climate local file grew')
    return data


def publish(packet: Path, store) -> dict:
    if packet.is_symlink():
        raise ValueError('Climate packet symlink')
    pointer_raw = bounded(packet / 'latest.json', 2048)
    pointer = json.loads(pointer_raw)
    generation = pointer.get('generation')
    if pointer.get('schema') != 1 or not isinstance(generation, str) or not re.fullmatch('[a-f0-9]{64}', generation):
        raise ValueError('Climate generation')
    raw = bounded(packet / 'manifest.json', 524288)
    if pointer.get('manifest') != {'bytes': len(raw), 'sha256': sha(raw)}:
        raise ValueError('Climate local manifest integrity')
    manifest = json.loads(raw)
    tiles = manifest.get('tiles')
    if manifest.get('schema') != 1 or manifest.get('kind') != 'era5-climate' or manifest.get('generation') != generation or manifest.get('originals') != 720 or manifest.get('firstYear') != FIRST or manifest.get('lastYear') != LAST or manifest.get('dataset') != DATASET or manifest.get('method') != METHOD or manifest.get('gridDegrees') != 1 or manifest.get('licence') != 'CC-BY-4.0' or not isinstance(tiles, dict) or not 0 < len(tiles) <= 2664:
        raise ValueError('Climate cohort incomplete')
    seal = json.loads(bounded(packet / 'originals-seal.json', 1048576))
    originals = seal.get('originals')
    expected_originals = {original_id(y, m, k): (y, m, k) for y in range(FIRST, LAST + 1) for m in range(1, 13) for k in KINDS}
    if seal.get('schema') != 1 or seal.get('planSha256') != PLAN_SHA or not isinstance(originals, dict) or originals.keys() != expected_originals.keys() or sha(canonical(originals)) != manifest.get('originalCohortSha256') or generation != sha(canonical({'plan': PLAN_SHA, 'cohort': sha(canonical(originals))})):
        raise ValueError('Climate original cohort seal')
    for name, (year, month, kind) in expected_originals.items():
        receipt = originals[name]
        if not isinstance(receipt, dict) or receipt.get('id') != name or receipt.get('year') != year or receipt.get('month') != month or receipt.get('kind') != kind or receipt.get('planSha256') != PLAN_SHA or receipt.get('requestSha256') != sha(canonical(request(year, month, kind))) or not isinstance(receipt.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', receipt['sha256']) or 'path' in receipt:
            raise ValueError('Climate original receipt identity')
    expected = {'manifest.json', 'latest.json', 'originals-seal.json'} | {f'tile-{key}.json' for key in tiles}
    if {p.name for p in packet.iterdir()} != expected or any(p.is_symlink() for p in packet.iterdir()):
        raise ValueError('Climate local packet ownership')
    # Validate every child before the first public write, one bounded tile at a time.
    for key, entry in tiles.items():
        if not re.fullmatch(r'(?:[0-9]|[12][0-9]|3[0-6])_(?:[0-9]|[1-6][0-9]|7[01])', key):
            raise ValueError('Climate tile path')
        data = bounded(packet / f'tile-{key}.json', TILE_LIMIT)
        if entry != {'bytes': len(data), 'sha256': sha(data)}:
            raise ValueError('Climate local child integrity')
    for key in tiles:
        data = bounded(packet / f'tile-{key}.json', TILE_LIMIT)
        if tiles[key] != {'bytes': len(data), 'sha256': sha(data)}:
            raise ValueError('Climate child changed during publication')
        target = PREFIX + generation + f'/tile-{key}.json'
        store.put_immutable(target, data)
        if store.read(target, TILE_LIMIT) != data:
            raise ValueError('Climate public child readback failed')
    target = PREFIX + generation + '/manifest.json'
    store.put_immutable(target, raw)
    if store.read(target, 524288) != raw:
        raise ValueError('Climate public manifest readback failed')
    store.put_pointer(PREFIX + 'latest.json', pointer_raw)
    if store.read(PREFIX + 'latest.json', 2048) != pointer_raw:
        raise ValueError('Climate public pointer readback failed')
    return {'generation': generation, 'children': len(tiles), 'manifestSha256': sha(raw), 'pointerSha256': sha(pointer_raw)}
