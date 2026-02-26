"""Quick diagnostic: test graph connectivity."""
import json, math, networkx as nx

d = json.load(open('thalassa_graph_se_queensland.json'))

def hav(lat1, lon1, lat2, lon2):
    r = 3440.065
    la1,lo1,la2,lo2 = map(math.radians, [lat1,lon1,lat2,lon2])
    dl = la2-la1; dn = lo2-lo1
    a = math.sin(dl/2)**2 + math.cos(la1)*math.cos(la2)*math.sin(dn/2)**2
    return 2*r*math.asin(math.sqrt(a))

# Test points
points = {
    'Newport': (-27.21, 153.09),
    'Port of Brisbane': (-27.38, 153.17),
    'Murarrie/Rivergate': (-27.48, 153.10),
    'Gold Coast Seaway': (-27.94, 153.43),
}

# Build NetworkX graph
G = nx.Graph()
for edge in d['edges']:
    G.add_edge(edge[0], edge[1], weight=edge[2])

components = sorted(nx.connected_components(G), key=len, reverse=True)
print(f"Graph: {len(d['nodes'])} nodes, {len(d['edges'])} edges")
print(f"Components: {len(components)} (top 5 sizes: {[len(c) for c in components[:5]]})")
print()

# Snap each point and check component
for name, (lat, lon) in points.items():
    best_i, best_d = 0, 9999
    for i, n in enumerate(d['nodes']):
        dd = hav(lat, lon, n[1], n[0])
        if dd < best_d:
            best_d = dd
            best_i = i
    
    # Find which component this node is in
    comp_idx = -1
    for ci, comp in enumerate(components):
        if best_i in comp:
            comp_idx = ci
            break
    
    print(f"{name}: snaps to [{best_i}] at {best_d:.2f}NM, coord={d['nodes'][best_i]}, component #{comp_idx} (size={len(components[comp_idx])})")

# Test route between Newport and Port of Brisbane
print()
snap_np = 0
snap_pb = 0
best_np, best_pb = 9999, 9999
for i, n in enumerate(d['nodes']):
    d1 = hav(-27.21, 153.09, n[1], n[0])
    d2 = hav(-27.38, 153.17, n[1], n[0])
    if d1 < best_np: best_np = d1; snap_np = i
    if d2 < best_pb: best_pb = d2; snap_pb = i

try:
    path = nx.dijkstra_path(G, snap_np, snap_pb, weight='weight')
    dist = nx.dijkstra_path_length(G, snap_np, snap_pb, weight='weight')
    print(f"Route Newport->Port of Brisbane: {len(path)} nodes, {dist:.1f} NM")
except nx.NetworkXNoPath:
    print(f"No path between Newport [{snap_np}] and Port of Brisbane [{snap_pb}]")
    print(f"They are in different components!")
