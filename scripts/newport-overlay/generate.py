#!/usr/bin/env python3
"""Build the reviewed Newport overlay from a complete Geofabrik Queensland PBF.

No public Overpass calls, spatial OSM node crop, polygon repair, inferred depths,
or deployment. Failures leave the last good bundle untouched. Requires osmium.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen

import osmium
from shapely.geometry import box, mapping, shape

COVERAGE = [153.075, -27.23, 153.13, -27.15]
# Clip only outside the advertised area. Keep a ~200 m buffer for thin obstacles.
CLIP = [153.073, -27.232, 153.132, -27.148]
FIELDS = ('water', 'reef', 'coastline', 'marina', 'breakwater', 'aeroway', 'canalLines', 'navLines', 'berths')
FILTERS = (
    'wr/natural=water,reef,coastline', 'wr/leisure=marina',
    'wr/man_made=breakwater,pier,pontoon,quay,groyne,embankment',
    'wr/barrier=wall,retaining_wall', 'wr/floating=yes',
    'wr/waterway=canal,fairway,dock,river,riverbank',
    'wr/aeroway=aerodrome,runway,taxiway,apron',
    'wr/seamark:type=navigation_line', 'wr/bridge',
)

def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{args[0:2]} failed: {result.stderr[-4000:]} {result.stdout[-1000:]}')
    return result.stdout

def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Source timestamp requires timezone')
    return result

def classify(p, kind):
    area = kind in ('Polygon', 'MultiPolygon')
    if p.get('natural') == 'water':
        return 'water' if area else None
    if p.get('natural') == 'reef':
        return 'reef'
    if p.get('natural') == 'coastline':
        return 'coastline' if not area else None
    if p.get('leisure') == 'marina':
        return 'marina' if area else None
    if (p.get('man_made') in ('breakwater', 'quay', 'groyne', 'embankment')
            or p.get('barrier') in ('wall', 'retaining_wall')
            or p.get('bridge') not in (None, 'no')):
        # Existing client blocks this entire collection. All mapped bridges
        # are obstacles here; no clearance or opening capability is inferred.
        return 'breakwater'
    if p.get('man_made') in ('pier', 'pontoon') or p.get('floating') == 'yes':
        return 'berths'
    if p.get('waterway') in ('canal', 'fairway', 'dock', 'river', 'riverbank'):
        return 'water' if area else ('canalLines' if p['waterway'] in ('canal', 'fairway', 'dock') else None)
    if p.get('aeroway') in ('aerodrome', 'runway', 'taxiway', 'apron'):
        return 'aeroway' if area else None
    if p.get('seamark:type') == 'navigation_line' and p.get('seamark:navigation_line:category') != 'clearing':
        return 'navLines' if not area else None
    return None

def select_local_ids(pbf):
    """Select by WHOLE geometry envelopes, not vertices inside a spatial cut.

    Include enclosing polygons and lines crossing Newport with both endpoints
    outside it. Then getid recursively brings all required refs from the state.
    An incomplete relation whose known envelope touches Newport is rejected.
    """
    bounds = {}
    ids = []
    clip = box(*CLIP)
    for obj in osmium.FileProcessor(pbf).with_locations('flex_mem'):
        if obj.is_way():
            positions = [(n.lon, n.lat) for n in obj.nodes]  # missing refs throw
            if not positions:
                continue
            b = (min(p[0] for p in positions), min(p[1] for p in positions),
                 max(p[0] for p in positions), max(p[1] for p in positions))
            bounds[obj.id] = b
            tags = dict(obj.tags)
            if (classify(tags, 'Polygon') or classify(tags, 'LineString')) and box(*b).intersects(clip):
                ids.append(f'w{obj.id}')
        elif obj.is_relation():
            tags = dict(obj.tags)
            if not (classify(tags, 'Polygon') or classify(tags, 'LineString')):
                continue
            if tags.get('type') not in ('multipolygon', 'boundary') and classify(tags, 'LineString') not in ('berths', 'breakwater', 'reef', 'aeroway'):
                # A type=waterway river relation groups centrelines; it is not
                # a water area. Individual tagged member ways are handled above.
                continue
            way_ids = [m.ref for m in obj.members if m.type == 'w']
            known = [bounds[w] for w in way_ids if w in bounds]
            if not known:
                raise ValueError(f'Relation {obj.id} has no locatable geometry')
            b = (min(v[0] for v in known), min(v[1] for v in known),
                 max(v[2] for v in known), max(v[3] for v in known))
            if not box(*b).intersects(clip):
                continue
            if len(known) != len(way_ids) or tags.get('type') not in ('multipolygon', 'boundary'):
                raise ValueError(f'Incomplete or unsupported local relation {obj.id}')
            if any(m.type == 'r' for m in obj.members):
                raise ValueError(f'Nested local relation {obj.id} requires review')
            ids.append(f'r{obj.id}')
    if not ids:
        raise ValueError('No regional objects selected')
    return ids

def collect(path):
    clip = box(*CLIP)
    overlay = {k: {'type': 'FeatureCollection', 'features': []} for k in FIELDS}
    with path.open() as stream:
        lines = list(stream)
    for line in lines:
        f = json.loads(line.lstrip('\x1e'))
        geom = shape(f['geometry'])
        field = classify(f['properties'], geom.geom_type)
        if field is None or not box(*geom.bounds).intersects(clip):
            continue
        if not geom.is_valid or geom.is_empty:
            raise ValueError(f"Invalid local source geometry {f['properties']}")
        if not geom.intersects(clip):
            continue
        clipped = geom.intersection(clip)
        # Keep polygon holes and multi-part geometry. Never buffer(0), simplify,
        # force-close or silently drop a malformed local feature.
        if clipped.is_empty or not clipped.is_valid or clipped.geom_type not in (
                'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point'):
            raise ValueError('Unsupported clipped geometry')
        props = {**f['properties'], '_source': 'osm', '_regional': 'newport-v1'}
        overlay[field]['features'].append({
            'type': 'Feature', 'properties': props, 'geometry': mapping(clipped),
            'bbox': list(clipped.bounds),
        })
    counts = {k: len(v['features']) for k, v in overlay.items()}
    # Newport-specific minimum inventory catches empty/tag-filter regressions;
    # it is not evidence that every real-world obstacle has been mapped.
    if counts['berths'] < 100 or counts['water'] < 5 or counts['canalLines'] < 5:
        raise ValueError(f'Incomplete Newport feature inventory: {counts}')
    return overlay, counts

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pbf', type=Path, required=True)
    parser.add_argument('--source-url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'https://download\.geofabrik\.de/australia-oceania/australia/queensland-\d{6}\.osm\.pbf', args.source_url):
        raise ValueError('Use an immutable dated public Queensland extract')
    md5 = hashlib.md5(usedforsecurity=False)
    sha = hashlib.sha256()
    with args.pbf.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            md5.update(chunk)
            sha.update(chunk)
    with urlopen(args.source_url + '.md5', timeout=30) as response:
        expected = response.read(1024).decode().split()[0]
    if md5.hexdigest() != expected:
        raise ValueError('Source checksum mismatch')
    source_time = run('osmium', 'fileinfo', '-g', 'header.option.osmosis_replication_timestamp', str(args.pbf)).strip()
    now = datetime.now(timezone.utc)
    age = now - timestamp(source_time)
    if age < timedelta(0) or age > timedelta(days=3):
        raise ValueError('New publication requires a source snapshot no older than 3 days')
    with tempfile.TemporaryDirectory(prefix='newport-overlay-') as tmp:
        p = Path(tmp)
        # Filter the WHOLE state before GIS export. A wall crossing the region
        # is not lost just because its OSM vertices lie outside our bbox.
        run('osmium', 'tags-filter', str(args.pbf), *FILTERS, '-o', str(p / 'selected.osm.pbf'))
        ids = select_local_ids(p / 'selected.osm.pbf')
        (p / 'ids.txt').write_text('\n'.join(ids) + '\n')
        run('osmium', 'getid', '-r', '-i', str(p / 'ids.txt'),
            str(p / 'selected.osm.pbf'), '-o', str(p / 'local.osm.pbf'))
        run('osmium', 'check-refs', '-r', str(p / 'local.osm.pbf'))
        run('osmium', 'export', '--show-errors', '--stop-on-error',
            '-c', str(Path(__file__).with_name('export-config.json')),
            str(p / 'local.osm.pbf'), '-o', str(p / 'selected.geojsonseq'))
        overlay, counts = collect(p / 'selected.geojsonseq')
    overlay_json = json.dumps(overlay, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    if len(overlay_json.encode()) > 5_000_000:
        raise ValueError('Regional bundle exceeds server budget')
    bundle = {
        'schema': 1, 'region': 'newport-v1', 'coverage': COVERAGE,
        'sourceAsOf': source_time, 'generatedAt': now.isoformat(),
        'sourceUrl': args.source_url, 'sourceSha256': sha.hexdigest(),
        'attribution': '© OpenStreetMap contributors; extract by Geofabrik. ODbL 1.0.',
        'licenseUrl': 'https://www.openstreetmap.org/copyright',
        'limitations': 'Mapped geometry only. No depth, tide, clearance or navigability certification; unmapped obstacles may exist.',
        'generator': 'newport-overlay-v1', 'counts': counts,
        'payloadSha256': hashlib.sha256(overlay_json.encode()).hexdigest(),
        'overlayJson': overlay_json,
    }
    if args.output.exists():
        previous = json.loads(args.output.read_text())
        if timestamp(source_time) < timestamp(previous['sourceAsOf']):
            raise ValueError('Refusing a source-date regression')
        for field in ('water', 'berths', 'breakwater'):
            if counts[field] < previous['counts'][field] * 0.9:
                raise ValueError(f'{field} inventory dropped >10%; inspect source change before publication')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=args.output.parent, delete=False) as out:
        json.dump(bundle, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.write('\n')
        staged = out.name
    os.replace(staged, args.output)
    print(json.dumps({k: v for k, v in bundle.items() if k != 'overlayJson'}, indent=2))

if __name__ == '__main__':
    main()
