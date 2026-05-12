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
    -fl 0 -fl 0.5 -fl 1 -fl 1.5 -fl 2 -fl 2.5 -fl 3 -fl 4 -fl 5 -fl 8 -fl 12 -fl 20 -fl 30 -fl 50 -fl 100 \
    -f GeoJSON \
    "$DEPTH_TIF" \
    "$TEMP_GEOJSON"

# ── Simplify polygons for routing performance ──────────────────────
# The raw contour output has tens of thousands of vertices per
# MultiPolygon — each pixel boundary becomes a vertex. At ~60m
# source raster resolution, vertex density finer than 60m is just
# Douglas-Peucker noise — wasted work for the inshore router's
# point-in-polygon tests.
#
# First attempt used 0.0001° (~10m) which is *finer* than the source
# pixel, so simplify had nothing to remove (6.6MB output). 0.001°
# (~110m at AU latitudes, ~2× source resolution) is the right band:
# strips raster-jitter without losing real coastline features.
# Combined with -makevalid to repair any topology the simplifier
# introduces. Expected: ~70-90% vertex reduction.
echo -e "  Simplifying polygons (110m tolerance, ~2× source raster)..."
SIMPLIFIED_GEOJSON="$(mktemp -u --suffix=.geojson 2>/dev/null \
    || echo "/tmp/brisbane-simplified-$$.geojson")"
rm -f "$SIMPLIFIED_GEOJSON"

ogr2ogr -q \
    -f GeoJSON \
    -simplify 0.001 \
    -makevalid \
    "$SIMPLIFIED_GEOJSON" \
    "$TEMP_GEOJSON" 2>/dev/null

# Swap simplified output back into TEMP_GEOJSON so the jq pipeline
# below works on the simplified version.
mv "$SIMPLIFIED_GEOJSON" "$TEMP_GEOJSON"

# ── Tag features for the inshore router + classify land vs water ───
# Phase 13 uses `_layer` to identify the S-57 class. We need BOTH
# DEPARE (depth areas, water) and LNDARE (land) — without LNDARE the
# A* router treats land cells as "unknown open" with a 5× cost
# penalty, and A* still routes through suburbs if the straight-line
# saving beats the 5× tax. Routes end up crossing entire cities.
#
# gdal_contour with `-p` emits a "below-lowest-contour" polygon for
# the area above MSL — after our sign-flip that polygon has
# DRVAL1 < 0 (it's "depth less than zero" = land). Earlier we filtered
# it out; now we keep it and re-tag as LNDARE so the router blocks it.
#
# All other polygons (DRVAL1 ≥ 0) are real depth bands — DEPARE.
jq --arg source "GMRT (Global Multi-Resolution Topography, Lamont-Doherty)" \
   --arg license "Public domain (multi-source aggregate)" \
   '
   {
     type: "FeatureCollection",
     features: (.features
       | map(. + {
           properties: (.properties + {
             "_layer": (if .properties.DRVAL1 >= 0 then "DEPARE" else "LNDARE" end),
             "_source": $source,
             "_license": $license,
             "_grade": "D",
             "_generated": (now | todate)
           })
         })
     )
   }
   ' \
   "$TEMP_GEOJSON" > "$DEPARE_GEOJSON"

rm -f "$TEMP_GEOJSON"

# ── Seamarks from OpenSeaMap (fairways, buoys, beacons) ─────────────
# GMRT bathymetry tells us depth but nothing about marked channels.
# For real channel-following routing we need:
#   FAIRWY — fairway polygons (the marked channel area)
#   DRGARE — dredged area polygons (engineered deep water)
#   BOYLAT — lateral buoys (channel edge markers)
#   BCNLAT — lateral beacons (channel edge fixed markers)
#   RECTRC — recommended tracks (line features)
#
# OpenSeaMap publishes all of these as OSM features under
# seamark:type=* tags. We pull them via the Overpass API
# (https://overpass-api.de) — public, free, no auth, has good
# Brisbane coverage. Cached on disk after first run so subsequent
# spike runs don't hammer the Overpass servers.
SEAMARKS_CACHE="data/brisbane-seamarks.json"
SEAMARKS_GEOJSON="data/brisbane-seamarks.geojson"

