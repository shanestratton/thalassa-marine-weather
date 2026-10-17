"""Text-only bounded evidence; no original reupload or native binaries."""
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ['RUNNER_TEMP']) / 'arome142-corrected-evidence'
target = Path(os.environ['RUNNER_TEMP']) / 'arome142-corrected-artifact'
target.mkdir(mode=0o700)
rows = []
total = 0
if root.is_dir() and not root.is_symlink():
    for file in sorted(root.iterdir()):
        if not file.is_file() or file.is_symlink() or file.suffix not in ('.json', '.txt'):
            continue
        assert file.stat().st_size <= 4 * 1024**2
        raw = file.read_bytes()
        if file.suffix == '.txt':
            raw = raw[-131072:]
        total += len(raw)
        assert total <= 4 * 1024**2 - 32768
        (target / file.name).write_bytes(raw)
        rows.append({'path': file.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                     'originalBytes': file.stat().st_size})
(target / 'artifact-inventory.json').write_text(json.dumps({'files': rows, 'maximumMetadataBytes': 262144,
    'maximumArtifactTextBytes': 4194304, 'originalFieldsAdmission': 'consult exact native result; collection alone admits nothing', 'published': False}, indent=2) + '\n')
