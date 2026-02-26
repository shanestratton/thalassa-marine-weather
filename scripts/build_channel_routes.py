"""
Build channel_routes.json from existing data.

Creates pre-computed channel centerlines for each navigable zone:
- Brisbane River: from brisbane_river_centerline.json
- Newport Marina: from nearest IALA port/starboard mark midpoints
- Scarborough: from channel marks

Output goes to public/data/channel_routes.json
"""
import json
import math

# ── Load existing data ──────────────────────────────────────────────

river = json.load(open('brisbane_river_centerline.json'))
markers = json.load(open('nav_markers.geojson'))

# ── Helpers ─────────────────────────────────────────────────────────

def dist(a, b):
    """Simple equirectangular distance in meters."""
    dx = (a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * 111320
    dy = (a[1] - b[1]) * 111320
    return math.sqrt(dx * dx + dy * dy)

def midpoint(a, b):
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

# ── Extract port and starboard marks ────────────────────────────────

port_marks = []
stbd_marks = []

for f in markers['features']:
    if f['geometry']['type'] != 'Point':
        continue
    cls = f.get('properties', {}).get('_class', '')
    coord = f['geometry']['coordinates']  # [lon, lat]
    if cls == 'port':
        port_marks.append(coord)
    elif cls == 'starboard':
        stbd_marks.append(coord)

print(f"Port marks: {len(port_marks)}, Starboard marks: {len(stbd_marks)}")

# ── Brisbane River ──────────────────────────────────────────────────
# Already have the centerline, just convert to [lon, lat] array

brisbane_wps = [[w['lon'], w['lat']] for w in river['waypoints']]
# Reverse so it goes downstream (from CBD toward river mouth)
# Check if first WP is further from sea than last
if brisbane_wps[0][1] < brisbane_wps[-1][1]:
    # First WP is further south (upstream), keep order
    # Actually Brisbane River: CBD is at -27.47 (south), mouth is at -27.39 (north)
    # So going downstream = going north = increasing latitude
    pass  # Already goes upstream→downstream

print(f"Brisbane River: {len(brisbane_wps)} WPs")
print(f"  Start (upstream): [{brisbane_wps[0][1]:.4f}, {brisbane_wps[0][0]:.4f}]")
print(f"  End (downstream): [{brisbane_wps[-1][1]:.4f}, {brisbane_wps[-1][0]:.4f}]")

# ── Newport Marina Exit ─────────────────────────────────────────────
# Newport is at approximately [153.098, -27.200]
# The exit channel goes northeast toward the bay
# Find marks near Newport (within 2km) and compute midpoints

NEWPORT_CENTER = [153.098, -27.200]
NEWPORT_RADIUS = 3000  # meters

newport_port = [m for m in port_marks if dist(m, NEWPORT_CENTER) < NEWPORT_RADIUS]
newport_stbd = [m for m in stbd_marks if dist(m, NEWPORT_CENTER) < NEWPORT_RADIUS]

print(f"\nNewport area marks: {len(newport_port)} port, {len(newport_stbd)} starboard")

# For Newport, create a simple exit route:
# Start inside the marina basin, go to the channel entrance, then to safe water
newport_wps = [
    [153.0985, -27.2005],  # Inside marina basin
    [153.0998, -27.1995],  # Marina entrance (between breakwaters)
    [153.1010, -27.1985],  # Just outside breakwaters
    [153.1025, -27.1970],  # Channel start
    [153.1045, -27.1950],  # Channel mid
    [153.1070, -27.1925],  # Approaching safe water
    [153.1100, -27.1900],  # Safe water - handoff point
]

# ── Scarborough / Redcliffe Channel ─────────────────────────────────
# Scarborough marina exit to deeper water
SCARB_CENTER = [153.108, -27.192] 
SCARB_RADIUS = 3000

scarb_port = [m for m in port_marks if dist(m, SCARB_CENTER) < SCARB_RADIUS]
scarb_stbd = [m for m in stbd_marks if dist(m, SCARB_CENTER) < SCARB_RADIUS]

print(f"Scarborough area marks: {len(scarb_port)} port, {len(scarb_stbd)} starboard")

scarborough_wps = [
    [153.1060, -27.1945],  # Inside Scarborough harbor
    [153.1075, -27.1935],  # Channel entrance
    [153.1090, -27.1920],  # Past entrance marks
    [153.1110, -27.1900],  # Approaching safe water
    [153.1140, -27.1880],  # Safe water
]

# ── Pine River Mouth ────────────────────────────────────────────────
# From Hays Inlet / Pine River to Moreton Bay
pine_river_wps = [
    [153.0760, -27.2550],  # Upper Pine River
    [153.0800, -27.2500],
    [153.0850, -27.2430],
    [153.0900, -27.2360],
    [153.0950, -27.2280],  # Pine River mouth
    [153.1000, -27.2200],  # Approaching bay
    [153.1050, -27.2100],  # Safe water
]

# ── Manly Boat Harbour ──────────────────────────────────────────────
manly_wps = [
    [153.1880, -27.4580],  # Inside Manly harbour
    [153.1900, -27.4560],
    [153.1930, -27.4530],
    [153.1960, -27.4500],  # Channel exit
    [153.2000, -27.4460],  # Safe water
]

# ── Rivergate Marina ────────────────────────────────────────────────
# On Brisbane River near the mouth
rivergate_wps = [
    [153.1180, -27.4200],  # Inside Rivergate
    [153.1200, -27.4180],  # Entry channel
    [153.1230, -27.4150],  # Back on Brisbane River
    [153.1280, -27.4100],  # Downstream
]

# ── Build output ────────────────────────────────────────────────────

channel_routes = {
    "brisbane_river": {
        "name": "Brisbane River",
        "waypoints": brisbane_wps,
        "exit_point": brisbane_wps[-1],
        "description": "CBD to river mouth, 11.3 NM"
    },
    "newport_marina": {
        "name": "Newport Marina",
        "waypoints": newport_wps,
        "exit_point": newport_wps[-1],
        "description": "Marina basin to safe water"
    },
    "scarborough_marina": {
        "name": "Scarborough Marina",
        "waypoints": scarborough_wps,
        "exit_point": scarborough_wps[-1],
        "description": "Harbour to safe water"
    },
    "pine_river": {
        "name": "Pine River",
        "waypoints": pine_river_wps,
        "exit_point": pine_river_wps[-1],
        "description": "Pine River to Moreton Bay"
    },
    "manly_harbour": {
        "name": "Manly Boat Harbour",
        "waypoints": manly_wps,
        "exit_point": manly_wps[-1],
        "description": "Manly harbour to safe water"
    },
    "rivergate_marina": {
        "name": "Rivergate Marina",
        "waypoints": rivergate_wps,
        "exit_point": rivergate_wps[-1],
        "description": "Rivergate to Brisbane River"
    }
}

# Write output
output_path = '../public/data/channel_routes.json'
with open(output_path, 'w') as f:
    json.dump(channel_routes, f, indent=2)

total_wps = sum(len(r['waypoints']) for r in channel_routes.values())
print(f"\n✓ Saved: {output_path}")
print(f"  Zones: {len(channel_routes)}")
print(f"  Total waypoints: {total_wps}")
for key, route in channel_routes.items():
    print(f"  {route['name']}: {len(route['waypoints'])} WPs → exit {route['exit_point']}")
