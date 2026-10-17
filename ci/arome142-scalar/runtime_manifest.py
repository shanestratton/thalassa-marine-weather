"""Bounded read-only stage inventory, outside the confined native process."""
import hashlib
import json
from pathlib import Path
import sys

stage, target = map(Path, sys.argv[1:])
rows = []
total = 0
for path in sorted(stage.rglob('*')):
    facts = path.lstat()
    assert facts.st_uid == 0 and facts.st_mode & 0o222 == 0
    if path.is_symlink():
        resolved = path.resolve()
        assert (resolved.is_file() or resolved.is_dir()) and resolved.stat().st_uid == 0
        assert resolved.stat().st_mode & 0o022 == 0
        rows.append({'path': path.relative_to(stage).as_posix(), 'link': str(resolved)})
    elif path.is_file():
        assert facts.st_size <= 128 * 1024**2 and len(rows) < 10000
        total += facts.st_size
        assert total <= 512 * 1024**2
        rows.append({'path': path.relative_to(stage).as_posix(), 'bytes': facts.st_size,
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uid': 0,
                     'mode': oct(facts.st_mode & 0o777)})
raw = (json.dumps({'files': rows, 'totalBytes': total}, sort_keys=True, indent=2) + '\n').encode()
assert len(raw) <= 3 * 1024**2
with target.open('xb') as stream:
    stream.write(raw)
