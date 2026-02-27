"""
Merge Newport Canal + Newport Channel IALA into ONE continuous centerline.
This eliminates the chaining gap that causes the route to pick side canals.
"""
import json, math

zones = json.load(open('../public/data/waterway_zones.geojson'))

def dist_m(lon1, lat1, lon2, lat2):
    dx = (lon2-lon1)*math.cos(math.radians((lat1+lat2)/2))*111320
    dy = (lat2-lat1)*111320
    return math.sqrt(dx*dx + dy*dy)

# Find components
canal = None
channel = None
canal_idx = None
channel_idx = None

for i, f in enumerate(zones['features']):
    n = f['properties'].get('name','')
    zt = f['properties'].get('zone_type','')
    if n == 'Newport Canal' and zt == 'channel_centerline':
        canal = f['geometry']['coordinates']
        canal_idx = i
        print(f'Newport Canal: {len(canal)} pts, [{canal[0][0]:.5f},{canal[0][1]:.5f}] → [{canal[-1][0]:.5f},{canal[-1][1]:.5f}]')
    elif n == 'Newport Channel' and zt == 'channel_centerline':
        channel = f['geometry']['coordinates'] 
        channel_idx = i
        print(f'Newport Channel: {len(channel)} pts, [{channel[0][0]:.5f},{channel[0][1]:.5f}] → [{channel[-1][0]:.5f},{channel[-1][1]:.5f}]')

if not canal or not channel:
    print("ERROR: Missing canal or channel!")
    exit(1)

# Figure out correct ordering: canal south→north, then channel to open water
# Canal end should connect to channel start (or channel end, check which is closer)
d_cs = dist_m(canal[-1][0], canal[-1][1], channel[0][0], channel[0][1])
d_ce = dist_m(canal[-1][0], canal[-1][1], channel[-1][0], channel[-1][1])
print(f'\nCanal end → Channel start: {d_cs:.0f}m')
print(f'Canal end → Channel end:   {d_ce:.0f}m')

if d_cs <= d_ce:
    # Canal end connects to channel start — perfect order
    merged = canal + channel
    print(f'Merged: canal → channel (natural order)')
else:
    # Channel is reversed — flip it
    merged = canal + list(reversed(channel))
    print(f'Merged: canal → reversed(channel)')

# Calculate total length
total_m = sum(dist_m(merged[i][0], merged[i][1], merged[i+1][0], merged[i+1][1]) 
              for i in range(len(merged)-1))

print(f'\nMerged centerline: {len(merged)} pts, {total_m:.0f}m ({total_m/1852:.2f} NM)')
print(f'  Start: [{merged[0][0]:.6f}, {merged[0][1]:.6f}]')
print(f'  End:   [{merged[-1][0]:.6f}, {merged[-1][1]:.6f}]')

# Remove old Newport Canal and Newport Channel, add merged version
zones['features'] = [f for i, f in enumerate(zones['features']) 
                     if i not in (canal_idx, channel_idx)]

zones['features'].append({
    "type": "Feature",
    "properties": {
        "zone_type": "channel_centerline",
        "name": "Newport Exit Route",
        "source": "merged_osm_iala",
        "length_m": round(total_m),
    },
    "geometry": {
        "type": "LineString",
        "coordinates": merged
    }
})

# Save
import os
output = os.path.join('..', 'public', 'data', 'waterway_zones.geojson')
with open(output, 'w') as f:
    json.dump(zones, f)

sz = os.path.getsize(output) / 1024
print(f'\n✓ Saved {output} ({sz:.0f} KB, {len(zones["features"])} features)')
print(f'  ONE centerline now goes from marina to open water: "Newport Exit Route"')
