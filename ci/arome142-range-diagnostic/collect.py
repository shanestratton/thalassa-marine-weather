"""At most4MiB diagnostic text. No originals, arrays, runtime or static tiles."""
import hashlib
import json
import os
from pathlib import Path
import re

temp = Path(os.environ['RUNNER_TEMP'])
root = temp / 'arome142-range-diagnostic-evidence'
target = temp / 'arome142-range-diagnostic-artifact'
target.mkdir(mode=0o700)
run = os.environ['GITHUB_RUN_ID']; assert re.fullmatch('[0-9]+', run)
allowed = {'retained-artifact-download.txt', 'source.txt', 'controller-source.txt', 'control.txt',
    'python.txt', 'node.txt', 'verified-retained.json', 'native-source-manifest.json',
    'posix-link-fixtures10.txt', 'complete26.txt', 'range8.txt', 'constant48.txt', 'controller15.txt', 'source18.txt',
    'install.txt', 'pip-check.txt', 'packages.txt', 'read-only-runtime-manifest.json', 'read-only-runtime-after.json',
    'compiled-fixtures4.txt', 'generated-fixture-proof.json', 'native-diagnostic.txt', 'native-process-exit.txt',
    'native/kernel-before-generated-fixtures.json', 'native/kernel-before-range-diagnostic.json',
    'native/physical-range-diagnostic.json'}
allowed.update(f'cleanup-arome142-range-diagnostic-{phase}-{run}.service.txt' for phase in ('fixture', 'native'))
rows = []; total = 0
if root.is_dir() and not root.is_symlink():
    for directory, children, files in os.walk(root, followlinks=False):
        directory = Path(directory)
        for child in children: assert not (directory / child).is_symlink()
        for name in sorted(files):
            source = directory / name
            relative = source.relative_to(root).as_posix()
            assert relative in allowed and source.is_file() and not source.is_symlink()
            assert source.stat().st_size <= 4 * 1024**2
            raw = source.read_bytes()
            if source.suffix == '.txt': raw = raw[-131072:]
            raw.decode('utf-8')
            total += len(raw); assert total <= 4 * 1024**2 - 65536
            destination = target / relative; destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream: stream.write(raw)
            rows.append({'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                         'sourceBytes': source.stat().st_size})
inventory = {'schema': 1, 'files': rows, 'textBytes': total, 'maximumTextBytes': 4 * 1024**2,
    'retainedOriginalArtifact': 12104635869, 'originalsIncluded': False, 'arraysIncluded': False,
    'runtimeOrStaticIncluded': False, 'diagnosticOnly': True, 'nativeRefusalIsNotWaived': True,
    'originalQualificationClockRenewed': False, 'full49HourCohortAdmitted': False, 'published': False}
raw = (json.dumps(inventory, indent=2) + '\n').encode(); assert len(raw) <= 65536
with (target / 'artifact-inventory.json').open('xb') as stream: stream.write(raw)
