#!/usr/bin/env python3
"""Reviewed LINZ coastal patches only. Default is a no-op; no publishing code."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import re
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from build_au250 import BudgetWriter, workspace_size
from regional_plan import tile_range
from regional_sources import NoRedirect, source_hash

ROOT = Path('/srv/weather/thalassa-relief135-nz-build')
RETAINED = Path('/srv/weather/thalassa-relief135-nz-proof/AU26.tiff')
PLAN_SHA = '80031d2dddcdc54e2fbf2d2bd93492cd83278f7abad547355e0ae0c232069f16'
IMAGE = 'sha256:57b20fcd82df868582b1a024f7b00f181e0614950b7a7046b02a5d5cd3c2bb2e'
INPUT_CAP, OUTPUT_CAP, WORKSPACE_CAP = 5_000_000_000, 2_000_000_000, 10_000_000_000
ROI_CAP, INPUTS_PER_WINDOW = 256_000_000, 8
HOST = 'https://nz-coastal.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'


def check_deadline(deadline):
    if time.time() >= deadline:
        raise TimeoutError('Reviewed two-hour invocation deadline reached')


def load_plan(path):
    if path.stat().st_size > 262144 or source_hash(path) != PLAN_SHA:
        raise ValueError('Reviewed NZ61 plan changed')
    plan = json.loads(path.read_text())
    rows = plan['sources']
    if (len(rows) != 61 or sum(row['bytes'] for row in rows) != 4_111_183_760
            or len({row['id'] for row in rows}) != 61):
        raise ValueError('Reviewed NZ input inventory changed')
    for row in rows:
        if (not re.fullmatch(r'[A-Z]{2}\d{2}', row['id'])
                or row['url'] != HOST + row['id'] + '.tiff'
                or not re.fullmatch(r'[0-9a-f]{64}', row['sha256'])
                or not 0 < row['bytes'] <= INPUT_CAP):
            raise ValueError('Unreviewed NZ source identity')
        tile_range(row['bbox'], 8)
    return plan


def collection_identity(plan):
    # Preserve actual provider issuance, never substitute execution time or a title.
    matched = re.search(r'collection updated (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$', plan['dataset'])
    if not matched:
        raise ValueError('Pinned LINZ collection has no actual UTC issuance timestamp')
    stamp = matched.group(1)
    dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return {'sourceCollectionUpdated': stamp, 'sourceCollectionUrl': plan['collectionUrl'],
            'sourceCollectionSha256': plan['collectionSha256']}


def verify_file(path, row):
    if path.is_symlink() or path.stat().st_size != row['bytes'] or source_hash(path) != row['sha256']:
        raise ValueError('Retained LINZ source differs from pinned inventory')


def reserve(root):
    if workspace_size(root) > WORKSPACE_CAP:
        raise ValueError('NZ workspace byte cap exceeded')
    if os.statvfs(root).f_bavail * os.statvfs(root).f_frsize < 20_000_000_000:
        raise ValueError('Keep 20 GB free on the weather volume')


def acquire_one(row, root, deadline, stopped=None):
    if stopped and stopped.is_set():
        raise ValueError('Another pinned source failed; stop further acquisition')
    path = RETAINED if row['id'] == 'AU26' else root / 'sources' / (row['id'] + '.tiff')
    if path.exists():
        verify_file(path, row)
        return {'id': row['id'], 'path': str(path), 'bytes': row['bytes'], 'sha256': row['sha256'], 'retained': True}
    if row['id'] == 'AU26':
        raise ValueError('Previously verified AU26 must be reused, never refetched')
    check_deadline(deadline)
    temporary = path.with_suffix('.tiff.partial')
    # Deliberately preserve incomplete downloads; never continue an unidentified body.
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(row['url'], timeout=30) as response:
        if (response.status != 200 or response.url != row['url']
                or response.headers.get('Content-Length') != str(row['bytes'])
                or response.headers.get('Content-Encoding') not in (None, 'identity')):
            raise ValueError('LINZ response identity or length changed')
        size, digest = 0, hashlib.sha256()
        with temporary.open('xb') as output:
            while True:
                check_deadline(deadline)
                if stopped and stopped.is_set():
                    raise ValueError('Another pinned source failed; retain this partial body')
                data = response.read(min(1024 * 1024, row['bytes'] - size + 1))
                if not data:
                    break
                size += len(data)
                if size > row['bytes']:
                    raise ValueError('LINZ body exceeds its exact pinned size')
                output.write(data)
                digest.update(data)
    if size != row['bytes'] or digest.hexdigest() != row['sha256']:
        raise ValueError('LINZ source checksum or exact length mismatch')
    temporary.rename(path)
    return {'id': row['id'], 'path': str(path), 'bytes': size, 'sha256': digest.hexdigest(), 'retained': False}


def rows_for_tiles(tiles):
    """Canonical [z,y,xFirst,xLast] runs; exact emitted tiles, no rectangles over holes."""
    result = []
    for z, y, x in sorted({tuple(tile) for tile in tiles}):
        if result and result[-1][0:2] == [z, y] and result[-1][3] + 1 == x:
            result[-1][3] = x
        else:
            result.append([z, y, x, x])
    return result


def candidate_blocks(rows):
    blocks = set()
    for z in range(8, 15):
        for row in rows:
            x0, y0, x1, y1 = tile_range(row['bbox'], z)
            for y in range(y0 // 2 * 2, y1 + 1, 2):
                for x in range(x0 // 2 * 2, x1 + 1, 2):
                    blocks.add((z, y, x))
    return sorted(blocks)


def checked_window(gt, width, height, corners, bytes_per_pixel=4):
    if gt[2] or gt[4] or gt[1] <= 0 or gt[5] >= 0:
        raise ValueError('Rotated or inverted LINZ grid is unsupported')
    x0 = max(0, math.floor((min(p[0] for p in corners) - gt[0]) / gt[1]) - 4)
    y0 = max(0, math.floor((max(p[1] for p in corners) - gt[3]) / gt[5]) - 4)
    x1 = min(width, math.ceil((max(p[0] for p in corners) - gt[0]) / gt[1]) + 4)
    y1 = min(height, math.ceil((min(p[1] for p in corners) - gt[3]) / gt[5]) + 4)
    w, h = max(0, x1 - x0), max(0, y1 - y0)
    if w * h * bytes_per_pixel > ROI_CAP:
        raise ValueError('Decoded regional ROI exceeds 256 MB')
    return x0, y0, w, h


def run(plan_path):
    import fcntl
    plan = load_plan(plan_path)
    if ROOT.resolve() != ROOT or os.name != 'posix':
        raise ValueError('Use the exact reviewed weather-volume workspace')
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = (ROOT / 'invocation.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    reserve(ROOT)
    deadline = time.time() + 7200
    (ROOT / 'sources').mkdir(exist_ok=True)
    if sum(row['bytes'] for row in plan['sources']) > INPUT_CAP:
        raise ValueError('NZ input byte cap exceeded')
    stopped = threading.Event()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(acquire_one, row, ROOT, deadline, stopped) for row in plan['sources']]
        try:
            receipts = [future.result() for future in concurrent.futures.as_completed(futures)]
            receipts.sort(key=lambda row: row['id'])
        except BaseException:
            stopped.set()
            for future in futures:
                future.cancel()
            raise
    reserve(ROOT)
    BudgetWriter(ROOT, WORKSPACE_CAP, workspace_size(ROOT)).write(
        ROOT / 'acquisition.json', json.dumps({'planSha256': PLAN_SHA, 'sources': receipts}, sort_keys=True).encode())
    remaining = deadline - time.time()
    if remaining <= 0:
        raise TimeoutError('NZ acquisition exhausted the reviewed invocation')
    source_dir = Path(__file__).resolve().parent
    command = ['sudo', '-n', 'docker', 'run', '--rm', '--name', 'thalassa-relief135-nz61-build', '--network', 'none',
               '--cpus', '1', '--memory', '1g', '--pids-limit', '64', '--read-only', '--tmpfs', '/tmp:rw,size=64m',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'PROJ_NETWORK=OFF',
               '-e', 'OPENBLAS_NUM_THREADS=1', '-e', 'OMP_NUM_THREADS=1', '-u', f'{os.getuid()}:{os.getgid()}',
               '-v', f'{ROOT}:{ROOT}', '-v', f'{RETAINED.parent}:{RETAINED.parent}:ro',
               '-v', '/srv/relief:/srv/relief:ro', '-v', f'{source_dir}:/tools:ro', '-w', '/tools', IMAGE,
               'python3', 'nz_coastal.py', '--build', '--deadline', str(deadline), '--plan', str(plan_path)]
    try:
        subprocess.run(command, check=True, timeout=remaining)
    except subprocess.TimeoutExpired:
        subprocess.run(['sudo', '-n', 'docker', 'stop', '--time', '10', 'thalassa-relief135-nz61-build'], check=False, timeout=20)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--deadline', type=float)
    args = parser.parse_args()
    plan = load_plan(args.plan)
    if args.run and args.build:
        raise ValueError('Choose one explicit execution phase')
    if args.run:
        run(args.plan)
    elif args.build:
        if not args.deadline or args.deadline > time.time() + 7200:
            raise ValueError('A bounded parent invocation deadline is required')
        from nz_render import build
        build(plan, args.deadline)
    else:
        print(json.dumps({'noOp': True, 'sources': len(plan['sources']), 'inputBytes': plan['exactInputBytes'],
                          'outputBytesCap': OUTPUT_CAP, 'workspaceBytesCap': WORKSPACE_CAP,
                          'deadlineSeconds': 7200, 'blocks': len(candidate_blocks(plan['sources'])),
                          'published': False}, indent=2))


if __name__ == '__main__':
    main()
