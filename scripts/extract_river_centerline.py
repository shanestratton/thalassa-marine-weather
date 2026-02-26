"""
Brisbane River Centerline Extraction (via OSM waterway=river LineStrings)
=========================================================================

Instead of computing the Voronoi medial axis from water polygons (which
crashes GEOS on degenerate geometries), this script fetches the actual
waterway=river LineStrings from OSM, which already represent the center
of the navigable channel. Then it routes Dijkstra from Kangaroo Point
to Moreton Bay along those lines.

Usage:
    python scripts/extract_river_centerline.py
"""

import json
import math
import os
import requests
import networkx as nx

# Configuration
KANGAROO_POINT = (-27.4768, 153.0365)
BAY_HANDOFF = (-27.2500, 153.2500)
BBOX = (-27.49, 153.02, -27.25, 153.26)


def haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def fetch_river_centerline():
    """Fetch Brisbane River centerline from OSM waterway LineStrings."""
    print("Fetching river centerline from OpenStreetMap...")
    
    s, w, n, e = BBOX
    
    # Check cache
    cache_file = 'scripts/.waterway_cache.json'
    if os.path.exists(cache_file):
        print("  Using cached response")
        with open(cache_file, 'r') as f:
            data = json.load(f)
    else:
        # Query for waterway=river and waterway=fairway (navigation channels)
        query = f"""
        [out:json][timeout:60];
        (
            way["waterway"="river"]({s},{w},{n},{e});
            way["waterway"="fairway"]({s},{w},{n},{e});
            way["waterway"="canal"]({s},{w},{n},{e});
        );
        (._;>;);
        out body;
        """
        
        import time
        for attempt in range(3):
            resp = requests.post(
                'http://overpass.geofabrik.de/09346c7fd39748578ad67c049f19a017/api/interpreter',
                data={'data': query},
                timeout=60,
            )
            if resp.status_code == 200:
                data = resp.json()
                with open(cache_file, 'w') as f:
                    json.dump(data, f)
                break
            elif resp.status_code in (429, 504):
                wait = 15 * (attempt + 1)
                print(f"  Rate limited ({resp.status_code}), waiting {wait}s...")
                time.sleep(wait)
            else:
                raise ValueError(f"Overpass error {resp.status_code}")
        else:
            raise ValueError("Overpass failed after retries")
    
    elements = data.get('elements', [])
    print(f"  Received {len(elements)} elements")
    
    # Parse nodes
    nodes = {}
    for el in elements:
        if el['type'] == 'node':
            nodes[el['id']] = (el['lon'], el['lat'])
    
    # Parse ways into LineStrings (list of coordinate lists)
    ways = []
    for el in elements:
        if el['type'] == 'way' and 'nodes' in el:
            coords = [nodes[nid] for nid in el['nodes'] if nid in nodes]
            if len(coords) >= 2:
                name = el.get('tags', {}).get('name', '')
                ways.append({
                    'coords': coords,  # (lon, lat) tuples
                    'name': name,
                    'id': el['id'],
                })
    
    print(f"  Found {len(ways)} waterway segments")
    
    # Show what we found
    for w in ways[:10]:
        c = w['coords']
        print(f"    Way {w['id']}: {w['name'] or 'unnamed'} ({len(c)} pts, "
              f"from ({c[0][1]:.4f},{c[0][0]:.4f}) to ({c[-1][1]:.4f},{c[-1][0]:.4f}))")
    
    return ways


