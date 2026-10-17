"""Bounded exact original plus text receipts; never runtime/packages/SQLite binary."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3

root = Path(os.environ['RUNNER_TEMP']) / 'arome142-constant-evidence'
target = Path(os.environ['RUNNER_TEMP']) / 'arome142-constant-artifact'
target.mkdir(mode=0o700)
text_cap = 4 * 1024**2
original_cap = 16 * 1024**2
rows = []
text_bytes = 0
original_bytes = 0
state_rows = []


def save(name, raw, original=False, source_bytes=None):
    global text_bytes, original_bytes
    if original:
        assert name == 'attempt/original.grib2' and len(raw) <= original_cap
        original_bytes += len(raw)
        assert original_bytes <= original_cap
    else:
        raw.decode('utf-8')
        text_bytes += len(raw)
        assert text_bytes <= text_cap - 32768
    path = target / name
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open('xb') as stream: stream.write(raw)
    rows.append({'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                 'originalBytes': source_bytes if source_bytes is not None else len(raw)})


if root.is_dir() and not root.is_symlink():
    files = sorted(root.rglob('*'))
    assert len(files) <= 96
    for file in files:
        if not file.is_file() or file.is_symlink(): continue
        name = file.relative_to(root).as_posix()
        assert '..' not in Path(name).parts
        if name.startswith('state/'):
            assert name in ('state/day.sqlite', 'state/day.sqlite-journal', 'state/day.sqlite-wal', 'state/day.sqlite-shm')
            assert file.stat().st_size <= 1024**2
            raw = file.read_bytes()
            state_rows.append({'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
            continue
        if name == 'attempt/original.grib2':
            assert file.stat().st_size <= original_cap
            save(name, file.read_bytes(), True)
        elif file.suffix in ('.json', '.txt'):
            assert file.stat().st_size <= text_cap
            raw = file.read_bytes()
            if file.suffix == '.txt': raw = raw[-131072:]
            save(name, raw, source_bytes=file.stat().st_size)
        else:
            raise AssertionError('unreviewed evidence member')
    ledger = root / 'state/day.sqlite'
    if ledger.is_file() and not ledger.is_symlink() and 0 < ledger.stat().st_size <= 1024**2:
        try:
            db = sqlite3.connect(ledger.as_uri() + '?mode=ro', uri=True, timeout=2)
            try:
                raw = ('\n'.join(db.iterdump()) + '\n').encode()
                assert len(raw) <= 65536
                save('durable-ledger.sql', raw)
            finally:
                db.close()
        except sqlite3.Error as error:
            save('durable-ledger-refusal.json', (json.dumps({'errorType': type(error).__name__,
                'error': str(error)[:512], 'statePreservedNeverReset': True}) + '\n').encode())
    save('durable-state-inventory.json', (json.dumps({'files': state_rows, 'noBinaryUpload': True}, indent=2) + '\n').encode())
inventory = {'files': rows, 'textBytes': text_bytes, 'originalBytes': original_bytes,
             'maximumTextBytes': text_cap, 'maximumOriginalBytes': original_cap,
             'originalMaskAdmission': 'consult exact native result; collection alone admits nothing',
             'full49HourCohortAdmitted': False, 'published': False}
with (target / 'artifact-inventory.json').open('x') as stream:
    stream.write(json.dumps(inventory, indent=2) + '\n')
