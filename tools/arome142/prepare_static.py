"""Local-only static-cohort builder. No provider download/upload/timer/URL option."""
import argparse
import json
from datetime import datetime, timezone

from catalogue import MAX_CATALOGUE_BYTES, build_plan, require
from static_tiles import build_static, read_local


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', required=True)
    parser.add_argument('--domain', required=True, choices=('NCALED', 'ANTIL', 'POLYN'))
    parser.add_argument('--run', required=True)
    parser.add_argument('--sources', required=True, help='bounded local receipt: packets[49] and original mask')
    parser.add_argument('--out', required=True, help='new directory only; never a live current slot')
    args = parser.parse_args()
    plan = build_plan(read_local(args.catalogue, MAX_CATALOGUE_BYTES), args.domain, args.run, datetime.now(timezone.utc))
    receipt = json.loads(read_local(args.sources, 64 * 1024))
    require(isinstance(receipt, dict) and receipt.get('schema') == 1, 'local source receipt schema')
    result = build_static(plan, receipt.get('packets'), receipt.get('mask'), args.out)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__': main()
