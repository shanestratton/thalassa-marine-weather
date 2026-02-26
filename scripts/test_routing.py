#!/usr/bin/env python3
"""Quick local test: load the graph, run Dijkstra, report waypoint count."""

import json
import math
import sys
import time

def haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return 2 * R * math.asin(min(1, math.sqrt(a)))

def snap(lat, lon, nodes):
    best_idx, best_dist = 0, float('inf')
    for i, n in enumerate(nodes):
        if abs(n[1]-lat) > 0.5 or abs(n[0]-lon) > 0.5:
            continue
        d = haversine_nm(lat, lon, n[1], n[0])
        if d < best_dist:
            best_dist = d
            best_idx = i
    return best_idx, best_dist

import heapq

def dijkstra(start, end, adj, n_nodes):
    dist = [float('inf')] * n_nodes
    dist[start] = 0
    prev = [-1] * n_nodes
    heap = [(0, start)]
    expanded = 0
    while heap:
        d, u = heapq.heappop(heap)
        if u == end:
            path = []
            cur = end
            while cur != -1:
                path.append(cur)
                cur = prev[cur]
            path.reverse()
            return path, dist[end], expanded
        if d > dist[u]:
            continue
        expanded += 1
        for v, w in adj[u]:
            nd = dist[u] + w
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    return None, float('inf'), expanded

def main():
    graph_file = sys.argv[1] if len(sys.argv) > 1 else "thalassa_graph_australia_se_qld.json"
    
    print(f"Loading {graph_file}...")
    t0 = time.time()
    with open(graph_file, 'r') as f:
        g = json.load(f)
    
    nodes = g['nodes']
    edges = g['edges']
    print(f"  Loaded: {len(nodes):,} nodes, {len(edges):,} edges in {time.time()-t0:.1f}s")
    print(f"  File size: {len(json.dumps(g, separators=(',',':'))):,} bytes")
    
    # Build adjacency
    adj = [[] for _ in range(len(nodes))]
    for e in edges:
        adj[e[0]].append((e[1], e[2]))
        adj[e[1]].append((e[0], e[2]))
    
    # Test routes
    tests = [
        ("Brisbane CBD -> Moreton Bay (Scarborough)", -27.4698, 153.0251, -27.2, 153.1),
        ("Brisbane -> Manly", -27.4698, 153.0251, -27.4587, 153.1842),
        ("Manly -> Tangalooma", -27.4587, 153.1842, -27.1840, 153.3740),
    ]
    
    for name, olat, olon, dlat, dlon in tests:
        print(f"\n{'='*50}")
        print(f"  Route: {name}")
        
        si, sd = snap(olat, olon, nodes)
        ei, ed = snap(dlat, dlon, nodes)
        print(f"  Origin snap: node[{si}] ({sd:.2f} NM)")
        print(f"  Dest snap:   node[{ei}] ({ed:.2f} NM)")
        
        t1 = time.time()
        result = dijkstra(si, ei, adj, len(nodes))
        elapsed = (time.time() - t1) * 1000
        
        if result[0]:
            path, cost, expanded = result
            # Compute actual distance
            total_nm = 0
            for i in range(1, len(path)):
                total_nm += haversine_nm(nodes[path[i-1]][1], nodes[path[i-1]][0], nodes[path[i]][1], nodes[path[i]][0])
            print(f"  Result: {len(path)} waypoints, {total_nm:.1f} NM, {elapsed:.0f}ms ({expanded:,} expanded)")
            print(f"  First 3: {[(round(nodes[p][1],4), round(nodes[p][0],4)) for p in path[:3]]}")
            print(f"  Last 3:  {[(round(nodes[p][1],4), round(nodes[p][0],4)) for p in path[-3:]]}")
        else:
            print(f"  NO PATH FOUND ({expanded:,} expanded, {elapsed:.0f}ms)")

if __name__ == '__main__':
    main()
