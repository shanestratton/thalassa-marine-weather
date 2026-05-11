#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  Phase 14 PIVOT — Brisbane bathymetry spike
#
#  Proves the public-data → ENC-shaped GeoJSON pipeline end-to-end
#  on one small bbox (Moreton Bay / Brisbane River, ~30km × 45km).
#  Fully automated — downloads bathymetry, runs contour extraction,
#  outputs ENC-compatible GeoJSON.
#
#  Run on Pi (or any GDAL ≥ 3 box):
#    cd pack-generator
#    ./spikes/brisbane-bathymetry.sh
#
#  Estimate: ~30 seconds first run (download + extract), ~5s subsequent.
#
#  Source: GMRT (Global Multi-Resolution Topography), Lamont-Doherty
#  Earth Observatory at Columbia. Free, no registration, public-domain.
#  https://www.gmrt.org
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

# ── Prereqs ─────────────────────────────────────────────────────────
for cmd in gdal_contour gdalinfo curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
        case "$cmd" in
            gdal_contour|gdalinfo)
                echo -e "${RED}  GDAL not installed.${NC} On Pi: ${BOLD}sudo apt install gdal-bin${NC}"
                ;;
            curl|jq)
                echo -e "${RED}  $cmd not installed.${NC} On Pi: ${BOLD}sudo apt install $cmd${NC}"
                ;;
        esac
        exit 1
    fi
done
GDAL_VERSION=$(gdalinfo --version | awk '{print $2}' | tr -d ',')
echo -e "  ${GREEN}✓${NC} GDAL ${GDAL_VERSION}"

# ── Working dirs ────────────────────────────────────────────────────
mkdir -p data out
SOURCE_TIF="data/brisbane-bathymetry.tif"
DEPARE_GEOJSON="out/brisbane-depare.geojson"

# Brisbane bbox: Moreton Bay + River + outer shelf. About 30km × 45km.
BBOX_LON_MIN="153.00"
BBOX_LAT_MIN="-27.60"
BBOX_LON_MAX="153.40"
BBOX_LAT_MAX="-27.10"

# ── Download bathymetry via GMRT ────────────────────────────────────
# GMRT GridServer: returns GeoTIFF for any bbox at requested resolution.
# Resolution 'med' = ~100m near coast (good for harbour-scale routing),
# 'high' = ~50m where data exists. We use 'med' for guaranteed coverage.
#
# GMRT data is multi-source: combines GEBCO + many regional surveys.
# For Australian waters they include AusBathyTopo plus other sources.
# All public domain in the GMRT distribution.
if [[ ! -f "$SOURCE_TIF" ]]; then
    GMRT_URL="https://www.gmrt.org/services/GridServer"
    GMRT_URL+="?west=${BBOX_LON_MIN}"
    GMRT_URL+="&east=${BBOX_LON_MAX}"
    GMRT_URL+="&south=${BBOX_LAT_MIN}"
    GMRT_URL+="&north=${BBOX_LAT_MAX}"
    GMRT_URL+="&format=geotiff"
    GMRT_URL+="&resolution=med"
    GMRT_URL+="&layer=topo"

    echo -e "  Downloading bathymetry from GMRT..."
    echo -e "      bbox: ${BBOX_LON_MIN},${BBOX_LAT_MIN} → ${BBOX_LON_MAX},${BBOX_LAT_MAX}"

    if ! curl -fsSL --max-time 120 -o "$SOURCE_TIF" "$GMRT_URL"; then
        echo -e "${RED}  ✗ GMRT download failed.${NC}"
        echo -e "    URL: ${GMRT_URL}"
        echo -e "    The GMRT service may be down, or the bbox may be too large."
        echo -e "    Try a smaller bbox or check https://www.gmrt.org status."
        exit 1
    fi

    SIZE=$(stat -c%s "$SOURCE_TIF" 2>/dev/null || stat -f%z "$SOURCE_TIF")
    if [[ "$SIZE" -lt 1000 ]]; then
        # Likely an HTML error page rather than a real GeoTIFF
        echo -e "${RED}  ✗ Downloaded file is too small (${SIZE} bytes).${NC}"
        echo -e "    Probably an error response. First 200 chars:"
        head -c 200 "$SOURCE_TIF" | sed 's/^/      /'
        echo ""
        rm -f "$SOURCE_TIF"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Downloaded $(du -h "$SOURCE_TIF" | awk '{print $1}')"
else
    echo -e "  ${GREEN}✓${NC} Source already cached: $(du -h "$SOURCE_TIF" | awk '{print $1}')"
fi

# ── Inspect input ───────────────────────────────────────────────────
echo -e "  Source raster info:"
gdalinfo "$SOURCE_TIF" 2>/dev/null | grep -E '^(Size|Pixel Size|Origin)' | head -3 | sed 's/^/      /'

# Detect depth-value sign convention. GMRT uses NEGATIVE for below
# sea level (z = elevation, negative below MSL). ENC convention is
# POSITIVE for depth below MSL. We need to flip the sign.
DEPTH_SAMPLE=$(gdalinfo -mm "$SOURCE_TIF" 2>/dev/null \
    | grep "Computed Min/Max" | head -1 | grep -oE -- '-?[0-9]+\.?[0-9]*' | head -1)
