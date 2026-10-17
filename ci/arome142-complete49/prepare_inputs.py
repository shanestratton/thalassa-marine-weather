"""Root copy of exact bounded originals; no native decoder or network client."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from complete49 import H000_BYTES, H000_SHA, MASK_BYTES, MASK_SHA, MASK_RESOURCE, plan_from, utc_now

parser = argparse.ArgumentParser()
for name in ('capture', 'h000', 'mask', 'catalogue', 'out'):
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
assert os.getuid() == 0 and not args.out.exists()
assert args.capture.is_dir() and not args.capture.is_symlink()
receipt = json.loads((args.capture / 'sources.json').read_bytes())
result = json.loads((args.capture / 'result.json').read_bytes())
assert result['outcome'] == 'all48-captured-native-unadmitted' and result['completedNewOriginals'] == 48
plan = plan_from(args.catalogue.read_bytes(), utc_now())
assert receipt['schema'] == 1 and len(receipt['packets']) == 49
args.out.mkdir(mode=0o755)
rows = []
for offset, row in enumerate(receipt['packets']):
    expected = args.h000 if offset == 0 else args.capture / f'hour-{offset:03}/original.grib2'
    assert Path(row['path']).resolve() == expected.resolve() and not expected.is_symlink()
    assert row['offsetHours'] == offset and row['url'] == plan['packets'][offset]['url']
    assert type(row['bytes']) is int and row['bytes'] == plan['packets'][offset]['bytes'] <= 16 * 1024**2
    assert re.fullmatch('[a-f0-9]{64}', row['sha256'])
    assert expected.is_file() and expected.stat().st_size == row['bytes']
    raw = expected.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == row['sha256']
    if offset == 0: assert row['sha256'] == H000_SHA and len(raw) == H000_BYTES
    target = args.out / f'hour-{offset:03}.grib2'
    with target.open('xb') as stream: stream.write(raw)
    target.chmod(0o444)
    rows.append({**row, 'path': str(target.resolve())})
assert receipt['mask'] == {'resource': MASK_RESOURCE, 'path': str(args.mask.resolve()), 'bytes': MASK_BYTES, 'sha256': MASK_SHA}
assert args.mask.is_file() and not args.mask.is_symlink() and args.mask.stat().st_size == MASK_BYTES
mask = args.mask.read_bytes(); assert hashlib.sha256(mask).hexdigest() == MASK_SHA
target = args.out / 'mask.grib2'; target.write_bytes(mask); target.chmod(0o444)
for name, raw in (
    ('sources.json', json.dumps({'schema': 1, 'packets': rows, 'mask': {**receipt['mask'], 'path': str(target.resolve())}}, sort_keys=True, indent=2).encode() + b'\n'),
    ('capture-result.json', (args.capture / 'result.json').read_bytes()),
):
    assert len(raw) <= 65536
    with (args.out / name).open('xb') as stream: stream.write(raw)
    (args.out / name).chmod(0o444)
assert sum(row['bytes'] for row in rows) + MASK_BYTES == 137421911
args.out.chmod(0o555)
print(json.dumps({'originalFiles': 50, 'originalBytes': 137421911, 'rootReadonly': True,
                  'providerRequests': 0, 'nativeImported': False}))
