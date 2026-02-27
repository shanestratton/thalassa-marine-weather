"""
Rebuild the Newport canal centerline using REAL OSM coordinates.

The canal network layout (from Overpass data):
- Albatross Canal (main trunk): runs NW from deep inside Newport
  Two segments: id=655491186 (south) → id=655491185 (north)
  655491186: from [153.1005, -27.2173] to [153.0973, -27.2149]
  655491185: from [153.0973, -27.2149] to [153.0929, -27.2043]
  → The canal goes north along the main waterway
  
- At the north end, Albatross connects to the harbour entrance
  via canal_718772208 which goes west toward the bay

The route should be:
1. Start in Albatross Canal (south end, near the boat)
2. Follow Albatross Canal north (19 pts)
3. Connect to the harbour entrance
4. Follow IALA channel marks out to sea
"""
import json, math

zones = json.load(open('../public/data/waterway_zones.geojson'))

def dist_m(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111320
    dy = (lat2 - lat1) * 111320
    return math.sqrt(dx * dx + dy * dy)

# ── REAL OSM canal coordinates ──────────────────────────────────

# Albatross Canal segment 1 (south, id=655491186): SE → NW
albatross_south = [
    [153.1005083, -27.2173494],
    [153.1001929, -27.2170599],
    [153.1000971, -27.2169342],
    [153.1000242, -27.2168050],
    [153.0999058, -27.2164865],
    [153.0998771, -27.2164208],
    [153.0997941, -27.2163020],
    [153.0996864, -27.2161813],
    [153.0994811, -27.2160104],
    [153.0993179, -27.2158907],
    [153.0991647, -27.2158180],
    [153.0989657, -27.2157370],
    [153.0988765, -27.2157007],
    [153.0986556, -27.2156215],
    [153.0983629, -27.2155167],
    [153.0981449, -27.2154170],
    [153.0973112, -27.2148853],
]

# Albatross Canal segment 2 (north, id=655491185): continues NW then N
albatross_north = [
    [153.0973112, -27.2148853],  # connects to south segment
    [153.0966807, -27.2144363],
    [153.0961852, -27.2140213],
    [153.0954954, -27.2134015],
    [153.0950679, -27.2129616],
    [153.0947553, -27.2125768],
    [153.0938811, -27.2113997],
    [153.0937374, -27.2110866],
    [153.0935509, -27.2106806],
    [153.0933292, -27.2102040],
    [153.0931945, -27.2097967],
    [153.0931029, -27.2094661],
    [153.0929335, -27.2087462],
    [153.0928727, -27.2084862],
    [153.0928003, -27.2079367],
    [153.0927551, -27.2075939],
    [153.0927606, -27.2072597],
    [153.0927659, -27.2069373],
    [153.0929158, -27.2042502],
]

# Canal from harbour entrance westward (id=718772208) - 
# connects to Albatross via the canal junction
harbour_approach = [
    [153.0929158, -27.2042502],  # connects from Albatross north end
    [153.0918804, -27.2082703],  # unnamed canal connection
    [153.0914749, -27.2083617],  # continuing toward the bay
    [153.0903904, -27.2087043],
]

# Build the combined route: boat position → Albatross south → north → harbour
# The boat starts near the south end of Albatross Canal
# We need to REVERSE the south segment (it goes SE→NW, we want SE→NW which is correct direction)

# Full canal route from deep in Newport to harbour entrance
full_canal = albatross_south + albatross_north[1:]  # skip duplicate junction point

# Total length
total_m = sum(dist_m(full_canal[i][0], full_canal[i][1], 
                     full_canal[i+1][0], full_canal[i+1][1]) 
              for i in range(len(full_canal)-1))

print(f"Newport Canal centerline: {len(full_canal)} points, {total_m:.0f}m ({total_m/1852:.1f} NM)")
print(f"  Start: [{full_canal[0][0]:.6f}, {full_canal[0][1]:.6f}]")
print(f"  End:   [{full_canal[-1][0]:.6f}, {full_canal[-1][1]:.6f}]")

# Check: how close is the boat to the start?
BOAT = (153.090, -27.210)
start_d = dist_m(BOAT[0], BOAT[1], full_canal[0][0], full_canal[0][1])
# Find nearest point
nearest_d = float('inf')
nearest_i = 0
for i, c in enumerate(full_canal):
    d = dist_m(BOAT[0], BOAT[1], c[0], c[1])
    if d < nearest_d:
        nearest_d = d
        nearest_i = i

print(f"\n  Boat [{BOAT[1]:.4f}, {BOAT[0]:.4f}] → nearest point: idx {nearest_i}, {nearest_d:.0f}m")
print(f"  Start dist: {start_d:.0f}m")

# Now find the existing Newport Channel IALA centerline
print("\nConnecting to IALA channel marks...")
for f in zones['features']:
    if f['properties'].get('name') == 'Newport Channel' and f['properties'].get('zone_type') == 'channel_centerline':
        iala = f['geometry']['coordinates']
        print(f"  Found Newport Channel: {len(iala)} pts")
        # Check distance from canal end to IALA start/end
        d_start = dist_m(full_canal[-1][0], full_canal[-1][1], iala[0][0], iala[0][1])
        d_end = dist_m(full_canal[-1][0], full_canal[-1][1], iala[-1][0], iala[-1][1])
        print(f"  Canal end → IALA start: {d_start:.0f}m")
        print(f"  Canal end → IALA end: {d_end:.0f}m")
        
        if d_start <= d_end:
            connected = full_canal + iala
        else:
            connected = full_canal + list(reversed(iala))
        
        total_m2 = sum(dist_m(connected[i][0], connected[i][1],
                              connected[i+1][0], connected[i+1][1])
                       for i in range(len(connected)-1))
        print(f"\n  FULL ROUTE: {len(connected)} points, {total_m2:.0f}m ({total_m2/1852:.1f} NM)")
        break

# ─── Update waterway_zones.geojson ───────────────────────────────

# Remove old Newport Canal
zones['features'] = [f for f in zones['features'] 
                     if f['properties'].get('name') not in ('Newport Canal', 'Newport Waterway')]

# Add the new one (just the canal, NOT connected to IALA - keep them separate
# so the chaining logic handles the connection)
zones['features'].append({
    "type": "Feature",
    "properties": {
        "zone_type": "channel_centerline",
        "name": "Newport Canal",
        "source": "osm_overpass",
        "length_m": round(total_m),
    },
    "geometry": {
        "type": "LineString",
        "coordinates": full_canal
    }
})

# Also update the marina polygon to better cover the actual canal area
# Remove old Newport marina
zones['features'] = [f for f in zones['features'] 
                     if f['properties'].get('name') != 'Newport Waterways Marina']

# Add a proper marina polygon covering the Albatross Canal area
zones['features'].append({
    "type": "Feature",
    "properties": {
        "zone_type": "marina",
        "name": "Newport Waterways Marina",
        "source": "manual_from_osm_canals",
    },
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [153.085, -27.220],   # SW
            [153.105, -27.220],   # SE
            [153.105, -27.200],   # NE (past canal entrance)
            [153.085, -27.200],   # NW
            [153.085, -27.220],   # Close
        ]]
    }
})

