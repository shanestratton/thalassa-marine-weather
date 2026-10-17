"""Local original-grid qualified display tiles; zero network/publication.

49 local original SP1 packets plus the original constant-mask packet are required.
Finite upper RH is explicitly unavailable in the qualified display view. Original
GRIBs and grid locations remain intact; not every original numeric RH is retained.
Fresh output and per-file fsync/drop-advice bound dirty-page charge without global
kernel tuning. Actual filesystem/cgroup admission remains required before wx use.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import stat
import struct
import time
from pathlib import Path

from catalogue import DOMAINS, HOURS, MAX_COHORT_BYTES, MAX_PACKET_BYTES, require, digest, original_run, packet_url
from native import FIELDS, UNITS, RH_DISPLAY_POLICY, decode_packet

CORE, HALO = 32, 3
MAX_TILE_BYTES = 3 * 1024**2
MAX_MANIFEST_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 1024**3
MAX_NATIVE_TEMP_BYTES = 1200 * 1024**2
MAGIC = b'THAROME1'


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'), sort_keys=True).encode('utf-8')


def hash_value(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def read_source(path, expected_sha256, expected_bytes):
    require(hash_value(expected_sha256) and type(expected_bytes) is int
            and 20 <= expected_bytes <= MAX_PACKET_BYTES, 'source receipt byte/hash bound')
    raw = read_local(path, expected_bytes)
    require(len(raw) == expected_bytes and digest(raw) == expected_sha256, 'original source identity/hash mismatch')
    return raw


def read_local(path, max_bytes):
    require(type(max_bytes) is int and 1 <= max_bytes <= MAX_PACKET_BYTES, 'bounded local read required')
    path = Path(path)
    require(not path.is_symlink(), 'symlink source refused')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= max_bytes, 'source regular-file size mismatch')
        raw = stream.read(max_bytes + 1)
        after = os.fstat(stream.fileno())
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(before) == identity(after) and len(raw) == before.st_size and len(raw) <= max_bytes,
                'original source identity/hash mismatch')
    return raw


def write_fresh(path, raw):
    path = Path(path)
    with path.open('xb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
        if hasattr(os, 'posix_fadvise'):
            os.posix_fadvise(output.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def tile_shape(domain, x, y):
    require(domain in DOMAINS, 'unknown original tile domain')
    spec = DOMAINS[domain]
    require(type(x) is int and type(y) is int and 0 <= x < math.ceil(spec['width'] / CORE)
            and 0 <= y < math.ceil(spec['height'] / CORE), 'original tile index bound')
    i0, j0 = max(0, x * CORE - HALO), max(0, y * CORE - HALO)
    return {'id': f'{x}-{y}', 'i0': i0, 'j0': j0,
            'width': min(spec['width'], (x + 1) * CORE + HALO) - i0,
            'height': min(spec['height'], (y + 1) * CORE + HALO) - j0}


def build_tile(domain, run_utc, mask_sha256, native_proof_sha256, shape, mask_bytes, samples):
    """samples yields exactly5×49 bounded row-major f64 blocks in field/hour order."""
    require(hash_value(mask_sha256) and hash_value(native_proof_sha256), 'original tile proof hashes')
    cells = shape['width'] * shape['height']
    require(type(mask_bytes) is bytes and len(mask_bytes) == cells * 8, 'original mask tile cardinality')
    header = encoded({'schema': 1, 'model': DOMAINS[domain]['model'], 'runUtc': run_utc,
                      'maskSha256': mask_sha256, 'nativeProofSha256': native_proof_sha256,
                      **shape, 'hours': HOURS, 'fields': FIELDS, 'units': UNITS})
    require(len(header) <= 4096, 'original tile header bound')
    raw = bytearray(MAGIC + struct.pack('<I', len(header)) + header + mask_bytes)
    count = 0
    for block in samples:
        require(count < len(FIELDS) * HOURS and type(block) is bytes and len(block) == cells * 8,
                'original sample tile cardinality')
        raw.extend(block)
        count += 1
    require(count == len(FIELDS) * HOURS and len(raw) <= MAX_TILE_BYTES, 'original tile byte/member bound')
    raw = bytes(raw)
    packed = gzip.compress(raw, compresslevel=6, mtime=0)
    require(len(packed) <= MAX_TILE_BYTES, 'compressed original tile byte bound')
    return packed, {**shape, 'sha256': digest(packed), 'rawSha256': digest(raw),
                    'bytes': len(packed), 'rawBytes': len(raw)}


def read_rectangle(path, shape, full_width, field=0, full_cells=0):
    """Only the original contiguous row fragments, with no interpolation."""
    rows = []
    with Path(path).open('rb') as source:
        for row in range(shape['j0'], shape['j0'] + shape['height']):
            source.seek((field * full_cells + row * full_width + shape['i0']) * 8)
            block = source.read(shape['width'] * 8)
            require(len(block) == shape['width'] * 8, 'local original native fragment truncated')
            rows.append(block)
    return b''.join(rows)


def build_static(plan, sources, mask_source, out, clock=None):
    """A held local transform. Receipt inputs are verified, not invented HTTP clocks.

    Caller must first obtain actual source/native/resource admission; this function
    cannot acquire packets, upload an object, alter a current slot or install a job.
    """
    from datetime import datetime, timezone
    started = time.monotonic()
    def within_deadline():
        require(time.monotonic() - started <= 1200, 'original native cohort deadline')
    clock = clock or (lambda: datetime.now(timezone.utc))
    domain = plan.get('domain') if isinstance(plan, dict) else None
    require(domain in DOMAINS and plan.get('schema') == 1 and plan.get('model') == DOMAINS[domain]['model']
            and hash_value(plan.get('catalogueSha256')), 'unadmitted original plan')
    original_run(plan.get('runUtc'), domain, clock())
    spec, run_utc = DOMAINS[domain], plan['runUtc']
    require(plan.get('licence') == 'Etalab-2.0' and plan.get('resolutionDegrees') == .025
            and plan.get('bounds') == spec['bounds'] and plan.get('width') == spec['width']
            and plan.get('height') == spec['height'] and plan.get('grid') == spec['grid'], 'original plan grid/rights mismatch')
    require(isinstance(sources, list) and len(sources) == HOURS and isinstance(plan.get('packets'), list)
            and len(plan['packets']) == HOURS, 'local original cohort incomplete')
    total = 0
    for offset, source in enumerate(sources):
        packet = plan['packets'][offset]
        require(isinstance(source, dict) and isinstance(packet, dict) and packet.get('offsetHours') == offset
                and packet.get('url') == packet_url(domain, run_utc, offset) and source.get('offsetHours') == offset
                and source.get('url') == packet.get('url') and source.get('bytes') == packet.get('bytes')
                and hash_value(source.get('sha256')) and type(source.get('bytes')) is int
                and 20 <= source['bytes'] <= MAX_PACKET_BYTES, 'local source receipt mismatch')
        total += source['bytes']
    require(total <= MAX_COHORT_BYTES and isinstance(mask_source, dict)
            and mask_source.get('resource') == plan.get('constantResource'), 'original cohort/mask receipt bound')
    out = Path(out)
    require(out.parent.is_dir() and not out.exists() and not out.is_symlink(), 'fresh output required')
    native_bytes = spec['width'] * spec['height'] * 8 * (1 + HOURS * len(FIELDS))
    require(native_bytes <= MAX_NATIVE_TEMP_BYTES, 'original native scratch bound')
    out.mkdir(mode=0o700)
    scratch = out / '.native'
    scratch.mkdir()
    objects = out / 'tiles'
    objects.mkdir()
    mask_raw = read_source(mask_source['path'], mask_source.get('sha256'), mask_source.get('bytes'))
    mask, mask_facts = decode_packet(mask_raw, domain, mask_only=True)
    within_deadline()
    mask_path = scratch / 'mask.f64'
    write_fresh(mask_path, mask['mask'].tobytes(order='C'))
    del mask, mask_raw
    facts = []
    hours = []
    for offset, source in enumerate(sources):
        within_deadline()
        raw = read_source(source['path'], source['sha256'], source['bytes'])
        fields, metadata = decode_packet(raw, domain, run_utc, offset)
        path = scratch / f'hour-{offset:03}.f64'
        # At most5 full grids live. No49-hour ndarray/memmap or retained raw packets.
        with path.open('xb') as output:
            for field in FIELDS: output.write(fields[field].tobytes(order='C'))
            output.flush()
            os.fsync(output.fileno())
            if hasattr(os, 'posix_fadvise'): os.posix_fadvise(output.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
        facts.append({'offsetHours': offset, 'url': source['url'], 'sha256': source['sha256'], 'bytes': source['bytes'], 'fields': metadata})
        hours.append(path)
        del fields, metadata, raw
    rh_qa = [fact['fields']['rh2m']['displayQualification'] for fact in facts]
    upper_rh = sum(qa['upperDisplayUnavailableCells'] for qa in rh_qa)
    rh_available = sum(qa['displayAvailableCells'] for qa in rh_qa)
    rh_cells = sum(qa['sourceCells'] for qa in rh_qa)
    science = {name: digest(read_local(Path(__file__).with_name(name), 128 * 1024)) for name in
               ('native.py', 'static_tiles.py', 'catalogue.py', 'native-requirements.lock')}
    native_proof = encoded({'schema': 1, 'model': spec['model'], 'runUtc': run_utc, 'decoder': 'ecCodes',
                            'maskSha256': mask_source['sha256'], 'maskFields': mask_facts,
                            'packets': facts, 'allOriginalGridLocationsPreserved': True,
                            'originalSourceGribBytesModified': False, 'scientificFilesSha256': science,
                            'optionalDisplayQualification': {'policy': RH_DISPLAY_POLICY, 'field': 'rh2m',
                                'reason': 'upper-rh-outside-display-domain' if upper_rh else None,
                                'sourceCells': rh_cells, 'upperDisplayUnavailableCells': upper_rh,
                                'sourceMissingCells': sum(qa['sourceMissingCells'] for qa in rh_qa),
                                'sourceBitmapMissingCells': sum(qa['sourceBitmapMissingCells'] for qa in rh_qa),
                                'sourceUnmarkedMissingCells': sum(qa['sourceUnmarkedMissingCells'] for qa in rh_qa),
                                'displayAvailableCells': rh_available, 'displayMissingCells': rh_cells - rh_available,
                                'displayAvailability': 'complete' if rh_available == rh_cells
                                    else 'partial' if rh_available else 'unavailable',
                                'unchangedNumericFields': ['u10', 'v10', 'msl', 't2m'],
                                'upperValuesClamped': False, 'roundingNormalizationApplied': False},
                            'providerRequests': 0,
                            'published': False})
    native_proof_sha256 = digest(native_proof)
    require(len(native_proof) <= 1024**2, 'original native proof metadata bound')
    write_fresh(out / 'native-proof.json', native_proof)
    tiles = []
    output_bytes = 0
    full_cells = spec['width'] * spec['height']
    for y in range(math.ceil(spec['height'] / CORE)):
        for x in range(math.ceil(spec['width'] / CORE)):
            within_deadline()
            shape = tile_shape(domain, x, y)
            mask_fragment = read_rectangle(mask_path, shape, spec['width'])
            samples = (read_rectangle(path, shape, spec['width'], field, full_cells)
                       for field in range(len(FIELDS)) for path in hours)
            packed, tile = build_tile(domain, run_utc, mask_source['sha256'], native_proof_sha256,
                                      shape, mask_fragment, samples)
            output_bytes += len(packed)
            require(output_bytes <= MAX_OUTPUT_BYTES, 'original static cohort storage bound')
            write_fresh(objects / f"{tile['sha256']}.bin.gz", packed)
            tiles.append(tile)
    manifest = encoded({'schema': 1, 'model': spec['model'], 'runUtc': run_utc,
                        'provider': 'Météo-France', 'product': 'AROME-OM', 'licence': 'Etalab-2.0',
                        'width': spec['width'], 'height': spec['height'], 'bounds': spec['bounds'],
                        'stepDegrees': .025, 'hours': HOURS, 'fields': FIELDS, 'units': UNITS,
                        'encoding': 'gzip-f64le-v1', 'core': CORE, 'halo': HALO,
                        'maskSha256': mask_source['sha256'], 'nativeProofSha256': native_proof_sha256,
                        'catalogueSha256': plan['catalogueSha256'],
                        'packets': [{key: fact[key] for key in ('offsetHours', 'sha256', 'bytes')} for fact in facts],
                        'tiles': tiles})
    require(len(manifest) <= MAX_MANIFEST_BYTES, 'original manifest byte bound')
    within_deadline()
    # Freshness is checked again before creating the manifest/slot admission output.
    original_run(run_utc, domain, clock())
    write_fresh(out / 'manifest.json', manifest)
    slot = {'schema': 1, 'model': spec['model'], 'runUtc': run_utc,
            'manifestSha256': digest(manifest), 'manifestBytes': len(manifest)}
    write_fresh(out / 'prepared-slot.json', encoded(slot))
    # Only files we exclusively created are unlinked; input/source files stay intact.
    for path in [mask_path, *hours]: path.unlink()
    scratch.rmdir()
    return {'slot': slot, 'nativeProofSha256': native_proof_sha256, 'tileCount': len(tiles),
            'tileBytes': output_bytes, 'providerRequests': 0, 'published': False, 'installed': False}
