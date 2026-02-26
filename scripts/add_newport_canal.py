"""
Add Newport canal centerline manually and connect it to the IALA channel centerline.

The gap: IALA marks only cover the channel in the bay (from the entrance outward).
The boat starts in the canal INSIDE the peninsula. We need a centerline from the
marina basin, through the canal, to where the IALA marks begin.

This script:
1. Creates a canal centerline from Newport marina to the channel entrance
2. Connects it to the existing IALA channel centerline
3. Saves to waterway_zones.geojson
"""
import json
import math
import os

zones_path = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
zones = json.load(open(zones_path))

def dist_m(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111320
    dy = (lat2 - lat1) * 111320
    return math.sqrt(dx * dx + dy * dy)

# ── Newport Canal Centerline ────────────────────────────────────────
# Traced from Google Maps / OpenStreetMap:
# From the marina basin, through the main canal, to the channel entrance
# where the IALA marks begin

newport_canal_centerline = [
    # Start: Inside Newport marina basin (Osprey Canal junction area)
    [153.0880, -27.2135],
    [153.0882, -27.2125],
    [153.0885, -27.2115],
    # Moving north through the main canal 
    [153.0890, -27.2100],
    [153.0892, -27.2085],
    [153.0895, -27.2070],
    # Canal bends slightly
    [153.0897, -27.2058],
    [153.0900, -27.2045],
    [153.0905, -27.2033],
    # Approaching canal mouth / entrance to bay
    [153.0910, -27.2020],
    [153.0918, -27.2008],
    [153.0925, -27.1998],
    # Canal entrance - meeting the IALA channel marks
    [153.0933, -27.1968],
]

# Now find the existing Newport Channel or Scarborough Channel IALA centerline
# and connect to it
iala_centerlines = []
for f in zones['features']:
    if f['properties'].get('zone_type') == 'channel_centerline':
        name = f['properties']['name']
        coords = f['geometry']['coordinates']
        start_d = dist_m(153.0933, -27.1968, coords[0][0], coords[0][1])
        end_d = dist_m(153.0933, -27.1968, coords[-1][0], coords[-1][1])
        min_d = min(start_d, end_d)
        if min_d < 2000:
            iala_centerlines.append((min_d, name, coords, start_d, end_d))
            print(f"  IALA centerline: {name}, start_dist={start_d:.0f}m, end_dist={end_d:.0f}m")

# Build the full route: canal centerline + IALA channel
if iala_centerlines:
    iala_centerlines.sort()
    _, iala_name, iala_coords, start_d, end_d = iala_centerlines[0]
    
    print(f"\nConnecting Newport Canal to {iala_name}")
    
    # Determine which end of the IALA centerline to connect to
    if start_d <= end_d:
        # Canal mouth is near the start of IALA → append IALA to canal
        full_centerline = newport_canal_centerline + iala_coords
    else:
        # Canal mouth is near the end of IALA → prepend reversed IALA to canal
        full_centerline = newport_canal_centerline + list(reversed(iala_coords))
    
    print(f"  Full centerline: {len(full_centerline)} points")
    total_m = sum(dist_m(full_centerline[i][0], full_centerline[i][1], 
                         full_centerline[i+1][0], full_centerline[i+1][1]) 
                  for i in range(len(full_centerline)-1))
    print(f"  Total length: {total_m:.0f}m ({total_m/1852:.1f} NM)")
else:
    full_centerline = newport_canal_centerline
    print("  No IALA centerline found nearby — using canal alone")

# Add the combined feature
newport_feature = {
    "type": "Feature",
    "properties": {
        "zone_type": "channel_centerline",
        "name": "Newport Waterway",
        "source": "manual_trace_plus_iala",
        "length_m": round(sum(dist_m(full_centerline[i][0], full_centerline[i][1],
                                      full_centerline[i+1][0], full_centerline[i+1][1])
                              for i in range(len(full_centerline)-1))),
    },
    "geometry": {
        "type": "LineString",
        "coordinates": full_centerline
    }
}

# Also add a marina polygon for Newport (OSM doesn't have one)
# This covers the main canal basin area
newport_marina = {
    "type": "Feature",
    "properties": {
        "zone_type": "marina",
        "name": "Newport Waterways Marina",
        "source": "manual",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.0860, -27.2160],  # SW corner
            [153.0920, -27.2160],  # SE corner
            [153.0920, -27.2000],  # NE corner (canal entrance)
            [153.0860, -27.2000],  # NW corner
            [153.0860, -27.2160],  # Close polygon
        ]]
    }
}

# Remove any existing Newport entries (avoid duplicates)
zones['features'] = [f for f in zones['features'] 
                     if f['properties'].get('name', '') not in ('Newport Waterway', 'Newport Waterways Marina')]

zones['features'].append(newport_feature)
zones['features'].append(newport_marina)

with open(zones_path, 'w') as f:
    json.dump(zones, f)

size_kb = os.path.getsize(zones_path) / 1024
print(f"\n✓ Saved: {zones_path} ({size_kb:.0f} KB)")
print(f"  Total features: {len(zones['features'])}")

# Verify boat position detection
boat_lon, boat_lat = 153.088, -27.213
nearest = None
best_d = float('inf')
for f in zones['features']:
    zt = f['properties']['zone_type']
    if zt not in ('waterway_centerline', 'channel_centerline'): continue
    coords = f['geometry']['coordinates']
    for i, c in enumerate(coords):
        d = dist_m(boat_lon, boat_lat, c[0], c[1])
        if d < best_d:
            best_d = d
            nearest = (f['properties']['name'], zt, i)

print(f"\nBoat [{boat_lat}, {boat_lon}] → nearest centerline: {nearest[0]} ({nearest[1]}) at {best_d:.0f}m")

# Check marina containment
from functools import reduce
def pip(px, py, poly):
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

for f in zones['features']:
    if f['properties']['zone_type'] == 'marina':
        coords = f['geometry']['coordinates'][0]
        inside = pip(boat_lon, boat_lat, coords)
        if inside:
            print(f"Boat IS INSIDE: {f['properties']['name']}")
