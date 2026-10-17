"""Allowlisted partial source/text evidence only. Never executable packages."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3

root = Path(os.environ['RUNNER_TEMP']) / 'arome142-original-pilot-evidence'
artifact = Path(os.environ['RUNNER_TEMP']) / 'arome142-original-pilot-artifact'
artifact.mkdir(mode=0o700)
rows = []
text_total = 0
if root.is_dir() and not root.is_symlink():
    database = root / 'state/day.sqlite'
    if database.is_file() and not database.is_symlink() and 0 < database.stat().st_size <= 1024**2:
        try:
            db = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
            try:
                dump = '\n'.join(db.iterdump()) + '\n'
            finally:
                db.close()
            assert len(dump.encode()) <= 65536
            (root / 'durable-ledger.sql').write_text(dump)
        except (sqlite3.Error, AssertionError) as error:
            (root / 'ledger-export-error.txt').write_text(type(error).__name__ + '\n')
    for file in sorted(root.rglob('*')):
        if not file.is_file() or file.is_symlink():
            continue
        relative = file.relative_to(root).as_posix()
        if relative == 'attempt/original.grib2':
            assert file.stat().st_size <= 16 * 1024**2
            raw = file.read_bytes()
            partial = not (root / 'capture-process-exit.txt').is_file()
            trimmed = False
        elif file.suffix in ('.json', '.txt', '.log', '.sql'):
            assert file.stat().st_size <= 8 * 1024**2
            complete = file.read_bytes()
            # Keep exact structured receipts/catalogue; only known text logs
            # may use a clearly recorded bounded tail on failure.
            raw = complete[-262144:] if file.suffix in ('.txt', '.log') else complete
            trimmed = len(raw) != len(complete)
            text_total += len(raw)
            assert text_total <= 4 * 1024**2 - 65536
            partial = False
        else:
            continue
        target = artifact / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        rows.append({'path': relative, 'preservedBytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                     'originalFileBytes': file.stat().st_size, 'partialOriginal': partial, 'textTailOnly': trimmed})
(artifact / 'artifact-inventory.json').write_text(json.dumps({'files': rows, 'maximumOpenOriginalBytes': 16 * 1024**2,
    'maximumTextBytes': 4 * 1024**2, 'publication': False, 'activation': False}, indent=2) + '\n')
assert sum(p.stat().st_size for p in artifact.rglob('*') if p.is_file() and p.suffix != '.grib2') <= 4 * 1024**2
