#!/usr/bin/env python3
import sys; sys.stdout.reconfigure(encoding='utf-8', errors='replace'); sys.stderr.reconfigure(encoding='utf-8', errors='replace')
"""
╔══════════════════════════════════════════════════════════════╗
║  Thalassa — Offline Navigation Graph Builder                ║
║  PBF → NetworkX → Compact JSON for mobile Dijkstra         ║
╚══════════════════════════════════════════════════════════════╝

Usage:
    python build_nav_graph.py <input.osm.pbf> [options]

Examples:
    # Build graph for all of Australia
    python build_nav_graph.py australia-oceania-latest.osm.pbf

    # Build graph for SE Queensland only (Brisbane/Gold Coast/Sunshine Coast)
    python build_nav_graph.py australia-oceania-latest.osm.pbf \
        --bbox 152.5,-28.2,153.6,-26.5 --name se_queensland

    # Build graph with GeoJSON debug output
    python build_nav_graph.py queensland-latest.osm.pbf --geojson

Dependencies:
    pip install osmium networkx
"""

import argparse
import json
import gzip
import math
import os
import sys
import time
from collections import defaultdict

try:
    import osmium
except ImportError:
    print("ERROR: pyosmium not installed. Run: pip install osmium")
    sys.exit(1)

try:
    import networkx as nx
except ImportError:
    print("ERROR: networkx not installed. Run: pip install networkx")
    sys.exit(1)

try:
    import numpy as np
    from scipy.spatial import KDTree
except ImportError:
    print("ERROR: numpy/scipy not installed. Run: pip install numpy scipy")
    sys.exit(1)


# ── Constants ────────────────────────────────────────────────

EARTH_RADIUS_NM = 3440.065
COORD_PRECISION = 5      # 5 decimal places ≈ 1.1m accuracy
WEIGHT_PRECISION = 3     # Edge weights in NM, 3dp
MIN_COMPONENT_NODES = 5  # Drop components smaller than this


# ── OSM tags we care about ───────────────────────────────────

WATERWAY_TAGS = {
    'river', 'canal', 'fairway', 'tidal_channel',
    'dock', 'stream', 'drain', 'ditch',
    'boatyard', 'fuel', 'lock_gate',
}

# Tags that indicate navigable waterway LineStrings (preferred, no penalty)
NAVIGABLE_TAGS = {
    ('waterway', v) for v in WATERWAY_TAGS
} | {
    ('route', 'ferry'),
    ('route', 'canoe'),
    ('route', 'boat'),
    ('leisure', 'marina'),
    ('man_made', 'pier'),
    ('man_made', 'breakwater'),
}

# Tags that provide shore connectivity but should be penalized in routing.
# Coastline traces the LAND side — we keep it for graph connectivity but
# multiply edge weights by COASTAL_PENALTY so the router prefers channels.
COASTAL_PENALTY = 10  # 10x weight multiplier for shore edges
PENALIZED_TAGS = {
    ('natural', 'coastline'),
    ('natural', 'water'),
}

# Seamark types that indicate navigation channels/features
SEAMARK_CHANNEL_TYPES = {
    'fairway', 'recommended_track', 'navigation_line',
    'channel', 'separation_zone', 'separation_lane',
    'buoy_lateral', 'beacon_lateral',
    'buoy_cardinal', 'beacon_cardinal',
    'light_major', 'light_minor',
    'anchorage', 'harbour',
}


# ── Math ─────────────────────────────────────────────────────

def haversine_nm(lat1, lon1, lat2, lon2):
    """Haversine distance in nautical miles."""
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(a))


# ── Pass 1: Collect matching way IDs and their node refs ─────

class WayCollector(osmium.SimpleHandler):
    """First pass: identify ways with marine tags and collect their node refs."""

    def __init__(self, bbox=None):
        super().__init__()
        self.bbox = bbox  # (min_lon, min_lat, max_lon, max_lat) or None
        self.ways = {}    # way_id → [node_id, ...]
        self.matched = 0
        self.scanned = 0

    def way(self, w):
        self.scanned += 1
        if self.scanned % 500_000 == 0:
            print(f"  Pass 1: scanned {self.scanned:,} ways, matched {self.matched:,}...", flush=True)

        tags = {t.k: t.v for t in w.tags}
        penalty = self._is_marine(tags)
        if penalty is None:
            return

        # Collect node references (coordinates resolved in pass 2)
        node_refs = [n.ref for n in w.nodes]
        if len(node_refs) < 2:
            return

        self.ways[w.id] = (node_refs, penalty)
        self.matched += 1

    def _is_marine(self, tags):
        """Check if way has any marine-relevant tag.
        Returns: penalty multiplier (1.0=channel, 10.0=coastline) or None if not marine."""
        for key, val in tags.items():
            if (key, val) in NAVIGABLE_TAGS:
                return 1.0
            if key == 'seamark:type' and val in SEAMARK_CHANNEL_TYPES:
                return 1.0
        # Check penalized tags last (lower priority)
        for key, val in tags.items():
            if (key, val) in PENALIZED_TAGS:
                return COASTAL_PENALTY
        return None


# ── Pass 2: Resolve node coordinates ─────────────────────────

class NodeResolver(osmium.SimpleHandler):
    """Second pass: resolve coordinates for nodes referenced by matched ways."""

    def __init__(self, needed_nodes, bbox=None):
        super().__init__()
        self.needed = needed_nodes  # set of node IDs
        self.coords = {}            # node_id → (lon, lat)
        self.bbox = bbox
        self.resolved = 0

    def node(self, n):
        if n.id in self.needed:
            lon = round(n.location.lon, COORD_PRECISION)
            lat = round(n.location.lat, COORD_PRECISION)

            # Optional bounding box filter
            if self.bbox:
                min_lon, min_lat, max_lon, max_lat = self.bbox
                if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
                    return

            self.coords[n.id] = (lon, lat)
            self.resolved += 1

            if self.resolved % 100_000 == 0:
                print(f"  Pass 2: resolved {self.resolved:,} / {len(self.needed):,} nodes...", flush=True)


