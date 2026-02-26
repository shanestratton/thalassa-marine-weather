"""
SE QLD Routing Sandbox — Full Data Extraction
==============================================
Extracts from OSM via Overpass API:
1. leisure=marina polygons (marina basins)
2. waterway=river/canal/fairway centerlines
3. seamark:type=buoy_lateral / beacon_lateral (channel marks)

Builds IALA channel centerlines by pairing port+starboard marks.
Adds safe water exit geofences (North West Channel, South Passage).
Outputs: public/data/waterway_zones.geojson

Bounding box: Noosa (-26.38) to Gold Coast (-28.17), coast to past Stradbroke
"""
import json
import math
import os
import time
import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# ── SE QLD Bounding Box ────────────────────────────────────────────
# south, west, north, east
SE_QLD_BBOX = "-28.17,152.90,-26.38,153.65"

# Smaller sub-regions to avoid timeouts
REGIONS = {
    "Sunshine Coast": "-26.80,152.90,-26.38,153.25",
    "Moreton Bay North": "-27.25,152.90,-26.80,153.45",
    "Brisbane": "-27.55,152.90,-27.25,153.25",
    "Moreton Bay South": "-27.55,153.25,-27.25,153.65",
    "Gold Coast North": "-27.95,153.20,-27.55,153.50",
    "Gold Coast South": "-28.17,153.30,-27.95,153.55",
}

# ── Helpers ─────────────────────────────────────────────────────────

def dist_m(a, b):
    dx = (a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111320
    dy = (a[1] - b[1]) * 111320
    return math.sqrt(dx * dx + dy * dy)

def midpoint(a, b):
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

def query_overpass(query, label=""):
    for attempt in range(3):
        try:
            print(f"  Querying: {label}... (attempt {attempt+1})")
            resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=120)
            if resp.status_code == 429:
                print(f"  Rate limited, waiting 30s...")
                time.sleep(30)
                continue
            resp.raise_for_status()
            data = resp.json()
            print(f"  Got {len(data['elements'])} elements")
            return data
        except Exception as e:
            print(f"  Error: {e}")
            if attempt < 2:
                print(f"  Retrying in 15s...")
                time.sleep(15)
    return {"elements": []}

# ── Storage ─────────────────────────────────────────────────────────

nodes = {}
all_features = []
port_marks = []
stbd_marks = []

# ══════════════════════════════════════════════════════════════════
# PHASE 1: MARINA POLYGONS
# ══════════════════════════════════════════════════════════════════
print("=" * 60)
print("PHASE 1: MARINA POLYGONS")
print("=" * 60)

marina_query = f"""
[out:json][timeout:90];
(
  way["leisure"="marina"]({SE_QLD_BBOX});
  relation["leisure"="marina"]({SE_QLD_BBOX});
);
out body;
>;
out skel qt;
"""

data = query_overpass(marina_query, "All SE QLD marinas")
for el in data['elements']:
    if el['type'] == 'node':
        nodes[el['id']] = [el['lon'], el['lat']]

marina_count = 0
for el in data['elements']:
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
                lat_c = sum(c[1] for c in coords) / len(coords)
                lon_c = sum(c[0] for c in coords) / len(coords)
                print(f"  ✓ {name} ({len(coords)} nodes) [{lat_c:.3f}, {lon_c:.3f}]")

print(f"\nTotal marinas: {marina_count}")

# Add manually-defined Newport Waterways Marina (not in OSM)
all_features.append({
    "type": "Feature",
    "properties": {
        "zone_type": "marina",
        "name": "Newport Waterways Marina",
        "source": "manual",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.0860, -27.2160],
            [153.0920, -27.2160],
            [153.0920, -27.2000],
            [153.0860, -27.2000],
            [153.0860, -27.2160],
        ]]
    }
})
print("  ✓ Newport Waterways Marina (manual)")

time.sleep(5)  # Be nice to Overpass

# ══════════════════════════════════════════════════════════════════
# PHASE 2: WATERWAY CENTERLINES
# ══════════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("PHASE 2: WATERWAY CENTERLINES")
print("=" * 60)

centerline_count = 0

