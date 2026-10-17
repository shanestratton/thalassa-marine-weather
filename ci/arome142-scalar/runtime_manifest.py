"""Bounded readonly inventory; only the exact ordinary venv lib64 link is allowed."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def demand(ok, relative, rule):
    if not ok:
        raise AssertionError(rule + ': ' + json.dumps(relative[:192]))


def inventory(stage):
    stage = stage.absolute()
    assert not stage.is_symlink() and stage.resolve(strict=True) == stage
    root = stage.stat()
    assert root.st_uid == 0 and root.st_mode & 0o222 == 0
    rows = []
    total = 0
    for path in sorted(stage.rglob('*')):
        facts = path.lstat()
        relative = path.relative_to(stage).as_posix()
        demand(facts.st_uid == 0, relative, 'stage member is not root owned')
        if stat.S_ISLNK(facts.st_mode):
            # POSIX link permission bits are always0777 and are not file write
            # authority. Admit only this literal link to its readonly local lib.
            demand(relative == 'runtime/lib64' and os.readlink(path) == 'lib', relative, 'unreviewed stage symlink')
            expected = stage / 'runtime/lib'
            try:
                target = path.resolve(strict=True)
            except (OSError, RuntimeError):
                raise AssertionError('venv link resolution refused: ' + json.dumps(relative[:192])) from None
            demand(target == expected and target.is_relative_to(stage / 'runtime'), relative, 'venv link escaped or changed')
            target_facts = expected.lstat()
            demand(stat.S_ISDIR(target_facts.st_mode) and target_facts.st_uid == 0, relative, 'venv target ownership/type')
            demand(target_facts.st_mode & 0o222 == 0, relative, 'venv target is writable')
            rows.append({'path': relative, 'link': 'lib', 'resolvedTarget': 'runtime/lib', 'uid': 0})
        elif stat.S_ISREG(facts.st_mode):
            demand(facts.st_mode & 0o222 == 0, relative, 'stage file is writable')
            demand(facts.st_size <= 128 * 1024**2 and len(rows) < 10000, relative, 'stage member byte/count ceiling')
            total += facts.st_size
            assert total <= 512 * 1024**2
            rows.append({'path': relative, 'bytes': facts.st_size,
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uid': 0,
                         'mode': oct(facts.st_mode & 0o777)})
        else:
            demand(stat.S_ISDIR(facts.st_mode) and facts.st_mode & 0o222 == 0, relative, 'unsupported or writable stage member')
    raw = (json.dumps({'files': rows, 'totalBytes': total}, sort_keys=True, indent=2) + '\n').encode()
    assert len(raw) <= 3 * 1024**2
    return raw


if __name__ == '__main__':
    stage, target = map(Path, sys.argv[1:])
    raw = inventory(stage)
    with target.open('xb') as stream:
        stream.write(raw)
