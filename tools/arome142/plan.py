"""Pure offline source plan CLI; never downloads, installs or publishes."""
import argparse
import json
from pathlib import Path

from catalogue import DOMAINS, MAX_CATALOGUE_BYTES, build_plan, digest, require


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', type=Path, required=True)
    parser.add_argument('--domain', choices=list(DOMAINS), required=True)
    parser.add_argument('--run', required=True, help='Exact original UTC cycle, YYYY-MM-DDTHH:00:00Z')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.catalogue.is_symlink() and args.catalogue.is_file(), 'regular original metadata file required')
    require(args.catalogue.stat().st_size <= MAX_CATALOGUE_BYTES, 'catalogue byte limit')
    require(not args.output.exists() and not args.output.is_symlink(), 'plan output must be fresh')
    plan = build_plan(args.catalogue.read_bytes(), args.domain, args.run)
    raw = (json.dumps(plan, indent=2, sort_keys=True, allow_nan=False) + '\n').encode()
    require(len(raw) <= 1024 * 1024, 'plan metadata limit')
    with args.output.open('xb') as stream:
        stream.write(raw)
    print(json.dumps({'output': str(args.output), 'sha256': digest(raw), 'domain': args.domain,
                      'sourceRun': args.run, 'leads': len(plan['packets']),
                      'declaredBytes': plan['declaredForecastBytes'],
                      'nativeAdmission': False, 'downloads': 0, 'publication': False}))


if __name__ == '__main__':
    main()