for region_name, bbox in REGIONS.items():
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
    data = query_overpass(query, f"waterways: {region_name}")
    
    for el in data['elements']:
        if el['type'] == 'node':
            nodes[el['id']] = [el['lon'], el['lat']]
    
    region_count = 0
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
                    region_count += 1
    
    print(f"  {region_name}: {region_count} waterway segments")
    time.sleep(5)

print(f"\nTotal waterway centerlines: {centerline_count}")

# Add Newport canal centerline (manually traced)
newport_canal = [
    [153.0880, -27.2135], [153.0882, -27.2125], [153.0885, -27.2115],
    [153.0890, -27.2100], [153.0892, -27.2085], [153.0895, -27.2070],
    [153.0897, -27.2058], [153.0900, -27.2045], [153.0905, -27.2033],
    [153.0910, -27.2020], [153.0918, -27.2008], [153.0925, -27.1998],
    [153.0933, -27.1968],
]
all_features.append({
    "type": "Feature",
    "properties": {
        "zone_type": "channel_centerline",
        "name": "Newport Canal",
        "source": "manual_trace",
    },
    "geometry": {"type": "LineString", "coordinates": newport_canal}
})
print("  ✓ Newport Canal (manual trace, 13 WPs)")

# ══════════════════════════════════════════════════════════════════
# PHASE 3: IALA LATERAL MARKS + CHANNEL CENTERLINES
# ══════════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("PHASE 3: IALA LATERAL MARKS")
print("=" * 60)

# Load from existing nav_markers.geojson (already processed)
markers = json.load(open('nav_markers.geojson'))

for f in markers['features']:
    if f['geometry']['type'] != 'Point':
        continue
    props = f.get('properties', {})
    cls = props.get('_class', '')
    coord = f['geometry']['coordinates']
    
    if cls == 'port':
        port_marks.append(coord)
    elif cls == 'starboard':
        stbd_marks.append(coord)

print(f"Loaded: {len(port_marks)} port, {len(stbd_marks)} starboard marks")

# Build channel centerlines from paired marks
CHANNEL_AREAS = [
    ("Newport Channel", [153.098, -27.198], 3000),
    ("Scarborough Channel", [153.108, -27.192], 3000),
    ("Pine River Entrance", [153.085, -27.250], 4000),
    ("Brisbane River Mouth", [153.130, -27.400], 5000),
    ("Manly Channel", [153.190, -27.455], 3000),
    ("Redcliffe Channel", [153.100, -27.230], 3000),
    ("Moreton Bay NW Channel", [153.100, -27.050], 8000),
    ("Moreton Bay Central", [153.200, -27.200], 15000),
    ("Gold Coast Seaway", [153.430, -27.940], 3000),
    ("Jumpinpin Bar", [153.440, -27.740], 3000),
    ("Mooloolaba Channel", [153.130, -26.685], 3000),
    ("Caloundra Channel", [153.135, -26.810], 5000),
    ("Pumicestone Passage N", [153.100, -26.850], 5000),
    ("Pumicestone Passage S", [153.130, -26.950], 5000),
]

iala_count = 0
for area_name, center, radius in CHANNEL_AREAS:
    area_port = [m for m in port_marks if dist_m(m, center) < radius]
    area_stbd = [m for m in stbd_marks if dist_m(m, center) < radius]
    
    if len(area_port) < 2 or len(area_stbd) < 2:
        continue
    
    # Pair nearest port+starboard
    pairs = []
    used_stbd = set()
    
    for pm in area_port:
        best_d = float('inf')
        best_idx = -1
        for i, sm in enumerate(area_stbd):
            if i in used_stbd: continue
            d = dist_m(pm, sm)
            if 10 < d < 500 and d < best_d:
                best_d = d
                best_idx = i
        if best_idx >= 0:
            pairs.append({
                'midpoint': midpoint(pm, area_stbd[best_idx]),
                'width': best_d,
            })
            used_stbd.add(best_idx)
    
    if len(pairs) < 2:
        continue
    
    # Sort by proximity chain
    sorted_pairs = [pairs[0]]
    remaining = pairs[1:]
    while remaining:
        last = sorted_pairs[-1]['midpoint']
        best_idx = min(range(len(remaining)), key=lambda i: dist_m(remaining[i]['midpoint'], last))
        sorted_pairs.append(remaining.pop(best_idx))
    
    coords = [p['midpoint'] for p in sorted_pairs]
    total_m = sum(dist_m(coords[i], coords[i+1]) for i in range(len(coords)-1))
    
    all_features.append({
        "type": "Feature",
        "properties": {
            "zone_type": "channel_centerline",
            "name": area_name,
            "source": "iala_marks",
            "pairs": len(sorted_pairs),
            "length_m": round(total_m),
            "avg_width_m": round(sum(p['width'] for p in sorted_pairs) / len(sorted_pairs)),
        },
        "geometry": {"type": "LineString", "coordinates": coords}
    })
    iala_count += 1
    print(f"  ✓ {area_name}: {len(pairs)} pairs, {total_m:.0f}m")