if [[ ! -f "$SEAMARKS_CACHE" ]]; then
    echo -e "  Fetching seamarks from OpenSeaMap (Overpass)..."
    # bbox: south,west,north,east
    # Note: we deliberately DON'T query node[buoy_lateral] / node[beacon_lateral]
    # here. The engine treats individual lateral markers by stamping an 80 m
    # preferred radius around each — which is fine when those markers have
    # been pre-paired (port + starboard → midpoint, see services/InshoreRouter.ts
    # fetchRegionalMarkers). Raw unpaired markers cause the preferred zones
    # to land on the SHALLOW shore side of each marker (the wrong side of the
    # channel), and the route then weaves toward shore. The iOS-side regional
    # nav_markers.geojson fetch handles pairing — leave individual markers
    # to that path, and only pull channel POLYGONS / LINES here.
    OVERPASS_QUERY="[out:json][timeout:60];
(
  nwr[\"seamark:type\"=\"fairway\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  nwr[\"seamark:type\"=\"dredged_area\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  nwr[\"seamark:type\"=\"recommended_track\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
);
out geom;"
    if curl -fsSL --max-time 120 \
        --data-urlencode "data=${OVERPASS_QUERY}" \
        https://overpass-api.de/api/interpreter \
        -o "$SEAMARKS_CACHE"; then
        SIZE=$(stat -c%s "$SEAMARKS_CACHE" 2>/dev/null || stat -f%z "$SEAMARKS_CACHE")
        if [[ "$SIZE" -lt 100 ]]; then
            echo -e "${YELLOW}  ⚠ Overpass returned ${SIZE} bytes — probably an error response.${NC}"
            rm -f "$SEAMARKS_CACHE"
        else
            echo -e "  ${GREEN}✓${NC} Cached $(du -h "$SEAMARKS_CACHE" | awk '{print $1}')"
        fi
    else
        echo -e "${YELLOW}  ⚠ Overpass query failed — continuing without seamarks${NC}"
    fi
else
    echo -e "  ${GREEN}✓${NC} Seamarks already cached: $(du -h "$SEAMARKS_CACHE" | awk '{print $1}')"
fi

# Convert Overpass JSON → GeoJSON FeatureCollection with our _layer tags.
# Nodes become Point features (BOYLAT / BCNLAT). Ways with the same
# start+end node become Polygon (FAIRWY / DRGARE); open ways become
# LineString (RECTRC).
if [[ -f "$SEAMARKS_CACHE" ]]; then
    jq '
      def to_geom:
        if .type == "node" then
          {type: "Point", coordinates: [.lon, .lat]}
        elif .type == "way" and (.geometry | length >= 2) then
          if .geometry[0].lat == .geometry[-1].lat and .geometry[0].lon == .geometry[-1].lon then
            {type: "Polygon", coordinates: [[.geometry[] | [.lon, .lat]]]}
          else
            {type: "LineString", coordinates: [.geometry[] | [.lon, .lat]]}
          end
        else null end;
      def to_layer:
        if .tags."seamark:type" == "fairway" then "FAIRWY"
        elif .tags."seamark:type" == "dredged_area" then "DRGARE"
        elif .tags."seamark:type" == "recommended_track" then "RECTRC"
        elif .tags."seamark:type" == "buoy_lateral" then "BOYLAT"
        elif .tags."seamark:type" == "beacon_lateral" then "BCNLAT"
        else null end;
      {
        type: "FeatureCollection",
        features: (
          .elements
          | map({
              type: "Feature",
              properties: (.tags + {
                "_layer": to_layer,
                "_source": "OpenSeaMap (OSM)",
                "_license": "ODbL",
                "_grade": "D",
                "osm_id": .id,
                "osm_type": .type
              }),
              geometry: to_geom
            })
          | map(select(.geometry != null and .properties._layer != null))
        )
      }
    ' "$SEAMARKS_CACHE" > "$SEAMARKS_GEOJSON"

    SEAMARK_COUNT=$(jq '.features | length' "$SEAMARKS_GEOJSON")
    if [[ "$SEAMARK_COUNT" -gt 0 ]]; then
        echo -e "  ${GREEN}✓${NC} Parsed ${SEAMARK_COUNT} seamarks"

        # Merge seamarks into the main DEPARE GeoJSON. The result is
        # still a single FeatureCollection that install-public can
        # group by _layer.
        MERGED=$(mktemp -u --suffix=.geojson 2>/dev/null || echo "/tmp/brisbane-merged-$$.geojson")
        jq -s '
          {
            type: "FeatureCollection",
            features: ((.[0].features) + (.[1].features))
          }
        ' "$DEPARE_GEOJSON" "$SEAMARKS_GEOJSON" > "$MERGED"
        mv "$MERGED" "$DEPARE_GEOJSON"
    else
        echo -e "${YELLOW}  ⚠ No seamarks parsed — Overpass returned no matching features${NC}"
    fi
fi

# ── OSM water polygons (marinas / canals / docks / rivers) ──────────
# GMRT bathymetry can't see engineered water features that sit below
# MSL but are inside the natural shoreline polygon — marina basins,
# dredged canals, commercial docks, etc. Newport marina is the
# obvious case: GMRT marks the whole peninsula as land at 60 m pixel
# resolution, so our LNDARE polygon swallows the marina basin and
# the router treats it as blocked. Routes refuse to start there.
#
# OSM has all of these as `landuse=basin`, `leisure=marina`,
# `waterway=canal/dock`, `natural=water`. We fetch them via Overpass,
# tag as DEPARE with sensible default depths, and merge. The engine's
# "DEPARE wins over LNDARE in overlap" rule (services/inshore-
# RouterEngine.ts Pass 2) then keeps these cells navigable even
# though our chunky LNDARE covers the same area.
#
# Default depths chosen for general AU east-coast cruising vessels
# (2-3 m draft typical). Override per-feature by editing the jq.
WATER_CACHE="data/brisbane-water-polygons.json"
WATER_GEOJSON="data/brisbane-water-polygons.geojson"

if [[ ! -f "$WATER_CACHE" ]]; then
    echo -e "  Fetching OSM water polygons (Overpass)..."
    WATER_QUERY="[out:json][timeout:90];
(
  way[\"natural\"=\"water\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  way[\"landuse\"=\"basin\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  way[\"leisure\"=\"marina\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  way[\"waterway\"=\"canal\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  way[\"waterway\"=\"dock\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  way[\"waterway\"=\"riverbank\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  relation[\"natural\"=\"water\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
);
out geom;"
    if curl -fsSL --max-time 180 \
        --data-urlencode "data=${WATER_QUERY}" \
        https://overpass-api.de/api/interpreter \
        -o "$WATER_CACHE"; then
        SIZE=$(stat -c%s "$WATER_CACHE" 2>/dev/null || stat -f%z "$WATER_CACHE")
        if [[ "$SIZE" -lt 100 ]]; then
            echo -e "${YELLOW}  ⚠ OSM water query returned ${SIZE} bytes — error response.${NC}"
            rm -f "$WATER_CACHE"
        else
            echo -e "  ${GREEN}✓${NC} Cached $(du -h "$WATER_CACHE" | awk '{print $1}')"
        fi
    else
        echo -e "${YELLOW}  ⚠ OSM water Overpass query failed — continuing without marina overrides${NC}"
    fi
else
    echo -e "  ${GREEN}✓${NC} OSM water polygons cached: $(du -h "$WATER_CACHE" | awk '{print $1}')"
fi

# Convert OSM water JSON → GeoJSON DEPARE features. Each polygon
# gets a default DRVAL1 depth based on its OSM tags. The DRVAL2
# upper bound is just DRVAL1+10 (we don't have real data) — the
# engine only reads DRVAL1.
if [[ -f "$WATER_CACHE" ]]; then
    jq '
      def default_depth:
        if .tags.leisure == "marina" then 3.0
        elif .tags.landuse == "basin" then 3.0
        elif .tags.waterway == "dock" then 5.0
        elif .tags.waterway == "canal" then 2.0
        elif .tags.waterway == "riverbank" then 4.0
        elif .tags.natural == "water" then 3.0
        else 2.0 end;
      def to_polygon:
        if .type == "way" and (.geometry | length >= 4)
           and .geometry[0].lat == .geometry[-1].lat
           and .geometry[0].lon == .geometry[-1].lon then
          {type: "Polygon", coordinates: [[.geometry[] | [.lon, .lat]]]}
        else null end;
      {
        type: "FeatureCollection",
        features: (
          .elements
          | map(
              . as $e |
              ($e | to_polygon) as $g |
              if $g == null then null
              else {
                type: "Feature",
                properties: ($e.tags + {
                  "_layer": "DEPARE",
                  "_source": "OpenStreetMap",
                  "_license": "ODbL",
                  "_grade": "D",
                  "_osm_id": $e.id,
                  "_osm_type": $e.type,
                  "DRVAL1": ($e | default_depth),
                  "DRVAL2": (($e | default_depth) + 10)
                }),
                geometry: $g
              }
              end
            )
          | map(select(. != null))
        )
      }
    ' "$WATER_CACHE" > "$WATER_GEOJSON"

    WATER_COUNT=$(jq '.features | length' "$WATER_GEOJSON")
    if [[ "$WATER_COUNT" -gt 0 ]]; then
        echo -e "  ${GREEN}✓${NC} Parsed ${WATER_COUNT} OSM water polygons as DEPARE overrides"
        MERGED=$(mktemp -u --suffix=.geojson 2>/dev/null || echo "/tmp/brisbane-merged2-$$.geojson")
        jq -s '
          {
            type: "FeatureCollection",
            features: ((.[0].features) + (.[1].features))
          }
        ' "$DEPARE_GEOJSON" "$WATER_GEOJSON" > "$MERGED"
        mv "$MERGED" "$DEPARE_GEOJSON"
    else
        echo -e "${YELLOW}  ⚠ No OSM water polygons parsed${NC}"
    fi
fi

# ── OSM ferry routes → synthetic FAIRWY polygons ────────────────────
# Ferries follow real, surveyed, well-marked deep channels by
# definition — they have to, repeatedly, every day. Aggregating
# ferry route geometries gives us channel polylines basically for
# free, with zero algorithm work, anywhere in the world that has
# OSM ferry coverage (most of the developed coastal world).
#
# We buffer each ferry route LineString by 30 m on each side and
# emit as a FAIRWY polygon. The engine's existing Pass 4 marks
# cells inside as preferred. A* then prefers to track along the
# ferry route, which is exactly what we want for shipping channels.
#
# Note: ferry routes won't cover every channel (no ferries through
# every harbour), but for major shipping lanes they're authoritative.
FERRY_CACHE="data/brisbane-ferry-routes.json"
FERRY_GEOJSON="data/brisbane-ferry-routes.geojson"

if [[ ! -f "$FERRY_CACHE" ]]; then
    echo -e "  Fetching OSM ferry routes (Overpass)..."
    FERRY_QUERY="[out:json][timeout:60];
(
  way[\"route\"=\"ferry\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
  relation[\"route\"=\"ferry\"](${BBOX_LAT_MIN},${BBOX_LON_MIN},${BBOX_LAT_MAX},${BBOX_LON_MAX});
);
out geom;"
    if curl -fsSL --max-time 120 \
        --data-urlencode "data=${FERRY_QUERY}" \
        https://overpass-api.de/api/interpreter \
        -o "$FERRY_CACHE"; then
        SIZE=$(stat -c%s "$FERRY_CACHE" 2>/dev/null || stat -f%z "$FERRY_CACHE")
        if [[ "$SIZE" -lt 100 ]]; then
            echo -e "${YELLOW}  ⚠ Ferry query returned ${SIZE} bytes — error response.${NC}"
            rm -f "$FERRY_CACHE"
        else
            echo -e "  ${GREEN}✓${NC} Cached $(du -h "$FERRY_CACHE" | awk '{print $1}')"
        fi
    else
        echo -e "${YELLOW}  ⚠ Ferry Overpass query failed — continuing without ferry routes${NC}"
    fi
else
    echo -e "  ${GREEN}✓${NC} Ferry routes cached: $(du -h "$FERRY_CACHE" | awk '{print $1}')"
fi

# Convert each ferry-route way into a buffered Polygon along the
# route line. We buffer ±30 m perpendicular to each segment of the
# line — gives a ~60 m wide channel ribbon that closely matches
# the actual swept path of typical ferry boats.
if [[ -f "$FERRY_CACHE" ]]; then
    # The buffering is non-trivial in jq alone (perpendicular vectors
    # in lat/lon need cos(lat) scaling). We use ogr2ogr's BUFFER op
    # via a small in-memory pipeline: write the raw line GeoJSON,
    # use ogr2ogr -sql "SELECT ST_Buffer(geom, ...)" to buffer.
    LINES_TMP=$(mktemp -u --suffix=.geojson 2>/dev/null || echo "/tmp/brisbane-ferry-lines-$$.geojson")

    jq '
      def to_line:
        if .type == "way" and (.geometry | length >= 2) then
          {type: "LineString", coordinates: [.geometry[] | [.lon, .lat]]}
        else null end;
      {
        type: "FeatureCollection",
        features: (
          .elements
          | map(
              . as $e |
              ($e | to_line) as $g |
              if $g == null then null
              else {
                type: "Feature",
                properties: ($e.tags + {
                  "_source": "OpenStreetMap ferry route",
                  "_osm_id": $e.id,
                  "_osm_type": $e.type
                }),
                geometry: $g
              }
              end
            )
          | map(select(. != null))
        )
      }
    ' "$FERRY_CACHE" > "$LINES_TMP"

    LINE_COUNT=$(jq '.features | length' "$LINES_TMP")
    if [[ "$LINE_COUNT" -gt 0 ]]; then
        # Buffer 30 m. Approximate 30 m as 0.00027° (~30/111000 m/deg);
        # close enough at AU latitudes for routing-grade ribbons.
        FERRY_BUFFER_DEG=0.00027
        ogr2ogr -q \
            -f GeoJSON \
            -dialect SQLite \
            -sql "SELECT ST_Buffer(geometry, ${FERRY_BUFFER_DEG}) AS geometry FROM 'ferry'" \
            -nln ferry \
            "$FERRY_GEOJSON" \
            "$LINES_TMP" 2>/dev/null && {
            # Re-tag with our _layer/_source schema (ogr2ogr drops properties on ST_Buffer).
            jq --arg source "OpenStreetMap ferry route" \
               --arg license "ODbL" \
               '
               {
                 type: "FeatureCollection",
                 features: (.features
                   | map(.properties += {
                       "_layer": "FAIRWY",
                       "_class": "ferry-route-buffered",
                       "_source": $source,
                       "_license": $license,
                       "_grade": "D"
                     })
                 )
               }' "$FERRY_GEOJSON" > "${FERRY_GEOJSON}.tagged"
            mv "${FERRY_GEOJSON}.tagged" "$FERRY_GEOJSON"

            FERRY_COUNT=$(jq '.features | length' "$FERRY_GEOJSON")
            echo -e "  ${GREEN}✓${NC} Parsed ${FERRY_COUNT} ferry routes → buffered FAIRWY polygons"
            MERGED=$(mktemp -u --suffix=.geojson 2>/dev/null || echo "/tmp/brisbane-merged3-$$.geojson")
            jq -s '
              {
                type: "FeatureCollection",
                features: ((.[0].features) + (.[1].features))
              }
            ' "$DEPARE_GEOJSON" "$FERRY_GEOJSON" > "$MERGED"
            mv "$MERGED" "$DEPARE_GEOJSON"
        } || {
            echo -e "${YELLOW}  ⚠ ogr2ogr ST_Buffer failed — skipping ferry routes${NC}"
        }
    else
        echo -e "${YELLOW}  ⚠ No ferry routes parsed${NC}"
    fi
    rm -f "$LINES_TMP"
fi

# ── Stats ───────────────────────────────────────────────────────────
FEATURE_COUNT=$(jq '.features | length' "$DEPARE_GEOJSON")
LAYER_BREAKDOWN=$(jq -r '
    [.features[].properties._layer] | group_by(.)
    | map("        \(.[0]): \(length) polygons")
    | join("\n")
' "$DEPARE_GEOJSON" 2>/dev/null || echo "(parse failed)")
DEPTH_BREAKDOWN=$(jq -r '
    [.features[] | select(.properties._layer == "DEPARE") | .properties.DRVAL1]
    | map(select(. != null))
    | group_by(.) | map({band: .[0], count: length})
    | map("        \(.band)m: \(.count) DEPARE polygons")
    | join("\n")
' "$DEPARE_GEOJSON" 2>/dev/null || echo "(parse failed)")

OUTPUT_SIZE=$(du -h "$DEPARE_GEOJSON" | awk '{print $1}')

echo -e "  ${GREEN}✓${NC} ${BOLD}${DEPARE_GEOJSON}${NC} (${OUTPUT_SIZE})"
echo -e "      ${FEATURE_COUNT} total polygons:"
echo "${LAYER_BREAKDOWN}"
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