def build_graph(ways):
    """Build a NetworkX graph from waterway segments."""
    print("\nBuilding navigation graph...")
    
    G = nx.Graph()
    
    for w in ways:
        coords = w['coords']
        for i in range(len(coords) - 1):
            p1 = coords[i]  # (lon, lat)
            p2 = coords[i + 1]
            dist = haversine_nm(p1[1], p1[0], p2[1], p2[0])
            G.add_edge(p1, p2, weight=dist)
    
    print(f"  Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    print(f"  Connected components: {nx.number_connected_components(G)}")
    
    return G


def snap_to_nearest_node(coord, graph):
    """
    Finds the closest deep-water graph node to the user's dock pin
    using a KDTree spatial index (O(log n) instead of O(n)).
    
    coord: (lat, lon) — user's dock pin
    graph: NetworkX graph from OSM waterway segments
    """
    from scipy.spatial import KDTree
    
    # 1. Extract all node coordinates from the graph
    graph_nodes = list(graph.nodes())  # Each node is (lon, lat)
    
    # 2. Build the spatial tree
    tree = KDTree(graph_nodes)
    
    # 3. Query for the single closest node to the user's dock
    user_point = (coord[1], coord[0])  # Convert (lat, lon) → (lon, lat)
    distance, index = tree.query(user_point)
    nearest_node = graph_nodes[index]
    
    print(f"  Snapped ({coord[0]:.4f}, {coord[1]:.4f}) -> "
          f"({nearest_node[1]:.4f}, {nearest_node[0]:.4f}), dist={distance:.6f} deg")
    return nearest_node


def simplify_path(path, tolerance_nm=0.05):
    """Douglas-Peucker simplification."""
    from shapely.geometry import LineString
    line = LineString(path)
    tol_deg = tolerance_nm / 60
    simplified = line.simplify(tol_deg, preserve_topology=True)
    return list(simplified.coords)


def main():
    print("=" * 60)
    print("Brisbane River Centerline (OSM Waterway Method)")
    print("=" * 60)
    
    # 1. Fetch waterway LineStrings
    ways = fetch_river_centerline()
    
    # 2. Build graph
    G = build_graph(ways)
    
    # 3. Snap start/end
    print("\nSnapping coordinates...")
    start_node = snap_to_nearest_node(KANGAROO_POINT, G)
    end_node = snap_to_nearest_node(BAY_HANDOFF, G)
    
    # 4. Find all connected components and pick the one containing start
    components = list(nx.connected_components(G))
    components.sort(key=len, reverse=True)
    
    for i, comp in enumerate(components[:5]):
        print(f"  Component {i}: {len(comp)} nodes")
    
    # Find component containing start
    start_comp = None
    for comp in components:
        if start_node in comp:
            start_comp = comp
            break
    
    if start_comp is None:
        raise ValueError("Start node not in any component!")
    
    print(f"\n  Start is in component with {len(start_comp)} nodes")
    
    # If end_node is not in same component, find nearest node in start's component
    if end_node not in start_comp:
        print("  End node not in same component, finding closest...")
        best_end = None
        best_dist = float('inf')
        for node in start_comp:
            d = math.hypot(node[0] - end_node[0], node[1] - end_node[1])
            if d < best_dist:
                best_dist = d
                best_end = node
        end_node = best_end
        print(f"  Nearest reachable end: ({end_node[1]:.4f}, {end_node[0]:.4f})")
    
    # 5. Dijkstra
    print("\nRunning Dijkstra...")
    path = nx.shortest_path(G, source=start_node, target=end_node, weight='weight')
    total_dist = nx.shortest_path_length(G, source=start_node, target=end_node, weight='weight')
    print(f"  Path: {len(path)} nodes, {total_dist:.2f} NM")
    
    # 6. Densify: interpolate long segments (max 0.1 NM between points)
    MAX_SEG_NM = 0.1  # ~185m max gap
    dense_path = [path[0]]
    for i in range(1, len(path)):
        p1 = dense_path[-1]
        p2 = path[i]
        seg_dist = haversine_nm(p1[1], p1[0], p2[1], p2[0])
        if seg_dist > MAX_SEG_NM:
            n_segments = int(math.ceil(seg_dist / MAX_SEG_NM))
            for j in range(1, n_segments):
                frac = j / n_segments
                interp_lon = p1[0] + frac * (p2[0] - p1[0])
                interp_lat = p1[1] + frac * (p2[1] - p1[1])
                dense_path.append((interp_lon, interp_lat))
        dense_path.append(p2)
    
    print(f"\nDensified: {len(path)} -> {len(dense_path)} points (max gap {MAX_SEG_NM} NM)")
    
    # 7. Light simplification to remove near-duplicates
    simplified = simplify_path(dense_path, tolerance_nm=0.003)  # ~6m tolerance
    print(f"Simplified: {len(dense_path)} -> {len(simplified)} waypoints")
    
    # 8. Output
    waypoints = []
    for lon, lat in simplified:
        waypoints.append({'lat': round(lat, 5), 'lon': round(lon, 5)})
    
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"Total waypoints: {len(waypoints)}")
    print(f"Total distance: {total_dist:.2f} NM")
    print()
    
    # TypeScript format
    print("egress: [")
    for i, wp in enumerate(waypoints):
        name = f"WP-{i:02d}"
        if i == 0:
            name = "Kangaroo Point"
        elif i == len(waypoints) - 1:
            name = "Bay Handoff"
        print(f'    {{ lat: {wp["lat"]}, lon: {wp["lon"]}, name: "{name}" }},')
    print("]")
    
    # GeoJSON LineString for Mapbox (dock-to-dock)
    geojson_coords = []
    # Prepend exact start pin
    geojson_coords.append([KANGAROO_POINT[1], KANGAROO_POINT[0]])  # [lon, lat]
    # Add simplified centerline waypoints
    for wp in waypoints:
        geojson_coords.append([wp['lon'], wp['lat']])
    # Append exact end pin
    geojson_coords.append([BAY_HANDOFF[1], BAY_HANDOFF[0]])
    
    geojson_feature = {
        'type': 'Feature',
        'properties': {
            'route': 'Brisbane River Egress',
            'distance_nm': round(total_dist, 2),
        },
        'geometry': {
            'type': 'LineString',
            'coordinates': geojson_coords,
        },
    }
    
    # Save JSON + GeoJSON
    output_file = 'scripts/brisbane_river_centerline.json'
    with open(output_file, 'w') as f:
        json.dump({
            'waypoints': waypoints,
            'total_distance_nm': round(total_dist, 2),
            'total_waypoints': len(waypoints),
            'method': 'OSM waterway + KDTree snap + Dijkstra',
            'geojson': geojson_feature,
        }, f, indent=2)
    print(f"\nSaved to {output_file}")
    
    # Also save standalone GeoJSON
    geojson_file = 'scripts/brisbane_river_route.geojson'
    with open(geojson_file, 'w') as f:
        json.dump(geojson_feature, f, indent=2)
    print(f"Saved GeoJSON to {geojson_file}")


if __name__ == '__main__':
    main()
