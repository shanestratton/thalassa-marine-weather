"""Fixed filesystem entry for a future reviewed, offline Linux native proof."""
from pathlib import Path
import json
import re
import sys

# -I excludes the script directory. Re-add only this actual immutable code root.
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from contract import PLAN_SHA, request  # noqa: E402
from native_grib import decode_original, require_linux_bounds  # noqa: E402


def parse_receipt(raw: bytes) -> dict:
    if not 0 < len(raw) <= 4096:
        raise ValueError('Native receipt bound')
    row = json.loads(raw)
    if not isinstance(row, dict) or set(row) != {'year', 'month', 'kind', 'sha256', 'planSha256'} or row['planSha256'] != PLAN_SHA or not isinstance(row['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', row['sha256']):
        raise ValueError('Native receipt identity')
    request(row['year'], row['month'], row['kind'])
    return row


def main():
    require_linux_bounds()
    if ROOT != Path('/opt/thalassa-climate142-v1/source'):
        raise RuntimeError('Unreviewed native source path')
    for path in [ROOT, *ROOT.parents, *ROOT.glob('*.py')]:
        stat = path.stat()
        if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise RuntimeError('Native code must be root-owned and read-only to the job')
    receipt_path = Path('/work/input/receipt.json')
    if receipt_path.is_symlink() or receipt_path.stat().st_size > 4096:
        raise ValueError('Native receipt path')
    row = parse_receipt(receipt_path.read_bytes())
    decode_original(Path('/work/input/original.grib'), row['sha256'], row['year'], row['month'], row['kind'],
                    Path('/work/output/month.jsonl'), Path('/work/output/fields.sqlite'))
    print(json.dumps({'state': 'decoded', 'planSha256': PLAN_SHA, 'year': row['year'], 'month': row['month'], 'kind': row['kind']}))


if __name__ == '__main__':
    main()
