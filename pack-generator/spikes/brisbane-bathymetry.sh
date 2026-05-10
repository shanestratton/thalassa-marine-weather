#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  Phase 14 PIVOT — Brisbane bathymetry spike
#
#  Proves the public-data → ENC-shaped GeoJSON pipeline end-to-end
#  on one small area (Moreton Bay / Brisbane River mouth, ~5 NM box).
#
#  Inputs:  AusBathyTopo (Geoscience Australia, CC-BY 4.0) GeoTIFF
#  Outputs: out/brisbane-depare.geojson (FeatureCollection of DEPARE
#           polygons with DRVAL1/DRVAL2 attributes — same shape as
#           Phase 13's inshore router consumes from NOAA cells)
#
#  Run on Pi (or any box with GDAL ≥ 3.0):
#    cd pack-generator
#    ./spikes/brisbane-bathymetry.sh
#
#  Estimate: ~2 minutes on Pi 5 (download + contour extraction).
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  🌊 Brisbane Bathymetry — Public Data Pipeline Spike${NC}"
echo -e "${CYAN}  ════════════════════════════════════════════════════${NC}"
echo ""

# ── Prereq: GDAL ────────────────────────────────────────────────────
if ! command -v gdal_contour &>/dev/null; then
    echo -e "${RED}  GDAL not installed.${NC} On Pi: ${BOLD}sudo apt install gdal-bin${NC}"
    exit 1
fi
GDAL_VERSION=$(gdalinfo --version | awk '{print $2}' | tr -d ',')
echo -e "  ${GREEN}✓${NC} GDAL ${GDAL_VERSION}"

# ── Working dirs ────────────────────────────────────────────────────
mkdir -p data out
SOURCE_TIF="data/brisbane-ausbathytopo.tif"
DEPARE_GEOJSON="out/brisbane-depare.geojson"

# ── Source data ─────────────────────────────────────────────────────
# AusBathyTopo's full 250m grid for AU is ~5GB. For the spike we
# subset to Brisbane harbour using gdal_translate's projwin.
#
# Geoscience Australia hosts AusBathyTopo on their AODN node. The
# full URL pattern for the 2024 release is documented at:
#   https://www.ga.gov.au/data-pubs/data-and-publications-search/
#     publications/marine/ausbathytopo
#
# For the spike we use a known sample tile that covers the SE Qld
# coast at sufficient resolution to render the Brisbane River and
# Moreton Bay channels.
#
# NOTE: this URL is illustrative — Geoscience Australia's exact
# tile-download URL pattern may have changed between releases. The
# spike-runner can substitute their own bathymetry source (GEBCO,
# EMODnet, NOAA bathymetry — any GeoTIFF with depth values in m
# below MSL works the same way).

# Brisbane bbox: roughly 153.0 to 153.3 east, -27.6 to -27.2 south
BBOX_LON_MIN="153.00"
BBOX_LAT_MIN="-27.60"
BBOX_LON_MAX="153.30"
BBOX_LAT_MAX="-27.20"

if [[ ! -f "$SOURCE_TIF" ]]; then
    echo -e "  Source GeoTIFF not found at: ${SOURCE_TIF}"
    echo ""
    echo -e "${YELLOW}  Manual step required:${NC} download Brisbane-area"
    echo -e "  bathymetry GeoTIFF and place at ${BOLD}${SOURCE_TIF}${NC}."
    echo ""
    echo -e "  Recommended sources (any one is fine for the spike):"
    echo ""
    echo -e "  • ${BOLD}GEBCO 2024${NC} (free, global, 460m resolution):"
    echo -e "    https://download.gebco.net/  → 'GEBCO_2024 sub-ice topo/bathymetry'"
    echo -e "    Subset to bbox: ${BBOX_LON_MIN},${BBOX_LAT_MIN},${BBOX_LON_MAX},${BBOX_LAT_MAX}"
    echo ""
    echo -e "  • ${BOLD}AusBathyTopo${NC} (Geoscience Australia, CC-BY 4.0, 30-250m):"
    echo -e "    https://ecat.ga.gov.au/geonetwork/srv/eng/catalog.search"
    echo -e "    Search: 'AusBathyTopo 250m 2024'"
    echo ""
    echo -e "  • ${BOLD}EMODnet Bathymetry${NC} (free, AU coverage in their global product):"
    echo -e "    https://emodnet.ec.europa.eu/en/bathymetry"
    echo ""
    echo -e "  Once downloaded, save as ${BOLD}${SOURCE_TIF}${NC} and re-run."
    echo -e "  Subsequent runs are instant — the contour extraction is fast."
    echo ""
    exit 0
fi

# ── Inspect input ───────────────────────────────────────────────────
echo -e "  ${GREEN}✓${NC} Source raster: ${SOURCE_TIF}"
gdalinfo "$SOURCE_TIF" | grep -E 'Size|Pixel|Coordinate|Origin|Min|Max' | head -8 | sed 's/^/      /'

