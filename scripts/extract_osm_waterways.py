"""
Extract marina polygons and river centerlines from OSM via Overpass API.
Split into smaller queries to avoid timeouts.
"""
import json
import requests
import os
import time

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

def query_overpass(query, label=""):
    """Run an Overpass QL query and return JSON."""
    print(f"  Querying: {label}...")
    resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=180)
    resp.raise_for_status()
    data = resp.json()
    print(f"  Got {len(data['elements'])} elements")
    return data

# Bounding boxes - focused on navigable areas
BBOX_ALL = "-27.55,152.90,-26.80,153.50"
# Tighter bbox for rivers (Brisbane River + Pine River + Maroochy)
BBOX_BRISBANE = "-27.55,152.90,-27.30,153.20"
BBOX_PINE = "-27.30,152.95,-27.15,153.15"
BBOX_NORTH = "-27.00,152.95,-26.80,153.20"

nodes = {}
all_features = []

# ── 1. Marina polygons ──────────────────────────────────────────────
print("=" * 60)
print("1. MARINA POLYGONS (leisure=marina)")
print("=" * 60)

marina_query = f"""
[out:json][timeout:60];
(
  way["leisure"="marina"]({BBOX_ALL});
  relation["leisure"="marina"]({BBOX_ALL});
);
out body;
>;
out skel qt;
"""

marina_data = query_overpass(marina_query, "marinas SE QLD")

for el in marina_data['elements']:
    if el['type'] == 'node':
        nodes[el['id']] = [el['lon'], el['lat']]

marina_count = 0
for el in marina_data['elements']:
    if el['type'] == 'way' and 'tags' in el:
        tags = el.get('tags', {})
        if tags.get('leisure') == 'marina':
            coords = [nodes[nid] for nid in el.get('nodes', []) if nid in nodes]
            if len(coords) >= 3:
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                name = tags.get('name', f'Marina {el["id"]}')
                all_features.append({
                    "type": "Feature",
                    "properties": {
                        "zone_type": "marina",
                        "name": name,
                        "osm_id": el['id'],
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [coords]
                    }
                })
                marina_count += 1
                print(f"  ✓ {name} ({len(coords)} nodes)")

print(f"  TOTAL: {marina_count} marinas\n")
time.sleep(2)  # Be nice to Overpass

# ── 2. River/canal centerlines ──────────────────────────────────────
print("=" * 60)
print("2. WATERWAY CENTERLINES")
print("=" * 60)

centerline_count = 0

for label, bbox in [("Brisbane area", BBOX_BRISBANE), ("Pine River area", BBOX_PINE), ("North area", BBOX_NORTH)]:
    query = f"""
[out:json][timeout:60];
(
  way["waterway"="river"]({bbox});
  way["waterway"="canal"]({bbox});
  way["waterway"="fairway"]({bbox});
);
out body;
>;
out skel qt;
"""
    try:
        data = query_overpass(query, label)
        
        for el in data['elements']:
            if el['type'] == 'node':
                nodes[el['id']] = [el['lon'], el['lat']]
        
        for el in data['elements']:
            if el['type'] == 'way' and 'tags' in el:
                tags = el.get('tags', {})
                wtype = tags.get('waterway', '')
                if wtype in ('river', 'canal', 'fairway'):
                    coords = [nodes[nid] for nid in el.get('nodes', []) if nid in nodes]
                    if len(coords) >= 2:
                        name = tags.get('name', f'{wtype.title()} {el["id"]}')
                        all_features.append({
                            "type": "Feature",
                            "properties": {
                                "zone_type": "waterway_centerline",
                                "waterway": wtype,
                                "name": name,
                                "osm_id": el['id'],
                            },
                            "geometry": {
                                "type": "LineString",
                                "coordinates": coords
                            }
                        })
                        centerline_count += 1
                        
    except Exception as e:
        print(f"  ⚠ Query failed: {e}")
    
    time.sleep(2)

# Show unique waterway names
names = {}
for f in all_features:
    if f['properties']['zone_type'] == 'waterway_centerline':
        n = f['properties']['name']
        names[n] = names.get(n, 0) + 1

print(f"\n  TOTAL: {centerline_count} waterway segments")
print(f"  Top waterways:")
for n, count in sorted(names.items(), key=lambda x: -x[1])[:15]:
    print(f"    {n}: {count} segments")

# ── Save ────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("SAVING")
print("=" * 60)

geojson = {
    "type": "FeatureCollection",
    "features": all_features
}

output_path = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, 'w') as f:
    json.dump(geojson, f)

size_kb = os.path.getsize(output_path) / 1024
marinas = len([f for f in all_features if f['properties']['zone_type'] == 'marina'])
centerlines = len([f for f in all_features if f['properties']['zone_type'] == 'waterway_centerline'])

print(f"✓ Saved: {output_path} ({size_kb:.0f} KB)")
print(f"  Marina polygons: {marinas}")
print(f"  Waterway centerlines: {centerlines}")
print(f"  Total features: {len(all_features)}")
