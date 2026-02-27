"""
Extract waterway graph from Overpass API for SE QLD.

Pulls all waterway=canal|river|fairway ways with their nodes,
preserving connectivity at junctions (shared OSM nodes).

Output: public/data/waterway_graph.json
"""

import json
import math
import requests
import sys
from collections import defaultdict

# SE QLD bounding box: Gold Coast to Noosa
BBOX = "-28.0,152.8,-26.3,153.6"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY = f"""
[out:json][timeout:120];
(
  way["waterway"~"canal|river|fairway|drain"]({BBOX});
  way["seamark:type"="fairway"]({BBOX});
  way["route"="ferry"]["motor_vehicle"="yes"]({BBOX});
);
out body;
>;
out skel qt;
"""


def haversine_m(lat1, lon1, lat2, lon2):
    """Distance in meters between two lat/lon points."""
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def main():
    print(f"[Overpass] Querying waterways in SE QLD ({BBOX})...")
    resp = requests.post(OVERPASS_URL, data={"data": QUERY}, timeout=180)
    resp.raise_for_status()
    data = resp.json()

    elements = data.get("elements", [])
    print(f"[Overpass] Received {len(elements)} elements")

    # Separate nodes and ways
    nodes = {}
    ways = []

    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = {"lat": el["lat"], "lon": el["lon"]}
        elif el["type"] == "way":
            ways.append(el)

    print(f"[Overpass] {len(nodes)} nodes, {len(ways)} ways")

    # Build the graph
    graph_nodes = {}  # node_id -> {lat, lon}
    edges = []  # [{from, to, way_id, name, waterway, dist_m}]
    node_usage = defaultdict(int)  # how many ways use each node

    for way in ways:
        way_nodes = way.get("nodes", [])
        tags = way.get("tags", {})
        name = tags.get("name", "Unnamed")
        waterway = tags.get("waterway", tags.get("seamark:type", "unknown"))

        # Add all nodes from this way to the graph
        for nid in way_nodes:
            if nid in nodes:
                graph_nodes[str(nid)] = nodes[nid]
                node_usage[nid] += 1

        # Create edges between consecutive nodes
        for i in range(len(way_nodes) - 1):
            n1 = way_nodes[i]
            n2 = way_nodes[i + 1]
            if n1 in nodes and n2 in nodes:
                dist = haversine_m(
                    nodes[n1]["lat"], nodes[n1]["lon"],
                    nodes[n2]["lat"], nodes[n2]["lon"]
                )
                edges.append({
                    "from": str(n1),
                    "to": str(n2),
                    "way_id": way["id"],
                    "name": name,
                    "waterway": waterway,
                    "dist_m": round(dist, 1),
                })

    # Count junction nodes (shared between 2+ ways)
    junctions = sum(1 for count in node_usage.values() if count >= 2)

    print(f"[Graph] {len(graph_nodes)} graph nodes, {len(edges)} edges, {junctions} junction nodes")

    # Build the output
    output = {
        "metadata": {
            "bbox": BBOX,
            "region": "SE Queensland",
            "node_count": len(graph_nodes),
            "edge_count": len(edges),
            "junction_count": junctions,
            "way_count": len(ways),
        },
        "nodes": graph_nodes,
        "edges": edges,
    }

    import os
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(script_dir, "..", "public", "data", "waterway_graph.json")
    out_path = os.path.normpath(out_path)
    with open(out_path, "w") as f:
        json.dump(output, f)

    size_kb = len(json.dumps(output)) / 1024
    print(f"[Graph] Written to {out_path} ({size_kb:.0f} KB)")

    # Stats
    waterway_types = defaultdict(int)
    for way in ways:
        wt = way.get("tags", {}).get("waterway", "other")
        waterway_types[wt] += 1
    print(f"[Graph] Waterway types: {dict(waterway_types)}")

    # Check Newport specifically
    newport_ways = [w for w in ways if "newport" in w.get("tags", {}).get("name", "").lower() or
                    "albatross" in w.get("tags", {}).get("name", "").lower() or
                    "kite" in w.get("tags", {}).get("name", "").lower() or
                    "hawk" in w.get("tags", {}).get("name", "").lower()]
    print(f"[Graph] Newport-area ways found: {len(newport_ways)}")
    for w in newport_ways:
        tags = w.get("tags", {})
        print(f"  - {tags.get('name', '?')} ({tags.get('waterway', '?')}) — {len(w.get('nodes', []))} nodes")


if __name__ == "__main__":
    main()
