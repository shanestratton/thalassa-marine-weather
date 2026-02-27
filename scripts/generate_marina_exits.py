"""
Auto-generate marina exit waypoints for SE QLD.

For each marina polygon in waterway_zones.geojson, finds the exit point:
- The point on the marina boundary closest to the nearest channel_centerline
- Or the northernmost point (toward open water in SE QLD)

Output: public/data/marina_exits.json
"""
import json
import math
import os

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    geojson_path = os.path.join(script_dir, "..", "public", "data", "waterway_zones.geojson")
    geojson_path = os.path.normpath(geojson_path)
    
    data = json.load(open(geojson_path))
    features = data['features']
    
    marinas = [f for f in features if f['properties'].get('zone_type') == 'marina']
    channels = [f for f in features if f['properties'].get('zone_type') == 'channel_centerline']
    
    print(f"Marinas: {len(marinas)}, Channels: {len(channels)}")
    
    # Get all channel endpoints (the end of each channel_centerline)
    channel_endpoints = []
    for ch in channels:
        if ch['geometry']['type'] == 'LineString':
            coords = ch['geometry']['coordinates']
            # Both endpoints
            channel_endpoints.append({
                'lon': coords[0][0], 'lat': coords[0][1],
                'name': ch['properties'].get('name', 'Channel')
            })
            channel_endpoints.append({
                'lon': coords[-1][0], 'lat': coords[-1][1],
                'name': ch['properties'].get('name', 'Channel')
            })
            # Also add midpoints for better coverage
            for i in range(0, len(coords), max(1, len(coords)//5)):
                channel_endpoints.append({
                    'lon': coords[i][0], 'lat': coords[i][1],
                    'name': ch['properties'].get('name', 'Channel')
                })
    
    print(f"Channel reference points: {len(channel_endpoints)}")
    
    exits = {}
    
    for marina in marinas:
        name = marina['properties'].get('name', 'Unknown')
        geom = marina['geometry']
        
        if geom['type'] != 'Polygon':
            continue
            
        # Get all boundary vertices
        boundary = geom['coordinates'][0]  # outer ring
        
        if not boundary:
            continue
        
        # Strategy 1: Find boundary vertex closest to any channel endpoint
        best_vertex = None
        best_dist = float('inf')
        best_channel = None
        
        for vertex in boundary:
            vlon, vlat = vertex[0], vertex[1]
            for ep in channel_endpoints:
                d = haversine_m(vlat, vlon, ep['lat'], ep['lon'])
                if d < best_dist:
                    best_dist = d
                    best_vertex = vertex
                    best_channel = ep['name']
        
        # Strategy 2: Fallback — northernmost vertex (toward bay in SE QLD)
        if not best_vertex or best_dist > 2000:
            north_vertex = max(boundary, key=lambda v: v[1])  # highest latitude (least negative)
            best_vertex = north_vertex
            best_channel = "northernmost"
        
        exit_lon = round(best_vertex[0], 6)
        exit_lat = round(best_vertex[1], 6)
        
        # Compute marina centroid for reference
        centroid_lon = sum(v[0] for v in boundary) / len(boundary)
        centroid_lat = sum(v[1] for v in boundary) / len(boundary)
        
        exits[name] = {
            'exit_lat': exit_lat,
            'exit_lon': exit_lon,
            'centroid_lat': round(centroid_lat, 6),
            'centroid_lon': round(centroid_lon, 6),
            'nearest_channel': best_channel,
            'channel_dist_m': round(best_dist, 0),
        }
        
        print(f"  {name}: exit=[{exit_lat:.5f}, {exit_lon:.5f}], channel={best_channel} @ {best_dist:.0f}m")
    
    # Output
    out_path = os.path.join(script_dir, "..", "public", "data", "marina_exits.json")
    out_path = os.path.normpath(out_path)
    
    with open(out_path, 'w') as f:
        json.dump(exits, f, indent=2)
    
    print(f"\nWritten {len(exits)} marina exits to {out_path}")

if __name__ == "__main__":
    main()
