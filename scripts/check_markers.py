import json

d = json.load(open('thalassa_graph_australia_se_qld_reduced.json'))
n = len(d['nodes'])
markers = d.get('markers', [])
obstacles = d.get('obstacles', [])

bad = [m for m in markers if m[0] >= n]
print(f"Total nodes: {n}")
print(f"Markers: {len(markers)}, invalid indices: {len(bad)}")
print(f"Obstacles: {len(obstacles)}")
print(f"Sample markers: {markers[:5]}")
if bad:
    print(f"BAD markers: {bad[:3]}")
