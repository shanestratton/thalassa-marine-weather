#!/usr/bin/env bash
# Build Thalassa's seafloor "Relief" base tiles on the wx server.
#
#   tools/relief/build_relief.sh fetch     download GEBCO 2026, GA GBR 30 m 2020, OSM land polygons into $ROOT/src
#   tools/relief/build_relief.sh prep      unzip, build the GDAL docker image and the VRT mosaics
#   tools/relief/build_relief.sh global    relief-global (GEBCO, z0-9)          -> $OUT/relief-global
#   tools/relief/build_relief.sh au        relief-au (GBR 30 m over GEBCO, z8-13) -> $OUT/relief-au
#   tools/relief/build_relief.sh manifest  $OUT/manifest.json (counts, sizes, encoding, credits)
#   tools/relief/build_relief.sh verify    decode samples of every zoom; check counts, encoding, exaggeration
#   tools/relief/build_relief.sh serve     tailnet mirror: nginx on $SERVE_ADDR:$SERVE_PORT
#   tools/relief/build_relief.sh all       fetch prep global au manifest verify
#
# Never run this on the Mac (8 GB RAM, no GDAL, little disk). It needs docker
# (sudo is fine), ~25 GB of disk for the sources and ~10 GB for the tiles.
# Long steps belong in tmux:  tmux new -s relief 'tools/relief/build_relief.sh all'
# Every step is resumable: downloads continue, finished tile blocks are skipped.
#
# Data and licences (credit both wherever the tiles are shown):
#   GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa).
#     Public domain; commercial use allowed with credit, no endorsement implied, not for navigation.
#   Great Barrier Reef Bathymetry 2020 30 m (GA eCat 115066, pid.geoscience.gov.au/dataset/ga/115066)
#     (c) Commonwealth of Australia (Geoscience Australia), CC BY 4.0. Not for navigation.
#     NB the GA record also carries an Australian Hydrographic Service notice on
#     AHS-sourced material: see README.md before publishing relief-au.
#   OpenStreetMap land polygons (osmdata.openstreetmap.de), ODbL: the land mask
#     and coastline edge. Credit "(c) OpenStreetMap contributors".
set -euo pipefail

ROOT=${ROOT:-/srv/relief}
OUT=${OUT:-$ROOT/v1}
WORK=${WORK:-$ROOT/work}
SRC=$ROOT/src
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE=${IMAGE:-thalassa-relief:1}
WORKERS=${WORKERS:-20}
SERVE_ADDR=${SERVE_ADDR:-100.76.191.119}
SERVE_PORT=${SERVE_PORT:-8790}
DOCKER=${DOCKER:-docker}
if ! $DOCKER info >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

GEBCO_URL='https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/ice_surface_elevation/geotiff/gebco_2026_geotiff.zip?download=1'
OSM_LAND_URL='https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip'
GBR_URL='https://files.ausseabed.gov.au/survey/Great%20Barrier%20Reef%20Bathymetry%202020%2030m.zip'

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

fetch() {
  mkdir -p "$SRC/gebco" "$SRC/gbr30" "$SRC/osm"
  log "OSM land polygons, split, EPSG:3857 (~950 MB)"
  curl -fsSL --retry 5 --retry-delay 10 -C - -o "$SRC/osm/land-polygons-split-3857.zip" "$OSM_LAND_URL"
  log "GEBCO 2026 ice-surface elevation (~4.2 GB)"
  curl -fsSL --retry 5 --retry-delay 10 -C - -o "$SRC/gebco/gebco_2026_geotiff.zip" "$GEBCO_URL"
  log "GA Great Barrier Reef 2020 30 m, grids A-D (~3.8 GB)"
  curl -fsSL --retry 5 --retry-delay 10 -C - -o "$SRC/gbr30/gbr30_2020.zip" "$GBR_URL"
}

unzip_to() { # zip dir
  [ -n "$(ls "$2"/*.tif 2>/dev/null)" ] && return 0
  mkdir -p "$2"
  python3 -m zipfile -e "$1" "$2"
}

prep() {
  log "unzip"
  [ -f "$SRC/osm/land-polygons-split-3857/land_polygons.shp" ] || python3 -m zipfile -e "$SRC/osm/land-polygons-split-3857.zip" "$SRC/osm"
  unzip_to "$SRC/gebco/gebco_2026_geotiff.zip" "$SRC/gebco/elev"
  unzip_to "$SRC/gbr30/gbr30_2020.zip" "$SRC/gbr30"
  log "docker image $IMAGE (osgeo/gdal + scipy + pillow)"
  local ctx; ctx=$(mktemp -d)
  cat > "$ctx/Dockerfile" <<'EOF'
FROM ghcr.io/osgeo/gdal:ubuntu-small-latest
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-numpy \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages scipy pillow
EOF
  $DOCKER build -q -t "$IMAGE" "$ctx" >/dev/null
  rm -rf "$ctx"
  log "GEBCO VRT mosaic"
  run sh -c 'gdalbuildvrt -q src/gebco/gebco_2026.vrt src/gebco/elev/*.tif'
  if [ ! -f "$SRC/osm/land.gpkg" ]; then
    log "OSM land polygons -> GeoPackage with a spatial index"
    run ogr2ogr -f GPKG src/osm/land.gpkg src/osm/land-polygons-split-3857/land_polygons.shp -nln land -lco SPATIAL_INDEX=YES
  fi
}