# ── Pass 3: Bridge Clearance Extraction ──────────────────────

class BridgeCollector(osmium.SimpleHandler):
    """Scan for bridge clearance data (nodes and ways tagged seamark:type=bridge)."""

    def __init__(self, bbox=None):
        super().__init__()
        self.bbox = bbox
        self.bridges = []  # list of {lat, lon, clearance_m, name, category}
        self.scanned = 0

    def node(self, n):
        self.scanned += 1
        tags = {t.k: t.v for t in n.tags}
        if not tags:
            return

        bridge_info = self._extract_bridge(tags)
        if bridge_info is None:
            return

        lat, lon = n.location.lat, n.location.lon
        if self.bbox:
            min_lon, min_lat, max_lon, max_lat = self.bbox
            if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
                return

        bridge_info['lat'] = lat
        bridge_info['lon'] = lon
        self.bridges.append(bridge_info)

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        if not tags:
            return

        bridge_info = self._extract_bridge(tags)
        if bridge_info is None:
            return

        # For ways, take the midpoint of the node list as the bridge position
        # (coordinates will be resolved by location=True in apply_file)
        nodes = [n for n in w.nodes if n.location.valid()]
        if not nodes:
            return

        mid = nodes[len(nodes) // 2]
        lat, lon = mid.location.lat, mid.location.lon

        if self.bbox:
            min_lon, min_lat, max_lon, max_lat = self.bbox
            if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
                return

        bridge_info['lat'] = lat
        bridge_info['lon'] = lon
        self.bridges.append(bridge_info)

    def _extract_bridge(self, tags):
        """Extract bridge clearance data from OSM tags.
        Returns dict with clearance info or None if not a bridge."""

        # Check for seamark bridge type
        is_seamark_bridge = tags.get('seamark:type') == 'bridge'
        # Check for bridge=yes with waterway context  
        is_bridge_way = tags.get('bridge') in ('yes', 'movable', 'viaduct')

        if not is_seamark_bridge and not is_bridge_way:
            return None

        # Extract clearance height (try multiple tags, prefer seamark)
        clearance = None
        for tag in [
            'seamark:bridge:clearance_height',
            'seamark:bridge:clearance_height_closed',
            'maxheight',
            'maxheight:physical',
            'bridge:clearance',
        ]:
            val = tags.get(tag)
            if val:
                try:
                    # Handle values like "15.2" or "15.2 m"
                    clearance = float(val.replace('m', '').strip())
                    break
                except (ValueError, AttributeError):
                    continue

        # Extract category
        category = tags.get('seamark:bridge:category', 'fixed')

        # Extract name
        name = tags.get('name', tags.get('seamark:name', 'Unknown Bridge'))

        # Also grab open clearance if available
        clearance_open = None
        val_open = tags.get('seamark:bridge:clearance_height_open')
        if val_open:
            try:
                clearance_open = float(val_open.replace('m', '').strip())
            except (ValueError, AttributeError):
                pass

        result = {
            'name': name,
            'clearance_m': clearance,
            'category': category,
        }
        if clearance_open is not None:
            result['clearance_open_m'] = clearance_open

        return result


# ── Graph Builder ────────────────────────────────────────────

def build_graph(ways, coords, bbox=None):
    """Build a NetworkX graph from ways and resolved coordinates."""
    G = nx.Graph()
    edges_added = 0
    ways_skipped = 0
    coastal_edges = 0

    for way_id, way_data in ways.items():
        # Unpack: way_data is (node_refs, penalty_factor)
        node_refs, penalty = way_data

        # Resolve coordinates for this way
        resolved = []
        for nid in node_refs:
            if nid in coords:
                resolved.append(coords[nid])

        if len(resolved) < 2:
            ways_skipped += 1
            continue

        # Add edges between consecutive nodes
        for i in range(len(resolved) - 1):
            lon1, lat1 = resolved[i]
            lon2, lat2 = resolved[i + 1]

            dist = haversine_nm(lat1, lon1, lat2, lon2)

            # Skip degenerate edges (same point or impossibly long)
            if dist < 0.0001 or dist > 50:
                continue

            # Apply penalty: coastline edges get inflated weights
            weight = round(dist * penalty, WEIGHT_PRECISION)
            if penalty > 1:
                coastal_edges += 1

            G.add_edge(
                (lon1, lat1),
                (lon2, lat2),
                weight=weight,
            )
            edges_added += 1

    print(f"  Graph: {G.number_of_nodes():,} nodes, {G.number_of_edges():,} edges")
    print(f"  Ways processed: {len(ways) - ways_skipped:,} used, {ways_skipped:,} skipped (unresolved)")
    print(f"  Coastal edges (penalized {COASTAL_PENALTY}x): {coastal_edges:,}")
    return G


# ── Seamark Injection (KDTree-optimized) ─────────────────────

SEAMARK_CONNECT_RADIUS_NM = 3.0  # Connect seamarks within this radius to each other
SEAMARK_GRAPH_RADIUS_NM = 2.0    # Connect seamarks to existing graph nodes within this radius
DEG_PER_NM = 1.0 / 60.0          # ~1 minute of arc per NM (approximate)

# ── Cost Hierarchy ──
VIRTUAL_GRID_PENALTY = 3.0   # Virtual water grid edges cost 3x (expensive dirt track)
FAIRWAY_DISCOUNT = 0.5       # Fairway edges cost 0.5x (cheap highway)
GRID_SPACING_NM = 1.0        # Blue water grid node spacing (1 NM = ~1852m)
GRID_CONNECT_RADIUS_NM = 1.2 # Connect grid nodes within this radius (just nearest neighbors)
GRID_MAX_CONNECTIONS = 8     # Max connections per grid node


def _build_coastline_index(G):
    """Build a spatial index of coastline edges for land-intersection checking."""
    try:
        from shapely.geometry import LineString
        from shapely import STRtree
    except ImportError:
        print("  WARNING: shapely not available - skipping land intersection checks")
        return None, []

    coastline_lines = []
    for u, v, data in G.edges(data=True):
        edge_dist = haversine_nm(u[1], u[0], v[1], v[0])
        weight = data.get('weight', 0)
        if edge_dist > 0.001 and weight / edge_dist > 1.5:
            coastline_lines.append(LineString([(u[0], u[1]), (v[0], v[1])]))

    if not coastline_lines:
        print("  WARNING: No coastline edges found for intersection checking")
        return None, []

    tree = STRtree(coastline_lines)
    print(f"  Coastline index: {len(coastline_lines):,} edges indexed for land checks")
    return tree, coastline_lines


def _edge_crosses_land(lon1, lat1, lon2, lat2, coast_tree, coast_lines):
    """Check if a proposed edge crosses any coastline segment (= crosses land)."""
    if coast_tree is None:
        return False
    from shapely.geometry import LineString
    proposed = LineString([(lon1, lat1), (lon2, lat2)])
    candidates = coast_tree.query(proposed)
    for idx in candidates:
        if proposed.crosses(coast_lines[idx]):
            return True
    return False


# ── Bathymetry Danger Zones (< 3m depth) ─────────────────────

def load_danger_polygons(geojson_path):
    """
    Load shallow-water danger polygons from GeoJSON and build spatial index.
    These polygons represent water shallower than 3m — dangerous for keel boats.
    
    Returns: (danger_tree, danger_polys) or (None, []) if unavailable
    """
    from shapely.geometry import shape
    from shapely import STRtree

    try:
        with open(geojson_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"  WARNING: Could not load danger polygons: {e}")
        return None, []

    features = data.get('features', [])
    if not features:
        print("  WARNING: No danger polygon features found")
        return None, []

    polys = []
    skipped = 0
    for feat in features:
        try:
            geom = shape(feat.get('geometry', {}))
            if geom.is_valid and not geom.is_empty:
                polys.append(geom)
            else:
                skipped += 1
        except Exception:
            skipped += 1

    if not polys:
        print("  WARNING: No valid danger polygons")
        return None, []

    tree = STRtree(polys)
    print(f"  Danger index: {len(polys):,} polygons ({skipped} invalid/skipped)")
    return tree, polys


def _point_in_danger(lon, lat, danger_tree, danger_polys):
    """Check if a point falls inside any shallow-water danger polygon."""
    if danger_tree is None:
        return False
    from shapely.geometry import Point
    pt = Point(lon, lat)
    candidates = danger_tree.query(pt)
    for idx in candidates:
        if danger_polys[idx].contains(pt):
            return True
    return False


def _edge_crosses_danger(lon1, lat1, lon2, lat2, danger_tree, danger_polys):
    """Check if a proposed edge crosses or is inside a shallow-water danger polygon."""
    if danger_tree is None:
        return False
    from shapely.geometry import LineString
    proposed = LineString([(lon1, lat1), (lon2, lat2)])
    candidates = danger_tree.query(proposed)
    for idx in candidates:
        if proposed.intersects(danger_polys[idx]):
            return True
    return False


SHALLOW_WATER_PENALTY = 10.0  # Edges crossing <3m water cost 10x


def apply_danger_penalties(G, danger_tree, danger_polys):
    """
    Scan ALL graph edges and apply a massive weight penalty to any edge
    that crosses a shallow-water danger polygon.

    This is the critical step that makes bathymetry work for routing —
    it penalizes existing OSM waterway edges (not just grid/seamark ones).
    
    We don't DELETE these edges because they're needed for graph connectivity
    and UI rendering. Instead, we make them extremely expensive so A* avoids them.
    """
    if danger_tree is None:
        print("  No danger polygons — skipping edge penalty pass")
        return G

    from shapely.geometry import LineString

    total_edges = G.number_of_edges()
    penalized = 0
    checked = 0
    batch_size = 50000

    # Process edges in batches for progress reporting
    edges = list(G.edges(data=True))
    for i, (u, v, data) in enumerate(edges):
        if i % batch_size == 0 and i > 0:
            print(f"    Checked {i:,}/{total_edges:,} edges, {penalized:,} penalized...")

        lon1, lat1 = u[0], u[1]
        lon2, lat2 = v[0], v[1]

        proposed = LineString([(lon1, lat1), (lon2, lat2)])
        candidates = danger_tree.query(proposed)

        for idx in candidates:
            if proposed.intersects(danger_polys[idx]):
                # Apply penalty: multiply weight by 10x
                old_weight = data.get('weight', 1.0)
                new_weight = round(old_weight * SHALLOW_WATER_PENALTY, WEIGHT_PRECISION)
                G[u][v]['weight'] = new_weight
                penalized += 1
                break  # One intersection is enough

    print(f"  Danger penalty: {penalized:,}/{total_edges:,} edges penalized ({SHALLOW_WATER_PENALTY}x)")
    return G


# ── Fairway Extraction ───────────────────────────────────────

class FairwayCollector(osmium.SimpleHandler):
    """Extract fairway ways from OSM PBF for centerline routing discount."""

    def __init__(self, bbox=None):
        super().__init__()
        self.bbox = bbox
        self.fairway_node_refs = set()  # OSM node IDs belonging to fairway ways
        self.fairway_count = 0
        self.fairway_names = []

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        is_fairway = (tags.get('waterway') == 'fairway' or
                      tags.get('seamark:type') == 'fairway')
        if not is_fairway:
            return

        self.fairway_count += 1
        name = tags.get('name') or tags.get('seamark:name') or f'Fairway #{self.fairway_count}'
        if self.fairway_count <= 5:
            self.fairway_names.append(name)

        for n in w.nodes:
            self.fairway_node_refs.add(n.ref)


# ── Blue Water Grid ──────────────────────────────────────────

def generate_water_grid(bbox, G, coast_tree, coast_lines, danger_tree=None, danger_polys=None):
    """
    Generate a synthetic grid of virtual water nodes across the bounding box.
    Nodes on land or inside danger polygons (<3m depth) are discarded.
    
    Virtual grid nodes provide stepping stones for A* to cross open bays
    instead of hugging the coast. They get a 3.0x cost multiplier.
    
    Returns: list of (lon, lat) tuples for valid water grid points
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    spacing_deg = GRID_SPACING_NM * DEG_PER_NM

    # Generate grid
    grid_points = []
    lon = min_lon
    while lon <= max_lon:
        lat = min_lat
        while lat <= max_lat:
            grid_points.append((round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)))
            lat += spacing_deg
        lon += spacing_deg

    print(f"  Raw grid: {len(grid_points):,} points at {GRID_SPACING_NM} NM spacing")

    if coast_tree is None:
        print("  WARNING: No coastline index -- keeping all grid points")
        return [p for p in grid_points if not G.has_node(p)]

    # Remove points on land or in danger zones
    check_radius = spacing_deg * 0.3
    valid = []
    on_land = 0
    in_danger = 0

    for lon, lat in grid_points:
        if G.has_node((lon, lat)):
            continue  # Already in graph

        # Check if point is on land
        is_blocked = False
        for dlon, dlat in [(check_radius, 0), (-check_radius, 0),
                           (0, check_radius), (0, -check_radius)]:
            if _edge_crosses_land(lon, lat, lon + dlon, lat + dlat, coast_tree, coast_lines):
                is_blocked = True
                break

        if is_blocked:
            on_land += 1
            continue

        # Check if point is inside a shallow-water danger zone
        if _point_in_danger(lon, lat, danger_tree, danger_polys):
            in_danger += 1
            continue

        valid.append((lon, lat))

    print(f"  Land filter: {on_land:,} on land, {in_danger:,} in danger (<3m), {len(valid):,} safe water")
    return valid


def inject_seamarks(G, geojson_path, bbox=None, danger_tree=None, danger_polys=None):
    """
    Inject seamark positions as graph nodes with KDTree-optimized neighbor
    search, IALA marker metadata, and danger zone checking.

    Returns: (G, markers_list, obstacles_list)
    """
    try:
        with open(geojson_path, 'r', encoding='utf-8') as f:
            geojson = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"  WARNING: Could not load seamarks: {e}")
        return G, [], []

    features = geojson.get('features', [])
    if not features:
        print("  WARNING: No seamark features found")
        return G, [], []

    # Build coastline spatial index for land intersection checks
    coast_tree, coast_lines = _build_coastline_index(G)

    NAVIGABLE_CLASSES = {'port', 'starboard', 'safe_water',
                         'cardinal', 'cardinal_n', 'cardinal_s', 'cardinal_e', 'cardinal_w'}
    OBSTACLE_CLASSES = {'danger', 'special'}

    seamark_nodes = []
    obstacle_marks = []
    skipped = 0

    for feat in features:
        geom = feat.get('geometry', {})
        if geom.get('type') != 'Point':
            continue
        coords = geom.get('coordinates', [])
        if len(coords) < 2:
            continue
        props = feat.get('properties', {})
        cls = props.get('_class', '')
        lon = round(coords[0], COORD_PRECISION)
        lat = round(coords[1], COORD_PRECISION)

        if bbox:
            bmin_lon, bmin_lat, bmax_lon, bmax_lat = bbox
            if not (bmin_lon <= lon <= bmax_lon and bmin_lat <= lat <= bmax_lat):
                continue

        if cls in NAVIGABLE_CLASSES:
            seamark_nodes.append((lon, lat, cls))
        elif cls in OBSTACLE_CLASSES:
            obstacle_marks.append({'lon': lon, 'lat': lat, '_class': cls})
        else:
            skipped += 1

    print(f"  Filtered: {len(seamark_nodes)} navigable, {len(obstacle_marks)} obstacles, {skipped} skipped")

    if not seamark_nodes:
        print("  WARNING: No navigable seamarks in bounding box")
        return G, [], obstacle_marks

    # Add seamark nodes with marker metadata
    nodes_added = 0
    for lon, lat, cls in seamark_nodes:
        node_key = (lon, lat)
        if not G.has_node(node_key):
            G.add_node(node_key, marker_class=cls)
            nodes_added += 1
        else:
            G.nodes[node_key]['marker_class'] = cls

    # ── KDTree-optimized neighbor search ──
    print("  Building KDTree for fast neighbor lookup...")
    all_nodes = list(G.nodes())
    all_coords = np.array([(n[0], n[1]) for n in all_nodes])
    kd_tree = KDTree(all_coords)

    seamark_set = {(s[0], s[1]) for s in seamark_nodes}

    # Connect seamarks to nearest graph nodes (KDTree radius query)
    radius_deg = SEAMARK_GRAPH_RADIUS_NM * DEG_PER_NM
    edges_to_graph = 0
    edges_between = 0
    edges_blocked = 0

    for s_lon, s_lat, _ in seamark_nodes:
        s_coord = np.array([s_lon, s_lat])
        nearby_idx = kd_tree.query_ball_point(s_coord, radius_deg)

        best_dist = SEAMARK_GRAPH_RADIUS_NM
        best_node = None
        for idx in nearby_idx:
            n = all_nodes[idx]
            if n in seamark_set:
                continue
            dist = haversine_nm(s_lat, s_lon, n[1], n[0])
            if dist < best_dist:
                best_dist = dist
                best_node = n

        if best_node is not None:
            if (_edge_crosses_land(s_lon, s_lat, best_node[0], best_node[1], coast_tree, coast_lines) or
                _edge_crosses_danger(s_lon, s_lat, best_node[0], best_node[1], danger_tree, danger_polys)):
                edges_blocked += 1
            else:
                G.add_edge((s_lon, s_lat), best_node,
                           weight=round(best_dist, WEIGHT_PRECISION))
                edges_to_graph += 1

    # Connect seamarks to each other (KDTree radius query)
    connect_radius_deg = SEAMARK_CONNECT_RADIUS_NM * DEG_PER_NM
    seen_pairs = set()
    for s1_lon, s1_lat, _ in seamark_nodes:
        s1_coord = np.array([s1_lon, s1_lat])
        nearby_idx = kd_tree.query_ball_point(s1_coord, connect_radius_deg)

        for idx in nearby_idx:
            n = all_nodes[idx]
            if n not in seamark_set or n == (s1_lon, s1_lat):
                continue
            pair = (min((s1_lon, s1_lat), n), max((s1_lon, s1_lat), n))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)

            dist = haversine_nm(s1_lat, s1_lon, n[1], n[0])
            if dist < SEAMARK_CONNECT_RADIUS_NM:
                if (_edge_crosses_land(s1_lon, s1_lat, n[0], n[1], coast_tree, coast_lines) or
                    _edge_crosses_danger(s1_lon, s1_lat, n[0], n[1], danger_tree, danger_polys)):
                    edges_blocked += 1
                else:
                    G.add_edge((s1_lon, s1_lat), n,
                               weight=round(dist, WEIGHT_PRECISION))
                    edges_between += 1

    print(f"  Seamarks: {len(seamark_nodes)} positions, {nodes_added} new nodes (KDTree)")
    print(f"  Edges: {edges_to_graph} to graph, {edges_between} between seamarks")
    print(f"  Land check: {edges_blocked} edges BLOCKED (would cross coastline)")

    markers = [{'lon': s[0], 'lat': s[1], '_class': s[2]} for s in seamark_nodes]
    return G, markers, obstacle_marks


# ── Graph Optimization ───────────────────────────────────────

def optimize_graph(G, min_component=MIN_COMPONENT_NODES, simplify=True):
    """
    Optimize the graph:
    1. Remove small disconnected components
    2. Bridge nearby components (stitch OSM gaps)
    3. Optionally simplify degree-2 chains (reduce node count)
    """
    # ── Connected component pruning ──
    components = list(nx.connected_components(G))
    components.sort(key=len, reverse=True)

    kept = 0
    removed_nodes = 0
    for comp in components:
        if len(comp) >= min_component:
            kept += 1
        else:
            G.remove_nodes_from(comp)
            removed_nodes += len(comp)

    print(f"  Components: {len(components)} total, {kept} kept (≥{min_component} nodes)")
    print(f"  Pruned: {removed_nodes:,} isolated nodes removed")

    # ── Bridge nearby components ──
    # OSM waterway data often has gaps at junctions (river mouths, port
    # entrances). Bridge components whose nodes are within BRIDGE_MAX_NM.
    BRIDGE_MAX_NM = 0.5  # ~925m — generous enough to bridge OSM data gaps
    bridges_added = _bridge_components(G, BRIDGE_MAX_NM)
    if bridges_added > 0:
        # Re-check components after bridging
        new_comps = list(nx.connected_components(G))
        print(f"  Bridged: {bridges_added} edges added, now {len(new_comps)} components")

    # ── Degree-2 chain simplification ──
    # Merge chains of degree-2 nodes into single edges
    # This dramatically reduces node count without changing topology
    if simplify:
        before = G.number_of_nodes()
        _simplify_degree2(G)
        after = G.number_of_nodes()
        print(f"  Simplified: {before:,} → {after:,} nodes ({before - after:,} merged)")

    # ── Compute total network distance ──
    total_nm = sum(d['weight'] for _, _, d in G.edges(data=True))
    print(f"  Network: {G.number_of_nodes():,} nodes, {G.number_of_edges():,} edges, {total_nm:,.1f} NM total")

    return G


def _bridge_components(G, max_bridge_nm):
    """Connect nearby disconnected components with bridge edges."""
    bridges_added = 0
    max_iterations = 50  # Safety limit

    for iteration in range(max_iterations):
        components = sorted(nx.connected_components(G), key=len, reverse=True)
        if len(components) <= 1:
            break

        # For each non-largest component, find the closest node in the largest
        largest = components[0]
        largest_nodes = list(largest)

        found_bridge = False
        for comp in components[1:]:
            comp_nodes = list(comp)

            best_dist = max_bridge_nm
            best_pair = None

            # Sample nodes for speed (check up to 200 per component)
            sample_l = largest_nodes if len(largest_nodes) <= 200 else largest_nodes[::len(largest_nodes)//200]
            sample_c = comp_nodes if len(comp_nodes) <= 200 else comp_nodes[::len(comp_nodes)//200]

            for n1 in sample_c:
                for n2 in sample_l:
                    # Quick degree filter
                    dlat = abs(n1[1] - n2[1])
                    dlon = abs(n1[0] - n2[0])
                    if dlat > 0.02 or dlon > 0.02:
                        continue
                    d = haversine_nm(n1[1], n1[0], n2[1], n2[0])
                    if d < best_dist:
                        best_dist = d
                        best_pair = (n1, n2)

            if best_pair:
                G.add_edge(best_pair[0], best_pair[1], weight=round(best_dist, WEIGHT_PRECISION))
                bridges_added += 1
                found_bridge = True

        if not found_bridge:
            break

    return bridges_added


def _simplify_degree2(G):
    """Merge chains of degree-2 nodes into single weighted edges."""
    to_remove = []

    for node in list(G.nodes()):
        if G.degree(node) != 2:
            continue

        neighbors = list(G.neighbors(node))
        if len(neighbors) != 2:
            continue

        n1, n2 = neighbors

        # Don't merge if it would create a self-loop
        if n1 == n2:
            continue

        # Compute merged weight
        w1 = G[node][n1].get('weight', 0)
        w2 = G[node][n2].get('weight', 0)
        merged_weight = round(w1 + w2, WEIGHT_PRECISION)

        # Check if direct edge already exists
        if G.has_edge(n1, n2):
            existing = G[n1][n2].get('weight', float('inf'))
            if merged_weight >= existing:
                # Keep the shorter existing edge, just remove the chain node
                to_remove.append(node)
                continue

        # Replace chain with direct edge
        G.add_edge(n1, n2, weight=merged_weight)
        to_remove.append(node)

    G.remove_nodes_from(to_remove)


# ── Export ────────────────────────────────────────────────────

def export_json(G, output_path, region_name, compress=True):
    """
    Export graph as compact JSON optimized for JS/Capacitor parsing.

    Format:
    {
        "meta": { ... },
        "nodes": [[lon, lat], ...],
        "edges": [[from_idx, to_idx, weight_nm], ...]
    }
    """
    # Build node index
    node_list = list(G.nodes())
    node_index = {node: i for i, node in enumerate(node_list)}

    # Flatten nodes: [[lon, lat], ...]
    nodes = [[n[0], n[1]] for n in node_list]

    # Flatten edges: [[from, to, weight], ...]
    edges = []
    total_nm = 0
    for u, v, data in G.edges(data=True):
        w = data.get('weight', 0)
        edges.append([node_index[u], node_index[v], w])
        total_nm += w

    payload = {
        "meta": {
            "version": 2,
            "format": "thalassa_nav_graph",
            "region": region_name,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "nodes": len(nodes),
            "edges": len(edges),
            "total_nm": round(total_nm, 1),
            "coord_order": "lon_lat",
            "weight_unit": "nautical_miles",
        },
        "nodes": nodes,
        "edges": edges,
    }

    # Write JSON
    json_str = json.dumps(payload, separators=(',', ':'))

    if compress:
        gz_path = output_path + '.gz'
        with gzip.open(gz_path, 'wt', encoding='utf-8', compresslevel=9) as f:
            f.write(json_str)
        raw_size = len(json_str.encode())
        gz_size = os.path.getsize(gz_path)
        print(f"\n  Saved: {gz_path}")
        print(f"  Raw JSON: {raw_size / 1024 / 1024:.1f} MB")
        print(f"  Gzipped:  {gz_size / 1024 / 1024:.1f} MB ({gz_size / raw_size * 100:.0f}%)")
    else:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(json_str)
        size = os.path.getsize(output_path)
        print(f"\n  Saved: {output_path} ({size / 1024 / 1024:.1f} MB)")

    # Also write uncompressed for debugging
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(json_str)

    return payload


def export_geojson(G, output_path):
    """Export graph as GeoJSON FeatureCollection for visual debugging."""
    features = []

    for u, v, data in G.edges(data=True):
        feature = {
            "type": "Feature",
            "properties": {
                "weight_nm": data.get('weight', 0),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [list(u), list(v)],
            },
        }
        features.append(feature)

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(geojson, f)

    print(f"  GeoJSON debug: {output_path} ({os.path.getsize(output_path) / 1024 / 1024:.1f} MB)")


# ── Routing Test ─────────────────────────────────────────────

def test_routing(G, payload):
    """Quick Dijkstra test between the two most distant nodes in the largest component."""
    if G.number_of_nodes() < 2:
        print("\n  ⚠ Graph too small to test routing")
        return

    # Find the largest component
    largest = max(nx.connected_components(G), key=len)
    subgraph = G.subgraph(largest)

    # Pick two nodes and route between them
    nodes_list = list(subgraph.nodes())
    # Pick nodes furthest apart by index for a reasonable test
    start = nodes_list[0]
    end = nodes_list[len(nodes_list) // 2]

    try:
        path = nx.dijkstra_path(subgraph, start, end, weight='weight')
        dist = nx.dijkstra_path_length(subgraph, start, end, weight='weight')
        print(f"\n  ✓ Routing test: {len(path)} waypoints, {dist:.1f} NM")
        print(f"    From: ({start[1]:.4f}, {start[0]:.4f})")
        print(f"    To:   ({end[1]:.4f}, {end[0]:.4f})")
    except nx.NetworkXNoPath:
        print(f"\n  ⚠ No path found in routing test (graph may be disconnected)")


# ── Main ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Thalassa Offline Navigation Graph Builder',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python build_nav_graph.py australia-latest.osm.pbf
  python build_nav_graph.py australia-latest.osm.pbf --bbox 152.5,-28.2,153.6,-26.5 --name se_qld
  python build_nav_graph.py australia-latest.osm.pbf --geojson --no-simplify
        """,
    )
    parser.add_argument('input', help='Path to .osm.pbf file')
    parser.add_argument('--name', default=None, help='Region name (default: derived from filename)')
    parser.add_argument('--bbox', default=None,
                        help='Bounding box: min_lon,min_lat,max_lon,max_lat (e.g., 152.5,-28.2,153.6,-26.5)')
    parser.add_argument('--output', default=None, help='Output path (default: thalassa_graph_<name>.json)')
    parser.add_argument('--geojson', action='store_true', help='Also export GeoJSON for visual debugging')
    parser.add_argument('--no-simplify', action='store_true', help='Skip degree-2 chain simplification')
    parser.add_argument('--no-compress', action='store_true', help='Skip gzip compression')
    parser.add_argument('--min-component', type=int, default=MIN_COMPONENT_NODES,
                        help=f'Minimum nodes per component (default: {MIN_COMPONENT_NODES})')
    parser.add_argument('--seamarks', default=None,
                        help='Path to nav_markers.geojson for seamark injection (creates open-water mesh)')
    parser.add_argument('--bathymetry', default=None,
                        help='Path to danger zone GeoJSON (polygons for water < 3m depth)')
    parser.add_argument('--no-bridges', action='store_true', help='Skip bridge clearance extraction (slow on large PBFs)')

    args = parser.parse_args()

    # Validate input
    if not os.path.exists(args.input):
        print(f"ERROR: File not found: {args.input}")
        sys.exit(1)

    # Parse bounding box
    bbox = None
    if args.bbox:
        try:
            parts = [float(x) for x in args.bbox.split(',')]
            if len(parts) != 4:
                raise ValueError
            bbox = tuple(parts)
            print(f"  Bounding box: {bbox}")
        except ValueError:
            print("ERROR: --bbox must be min_lon,min_lat,max_lon,max_lat")
            sys.exit(1)

    # Derive names
    region_name = args.name or os.path.splitext(os.path.basename(args.input))[0].replace('-latest', '')
    output_path = args.output or f"thalassa_graph_{region_name}.json"
    output_dir = os.path.dirname(output_path) or '.'

    input_size = os.path.getsize(args.input) / 1024 / 1024

    print("=" * 60)
    print("Thalassa — Navigation Graph Builder")
    print("=" * 60)
    print(f"  Input:   {args.input} ({input_size:.0f} MB)")
    print(f"  Region:  {region_name}")
    print(f"  Output:  {output_path}")
    if bbox:
        print(f"  BBox:    [{bbox[0]},{bbox[1]}] -> [{bbox[2]},{bbox[3]}]")
    print()

    t0 = time.time()

    # ── Pass 1: Collect matching ways ──
    print("─── Pass 1: Scanning for marine ways ───")
    collector = WayCollector(bbox=bbox)
    collector.apply_file(args.input, locations=False)
    print(f"  Found {collector.matched:,} marine ways (scanned {collector.scanned:,} total)")
    print(f"  Time: {time.time() - t0:.1f}s")
    print()

    if not collector.ways:
        print("ERROR: No marine ways found. Check your PBF file and bounding box.")
        sys.exit(1)

    # Collect all needed node IDs
    needed_nodes = set()
    for node_refs, _penalty in collector.ways.values():
        needed_nodes.update(node_refs)
    print(f"  Need {len(needed_nodes):,} node coordinates")

    # ── Pass 2: Resolve node coordinates ──
    t1 = time.time()
    print("\n─── Pass 2: Resolving node coordinates ───")
    resolver = NodeResolver(needed_nodes, bbox=bbox)
    resolver.apply_file(args.input, locations=True)
    print(f"  Resolved {resolver.resolved:,} / {len(needed_nodes):,} nodes")
    print(f"  Time: {time.time() - t1:.1f}s")
    print()

    if not resolver.coords:
        print("ERROR: No node coordinates resolved. The PBF may not contain node data.")
        sys.exit(1)

    # ── Build graph ──
    t2 = time.time()
    print("─── Building navigation graph ───")
    G = build_graph(collector.ways, resolver.coords, bbox=bbox)
    print(f"  Time: {time.time() - t2:.1f}s")
    print()

    if G.number_of_nodes() == 0:
        print("ERROR: Graph has no nodes. Check your bounding box.")
        sys.exit(1)

    # ── Load Bathymetry Danger Zones ──
    danger_tree = None
    danger_polys = []
    if args.bathymetry:
        t_bathy = time.time()
        print("--- Loading bathymetry danger polygons (<3m depth) ---")
        danger_tree, danger_polys = load_danger_polygons(args.bathymetry)
        print(f"  Time: {time.time() - t_bathy:.1f}s")
        print()

        # Apply danger penalties to ALL existing graph edges
        t_dp = time.time()
        print("--- Applying danger penalties to existing edges ---")
        G = apply_danger_penalties(G, danger_tree, danger_polys)
        print(f"  Time: {time.time() - t_dp:.1f}s")
        print()

    # ── Inject Seamarks (KDTree-optimized, land + danger checked) ──
    markers = []
    obstacles = []
    coast_tree = None
    coast_lines = []
    if args.seamarks:
        t_sm = time.time()
        print("--- Injecting seamark navigation markers (KDTree) ---")
        G, markers, obstacles = inject_seamarks(G, args.seamarks, bbox=bbox,
                                                danger_tree=danger_tree, danger_polys=danger_polys)
        # Save coastline index for reuse by grid generator
        coast_tree, coast_lines = _build_coastline_index(G)
        print(f"  Time: {time.time() - t_sm:.1f}s")
        print()

    # ── Fairway Extraction (centerline routing discount) ──
    t_fw = time.time()
    print("--- Pass 3: Extracting fairway centerlines ---")
    fairway_collector = FairwayCollector(bbox=bbox)
    fairway_collector.apply_file(args.input, locations=True)
    print(f"  Found {fairway_collector.fairway_count} fairway ways")
    if fairway_collector.fairway_names:
        print(f"  Channels: {', '.join(fairway_collector.fairway_names)}")
    print(f"  Fairway node refs: {len(fairway_collector.fairway_node_refs):,}")

    # Mark graph nodes that belong to fairway ways
    fairway_marked = 0
    if fairway_collector.fairway_node_refs:
        # Build OSM node_id -> (lon, lat) lookup from resolver
        for nid, (lon, lat) in resolver.coords.items():
            if nid in fairway_collector.fairway_node_refs:
                node_key = (round(lon, COORD_PRECISION), round(lat, COORD_PRECISION))
                if G.has_node(node_key):
                    existing_class = G.nodes[node_key].get('marker_class', '')
                    if not existing_class:
                        G.nodes[node_key]['marker_class'] = 'fairway'
                        fairway_marked += 1
    print(f"  Fairway nodes marked: {fairway_marked}")
    print(f"  Time: {time.time() - t_fw:.1f}s")
    print()

    # ── Blue Water Grid (open bay crossing) ──
    if bbox:
        t_gd = time.time()
        print("--- Generating Blue Water Grid ---")
        if coast_tree is None:
            coast_tree, coast_lines = _build_coastline_index(G)
        grid_points = generate_water_grid(bbox, G, coast_tree, coast_lines,
                                           danger_tree=danger_tree, danger_polys=danger_polys)

        # Add grid nodes and connect with KDTree
        if grid_points:
            for lon, lat in grid_points:
                G.add_node((lon, lat), marker_class='virtual_water')

            # Rebuild KDTree with all nodes (including grid)
            all_nodes = list(G.nodes())
            all_coords = np.array([(n[0], n[1]) for n in all_nodes])
            grid_kd = KDTree(all_coords)

            grid_set = set(grid_points)
            connect_deg = GRID_CONNECT_RADIUS_NM * DEG_PER_NM
            grid_edges = 0
            grid_blocked = 0

            for g_lon, g_lat in grid_points:
                g_coord = np.array([g_lon, g_lat])
                nearby_idx = grid_kd.query_ball_point(g_coord, connect_deg)

                # Sort by distance & limit to nearest neighbors
                candidates = []
                for idx in nearby_idx:
                    n = all_nodes[idx]
                    if n == (g_lon, g_lat):
                        continue
                    dist = haversine_nm(g_lat, g_lon, n[1], n[0])
                    if dist <= GRID_CONNECT_RADIUS_NM:
                        candidates.append((dist, n))
                candidates.sort(key=lambda x: x[0])

                connected = 0
                for dist, n in candidates:
                    if connected >= GRID_MAX_CONNECTIONS:
                        break
                    if G.has_edge((g_lon, g_lat), n):
                        connected += 1
                        continue
                    if (_edge_crosses_land(g_lon, g_lat, n[0], n[1], coast_tree, coast_lines) or
                        _edge_crosses_danger(g_lon, g_lat, n[0], n[1], danger_tree, danger_polys)):
                        grid_blocked += 1
                    else:
                        weight = round(dist * VIRTUAL_GRID_PENALTY, WEIGHT_PRECISION)
                        G.add_edge((g_lon, g_lat), n, weight=weight)
                        grid_edges += 1
                        connected += 1

            print(f"  Grid nodes: {len(grid_points):,} added")
            print(f"  Grid edges: {grid_edges:,} connected (3.0x penalty)")
            print(f"  Grid blocked: {grid_blocked:,} land crossings")
        print(f"  Time: {time.time() - t_gd:.1f}s")
        print()
    else:
        print("--- Skipping Blue Water Grid (no bbox) ---")
        print()

    # ── Optimize ──
    t3 = time.time()
    print("─── Optimizing graph ───")
    G = optimize_graph(G, min_component=args.min_component, simplify=not args.no_simplify)
    print(f"  Time: {time.time() - t3:.1f}s")
    print()

    # ── Bridge Clearance Extraction ──
    bridges = []
    bridges_with_clearance = []
    if not args.no_bridges:
        t_br = time.time()
        print("─── Pass 3: Extracting bridge clearance data ───")
        bridge_collector = BridgeCollector(bbox=bbox)
        bridge_collector.apply_file(args.input, locations=True)
        bridges = bridge_collector.bridges
        bridges_with_clearance = [b for b in bridges if b.get('clearance_m') is not None]
        print(f"  Found {len(bridges)} bridges total, {len(bridges_with_clearance)} with clearance data")
        for b in bridges_with_clearance[:10]:
            print(f"    {b['name']}: {b['clearance_m']}m ({b['category']}) @ ({b['lat']:.4f}, {b['lon']:.4f})")
        if len(bridges_with_clearance) > 10:
            print(f"    ... and {len(bridges_with_clearance) - 10} more")
        print(f"  Time: {time.time() - t_br:.1f}s")
        print()
    else:
        print("─── Bridge extraction skipped (--no-bridges) ───")
        print()

    # ── Export ──
    t4 = time.time()
    print("─── Exporting ───")
    payload = export_json(G, output_path, region_name, compress=not args.no_compress)

    # Inject bridge data into payload
    payload['bridges'] = [
        {
            'lon': round(b['lon'], COORD_PRECISION),
            'lat': round(b['lat'], COORD_PRECISION),
            'clearance_m': b.get('clearance_m'),
            'clearance_open_m': b.get('clearance_open_m'),
            'name': b['name'],
            'category': b['category'],
        }
        for b in bridges
    ]
    payload['meta']['bridges'] = len(bridges)
    payload['meta']['bridges_with_clearance'] = len(bridges_with_clearance)

    # Inject marker metadata for cost hierarchy (ALL node types)
    # Includes: port, starboard, cardinal, fairway, virtual_water
    node_list = list(payload['nodes'])
    node_lookup = {}
    for i, n in enumerate(node_list):
        node_lookup[(round(n[0], COORD_PRECISION), round(n[1], COORD_PRECISION))] = i

    payload['markers'] = []
    for node_key in G.nodes():
        mc = G.nodes[node_key].get('marker_class', '')
        if mc:
            key = (round(node_key[0], COORD_PRECISION), round(node_key[1], COORD_PRECISION))
            idx = node_lookup.get(key)
            if idx is not None:
                payload['markers'].append([idx, mc])
    payload['meta']['markers'] = len(payload['markers'])

    # Count by type for stats
    from collections import Counter
    type_counts = Counter(m[1] for m in payload['markers'])
    for mtype, count in sorted(type_counts.items()):
        print(f"  {mtype}: {count}")

    # Inject obstacle data for avoidance zones
    payload['obstacles'] = [[round(o['lon'], COORD_PRECISION), round(o['lat'], COORD_PRECISION), o['_class']] for o in obstacles]
    payload['meta']['obstacles'] = len(payload['obstacles'])

    print(f"  Total markers: {len(payload['markers'])} (for cost hierarchy)")
    print(f"  Obstacles: {len(payload['obstacles'])} (for avoidance zones)")

    # Re-write with bridge + marker + obstacle data
    json_str = json.dumps(payload, separators=(',', ':'))
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(json_str)
    if not args.no_compress:
        gz_path = output_path + '.gz'
        with gzip.open(gz_path, 'wt', encoding='utf-8', compresslevel=9) as f:
            f.write(json_str)
    print(f"  Re-saved with {len(bridges)} bridges, {len(payload['markers'])} markers, {len(payload['obstacles'])} obstacles")

    if args.geojson:
        geojson_path = output_path.replace('.json', '.geojson')
        export_geojson(G, geojson_path)

    print(f"  Time: {time.time() - t4:.1f}s")

    # ── Test routing ──
    test_routing(G, payload)

    # ── Summary ──
    total_time = time.time() - t0
    print()
    print("=" * 60)
    print(f"  ✓ Done in {total_time:.1f}s")
    print(f"  Nodes: {payload['meta']['nodes']:,}")
    print(f"  Edges: {payload['meta']['edges']:,}")
    print(f"  Total: {payload['meta']['total_nm']:,.1f} NM of navigable waterways")
    print("=" * 60)


if __name__ == '__main__':
    main()
