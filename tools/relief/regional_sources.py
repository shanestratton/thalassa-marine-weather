#!/usr/bin/env python3
"""Bounded public-source proof acquisition. No upload, serving, credentials or scheduler."""
import argparse
import hashlib
import json
import os
import stat
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

PROOF_ROOT = Path('/srv/weather/thalassa-relief135-proof')
COMPRESSED_LIMIT = 4_000_000_000
EXPANDED_LIMIT = 12_000_000_000
SOURCES = {
    'au250': {
        'url': 'https://files.ausseabed.gov.au/survey/AusBathyTopo_Australia_2026_250m.zip',
        'bytes': 2_380_292_468,
        'name': 'AusBathyTopo_Australia_2026_250m.zip',
        'mime': 'binary/octet-stream',
        'sha256': '4f1409ce9edcd451a850611791c300eeb383d905ce48fa1823a9b8ca5e6ddec6',
        'rasterSha256': '105e3fa5db779f3d37f37451305fc66ba2bcf491918f07f3875bd9efe304baea',
        'metadata': 'https://ecat.ga.gov.au/geonetwork/srv/api/records/7ff1f558-8ef4-427b-9696-007b76aab2c6/formatters/xml',
        'licence': 'CC-BY-4.0; not for navigation',
        'datum': 'Approximately Mean Sea Level (GA catalogue lineage)',
    },
    'pr': {
        'url': 'https://chs.coast.noaa.gov/htdata/raster5/elevation/NCEI_ninth_Topobathy_PuertoRico_9525/ncei19_n18x00_w066x00_2022v2.tif',
        'bytes': 141_980_462,
        'name': 'ncei19_n18x00_w066x00_2022v2.tif',
        'mime': 'image/tiff',
        'sha256': 'deb1f434565c3da06fead1af9d629f5defb3da5cc26bff92ea132bebda5d8c12',
        'metadata': 'https://chs.coast.noaa.gov/htdata/raster5/elevation/NCEI_ninth_Topobathy_PuertoRico_9525/cudem_ninth_pr_m9525_met_forHumans.html',
        'licence': 'US government work; cite CIRES/NOAA DOI10.25921/ds9v-ky35; not for navigation',
        'datum': 'Puerto Rico Vertical Datum 2002 (PRVD02), NAD83 horizontally',
    },
}
TRANSFORM_GRID = {
    'url': 'https://cdn.proj.org/us_noaa_pvhpgn.tif',
    'bytes': 3644,
    'name': 'us_noaa_pvhpgn.tif',
    'mime': 'image/tiff',
    'sha256': 'a6db010f956526a011ba719c45fe32e5aff987eeb1cb03f2b8338208a77c619d',
    'licence': 'Public domain; OSGeo PROJ-data copyright_and_licenses.csv',
    'metadata': 'https://github.com/OSGeo/PROJ-data/blob/master/copyright_and_licenses.csv',
    'purpose': 'Local horizontal NAD83 transformation dependency; no vertical conversion',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Public source redirect refused; review the exact new source first')


def source_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_zip(entries, limit=EXPANDED_LIMIT):
    if len(entries) > 128:
        raise ValueError('Archive has too many entries')
    total = 0
    seen = set()
    for entry in entries:
        name = entry.filename
        path = PurePosixPath(name)
        canonical = path.as_posix()
        mode = entry.external_attr >> 16
        if (not name or '\\' in entry.orig_filename or ':' in name or path.is_absolute()
                or any(part in ('..', '.') for part in name.split('/'))
                or canonical != name.rstrip('/')
                or any(ord(char) < 32 for char in entry.orig_filename)
                or stat.S_ISLNK(mode) or entry.flag_bits & 1 or canonical in seen
                or entry.file_size < 0):
            raise ValueError('Unsafe archive entry')
        seen.add(canonical)
        total += entry.file_size
        if total > limit:
            raise ValueError('Expanded source limit exceeded')
    return total


def acquire(source, destination):
    expected = source['bytes']
    if expected > COMPRESSED_LIMIT:
        raise ValueError('Compressed source limit exceeded')
    if destination.exists():
        if destination.stat().st_size != expected:
            raise ValueError('Existing source has unexpected size; preserve it for review')
        digest = source_hash(destination)
        if digest != source['sha256']:
            raise ValueError('Existing source hash differs from the reviewed public input')
        return digest
    opener = urllib.request.build_opener(NoRedirect)
    temporary = destination.with_suffix(destination.suffix + '.partial')
    deadline = time.monotonic() + 900
    try:
        with opener.open(source['url'], timeout=30) as response:
            if (response.status != 200 or response.url != source['url']
                    or response.headers.get('Content-Length') != str(expected)
                    or response.headers.get_content_type() != source['mime']):
                raise ValueError('Source identity, type or declared size changed')
            count = 0
            digest = hashlib.sha256()
            with temporary.open('xb') as output:
                while True:
                    chunk = response.read(min(1024 * 1024, expected - count + 1))
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > expected or time.monotonic() > deadline:
                        raise ValueError('Source exceeds byte or wall-clock limit')
                    output.write(chunk)
                    digest.update(chunk)
            if count != expected:
                raise ValueError('Source truncated')
        if digest.hexdigest() != source['sha256']:
            raise ValueError('Source hash changed; review the replacement before decoding')
        temporary.rename(destination)
        return digest.hexdigest()
    except Exception:
        # Partial public inputs stay in this isolated directory for review;
        # no recursive deletion or silent continuation from an unknown body.
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'acquire-proof'])
    args = parser.parse_args()
    plan = {'proofOnly': True, 'root': PROOF_ROOT.as_posix(), 'compressedLimit': COMPRESSED_LIMIT,
            'expandedLimit': EXPANDED_LIMIT, 'sources': SOURCES, 'projectionDependency': TRANSFORM_GRID}
    if sum(source['bytes'] for source in SOURCES.values()) + TRANSFORM_GRID['bytes'] > COMPRESSED_LIMIT:
        raise ValueError('Combined compressed source budget exceeded')
    if args.action == 'plan':
        print(json.dumps(plan, indent=2))
        return
    if os.name != 'posix' or PROOF_ROOT.resolve() != PROOF_ROOT:
        raise ValueError('Proof acquisition requires the reviewed weather-volume path on wx')
    PROOF_ROOT.mkdir(parents=True, exist_ok=True)
    if os.statvfs(PROOF_ROOT).f_bavail * os.statvfs(PROOF_ROOT).f_frsize < 20_000_000_000:
        raise ValueError('Reserve at least 20 GB free before acquiring public proof inputs')
    receipts = {}
    for key, source in SOURCES.items():
        destination = PROOF_ROOT / source['name']
        digest = acquire(source, destination)
        receipts[key] = {**source, 'path': str(destination), 'sha256': digest}
        print(json.dumps({'source': key, 'bytes': source['bytes'], 'sha256': digest}), flush=True)
    projection = PROOF_ROOT / 'proj'
    projection.mkdir(exist_ok=True)
    projection_path = projection / TRANSFORM_GRID['name']
    projection_hash = acquire(TRANSFORM_GRID, projection_path)
    receipts['projectionDependency'] = {**TRANSFORM_GRID, 'path': str(projection_path), 'sha256': projection_hash}
    archive = PROOF_ROOT / SOURCES['au250']['name']
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        expanded = validate_zip(entries)
        rasters = [entry for entry in entries if entry.filename.lower().endswith('.tif')]
        if not 1 <= len(rasters) <= 4:
            raise ValueError('Review unexpected GA raster layout before extracting')
        extraction = PROOF_ROOT / 'au250'
        extraction.mkdir(exist_ok=True)
        selected = []
        for entry in rasters:
            destination = extraction / entry.filename
            if not destination.resolve().is_relative_to(extraction.resolve()) or destination.is_symlink():
                raise ValueError('Extracted target escapes the isolated proof directory')
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                with package.open(entry) as source, destination.open('xb') as output:
                    written = 0
                    while chunk := source.read(1024 * 1024):
                        written += len(chunk)
                        if written > entry.file_size:
                            raise ValueError('Expanded source exceeds declared size')
                        output.write(chunk)
                if written != entry.file_size:
                    raise ValueError('Expanded source truncated')
            if destination.stat().st_size != entry.file_size:
                raise ValueError('Existing extracted source has unexpected size')
            selected.append({'path': str(destination), 'bytes': entry.file_size,
                             'sha256': source_hash(destination)})
        receipts['au250'].update(expandedBytes=expanded, rasters=selected)
    (PROOF_ROOT / 'acquisition.json').write_text(json.dumps(receipts, indent=2))


if __name__ == '__main__':
    main()