run() { # run a command in the GDAL image with $ROOT mounted at the same path
  $DOCKER run --rm -u "$(id -u):$(id -g)" -v "$ROOT:$ROOT" -v "$TOOLS:/tools:ro" -w "$ROOT" "$IMAGE" "$@"
}

encode() { # global|au
  mkdir -p "$OUT" "$WORK"
  run python3 /tools/encode_tiles.py --pyramid "$1" \
    --gebco src/gebco/gebco_2026.vrt --land src/osm/land.gpkg \
    --gbr src/gbr30/Great_Barrier_Reef_A_2020_30m_MSL_cog.tif src/gbr30/Great_Barrier_Reef_B_2020_30m_MSL_cog.tif \
          src/gbr30/Great_Barrier_Reef_C_2020_30m_MSL_cog.tif src/gbr30/Great_Barrier_Reef_D_2020_30m_MSL_cog.tif \
    --out "$OUT" --work "$WORK" --workers "$WORKERS"
}

manifest() {
  python3 - "$OUT" "$WORK" <<'EOF'
import json, os, sys, datetime
out, work = sys.argv[1], sys.argv[2]
pyrs = {}
for name, zr in (('relief-global', (0, 9)), ('relief-au', (8, 13))):
    p = os.path.join(work, f'{name}-stats.json')
    if not os.path.exists(p):
        continue
    st = json.load(open(p))
    pyrs[name] = {
        'minzoom': zr[0], 'maxzoom': zr[1],
        'dem': f'{name}/dem/{{z}}/{{x}}/{{y}}.webp', 'idx': f'{name}/idx/{{z}}/{{x}}/{{y}}.png',
        'tiles_per_set': sum(v['tiles'] for v in st.values()),
        'bytes': {'dem': sum(v['dem_bytes'] for v in st.values()), 'idx': sum(v['idx_bytes'] for v in st.values())},
        'per_zoom': {z: {'tiles': v['tiles'], 'dem_bytes': v['dem_bytes'], 'idx_bytes': v['idx_bytes']} for z, v in sorted(st.items(), key=lambda kv: int(kv[0]))},
    }
pyrs.get('relief-au', {})['bounds'] = [142.0, -29.0, 156.0, -10.0]
m = {
    'name': 'Thalassa seafloor relief', 'version': 'v1',
    'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'tile_size': 256, 'scheme': 'xyz', 'projection': 'EPSG:3857',
    'dem': {'format': 'webp (lossless)', 'encoding': 'terrarium', 'units': 'metres, whole',
            'land': 'clamped to 0 m', 'exaggeration_baked': 3,
            'smoothing': 'relief-au z11-13 gaussian sigma 1 px', 'use': 'hillshade only'},
    'idx': {'format': 'png, 8-bit grey (R = G = B = index)', 'formula': '0 if d <= 0.3 m else 1 + round(253 * ln(1 + min(d, 6000)/2) / ln(3001)), d = depth in metres (positive down)',
            'raster_color_mix': [255, 0, 0, 0], 'raster_color_range': [0, 255], 'use': 'colour ramp only'},
    'missing_tiles': '404 = all land (or, in relief-au, no GBR 30 m data)',
    'attribution': 'Seafloor: GEBCO Compilation Group (2026) GEBCO 2026 Grid; GBR 30 m (c) Commonwealth of Australia (Geoscience Australia), CC BY 4.0; coastline (c) OpenStreetMap contributors. Not for navigation.',
    'land_mask': 'OpenStreetMap land polygons (osmdata.openstreetmap.de, ODbL), rasterised at pixel centres; plus anything at or above 0 m',
    'pyramids': pyrs,
}
json.dump(m, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
for k, v in pyrs.items():
    print(f"{k}: {v['tiles_per_set']} tiles per set, dem {v['bytes']['dem']/1e9:.2f} GB, idx {v['bytes']['idx']/1e9:.2f} GB")
EOF
  log "measured on disk: $(du -sh --apparent-size "$OUT" | cut -f1) apparent, $(find "$OUT" -type f | wc -l) files"
}

verify() { # decode samples of every zoom and check them against the manifest; exit 1 on any failure
  $DOCKER run --rm -i -u "$(id -u):$(id -g)" -v "$ROOT:$ROOT:ro" "$IMAGE" python3 - "$OUT" "${SAMPLES:-40}" <<'EOF'
import json, math, os, random, sys
import numpy as np
from PIL import Image
out, n = sys.argv[1], int(sys.argv[2])
m = json.load(open(os.path.join(out, 'manifest.json')))
exag = float(m['dem']['exaggeration_baked'])
random.seed(1)
fails = []
def depth(i):  # inverse of the idx formula (bin centres)
    return np.where(i > 0, 2.0 * np.expm1((i.astype('float64') - 1) / 253.0 * math.log1p(3000.0)), 0.0)
for name, p in m['pyramids'].items():
    for z, want in sorted(p['per_zoom'].items(), key=lambda kv: int(kv[0])):
        sets = {}
        for kind, ext in (('idx', '.png'), ('dem', '.webp')):
            d = os.path.join(out, name, kind, z)
            sets[kind] = {(x, f[:-len(ext)]) for x in os.listdir(d) for f in os.listdir(os.path.join(d, x)) if f.endswith(ext)}
            bad = [f for x in os.listdir(d) for f in os.listdir(os.path.join(d, x)) if not f.endswith(ext) or os.path.getsize(os.path.join(d, x, f)) == 0]
            if bad: fails.append(f'{name}/{kind}/{z}: {len(bad)} stray or empty files')
        if sets['idx'] != sets['dem']: fails.append(f'{name} z{z}: idx and dem tile lists differ')
        if len(sets['idx']) != want['tiles']: fails.append(f"{name} z{z}: {len(sets['idx'])} tiles on disk, manifest says {want['tiles']}")
        ratios, b_bad, pos, land = [], 0, 0, 0
        smoothed = name == 'relief-au' and int(z) >= 11
        for x, y in random.sample(sorted(sets['idx']), min(n, len(sets['idx']))):
            im = Image.open(os.path.join(out, name, 'idx', z, x, y + '.png'))
            dm = Image.open(os.path.join(out, name, 'dem', z, x, y + '.webp'))
            if im.mode != 'L' or im.size != (256, 256) or dm.format != 'WEBP' or dm.size != (256, 256):
                fails.append(f'{name}/{z}/{x}/{y}: {im.mode} {im.size} / {dm.format} {dm.size}'); continue
            idx = np.array(im); rgb = np.array(dm.convert('RGB')).astype('int64')
            dem = rgb[..., 0] * 256 + rgb[..., 1] - 32768
            # Smoothing may round a pixel under 3 m (idx <= 30) next to land to 0 m: allowed there only.
            b_bad += int((rgb[..., 2] != 0).sum()); pos += int((dem > 0).sum()); land += int(((dem == 0) & (idx > (30 if smoothed else 1))).sum())
            sel = (idx >= 60) & (idx < 254)  # 10 m to 6 km: one index step is < 4 %; 254 is the 6 km cap
            if sel.any(): ratios.append(-dem[sel] / depth(idx[sel]))
        r = np.concatenate(ratios) if ratios else np.array([exag])
        inside = float(((r > exag * 0.87) & (r < exag * 1.13)).mean())
        line = f'{name:13s} z{int(z):<2d} {len(sets["idx"]):7d} tiles  dem/depth median {np.median(r):.2f}, {inside:.1%} within +-13%'
        print(line + (' (smoothed: median only)' if smoothed else ''))
        if b_bad or pos or land: fails.append(f'{name} z{z}: B!=0 {b_bad} px, dem>0 {pos} px, dem=0 under water {land} px')
        if abs(np.median(r) - exag) > 0.1 * exag or (not smoothed and inside < 0.99):
            fails.append(f'{name} z{z}: dem/depth is not a flat x{exag:g} (median {np.median(r):.2f}, {inside:.1%} within 13%): an exaggeration step bakes cliffs into the hillshade')
print('\n'.join(['FAIL ' + f for f in fails]) or 'verify: all checks passed')
sys.exit(1 if fails else 0)
EOF
}

serve() {
  mkdir -p "$ROOT/serve" "$OUT"
  cat > "$ROOT/serve/nginx.conf" <<'EOF'
# Thalassa relief tiles, tailnet mirror (wx). Read-only static files.
server {
    listen 8790;
    server_name _;
    root /usr/share/nginx/html;
    access_log off;
    gzip off;
    location / {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Cache-Control "public, max-age=3600" always;
        try_files $uri =404;
    }
}
EOF
  $DOCKER rm -f thalassa-relief-tiles >/dev/null 2>&1 || true
  $DOCKER run -d --name thalassa-relief-tiles --restart unless-stopped \
    -p "$SERVE_ADDR:$SERVE_PORT:8790" \
    -v "$OUT:/usr/share/nginx/html/$(basename "$OUT"):ro" \
    -v "$ROOT/serve/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine >/dev/null
  log "serving $OUT at http://$SERVE_ADDR:$SERVE_PORT/$(basename "$OUT")/"
}

case "${1:-}" in
  fetch) fetch ;;
  prep) prep ;;
  global) encode global ;;
  au) encode au ;;
  manifest) manifest ;;
  verify) verify ;;
  serve) serve ;;
  all) fetch; prep; encode global; encode au; manifest; verify ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