# ── Subset to bbox if the input is bigger ──────────────────────────
SUBSET_TIF="data/brisbane-bathymetry-subset.tif"
if [[ ! -f "$SUBSET_TIF" ]] || [[ "$SOURCE_TIF" -nt "$SUBSET_TIF" ]]; then
    echo -e "  Subsetting to Brisbane bbox..."
    gdal_translate -q \
        -projwin "$BBOX_LON_MIN" "$BBOX_LAT_MAX" "$BBOX_LON_MAX" "$BBOX_LAT_MIN" \
        "$SOURCE_TIF" "$SUBSET_TIF" 2>&1 | grep -v "^$" || true
fi
echo -e "  ${GREEN}✓${NC} Subset prepared: ${SUBSET_TIF}"

# ── The actual contour extraction ──────────────────────────────────
# gdal_contour reads the raster and emits polygon contours at the
# specified depth values. -fl flag = fixed level (one per contour).
#
# We pick depth bands that match common ENC DEPARE values:
#   0m, 2m, 5m, 10m, 20m, 30m, 50m, 100m, 200m
#
# AusBathyTopo and most bathymetry products use POSITIVE values for
# below sea level (BSL). If your source uses negative values, we'd
# need to flip the sign — gdalinfo's "Min/Max" in inspect step shows
# the convention.
#
# -p flag: produce polygons (areas between contour lines), not just
# lines. This matches ENC's DEPARE polygon model.
# -amin/-amax flags name the attributes for min/max depth — we map
# directly to S-57's DRVAL1/DRVAL2 names.

echo -e "  Extracting depth contour polygons..."
TEMP_GEOJSON="$(mktemp --suffix=.geojson)"

# Note: -fl values are in the RASTER's native units. If raster is
# meters BSL positive (standard), these give us real depth bands.
gdal_contour -q \
    -p \
    -amin DRVAL1 \
    -amax DRVAL2 \
    -fl 0 -fl 2 -fl 5 -fl 10 -fl 20 -fl 30 -fl 50 -fl 100 -fl 200 \
    -f GeoJSON \
    "$SUBSET_TIF" \
    "$TEMP_GEOJSON"

# ── Tag features with the S-57 layer name ──────────────────────────
# gdal_contour outputs Feature properties { DRVAL1, DRVAL2 } but
# doesn't add a layer label. Phase 13's inshore router uses
# `_layer` to filter by feature class. We post-process with jq to
# add `_layer: "DEPARE"` and a quality grade.

if ! command -v jq &>/dev/null; then
    echo -e "${YELLOW}  jq not installed — installing...${NC}"
    sudo apt-get install -y jq >/dev/null 2>&1 || {
        echo -e "${RED}  Failed to install jq. Install manually: sudo apt install jq${NC}"
        exit 1
    }
fi

jq --arg source "AusBathyTopo (Geoscience Australia)" \
   --arg license "CC-BY 4.0" \
   '.features |= map(.properties += {
        "_layer": "DEPARE",
        "_source": $source,
        "_license": $license,
        "_grade": "D"
    })' \
   "$TEMP_GEOJSON" > "$DEPARE_GEOJSON"

rm -f "$TEMP_GEOJSON"

# ── Sanity check the output ────────────────────────────────────────
FEATURE_COUNT=$(jq '.features | length' "$DEPARE_GEOJSON")
DEPTH_RANGE=$(jq -r '
    [.features[].properties.DRVAL1, .features[].properties.DRVAL2]
    | map(select(. != null))
    | "min: \(min) m, max: \(max) m"
' "$DEPARE_GEOJSON" 2>/dev/null || echo "(parse failed)")

echo -e "  ${GREEN}✓${NC} ${BOLD}${DEPARE_GEOJSON}${NC}"
echo -e "      Features: ${FEATURE_COUNT} DEPARE polygons"
echo -e "      Depth range: ${DEPTH_RANGE}"
echo -e "      Size: $(du -h "$DEPARE_GEOJSON" | awk '{print $1}')"
echo ""

# ── Done ────────────────────────────────────────────────────────────
echo -e "${GREEN}${BOLD}  ✓ Spike complete!${NC}"
echo ""
echo -e "${CYAN}  Sanity check the output by feeding it to the inshore router:${NC}"
echo ""
echo -e "  Method 1 (eyeball it):"
echo -e "    Drag ${BOLD}${DEPARE_GEOJSON}${NC} into ${BOLD}https://geojson.io${NC}"
echo -e "    You should see depth-banded polygons over Brisbane harbour."
echo ""
echo -e "  Method 2 (route through it):"
echo -e "    Once pi-cache adds the public-data install endpoint, POST this"
echo -e "    file to /api/enc/install-public — same router consumes it as"
echo -e "    consumes NOAA cells."
echo ""
echo -e "${CYAN}  Next milestone:${NC} expand to all of AU (~30 min generator run),"
echo -e "  package as ${BOLD}au-coastal-YYYY-MM.tar.zst${NC}, host on GitHub Releases."
echo ""