echo -e "      Min elevation: ${DEPTH_SAMPLE} (negative = below MSL — flipping for DEPARE)"

# ── Flip elevation → depth (multiply by -1) ────────────────────────
# gdal_calc inverts the values so that "deeper" = larger positive,
# matching ENC's DRVAL1/DRVAL2 convention.
DEPTH_TIF="data/brisbane-depth.tif"
if [[ ! -f "$DEPTH_TIF" ]] || [[ "$SOURCE_TIF" -nt "$DEPTH_TIF" ]]; then
    echo -e "  Flipping sign (elevation → depth)..."
    gdal_calc.py --quiet \
        -A "$SOURCE_TIF" \
        --outfile="$DEPTH_TIF" \
        --calc="-A" \
        --NoDataValue=-9999 \
        --overwrite >/dev/null 2>&1 || {
        # gdal_calc.py may not be installed — fallback to gdal_translate
        # with a scale factor of -1 (works in older GDAL too).
        gdal_translate -q -scale 0 -1 0 1 "$SOURCE_TIF" "$DEPTH_TIF" 2>/dev/null || {
            echo -e "${YELLOW}  Sign-flip failed — using raw values. Contour DRVAL may be negative.${NC}"
            cp "$SOURCE_TIF" "$DEPTH_TIF"
        }
    }
fi

# ── Contour extraction ─────────────────────────────────────────────
# gdal_contour reads the depth raster and emits POLYGON contours
# (with -p flag) at the specified depth values. Each polygon gets
# DRVAL1 (min depth in band) and DRVAL2 (max depth in band) — exactly
# the S-57 attribute names the inshore router expects.
echo -e "  Extracting depth contour polygons..."
# Use mktemp -u so we get a unique filename WITHOUT creating the file —
# gdal_contour's GeoJSON driver refuses to overwrite existing files.
TEMP_GEOJSON="$(mktemp -u --suffix=.geojson 2>/dev/null \
    || echo "/tmp/brisbane-contour-$$.geojson")"
rm -f "$TEMP_GEOJSON"

gdal_contour -q \
    -p \
    -amin DRVAL1 \
    -amax DRVAL2 \
    -fl 0 -fl 2 -fl 5 -fl 10 -fl 20 -fl 30 -fl 50 -fl 100 -fl 200 \
    -f GeoJSON \
    "$DEPTH_TIF" \
    "$TEMP_GEOJSON"

# ── Tag features for the inshore router + filter land ──────────────
# Phase 13 uses `_layer` to identify the S-57 class. Add quality
# grade ("D" = derived from public surveys, per Phase 14 PIVOT spec)
# and source attribution.
#
# Filter out the "below lowest contour" polygon that gdal_contour
# emits for the area above MSL — that's land, not a depth area.
# Detected by DRVAL1 < 0 after our sign-flip (the artifact has
# DRVAL1 = -elevation of highest land peak in the bbox).
jq --arg source "GMRT (Global Multi-Resolution Topography, Lamont-Doherty)" \
   --arg license "Public domain (multi-source aggregate)" \
   '
   {
     type: "FeatureCollection",
     features: (.features
       | map(select(.properties.DRVAL1 >= 0))
       | map(.properties += {
           "_layer": "DEPARE",
           "_source": $source,
           "_license": $license,
           "_grade": "D",
           "_generated": (now | todate)
         })
     )
   }
   ' \
   "$TEMP_GEOJSON" > "$DEPARE_GEOJSON"

rm -f "$TEMP_GEOJSON"

# ── Stats ───────────────────────────────────────────────────────────
FEATURE_COUNT=$(jq '.features | length' "$DEPARE_GEOJSON")
DEPTH_BREAKDOWN=$(jq -r '
    [.features[].properties.DRVAL1] | map(select(. != null))
    | group_by(.) | map({band: .[0], count: length})
    | map("        \(.band)m: \(.count) polygons")
    | join("\n")
' "$DEPARE_GEOJSON" 2>/dev/null || echo "(parse failed)")

OUTPUT_SIZE=$(du -h "$DEPARE_GEOJSON" | awk '{print $1}')

echo -e "  ${GREEN}✓${NC} ${BOLD}${DEPARE_GEOJSON}${NC} (${OUTPUT_SIZE})"
echo -e "      ${FEATURE_COUNT} DEPARE polygons, breakdown:"
echo "${DEPTH_BREAKDOWN}"

# ── Done ────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✓ Spike complete!${NC}"
echo ""
echo -e "${CYAN}  Next sanity check — eyeball the polygons:${NC}"
echo ""
echo -e "  scp ${BOLD}skipper@calypso.local:$(realpath "$DEPARE_GEOJSON")${NC} ~/Downloads/"
echo -e "  open https://geojson.io and drag the file in."
echo -e "  You should see depth-banded polygons over Moreton Bay,"
echo -e "  the Brisbane River, and the outer shelf to the east."
echo ""
echo -e "${CYAN}  Then the real test:${NC} feed this GeoJSON to Phase 13's inshore"
echo -e "  router and route Brisbane → Port Wentworth (or any AU route)."
echo -e "  The endpoint pi-cache needs is being added next."
echo ""
