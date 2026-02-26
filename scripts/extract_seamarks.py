#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  Thalassa — Seamark Navigation Aid Extractor                ║
║  PBF → GeoJSON FeatureCollection of ALL seamarks            ║
╚══════════════════════════════════════════════════════════════╝

Extracts ANY node with seamark:type OR any seamark:* key.
All attributes are preserved for frontend filtering.
"""

import argparse
import json
import os
import sys
import time

try:
    import osmium
except ImportError:
    print("ERROR: pyosmium not installed. Run: pip install osmium")
    sys.exit(1)


class SeamarkCollector(osmium.SimpleHandler):
    """Extract ALL seamark-tagged nodes from PBF."""

    def __init__(self, bbox=None):
        super().__init__()
        self.bbox = bbox
        self.features = []
        self.scanned = 0
        self.matched = 0
        self.type_counts = {}

    def node(self, n):
        self.scanned += 1
        if self.scanned % 5_000_000 == 0:
            print(f"  Scanned {self.scanned:,} nodes, found {self.matched:,} seamarks...", flush=True)

        # Check if ANY tag starts with 'seamark:'
        has_seamark = False
        for t in n.tags:
            if t.k.startswith('seamark:'):
                has_seamark = True
                break

        if not has_seamark:
            return

        # Check location validity
        try:
            lon = n.location.lon
            lat = n.location.lat
        except osmium.InvalidLocationError:
            return

        # Bounding box filter
        if self.bbox:
            min_lon, min_lat, max_lon, max_lat = self.bbox
            if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
                return

        # Extract ALL seamark tags as properties
        props = {}
        seamark_type = 'unknown'
        for t in n.tags:
            if t.k.startswith('seamark:'):
                key = t.k[8:]  # strip 'seamark:'
                props[key] = t.v
                if t.k == 'seamark:type':
                    seamark_type = t.v

        # Derive visual classification for frontend styling
        props['_class'] = self._classify(seamark_type, props)
        props['_type'] = seamark_type

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(lon, 6), round(lat, 6)],
            },
            "properties": props,
        }

        self.features.append(feature)
        self.matched += 1
        self.type_counts[seamark_type] = self.type_counts.get(seamark_type, 0) + 1

    def _classify(self, seamark_type, props):
        """Classify marker for frontend styling (IALA Region A)."""
        # Lateral marks
        if 'lateral' in seamark_type:
            for prefix in ['buoy_lateral', 'beacon_lateral']:
                colour = props.get(f'{prefix}:colour', '')
                category = props.get(f'{prefix}:category', '')
                if 'red' in colour or category == 'port':
                    return 'port'
                if 'green' in colour or category == 'starboard':
                    return 'starboard'
            return 'lateral'

        # Cardinal marks
        if 'cardinal' in seamark_type:
            for prefix in ['buoy_cardinal', 'beacon_cardinal']:
                cat = props.get(f'{prefix}:category', '')
                if cat:
                    return f'cardinal_{cat[0]}'
            return 'cardinal'

        if 'safe_water' in seamark_type: return 'safe_water'
        if 'isolated_danger' in seamark_type: return 'danger'
        if 'special_purpose' in seamark_type: return 'special'
        if 'light' in seamark_type: return 'light'
        if 'landmark' in seamark_type: return 'landmark'
        if 'mooring' in seamark_type: return 'mooring'
        if 'berth' in seamark_type: return 'berth'
        if 'anchorage' in seamark_type: return 'anchorage'
        if 'harbour' in seamark_type: return 'harbour'
        if 'pile' in seamark_type: return 'pile'
        if 'dolphin' in seamark_type: return 'dolphin'
        if 'gate' in seamark_type: return 'gate'
        if 'notice' in seamark_type: return 'notice'
        if 'rock' in seamark_type: return 'danger'
        if 'wreck' in seamark_type: return 'danger'
        if 'obstruction' in seamark_type: return 'danger'
        return 'other'


def main():
    parser = argparse.ArgumentParser(description='Thalassa Seamark Extractor')
    parser.add_argument('input', help='Path to .osm.pbf file')
    parser.add_argument('--name', default='se_queensland', help='Region name')
    parser.add_argument('--bbox', default='152.5,-28.2,153.6,-26.5',
                        help='Bounding box (default: SE Queensland)')
    parser.add_argument('--output', default=None, help='Output .geojson path')

    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"ERROR: File not found: {args.input}")
        sys.exit(1)

    bbox = tuple(float(x) for x in args.bbox.split(',')) if args.bbox else None
    output = args.output or f"{args.name}_nav_markers.geojson"

    print("=" * 60)
    print("Thalassa — Seamark Extractor (WIDE NET)")
    print("=" * 60)
    print(f"  Input:  {args.input}")
    print(f"  Filter: ANY node with seamark:* tags")
    if bbox:
        print(f"  BBox:   [{bbox[0]},{bbox[1]}] → [{bbox[2]},{bbox[3]}]")
    print()

    t0 = time.time()
    collector = SeamarkCollector(bbox=bbox)
    collector.apply_file(args.input, locations=True)

    elapsed = time.time() - t0
    print(f"\n  Found {collector.matched:,} seamarks in {elapsed:.1f}s")
    print(f"  Scanned {collector.scanned:,} nodes total\n")

    # Print type breakdown
    print("  Type breakdown:")
    for stype, count in sorted(collector.type_counts.items(), key=lambda x: -x[1]):
        print(f"    {stype}: {count}")

    # Print class breakdown
    class_counts = {}
    for f in collector.features:
        c = f['properties'].get('_class', 'unknown')
        class_counts[c] = class_counts.get(c, 0) + 1

    print(f"\n  Style classes:")
    for cls, count in sorted(class_counts.items(), key=lambda x: -x[1]):
        print(f"    {cls}: {count}")

    # Write GeoJSON
    geojson = {"type": "FeatureCollection", "features": collector.features}
    with open(output, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, separators=(',', ':'))

    size_kb = os.path.getsize(output) / 1024
    print(f"\n  Saved: {output} ({size_kb:.0f} KB)")
    print("=" * 60)


if __name__ == '__main__':
    main()
