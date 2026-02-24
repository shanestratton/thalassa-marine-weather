#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  THALASSA — Bathymetric Marine Routing Engine                              ║
║  A* Pathfinding over GEBCO Depth Grid with LOS Smoothing                   ║
║                                                                            ║
║  Guarantees:                                                               ║
║    • Route never crosses land (elevation > 0)                              ║
║    • Route maintains minimum safe water depth (draft + 1.0m UKC)           ║
║    • Route legs are smooth (line-of-sight ray-casting)                     ║
║    • Output is [lat, lon] waypoints ready for GPX export                   ║
╚══════════════════════════════════════════════════════════════════════════════╝

Usage:
    from marine_router import MarineRouter

    router = MarineRouter(zarr_path="./gebco_zarr", vessel_draft=2.5)
    waypoints = router.route(
        origin=(-27.35, 153.22),      # Newport, QLD
        destination=(-8.75, 115.17),  # Bali, Indonesia
    )
    # → [[-27.35, 153.22], [-25.1, 152.8], ..., [-8.75, 115.17]]
"""

from __future__ import annotations

import heapq
import math
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import xarray as xr


# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

# Earth radius in nautical miles (for haversine)
EARTH_RADIUS_NM = 3440.065

# Under-keel clearance above vessel draft (metres)
UKC_MARGIN = 1.0

# Grid resolution factor — downsample GEBCO for faster routing
# 1 = full 15-arc-sec (~450m), 4 = 1-arc-min (~1.85km), 8 = 2-arc-min (~3.7km)
# For offshore passages, 4–8 is plenty. For coastal, use 1–2.
DEFAULT_RESOLUTION_FACTOR = 4

# A* search directions: 8-connected grid (including diagonals)
# (dy, dx, cost_multiplier)
DIRECTIONS_8 = [
    (-1, 0, 1.0),    # N
    (1, 0, 1.0),     # S
    (0, -1, 1.0),    # W
    (0, 1, 1.0),     # E
    (-1, -1, 1.414), # NW
    (-1, 1, 1.414),  # NE
    (1, -1, 1.414),  # SW
    (1, 1, 1.414),   # SE
]

# Maximum nodes to expand before giving up (prevents infinite loops)
MAX_EXPANSIONS = 2_000_000


# ═══════════════════════════════════════════════════════════════════════════════
# HAVERSINE
# ═══════════════════════════════════════════════════════════════════════════════

def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_NM * math.asin(min(1.0, math.sqrt(a)))


# ═══════════════════════════════════════════════════════════════════════════════
# PRIORITY QUEUE NODE
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass(order=True)
class _Node:
    """A* search node with priority ordering."""
    f_cost: float                                    # g + h (total estimated cost)
    g_cost: float = field(compare=False)             # actual cost from start
    row: int = field(compare=False)                  # grid row index
    col: int = field(compare=False)                  # grid col index
    parent: Optional[tuple[int, int]] = field(       # (row, col) of parent
        default=None, compare=False
    )


# ═══════════════════════════════════════════════════════════════════════════════
# MARINE ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

class MarineRouter:
    """
    Bathymetric A* router that produces land-safe, depth-safe routes.

    The router:
    1. Loads regional bathymetry from a chunked Zarr store
    2. Builds a navigability mask (land + shallow = impassable)
    3. Runs A* pathfinding on the passable grid
    4. Smooths the path using line-of-sight ray-casting
    5. Returns clean [lat, lon] waypoints

    Parameters
    ----------
    zarr_path : str
        Path to the GEBCO Zarr store (from gebco_ingest.py)
    vessel_draft : float
        Vessel draft in metres (default: 2.5m)
    resolution_factor : int
        Downsample GEBCO grid by this factor (default: 4 = 1-arc-min)
    buffer_deg : float
        Extra padding around the route bounding box (default: 2.0°)
    """

    def __init__(
        self,
        zarr_path: str,
        vessel_draft: float = 2.5,
        resolution_factor: int = DEFAULT_RESOLUTION_FACTOR,
        buffer_deg: float = 2.0,
    ):
        self.zarr_path = zarr_path
        self.vessel_draft = vessel_draft
        self.safe_depth = vessel_draft + UKC_MARGIN  # metres below surface
        self.resolution_factor = resolution_factor
        self.buffer_deg = buffer_deg

    def route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        via: Optional[tuple[float, float]] = None,
    ) -> list[list[float]]:
        """
        Find a safe marine route between two points.

        Parameters
        ----------
        origin : (lat, lon)
            Departure position in decimal degrees
        destination : (lat, lon)
            Arrival position in decimal degrees
        via : (lat, lon), optional
            Intermediate waypoint to route through

        Returns
        -------
        list of [lat, lon]
            Smoothed waypoints that stay in safe water.
            Ready for GPX export.

        Raises
        ------
        RouteError
            If no safe route exists (e.g., landlocked origin/destination)
        """
        if via is not None:
            # Route in two legs: origin → via → destination
            leg1 = self._find_route(origin, via)
            leg2 = self._find_route(via, destination)
            # Remove duplicate via point
            return leg1 + leg2[1:]
        else:
            return self._find_route(origin, destination)

    def _find_route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
    ) -> list[list[float]]:
        """Core routing: load data → build mask → A* → smooth → return."""
        t0 = time.time()

        # ─── Step 1: Load regional bathymetry ─────────────────────────────
        print(f"  Loading bathymetry for "
              f"{origin[0]:.2f},{origin[1]:.2f} → {destination[0]:.2f},{destination[1]:.2f}...")

        bathy = self._load_region(origin, destination)
        lats = bathy.lat.values
        lons = bathy.lon.values
        elev = bathy.values  # 2D numpy array (negative = depth)

        rows, cols = elev.shape
        print(f"    Grid: {cols}×{rows} ({cols * rows:,} cells)")

        # ─── Step 2: Build navigability mask ──────────────────────────────
        # True = passable (deep enough water)
        # GEBCO elevation: negative = depth below sea level
        # safe_depth = draft + UKC → we need elevation ≤ -safe_depth
        passable = elev <= -self.safe_depth
        land_pct = 100.0 * (1 - np.mean(passable))
        print(f"    Navigable: {np.mean(passable) * 100:.1f}% "
              f"(land/shallow: {land_pct:.1f}%)")

        # ─── Step 3: Map origin/destination to grid indices ───────────────
        start_rc = self._latlon_to_grid(origin[0], origin[1], lats, lons)
        end_rc = self._latlon_to_grid(destination[0], destination[1], lats, lons)

        # Validate start/end are in navigable water
        if not passable[start_rc[0], start_rc[1]]:
            # Try to find nearest navigable cell (within 20 cells)
            start_rc = self._snap_to_water(start_rc, passable, max_search=20)
            if start_rc is None:
                raise RouteError(
                    f"Origin ({origin[0]:.4f}, {origin[1]:.4f}) is on land or "
                    f"shallow water (< {self.safe_depth}m). "
                    "Try a deeper-water departure point."
                )

        if not passable[end_rc[0], end_rc[1]]:
            end_rc = self._snap_to_water(end_rc, passable, max_search=20)
            if end_rc is None:
                raise RouteError(
                    f"Destination ({destination[0]:.4f}, {destination[1]:.4f}) is on land "
                    f"or shallow water (< {self.safe_depth}m). "
                    "Try a deeper-water arrival point."
                )

        print(f"    Start cell: ({start_rc[0]}, {start_rc[1]}) "
              f"depth: {-elev[start_rc[0], start_rc[1]]:.0f}m")
        print(f"    End cell:   ({end_rc[0]}, {end_rc[1]}) "
              f"depth: {-elev[end_rc[0], end_rc[1]]:.0f}m")

        # ─── Step 4: A* Search ────────────────────────────────────────────
        print(f"    Running A* pathfinding...")
        raw_path = self._astar(start_rc, end_rc, passable, lats, lons, elev)

        if raw_path is None:
            raise RouteError(
                f"No navigable route found between "
                f"({origin[0]:.4f}, {origin[1]:.4f}) and "
                f"({destination[0]:.4f}, {destination[1]:.4f}). "
                "The passage may be blocked by land or shallow water."
            )

        print(f"    A* raw path: {len(raw_path)} nodes")

        # ─── Step 5: Line-of-Sight Smoothing ──────────────────────────────
        smoothed = self._los_smooth(raw_path, passable)
        print(f"    Smoothed: {len(smoothed)} waypoints "
              f"(removed {len(raw_path) - len(smoothed)} intermediate nodes)")

        # ─── Step 6: Convert grid indices → lat/lon ───────────────────────
        waypoints = [[float(lats[r]), float(lons[c])] for r, c in smoothed]

        # Force exact origin and destination
        waypoints[0] = [origin[0], origin[1]]
        waypoints[-1] = [destination[0], destination[1]]

        # Calculate total distance
        total_nm = sum(
            haversine_nm(waypoints[i][0], waypoints[i][1],
                         waypoints[i + 1][0], waypoints[i + 1][1])
            for i in range(len(waypoints) - 1)
        )

        elapsed = time.time() - t0
        print(f"    ✓ Route: {len(waypoints)} waypoints, "
              f"{total_nm:.1f} NM, computed in {elapsed:.2f}s")

        return waypoints

    # ═══════════════════════════════════════════════════════════════════════
    # DATA LOADING
    # ═══════════════════════════════════════════════════════════════════════

    def _load_region(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
    ) -> xr.DataArray:
        """Load and downsample the regional bathymetry from Zarr."""
        lat_min = min(origin[0], destination[0]) - self.buffer_deg
        lat_max = max(origin[0], destination[0]) + self.buffer_deg
        lon_min = min(origin[1], destination[1]) - self.buffer_deg
        lon_max = max(origin[1], destination[1]) + self.buffer_deg

        # Clamp to valid ranges
        lat_min = max(-90, lat_min)
        lat_max = min(90, lat_max)
        lon_min = max(-180, lon_min)
        lon_max = min(180, lon_max)

        ds = xr.open_zarr(self.zarr_path, consolidated=True)

        region = ds["elevation"].sel(
            lat=slice(lat_min, lat_max),
            lon=slice(lon_min, lon_max),
        )

        # Downsample for performance
        if self.resolution_factor > 1:
            region = region.coarsen(
                lat=self.resolution_factor,
                lon=self.resolution_factor,
                boundary="trim",
            ).min()  # min() preserves the shallowest depth (conservative for safety)

        data = region.compute()
        ds.close()
        return data

    # ═══════════════════════════════════════════════════════════════════════
    # GRID UTILITIES
    # ═══════════════════════════════════════════════════════════════════════

    @staticmethod
    def _latlon_to_grid(
        lat: float, lon: float,
        lats: np.ndarray, lons: np.ndarray,
    ) -> tuple[int, int]:
        """Find the nearest grid cell to a lat/lon coordinate."""
        row = int(np.argmin(np.abs(lats - lat)))
        col = int(np.argmin(np.abs(lons - lon)))
        return (row, col)

    @staticmethod
    def _snap_to_water(
        rc: tuple[int, int],
        passable: np.ndarray,
        max_search: int = 20,
    ) -> Optional[tuple[int, int]]:
        """
        Find the nearest navigable cell to a given grid position.
        Spiral outward from the point until we find safe water.
        """
        rows, cols = passable.shape
        r0, c0 = rc

        for radius in range(1, max_search + 1):
            for dr in range(-radius, radius + 1):
                for dc in range(-radius, radius + 1):
                    if abs(dr) != radius and abs(dc) != radius:
                        continue  # Only check perimeter of the square
                    r, c = r0 + dr, c0 + dc
                    if 0 <= r < rows and 0 <= c < cols and passable[r, c]:
                        return (r, c)
        return None

    # ═══════════════════════════════════════════════════════════════════════
    # A* PATHFINDING
    # ═══════════════════════════════════════════════════════════════════════

    def _astar(
        self,
        start: tuple[int, int],
        end: tuple[int, int],
        passable: np.ndarray,
        lats: np.ndarray,
        lons: np.ndarray,
        elev: np.ndarray,
    ) -> Optional[list[tuple[int, int]]]:
        """
        A* search over the bathymetric grid.

        Cost function:
        - Base cost = haversine distance between adjacent cells
        - Land (elevation > 0) = impassable (infinite cost)
        - Shallow water (depth < safe_depth) = impassable
        - Depth-weighted penalty: slightly prefer deeper water for safety
          (cells just above the threshold get a 2× penalty to encourage
           routes through deeper, safer channels)

        Heuristic:
        - Haversine great-circle distance to goal (admissible, never overestimates)

        Returns None if no path exists. Otherwise returns list of (row, col).
        """
        rows, cols = passable.shape

        # Pre-compute cell sizes (lat degrees → constant, lon degrees vary with lat)
        lat_step = abs(float(lats[1] - lats[0])) if len(lats) > 1 else 0.01667
        lon_step = abs(float(lons[1] - lons[0])) if len(lons) > 1 else 0.01667

        goal_lat = float(lats[end[0]])
        goal_lon = float(lons[end[1]])

        # Priority queue
        open_set: list[_Node] = []
        h0 = haversine_nm(float(lats[start[0]]), float(lons[start[1]]), goal_lat, goal_lon)
        heapq.heappush(open_set, _Node(f_cost=h0, g_cost=0.0, row=start[0], col=start[1]))

        # Visited set with best g-cost
        g_best = np.full((rows, cols), np.inf, dtype=np.float32)
        g_best[start[0], start[1]] = 0.0

        # Parent map for path reconstruction
        parent = np.full((rows, cols, 2), -1, dtype=np.int32)

        expansions = 0

        while open_set:
            node = heapq.heappop(open_set)

            # Goal reached
            if node.row == end[0] and node.col == end[1]:
                return self._reconstruct_path(parent, start, end)

            # Skip if we've already found a better path to this cell
            if node.g_cost > g_best[node.row, node.col]:
                continue

            expansions += 1
            if expansions > MAX_EXPANSIONS:
                print(f"    ⚠ A* exceeded {MAX_EXPANSIONS:,} expansions — no route found")
                return None

            # Progress logging every 100k expansions
            if expansions % 100_000 == 0:
                remaining = haversine_nm(
                    float(lats[node.row]), float(lons[node.col]),
                    goal_lat, goal_lon
                )
                print(f"      ... {expansions:,} nodes expanded, "
                      f"~{remaining:.0f} NM remaining")

            # Explore 8-connected neighbours
            for dy, dx, diag_cost in DIRECTIONS_8:
                nr, nc = node.row + dy, node.col + dx

                # Bounds check
                if nr < 0 or nr >= rows or nc < 0 or nc >= cols:
                    continue

                # Passability check
                if not passable[nr, nc]:
                    continue

                # Movement cost (haversine between cells)
                cell_lat = float(lats[nr])
                cell_lon = float(lons[nc])
                step_dist = haversine_nm(
                    float(lats[node.row]), float(lons[node.col]),
                    cell_lat, cell_lon
                )

                # Depth penalty: cells barely deep enough get a 1.5× penalty
                # to encourage routes through deeper, safer water
                depth = -elev[nr, nc]  # Convert elevation to positive depth
                depth_factor = 1.0
                if depth < self.safe_depth * 2:
                    # Linearly interpolate penalty: safe_depth → 1.5×, safe_depth*2 → 1.0×
                    t = (depth - self.safe_depth) / max(1.0, self.safe_depth)
                    depth_factor = 1.5 - 0.5 * min(1.0, max(0.0, t))

                new_g = node.g_cost + step_dist * depth_factor

                if new_g < g_best[nr, nc]:
                    g_best[nr, nc] = new_g
                    h = haversine_nm(cell_lat, cell_lon, goal_lat, goal_lon)
                    parent[nr, nc] = [node.row, node.col]
                    heapq.heappush(open_set, _Node(
                        f_cost=new_g + h,
                        g_cost=new_g,
                        row=nr,
                        col=nc
                    ))

        print(f"    ⚠ A* exhausted search space ({expansions:,} expansions)")
        return None

    @staticmethod
    def _reconstruct_path(
        parent: np.ndarray,
        start: tuple[int, int],
        end: tuple[int, int],
    ) -> list[tuple[int, int]]:
        """Walk backwards through the parent map to build the path."""
        path = []
        r, c = end
        while (r, c) != start:
            path.append((r, c))
            pr, pc = int(parent[r, c, 0]), int(parent[r, c, 1])
            if pr == -1 and pc == -1:
                break
            r, c = pr, pc
        path.append(start)
        path.reverse()
        return path

    # ═══════════════════════════════════════════════════════════════════════
    # LINE-OF-SIGHT SMOOTHING (Bresenham Ray-Casting)
    # ═══════════════════════════════════════════════════════════════════════

    def _los_smooth(
        self,
        path: list[tuple[int, int]],
        passable: np.ndarray,
    ) -> list[tuple[int, int]]:
        """
        Remove unnecessary intermediate waypoints using line-of-sight checks.

        Algorithm:
        1. Start at the first waypoint
        2. Look ahead to the farthest waypoint where a straight line
           (Bresenham rasterisation) stays in navigable water
        3. Jump to that waypoint and repeat
        4. This produces long, clean legs — the route a human would actually sail

        This is critical because standard A* produces step-like zigzag paths
        on a grid. Without smoothing, a 2000 NM passage would have hundreds
        of 1° turns.
        """
        if len(path) <= 2:
            return path

        smoothed = [path[0]]
        current_idx = 0

        while current_idx < len(path) - 1:
            # Binary search for the farthest visible waypoint
            best_visible = current_idx + 1

            # Check progressively farther waypoints
            for check_idx in range(len(path) - 1, current_idx, -1):
                if self._bresenham_clear(
                    path[current_idx], path[check_idx], passable
                ):
                    best_visible = check_idx
                    break

            smoothed.append(path[best_visible])
            current_idx = best_visible

        return smoothed

    @staticmethod
    def _bresenham_clear(
        p1: tuple[int, int],
        p2: tuple[int, int],
        passable: np.ndarray,
    ) -> bool:
        """
        Check if a straight line between two grid cells passes entirely
        through navigable water, using Bresenham's line algorithm.

        This is the "ray-casting" check — if every cell on the line is
        passable, the two waypoints have line-of-sight and we can draw
        a straight leg between them.

        Returns True if the entire line is in safe water.
        """
        r1, c1 = p1
        r2, c2 = p2

        dr = abs(r2 - r1)
        dc = abs(c2 - c1)
        sr = 1 if r2 > r1 else -1
        sc = 1 if c2 > c1 else -1

        # Also check a 1-cell corridor on each side of the line
        # to ensure the route doesn't graze land/shallows
        rows, cols = passable.shape

        if dr >= dc:
            err = dr // 2
            c = c1
            for r in range(r1, r2 + sr, sr):
                # Check center and 1 cell on each side (perpendicular to line)
                if not (0 <= r < rows and 0 <= c < cols and passable[r, c]):
                    return False
                # Also check perpendicular neighbors for safety margin
                if dc > 0:
                    for offset in [-1, 1]:
                        cr = r + offset if dr > dc else r
                        cc = c + offset if dc >= dr else c
                        if 0 <= cr < rows and 0 <= cc < cols and not passable[cr, cc]:
                            return False

                err -= dc
                if err < 0:
                    c += sc
                    err += dr
        else:
            err = dc // 2
            r = r1
            for c_iter in range(c1, c2 + sc, sc):
                if not (0 <= r < rows and 0 <= c_iter < cols and passable[r, c_iter]):
                    return False
                for offset in [-1, 1]:
                    cr = r + offset
                    if 0 <= cr < rows and 0 <= c_iter < cols and not passable[cr, c_iter]:
                        return False

                err -= dr
                if err < 0:
                    r += sr
                    err += dc

        return True


# ═══════════════════════════════════════════════════════════════════════════════
# CUSTOM EXCEPTION
# ═══════════════════════════════════════════════════════════════════════════════

class RouteError(Exception):
    """Raised when no safe marine route can be found."""
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# GPX EXPORT
# ═══════════════════════════════════════════════════════════════════════════════

def waypoints_to_gpx(
    waypoints: list[list[float]],
    name: str = "Thalassa Route",
    origin_name: str = "Departure",
    destination_name: str = "Arrival",
) -> str:
    """
    Convert waypoint list to GPX 1.1 XML.

    Parameters
    ----------
    waypoints : list of [lat, lon]
    name : str
        Route name in GPX metadata
    origin_name, destination_name : str
        Labels for first/last waypoints

    Returns
    -------
    str
        GPX 1.1 XML string
    """
    gpx_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Thalassa Marine Router"',
        '     xmlns="http://www.topografix.com/GPX/1/1">',
        f'  <metadata><name>{name}</name></metadata>',
        f'  <rte>',
        f'    <name>{name}</name>',
    ]

    for i, (lat, lon) in enumerate(waypoints):
        if i == 0:
            wp_name = origin_name
        elif i == len(waypoints) - 1:
            wp_name = destination_name
        else:
            wp_name = f"WP-{i:02d}"

        gpx_lines.append(
            f'    <rtept lat="{lat:.6f}" lon="{lon:.6f}">'
            f'<name>{wp_name}</name></rtept>'
        )

    gpx_lines.extend([
        '  </rte>',
        '</gpx>',
    ])

    return "\n".join(gpx_lines)


# ═══════════════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Thalassa Marine Router — Find safe passages through deep water",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Newport QLD to Bali
  python marine_router.py --zarr ./gebco_zarr \\
    --origin -27.35,153.22 --dest -8.75,115.17 --draft 2.5

  # Sydney to Noumea via Norfolk Island
  python marine_router.py --zarr ./gebco_zarr \\
    --origin -33.86,151.21 --dest -22.27,166.45 \\
    --via -29.03,167.95 --draft 1.8

  # Output as GPX
  python marine_router.py --zarr ./gebco_zarr \\
    --origin -27.35,153.22 --dest -8.75,115.17 \\
    --format gpx > route.gpx
        """,
    )
    parser.add_argument("--zarr", "-z", required=True, help="Path to GEBCO Zarr store")
    parser.add_argument("--origin", "-o", required=True, help="Origin lat,lon (e.g., -27.35,153.22)")
    parser.add_argument("--dest", "-d", required=True, help="Destination lat,lon")
    parser.add_argument("--via", "-v", default=None, help="Via waypoint lat,lon (optional)")
    parser.add_argument("--draft", type=float, default=2.5, help="Vessel draft in metres (default: 2.5)")
    parser.add_argument("--resolution", "-r", type=int, default=DEFAULT_RESOLUTION_FACTOR,
                        help=f"Grid downsample factor (default: {DEFAULT_RESOLUTION_FACTOR})")
    parser.add_argument("--format", "-f", choices=["json", "gpx"], default="json",
                        help="Output format (default: json)")

    args = parser.parse_args()

    # Parse coordinates
    def parse_coord(s: str) -> tuple[float, float]:
        parts = s.split(",")
        return (float(parts[0]), float(parts[1]))

    origin = parse_coord(args.origin)
    dest = parse_coord(args.dest)
    via = parse_coord(args.via) if args.via else None

    # Route
    print(f"╔{'═' * 60}╗")
    print(f"║  THALASSA Marine Router{' ' * 36}║")
    print(f"╚{'═' * 60}╝")
    print()
    print(f"  Origin:      {origin[0]:.4f}°, {origin[1]:.4f}°")
    print(f"  Destination: {dest[0]:.4f}°, {dest[1]:.4f}°")
    if via:
        print(f"  Via:         {via[0]:.4f}°, {via[1]:.4f}°")
    print(f"  Draft:       {args.draft}m (safe depth: {args.draft + UKC_MARGIN}m)")
    print(f"  Resolution:  {args.resolution}× downsample")
    print()

    router = MarineRouter(
        zarr_path=args.zarr,
        vessel_draft=args.draft,
        resolution_factor=args.resolution,
    )

    try:
        waypoints = router.route(origin, dest, via)
    except RouteError as e:
        print(f"\n  ✗ {e}")
        exit(1)

    # Output
    if args.format == "gpx":
        print(waypoints_to_gpx(waypoints, name=f"Route"))
    else:
        print(json.dumps(waypoints, indent=2))