# Also add ALL the individual OSM canals as waterway_centerlines
# This gives the chaining logic more options to find routes
osm_canals = {
    "Jabiru Canal": [
        [153.0876324, -27.2145164], [153.0877677, -27.2136437], [153.0878261, -27.2133600],
        [153.0878862, -27.2132040], [153.0879867, -27.2130387], [153.0882433, -27.2128078],
        [153.0885276, -27.2125776], [153.0899381, -27.2116645], [153.0905267, -27.2113047],
        [153.0922886, -27.2102277], [153.0927544, -27.2099662], [153.0929525, -27.2098715],
        [153.0931945, -27.2097967],
    ],
    "Kingfisher Canal": [
        [153.0984610, -27.2057001], [153.0980209, -27.2059129], [153.0977556, -27.2060104],
        [153.0934476, -27.2072276], [153.0932305, -27.2072582], [153.0930098, -27.2072675],
        [153.0927606, -27.2072597],
    ],
    "Sandpiper Canal": [
        [153.0994204, -27.2067848], [153.0990295, -27.2069945], [153.0984461, -27.2071980],
        [153.0941057, -27.2084080], [153.0938843, -27.2084583], [153.0936306, -27.2084960],
        [153.0934047, -27.2085085], [153.0928727, -27.2084862],
    ],
}

# Add them with existing IDs to avoid duplicates
existing_names = set(f['properties'].get('name', '') for f in zones['features'])
for name, coords in osm_canals.items():
    if name not in existing_names:
        zones['features'].append({
            "type": "Feature",
            "properties": {
                "zone_type": "waterway_centerline",
                "waterway": "canal",
                "name": name,
                "source": "osm_overpass",
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coords
            }
        })

# Save
import os
output_path = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
with open(output_path, 'w') as f:
    json.dump(zones, f)

size_kb = os.path.getsize(output_path) / 1024
print(f"\n✓ Saved {output_path} ({size_kb:.0f} KB, {len(zones['features'])} features)")
