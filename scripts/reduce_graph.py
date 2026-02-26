#!/usr/bin/env python3
"""
Post-process the unsimplified nav graph to reduce node count
while preserving waterway geometry using Douglas-Peucker-style
chain simplification with angle tolerance.

Instead of the old approach (merge ALL degree-2 nodes → straight lines),
this keeps intermediate nodes where the route turns significantly.
"""

import json
import gzip
import math
import os
import sys
import time

COORD_PRECISION = 5


def haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    """Bearing in degrees from point 1 to point 2."""
    dlon = math.radians(lon2 - lon1)
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 360


def angle_change(b1, b2):
    """Smallest angle between two bearings (0-180)."""
    diff = abs(b1 - b2)
    return min(diff, 360 - diff)


def simplify_graph(graph, angle_threshold=5.0, min_edge_nm=0.01):
    """
    Simplify degree-2 chains but KEEP nodes where direction changes
    by more than angle_threshold degrees.
    
    This preserves waterway curvature (bends, turns) while removing
    redundant points on straight segments.
    """
    import networkx as nx
    
    nodes = graph['nodes']  # [[lon, lat], ...]
    edges = graph['edges']  # [[from, to, weight], ...]
    
    # Build adjacency
    adj = {}
    for i in range(len(nodes)):
        adj[i] = []
    for e in edges:
        f, t, w = e[0], e[1], e[2]
        adj[f].append((t, w))
        adj[t].append((f, w))
    
    # Find degree-2 nodes that are on straight segments
    to_remove = set()
    kept_for_angle = 0
    kept_for_edge = 0
    
    for node_idx in range(len(nodes)):
        neighbors = adj[node_idx]
        if len(neighbors) != 2:
            continue  # Only simplify degree-2 nodes
        
        n1_idx, w1 = neighbors[0]
        n2_idx, w2 = neighbors[1]
        
        if n1_idx == n2_idx:
            continue  # Self-loop
        
        # Get coordinates
        lon0, lat0 = nodes[node_idx]
        lon1, lat1 = nodes[n1_idx]
        lon2, lat2 = nodes[n2_idx]
        
        # Calculate bearing change at this node
        b_in = bearing(lat1, lon1, lat0, lon0)
        b_out = bearing(lat0, lon0, lat2, lon2)
        turn = angle_change(b_in, b_out)
        
        if turn > angle_threshold:
            kept_for_angle += 1
            continue  # Keep this node - significant turn
        
        # Check minimum edge length - keep nodes that are far apart
        if w1 > min_edge_nm * 10 and w2 > min_edge_nm * 10:
            # Both edges are significant, keep node to maintain density
            # (but only if the total chain is long)
            pass
        
        # This node is on a straight segment, safe to remove
        to_remove.add(node_idx)
    
    print(f"  Simplification: {len(to_remove):,} removable, {kept_for_angle:,} kept for angle > {angle_threshold}°")
    
    # Build new graph without removed nodes
    # Remap node indices
    old_to_new = {}
    new_nodes = []
    for i, node in enumerate(nodes):
        if i not in to_remove:
            old_to_new[i] = len(new_nodes)
            new_nodes.append(node)
    
    # Rebuild edges, merging chains through removed nodes
    # Use BFS to find chains
    visited_edges = set()
    new_edges = []
    
    for i in range(len(nodes)):
        if i in to_remove:
            continue
        for neighbor, weight in adj[i]:
            edge_key = (min(i, neighbor), max(i, neighbor))
            if edge_key in visited_edges:
                continue
            visited_edges.add(edge_key)
            
            if neighbor not in to_remove:
                # Direct edge between two kept nodes
                new_edges.append([old_to_new[i], old_to_new[neighbor], weight])
            else:
                # Follow the chain through removed nodes
                chain_weight = weight
                current = neighbor
                prev = i
                while current in to_remove:
                    for next_node, next_weight in adj[current]:
                        if next_node != prev:
                            chain_weight += next_weight
                            prev = current
                            current = next_node
                            break
                    else:
                        break
                
                if current not in to_remove and current != i:
                    chain_key = (min(i, current), max(i, current))
                    if chain_key not in visited_edges:
                        new_edges.append([old_to_new[i], old_to_new[current], round(chain_weight, 3)])
                        visited_edges.add(chain_key)
    
    graph['nodes'] = new_nodes
    graph['edges'] = new_edges
    graph['meta']['nodes'] = len(new_nodes)
    graph['meta']['edges'] = len(new_edges)

    # Remap marker node indices (markers reference old node indices)
    if 'markers' in graph:
        remapped = []
        for m in graph['markers']:
            old_idx = m[0]
            if old_idx in old_to_new:
                remapped.append([old_to_new[old_idx], m[1]])
        dropped = len(graph['markers']) - len(remapped)
        graph['markers'] = remapped
        graph['meta']['markers'] = len(remapped)
        print(f"  Markers: {len(remapped)} remapped, {dropped} dropped (nodes simplified away)")

    return graph


def main():
    if len(sys.argv) < 2:
        print("Usage: python reduce_graph.py <input.json> [angle_threshold]")
        print("  angle_threshold: degrees (default 5.0) — higher = more aggressive simplification")
        sys.exit(1)
    
    input_path = sys.argv[1]
    angle_threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    
    print("=" * 60)
    print("Thalassa — Graph Reducer")
    print("=" * 60)
    print(f"  Input: {input_path}")
    print(f"  Angle threshold: {angle_threshold}°")
    print()
    
    t0 = time.time()
    
    with open(input_path, 'r') as f:
        graph = json.load(f)
    
    orig_nodes = graph['meta']['nodes']
    orig_edges = graph['meta']['edges']
    print(f"  Original: {orig_nodes:,} nodes, {orig_edges:,} edges")
    
    graph = simplify_graph(graph, angle_threshold=angle_threshold)
    
    new_nodes = graph['meta']['nodes']
    new_edges = graph['meta']['edges']
    reduction = (1 - new_nodes / orig_nodes) * 100
    print(f"  Reduced:  {new_nodes:,} nodes, {new_edges:,} edges ({reduction:.0f}% reduction)")
    
    # Write output
    output_path = input_path.replace('.json', '_reduced.json')
    json_str = json.dumps(graph, separators=(',', ':'))
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(json_str)
    
    gz_path = output_path + '.gz'
    with gzip.open(gz_path, 'wt', encoding='utf-8', compresslevel=9) as f:
        f.write(json_str)
    
    raw_mb = len(json_str.encode()) / 1024 / 1024
    gz_mb = os.path.getsize(gz_path) / 1024 / 1024
    
    print(f"\n  Output: {output_path}")
    print(f"  Raw: {raw_mb:.1f} MB, Gzipped: {gz_mb:.1f} MB")
    print(f"  Time: {time.time() - t0:.1f}s")
    print("=" * 60)


if __name__ == '__main__':
    main()
