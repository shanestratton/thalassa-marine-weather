"""
Build IALA channel centerlines by pairing port+starboard marks.

For each area with navigation marks:
1. Find port (red) and starboard (green) lateral marks
2. Pair nearest port+starboard across the channel (like ladder rungs)
3. Compute midpoint of each pair → channel center
4. Connect midpoints → centerline LineString
5. Add to waterway_zones.geojson alongside OSM river centerlines

Uses an ECDIS-style "fairway snap" approach.
"""
import json
import math
import os

# ── Load data ───────────────────────────────────────────────────────

markers = json.load(open('nav_markers.geojson'))
zones = json.load(open(os.path.join('..', 'public', 'data', 'waterway_zones.geojson')))

# ── Helpers ─────────────────────────────────────────────────────────

def dist_m(a, b):
    """Equirectangular distance in meters between [lon,lat] points."""
    dx = (a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111320
    dy = (a[1] - b[1]) * 111320
    return math.sqrt(dx * dx + dy * dy)

def midpoint(a, b):
    """Midpoint between two [lon,lat] points."""
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

# ── Extract port and starboard marks ────────────────────────────────

port_marks = []
stbd_marks = []

for f in markers['features']:
    if f['geometry']['type'] != 'Point':
        continue
    props = f.get('properties', {})
    cls = props.get('_class', '')
    coord = f['geometry']['coordinates']  # [lon, lat]
    
    if cls == 'port':
        port_marks.append({'coord': coord, 'name': props.get('name', ''), 'type': props.get('_type', '')})
    elif cls == 'starboard':
        stbd_marks.append({'coord': coord, 'name': props.get('name', ''), 'type': props.get('_type', '')})

print(f"Total marks: {len(port_marks)} port, {len(stbd_marks)} starboard")

# ── Define channel areas to process ─────────────────────────────────
# Each area: name, center [lon,lat], radius in meters

CHANNEL_AREAS = [
    ("Newport Channel", [153.098, -27.198], 3000),
    ("Scarborough Channel", [153.108, -27.192], 3000),
    ("Pine River Entrance", [153.085, -27.250], 4000),
    ("Brisbane River Mouth", [153.130, -27.400], 5000),
    ("Manly Channel", [153.190, -27.455], 3000),
    ("Redcliffe Channel", [153.100, -27.230], 3000),
    ("Moreton Bay North", [153.100, -27.050], 8000),
    ("Moreton Bay Central", [153.200, -27.200], 15000),
]

centerline_features = []

for area_name, center, radius in CHANNEL_AREAS:
    # Find marks in this area
    area_port = [m for m in port_marks if dist_m(m['coord'], center) < radius]
    area_stbd = [m for m in stbd_marks if dist_m(m['coord'], center) < radius]
    
    if len(area_port) < 2 or len(area_stbd) < 2:
        print(f"\n⚠ {area_name}: {len(area_port)}P/{len(area_stbd)}S — not enough marks, skipping")
        continue
    
    print(f"\n{'='*50}")
    print(f"{area_name}: {len(area_port)} port, {len(area_stbd)} starboard")
    
    # ── Pair nearest port+starboard marks ───────────────────────────
    # For each port mark, find the nearest starboard mark
    pairs = []
    used_stbd = set()
    
    for pm in area_port:
        best_dist = float('inf')
        best_stbd = None
        best_idx = -1
        
        for i, sm in enumerate(area_stbd):
            if i in used_stbd:
                continue
            d = dist_m(pm['coord'], sm['coord'])
            # Channel marks should be across from each other: 20-300m apart
            if 10 < d < 500 and d < best_dist:
                best_dist = d
                best_stbd = sm
                best_idx = i
        
        if best_stbd and best_idx >= 0:
            pairs.append({
                'port': pm['coord'],
                'starboard': best_stbd['coord'],
                'midpoint': midpoint(pm['coord'], best_stbd['coord']),
                'width_m': best_dist,
            })
            used_stbd.add(best_idx)
    
    if len(pairs) < 2:
        print(f"  Only {len(pairs)} pairs formed — not enough for centerline")
        continue
    
    print(f"  Paired {len(pairs)} mark pairs (channel widths: {min(p['width_m'] for p in pairs):.0f}-{max(p['width_m'] for p in pairs):.0f}m)")
    
    # ── Sort pairs spatially (nearest-neighbor chain) ───────────────
    # Start from the pair nearest the area center, then chain by proximity
    
    # Find starting pair (nearest to area center)
    pairs.sort(key=lambda p: dist_m(p['midpoint'], center))
    
    sorted_pairs = [pairs[0]]
    remaining = pairs[1:]
    
    while remaining:
        last = sorted_pairs[-1]['midpoint']
        best_idx = min(range(len(remaining)), key=lambda i: dist_m(remaining[i]['midpoint'], last))
        sorted_pairs.append(remaining.pop(best_idx))
    
    # ── Build centerline from midpoints ─────────────────────────────
    centerline_coords = [p['midpoint'] for p in sorted_pairs]
    
    # Calculate total length
    total_m = sum(dist_m(centerline_coords[i], centerline_coords[i+1]) for i in range(len(centerline_coords)-1))
    
    print(f"  Centerline: {len(centerline_coords)} points, {total_m:.0f}m ({total_m/1852:.1f} NM)")
    print(f"  Start: {centerline_coords[0]}")
    print(f"  End: {centerline_coords[-1]}")
    
    # Create GeoJSON feature
    centerline_features.append({
        "type": "Feature",
        "properties": {
            "zone_type": "channel_centerline",
            "name": area_name,
            "source": "iala_marks",
            "pairs": len(sorted_pairs),
            "length_m": round(total_m),
            "avg_width_m": round(sum(p['width_m'] for p in sorted_pairs) / len(sorted_pairs)),
        },
        "geometry": {
            "type": "LineString",
            "coordinates": centerline_coords,
        }
    })

# ── Merge into waterway_zones.geojson ───────────────────────────────

print(f"\n{'='*50}")
print(f"Adding {len(centerline_features)} IALA centerlines to waterway_zones.geojson")

# Remove any existing channel_centerline features (in case we re-run)
zones['features'] = [f for f in zones['features'] if f.get('properties', {}).get('zone_type') != 'channel_centerline']

# Add new IALA centerlines
zones['features'].extend(centerline_features)

output_path = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
with open(output_path, 'w') as f:
    json.dump(zones, f)

size_kb = os.path.getsize(output_path) / 1024

marinas = len([f for f in zones['features'] if f['properties']['zone_type'] == 'marina'])
osm_ww = len([f for f in zones['features'] if f['properties']['zone_type'] == 'waterway_centerline'])
iala_cl = len([f for f in zones['features'] if f['properties']['zone_type'] == 'channel_centerline'])

print(f"\n✓ Saved: {output_path} ({size_kb:.0f} KB)")
print(f"  Marina polygons: {marinas}")
print(f"  OSM waterway centerlines: {osm_ww}")
print(f"  IALA channel centerlines: {iala_cl}")
print(f"  Total features: {len(zones['features'])}")