print(f"\nTotal IALA channel centerlines: {iala_count}")

# ══════════════════════════════════════════════════════════════════
# PHASE 4: SAFE WATER EXIT GEOFENCES
# ══════════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("PHASE 4: SAFE WATER EXIT GEOFENCES")
print("=" * 60)

# North West Channel exit (between Bribie Island and Moreton Island)
nw_channel_exit = {
    "type": "Feature",
    "properties": {
        "zone_type": "safe_water_exit",
        "name": "North West Channel Exit",
        "description": "Exit Moreton Bay via North West Channel (Caloundra Head)",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.08, -26.82],   # NW (off Bribie Is tip)
            [153.18, -26.82],   # NE (toward Moreton Is)
            [153.18, -26.88],   # SE
            [153.08, -26.88],   # SW
            [153.08, -26.82],   # Close
        ]]
    }
}
all_features.append(nw_channel_exit)
print("  ✓ North West Channel Exit geofence")

# South Passage exit (between Moreton Island and North Stradbroke Island)
south_passage_exit = {
    "type": "Feature",
    "properties": {
        "zone_type": "safe_water_exit",
        "name": "South Passage Exit",
        "description": "Exit Moreton Bay via South Passage (between Moreton & Straddie)",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.40, -27.05],   # NW (Moreton Is south tip)
            [153.48, -27.05],   # NE (open ocean)
            [153.48, -27.12],   # SE
            [153.40, -27.12],   # SW (Straddie north tip)
            [153.40, -27.05],   # Close
        ]]
    }
}
all_features.append(south_passage_exit)
print("  ✓ South Passage Exit geofence")

# Gold Coast Seaway exit
gc_seaway_exit = {
    "type": "Feature",
    "properties": {
        "zone_type": "safe_water_exit",
        "name": "Gold Coast Seaway Exit",
        "description": "Exit to open ocean via Gold Coast Seaway",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.42, -27.93],
            [153.48, -27.93],
            [153.48, -27.97],
            [153.42, -27.97],
            [153.42, -27.93],
        ]]
    }
}
all_features.append(gc_seaway_exit)
print("  ✓ Gold Coast Seaway Exit geofence")

# ══════════════════════════════════════════════════════════════════
# SAVE
# ══════════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("SAVING")
print("=" * 60)

# Deduplicate by osm_id (keeping manual features that have no osm_id)
seen_ids = set()
deduped = []
for f in all_features:
    oid = f['properties'].get('osm_id', None)
    if oid is not None:
        if oid in seen_ids:
            continue
        seen_ids.add(oid)
    deduped.append(f)

geojson = {"type": "FeatureCollection", "features": deduped}

output_path = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, 'w') as f:
    json.dump(geojson, f)

size_kb = os.path.getsize(output_path) / 1024

# Summary
marinas = len([f for f in deduped if f['properties']['zone_type'] == 'marina'])
centerlines = len([f for f in deduped if f['properties']['zone_type'] == 'waterway_centerline'])
channels = len([f for f in deduped if f['properties']['zone_type'] == 'channel_centerline'])
exits = len([f for f in deduped if f['properties']['zone_type'] == 'safe_water_exit'])

print(f"\n✓ Saved: {output_path} ({size_kb:.0f} KB)")
print(f"  Marina polygons: {marinas}")
print(f"  Waterway centerlines: {centerlines}")
print(f"  IALA channel centerlines: {channels}")
print(f"  Safe water exits: {exits}")
print(f"  Total features: {len(deduped)}")
