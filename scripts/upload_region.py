#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  Thalassa — Regional Square Uploader                        ║
║  Packages and uploads nav graph + markers to Supabase       ║
╚══════════════════════════════════════════════════════════════╝

Uploads a paired region "Square" to Supabase Storage:
  regions/<region_id>/nav_graph.json
  regions/<region_id>/nav_markers.geojson
  regions/<region_id>/manifest.json

Usage:
    python upload_region.py --region australia_se_qld \
        --graph thalassa_graph_se_queensland.json \
        --markers se_queensland_nav_markers.geojson

Requires:
    SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars
    (or a .env file in the project root)
"""

import argparse
import json
import os
import sys
import time

try:
    import requests
except ImportError:
    # Fall back to urllib for zero-dependency operation
    import urllib.request
    import urllib.error
    requests = None


BUCKET = "regions"


def load_env():
    """Load SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env or .env file."""
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not url or not key:
        # Try .env file in project root
        env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("SUPABASE_URL="):
                        url = url or line.split("=", 1)[1].strip().strip('"')
                    elif line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                        key = key or line.split("=", 1)[1].strip().strip('"')

    return url, key


def upload_file(supabase_url, service_key, region_id, filename, local_path, content_type="application/json"):
    """Upload a file to Supabase Storage."""
    storage_url = f"{supabase_url}/storage/v1/object/{BUCKET}/{region_id}/{filename}"

    with open(local_path, 'rb') as f:
        data = f.read()

    size_kb = len(data) / 1024
    print(f"  Uploading: {region_id}/{filename} ({size_kb:.0f} KB)")

    headers = {
        "Authorization": f"Bearer {service_key}",
        "Content-Type": content_type,
        "x-upsert": "true",  # Overwrite if exists
    }

    if requests:
        resp = requests.post(storage_url, headers=headers, data=data, timeout=120)
        if resp.status_code not in (200, 201):
            print(f"  ✗ Upload failed: {resp.status_code} {resp.text[:200]}")
            return False
    else:
        req = urllib.request.Request(storage_url, data=data, headers=headers, method='POST')
        try:
            urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            print(f"  ✗ Upload failed: {e.code} {e.read().decode()[:200]}")
            return False

    print(f"  ✓ Uploaded: {region_id}/{filename}")
    return True


def create_manifest(region_id, graph_path, markers_path, bbox=None):
    """Create a manifest.json describing the region Square."""
    graph_size = os.path.getsize(graph_path)
    markers_size = os.path.getsize(markers_path)

    # Read graph meta
    with open(graph_path, 'r') as f:
        graph_data = json.load(f)
    meta = graph_data.get('meta', {})

    # Count markers
    with open(markers_path, 'r') as f:
        markers_data = json.load(f)
    marker_count = len(markers_data.get('features', []))

    manifest = {
        "version": 1,
        "region_id": region_id,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": {
            "nav_graph": {
                "filename": "nav_graph.json",
                "size_bytes": graph_size,
                "content_type": "application/json",
            },
            "nav_markers": {
                "filename": "nav_markers.geojson",
                "size_bytes": markers_size,
                "content_type": "application/geo+json",
            },
        },
        "graph": {
            "nodes": meta.get("nodes", 0),
            "edges": meta.get("edges", 0),
            "total_nm": meta.get("total_nm", 0),
            "has_depth": meta.get("coord_order") == "lon_lat_depth",
        },
        "markers": {
            "count": marker_count,
        },
        "total_size_bytes": graph_size + markers_size,
        "total_size_mb": round((graph_size + markers_size) / 1024 / 1024, 1),
    }

    if bbox:
        manifest["bbox"] = bbox

    return manifest


def main():
    parser = argparse.ArgumentParser(
        description='Thalassa Regional Square Uploader',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python upload_region.py --region australia_se_qld \\
      --graph thalassa_graph_se_queensland.json \\
      --markers se_queensland_nav_markers.geojson

  python upload_region.py --region australia_se_qld \\
      --graph thalassa_graph_se_queensland.json \\
      --markers se_queensland_nav_markers.geojson \\
      --bbox 152.5,-28.2,153.6,-26.5
        """,
    )
    parser.add_argument('--region', required=True, help='Region ID (e.g., australia_se_qld)')
    parser.add_argument('--graph', required=True, help='Path to nav_graph.json')
    parser.add_argument('--markers', required=True, help='Path to nav_markers.geojson')
    parser.add_argument('--bbox', default=None, help='Bounding box: min_lon,min_lat,max_lon,max_lat')

    args = parser.parse_args()

    # Validate files
    for path, name in [(args.graph, 'graph'), (args.markers, 'markers')]:
        if not os.path.exists(path):
            print(f"ERROR: {name} file not found: {path}")
            sys.exit(1)

    # Load Supabase credentials
    supabase_url, service_key = load_env()
    if not supabase_url or not service_key:
        print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        print("  Either as environment variables or in a .env file")
        sys.exit(1)

    # Parse bbox
    bbox = None
    if args.bbox:
        bbox = [float(x) for x in args.bbox.split(',')]

    print("=" * 60)
    print("Thalassa — Regional Square Uploader")
    print("=" * 60)
    print(f"  Region:  {args.region}")
    print(f"  Graph:   {args.graph} ({os.path.getsize(args.graph) / 1024:.0f} KB)")
    print(f"  Markers: {args.markers} ({os.path.getsize(args.markers) / 1024:.0f} KB)")
    print(f"  Target:  {supabase_url}/storage/v1/{BUCKET}/{args.region}/")
    print()

    # Create manifest
    manifest = create_manifest(args.region, args.graph, args.markers, bbox)
    manifest_path = f"{args.region}_manifest.json"
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f"  Manifest: {manifest_path}")
    print(f"  Total package: {manifest['total_size_mb']} MB")
    print()

    # Upload all three files
    t0 = time.time()
    success = True

    success &= upload_file(supabase_url, service_key, args.region, "nav_graph.json", args.graph)
    success &= upload_file(supabase_url, service_key, args.region, "nav_markers.geojson", args.markers, "application/geo+json")
    success &= upload_file(supabase_url, service_key, args.region, "manifest.json", manifest_path)

    elapsed = time.time() - t0

    if success:
        print(f"\n  ✓ Region '{args.region}' uploaded in {elapsed:.1f}s")
        print(f"\n  Public URLs:")
        print(f"    Graph:    {supabase_url}/storage/v1/object/public/{BUCKET}/{args.region}/nav_graph.json")
        print(f"    Markers:  {supabase_url}/storage/v1/object/public/{BUCKET}/{args.region}/nav_markers.geojson")
        print(f"    Manifest: {supabase_url}/storage/v1/object/public/{BUCKET}/{args.region}/manifest.json")
    else:
        print(f"\n  ✗ Some uploads failed")
        sys.exit(1)

    # Cleanup temp manifest
    os.remove(manifest_path)
    print("=" * 60)


if __name__ == '__main__':
    main()
