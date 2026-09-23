#!/usr/bin/env python3
"""Refresh one EXISTING regional JSON bundle, without deploying application code.

The daily maintenance task runs this against a temporary copy of the LIVE
function, not the shared working tree. Publication is a separate verified step.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlopen

from generate import timestamp

BASE = 'https://download.geofabrik.de/australia-oceania/australia/'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    existing = json.loads(args.output.read_text())
    if existing.get('schema') != 1 or existing.get('region') != 'newport-v1':
        raise ValueError('Refusing to refresh an unrecognised bundle')
    with urlopen(BASE + 'queensland.html', timeout=30) as response:
        page = response.read(1_000_001)
        if len(page) > 1_000_000:
            raise ValueError('Source index exceeds limit')
    dates = re.findall(r'href="(queensland-\d{6}\.osm\.pbf)"', page.decode())
    if not dates:
        raise ValueError('No dated source extract found')
    source_url = BASE + max(dates)
    if source_url == existing['sourceUrl']:
        age = datetime.now(timezone.utc) - timestamp(existing['sourceAsOf'])
        if age < timedelta(0) or age > timedelta(days=3):
            raise ValueError('Source publication is delayed; no fresh snapshot available')
        print(json.dumps({'status': 'unchanged', 'sourceAsOf': existing['sourceAsOf']}))
        return
    with tempfile.TemporaryDirectory(prefix='thalassa-newport-refresh-') as directory:
        pbf = Path(directory) / max(dates)
        started = time.monotonic()
        size = 0
        with urlopen(source_url, timeout=30) as response, pbf.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 400_000_000 or time.monotonic() - started > 300:
                    raise ValueError('Source download exceeds budget')
                out.write(chunk)
        subprocess.run([
            sys.executable, str(Path(__file__).with_name('generate.py')),
            '--pbf', str(pbf), '--source-url', source_url, '--output', str(args.output),
        ], check=True, timeout=600)
    print(json.dumps({'status': 'refreshed', 'sourceUrl': source_url}))

if __name__ == '__main__':
    main()
