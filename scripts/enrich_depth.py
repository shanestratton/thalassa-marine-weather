#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  Thalassa — Depth Enrichment for Navigation Graph           ║
║  Samples bathymetry raster at each graph node               ║
╚══════════════════════════════════════════════════════════════╝

Takes an existing thalassa_nav_graph JSON and a bathymetry GeoTIFF,
samples depth at each node, and outputs an enriched graph with depth.

Node format changes from [lon, lat] to [lon, lat, depth_m].
Depth values: negative = below sea level (navigable), positive = land.

Usage:
    python enrich_depth.py thalassa_graph_se_queensland.json tiles/thalassa_bathymetry_global.tif
"""

import json
import os
import sys
import time
import gzip
import numpy as np

try:
    import rasterio
    from rasterio.transform import rowcol
except ImportError:
    print("ERROR: rasterio not installed. Run: pip install rasterio")
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print("Usage: python enrich_depth.py <graph.json> <bathymetry.tif>")
        sys.exit(1)

    graph_path = sys.argv[1]
    raster_path = sys.argv[2]

    print("=" * 60)
    print("Thalassa — Depth Enrichment")
    print("=" * 60)

    # Load graph
    print(f"\n  Loading graph: {graph_path}")
    with open(graph_path, 'r') as f:
        data = json.load(f)

    nodes = data['nodes']
    print(f"  Nodes: {len(nodes):,}")
    print(f"  Current format: {nodes[0]}")

    # Open raster
    print(f"\n  Opening raster: {raster_path}")
    t0 = time.time()

    with rasterio.open(raster_path) as src:
        print(f"  CRS: {src.crs}")
        print(f"  Size: {src.width}x{src.height}")
        print(f"  Bounds: {src.bounds}")
        print(f"  Resolution: {src.res}")

        # Read the entire band into memory for fast sampling
        print(f"\n  Reading raster into memory...")
        band = src.read(1)  # int16, ~79MB in memory
        transform = src.transform
        nodata = src.nodata

        print(f"  Band shape: {band.shape}, dtype: {band.dtype}")
        print(f"  NoData: {nodata}")

        # Sample depth at each node
        print(f"\n  Sampling depth at {len(nodes):,} nodes...")
        t1 = time.time()

        depth_stats = {'water': 0, 'land': 0, 'nodata': 0, 'shallow': 0}
        enriched_nodes = []

        for i, node in enumerate(nodes):
            lon, lat = node[0], node[1]

            try:
                row, col = rowcol(transform, lon, lat)
                row, col = int(row), int(col)

                if 0 <= row < band.shape[0] and 0 <= col < band.shape[1]:
                    elev = float(band[row, col])

                    if nodata is not None and elev == nodata:
                        depth_m = None
                        depth_stats['nodata'] += 1
                    else:
                        # GEBCO/ETOPO convention: negative = below sea level
                        depth_m = round(elev, 1)
                        if elev < -3:
                            depth_stats['water'] += 1
                        elif elev < 0:
                            depth_stats['shallow'] += 1
                        else:
                            depth_stats['land'] += 1
                else:
                    depth_m = None
                    depth_stats['nodata'] += 1

            except Exception:
                depth_m = None
                depth_stats['nodata'] += 1

            # [lon, lat, depth_m] — depth_m is negative for water
            enriched_nodes.append([node[0], node[1], depth_m])

            if (i + 1) % 50000 == 0:
                print(f"    Sampled {i + 1:,} / {len(nodes):,}...")

        elapsed = time.time() - t1
        print(f"\n  Depth sampling complete in {elapsed:.1f}s")
        print(f"  Water (>3m): {depth_stats['water']:,}")
        print(f"  Shallow (0-3m): {depth_stats['shallow']:,}")
        print(f"  Land (above sea level): {depth_stats['land']:,}")
        print(f"  NoData: {depth_stats['nodata']:,}")

    # Update graph
    data['nodes'] = enriched_nodes
    data['meta']['coord_order'] = 'lon_lat_depth'
    data['meta']['depth_unit'] = 'meters_below_sea_level'
    data['meta']['depth_convention'] = 'negative_is_water'

    # Save
    output_path = graph_path
    json_str = json.dumps(data, separators=(',', ':'))

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(json_str)

    # Also gzip
    gz_path = output_path + '.gz'
    with gzip.open(gz_path, 'wt', encoding='utf-8', compresslevel=9) as f:
        f.write(json_str)

    raw_size = len(json_str.encode()) / 1024 / 1024
    gz_size = os.path.getsize(gz_path) / 1024 / 1024

    print(f"\n  Saved: {output_path} ({raw_size:.1f} MB)")
    print(f"  Gzipped: {gz_path} ({gz_size:.1f} MB)")
    print(f"\n  Node format: [lon, lat, depth_m]")
    print(f"  Example: {enriched_nodes[0]}")
    print("=" * 60)


if __name__ == '__main__':
    main()
