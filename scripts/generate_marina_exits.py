"""
Generate marina_exits.json with pre-computed channel waypoints.

For each marina:
  - exit WP (canal mouth)
  - channel_waypoints: ordered [lon, lat] from canal mouth to open water
  - channel_end: far end of channel (open water)

This replaces the runtime followNearestChannel logic.
"""
import json, math, os

def dist_m(lat1, lon1, lat2, lon2):
    dx = (lon2 - lon1) * math.cos(math.radians((lat1+lat2)/2)) * 111320
    dy = (lat2 - lat1) * 111320
    return math.sqrt(dx*dx + dy*dy)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    geojson_path = os.path.normpath(os.path.join(script_dir, "..", "public", "data", "waterway_zones.geojson"))
    exits_path = os.path.normpath(os.path.join(script_dir, "..", "public", "data", "marina_exits.json"))
    
    data = json.load(open(geojson_path))
    features = data['features']
    exits = json.load(open(exits_path))
    
    channels = [f for f in features if f['properties'].get('zone_type') == 'channel_centerline']
    
    updated = 0
    
    for name, ex in exits.items():
        exit_lat, exit_lon = ex['exit_lat'], ex['exit_lon']
        centroid_lat = ex.get('centroid_lat', exit_lat)
        centroid_lon = ex.get('centroid_lon', exit_lon)
        
        # Find closest channel to exit WP
        best_ch = None
        best_d = 99999
        best_idx = 0
        
        for ch in channels:
            if ch['geometry']['type'] != 'LineString':
                continue
            coords = ch['geometry']['coordinates']
            for i, c in enumerate(coords):
                d = dist_m(exit_lat, exit_lon, c[1], c[0])
                if d < best_d:
                    best_d = d
                    best_ch = ch
                    best_idx = i
        
        if not best_ch or best_d > 500:
            # No nearby channel — clear any old channel data
            ex['channel_waypoints'] = []
            continue
        
        coords = best_ch['geometry']['coordinates']
        ch_name = best_ch['properties'].get('name', 'Unnamed')
        
        # Determine direction: from marina → open water
        # "Open water" = end farthest from marina centroid
        d_start = dist_m(centroid_lat, centroid_lon, coords[0][1], coords[0][0])
        d_end = dist_m(centroid_lat, centroid_lon, coords[-1][1], coords[-1][0])
        
        if d_end > d_start:
            # End is farther from marina → follow from snap to end
            channel_wps = coords[best_idx:]
        else:
            # Start is farther from marina → follow from snap to start (reversed)
            channel_wps = list(reversed(coords[:best_idx+1]))
        
        # Store as [lon, lat] arrays
        ex['channel_waypoints'] = [[round(c[0], 6), round(c[1], 6)] for c in channel_wps]
        ex['channel_name'] = ch_name
        ex['nearest_channel'] = ch_name
        
        print(f"  {name}: {len(channel_wps)} channel WPs via {ch_name} (snap {best_d:.0f}m)")
        updated += 1
    
    with open(exits_path, 'w') as f:
        json.dump(exits, f, indent=2)
    
    print(f"\nUpdated {updated} marinas with channel waypoints → {exits_path}")

if __name__ == "__main__":
    main()
