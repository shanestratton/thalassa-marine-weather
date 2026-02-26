#!/usr/bin/env python3
"""Quick scan of OSM PBF for depth_area, dredged_area, and fairway data."""
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import osmium

class DepthFairwayScanner(osmium.SimpleHandler):
    def __init__(self, bbox=None):
        super().__init__()
        self.bbox = bbox  # (min_lon, min_lat, max_lon, max_lat)
        self.depth_areas = []
        self.dredged_areas = []
        self.fairways = []
        self.depth_ways = 0
        self.fairway_ways = 0
        self.depth_relations = 0
        
    def _in_bbox(self, lon, lat):
        if not self.bbox:
            return True
        return (self.bbox[0] <= lon <= self.bbox[2] and 
                self.bbox[1] <= lat <= self.bbox[3])
    
    def way(self, w):
        tags = dict(w.tags)
        seamark_type = tags.get('seamark:type', '')
        
        # Depth areas
        if seamark_type in ('depth_area', 'dredged_area'):
            depth = tags.get('seamark:depth_area:minimum_depth', 
                    tags.get('seamark:depth_area:depth_range_value1',
                    tags.get('depth', 'unknown')))
            self.depth_ways += 1
            if self.depth_ways <= 10:
                self.depth_areas.append({
                    'id': w.id,
                    'type': seamark_type,
                    'depth': depth,
                    'tags': {k: v for k, v in tags.items() if 'depth' in k or 'seamark' in k}
                })
        
        # Fairways
        waterway = tags.get('waterway', '')
        if seamark_type == 'fairway' or waterway == 'fairway':
            self.fairway_ways += 1
            if self.fairway_ways <= 10:
                name = tags.get('name', 'unnamed')
                self.fairways.append({
                    'id': w.id,
                    'name': name,
                    'seamark_type': seamark_type,
                    'waterway': waterway,
                    'tags': {k: v for k, v in tags.items() if 'seamark' in k or 'waterway' in k or 'name' in k}
                })
    
    def relation(self, r):
        tags = dict(r.tags)
        seamark_type = tags.get('seamark:type', '')
        if seamark_type in ('depth_area', 'dredged_area'):
            self.depth_relations += 1
            depth = tags.get('seamark:depth_area:minimum_depth',
                    tags.get('depth', 'unknown'))
            if self.depth_relations <= 5:
                print(f"  RELATION depth_area: id={r.id}, type={seamark_type}, depth={depth}")

def main():
    pbf = sys.argv[1] if len(sys.argv) > 1 else 'australia-260224.osm.pbf'
    
    print("=" * 60)
    print("Scanning for depth_area and fairway data...")
    print(f"  Input: {pbf}")
    print("=" * 60)
    
    scanner = DepthFairwayScanner()
    scanner.apply_file(pbf)
    
    print(f"\n--- DEPTH AREAS ---")
    print(f"  Ways: {scanner.depth_ways}")
    print(f"  Relations: {scanner.depth_relations}")
    for d in scanner.depth_areas:
        print(f"    way/{d['id']}: type={d['type']}, depth={d['depth']}")
        for k, v in d['tags'].items():
            print(f"      {k} = {v}")
    
    print(f"\n--- FAIRWAYS ---")
    print(f"  Ways: {scanner.fairway_ways}")
    for f in scanner.fairways:
        print(f"    way/{f['id']}: name={f['name']}")
        for k, v in f['tags'].items():
            print(f"      {k} = {v}")
    
    print("\n" + "=" * 60)

if __name__ == '__main__':
    main()
