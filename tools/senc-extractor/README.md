# senc-extractor

Extract S-57 vector features from OpenCPN SENC binary files (decrypted o-charts oeSENC charts) into GeoJSON the Thalassa inshore router can eat.

## Why this exists

- The Thalassa inshore router (`services/inshoreRouterEngine.ts`) consumes S-57 layers as GeoJSON: LNDARE, DEPARE, OBSTRN, WRECKS, UWTROC, DRGARE, FAIRWY, BOYLAT, BCNLAT.
- o-charts sells encrypted oeSENC chart subscriptions (US/AU/NZ/EU coverage) — these are bound to a SG-Lock USB dongle and only decryptable by `oexserverd` + the o-charts plugin.
- OpenCPN decrypts oeSENC into its proprietary **SENC** binary cache (`~/.opencpn/SENC/*.S57`). The `.S57` extension is a misnomer — GDAL's S-57 driver cannot parse these files.
- This tool walks the SENC binary format and emits GeoJSON FeatureCollections per layer.

## Pipeline

```
.oesu (encrypted, dongle-locked)
    ↓ oexserverd (chart-load via o-charts plugin OR hornang/oesenc-export)
SENC binary (~/.opencpn/SENC/*.S57)
    ↓ this tool
GeoJSON cells (cells/<cellId>.json — keyed by chart cell name)
    ↓ ENC_CHART_DIR on the Bosun Pi
inshoreRouterEngine.routeInshore({ from, to, draftM })
```

## Status

- [x] SENC binary format reverse-engineered (record types 1-9, 64-65, 80-86, 96-101, 200)
- [x] `scan` utility — walks records, identifies all feature classes via S-57 catalog
- [ ] `extract` CLI — decode FEATURE_ID + ATTRIBUTE + GEOMETRY records into per-feature GeoJSON
- [ ] AREA geometry reconstruction via VECTOR_EDGE_NODE_TABLE / VECTOR_CONNECTED_NODE_TABLE
- [ ] CLI for batch decrypt via `oexserverd` (port of hornang/oesenc-export protocol)
- [ ] Pi-side daemon: watch `~/.opencpn/SENC/` and auto-extract on cache write

## Setting up reference materials

The reference C++ (wellenvogel/ochartsng) and Python (hornang/oesenc-export) sources are not redistributed in this repo. Pull on demand:

```bash
# wellenvogel/ochartsng — has the canonical record struct definitions in Osenc.h
mkdir -p reference
gh api repos/wellenvogel/ochartsng/contents/provider/include/Osenc.h \
  | jq -r .content | base64 -d > reference/Osenc.h
gh api repos/wellenvogel/ochartsng/contents/provider/src/OESUChart.cpp \
  | jq -r .content | base64 -d > reference/OESUChart.cpp

# S-57 object class catalog (GDAL, public CSV)
curl -o reference/s57objectclasses.csv \
  https://raw.githubusercontent.com/OSGeo/gdal/master/ogr/ogrsf_frmts/s57/data/s57objectclasses.csv
```

## Usage

```bash
npm install
npx tsx src/scan.ts <senc-file>   # walk all records, dump class histogram
```

Example output against a NOAA Savannah River SENC:

```
S-57 feature classes in this chart:
  *   30 COALNE   count=   856   Coastline
  *   43 DEPCNT   count=   731   Depth contour
  *   42 DEPARE   count=   584   Depth area
  *   71 LNDARE   count=    85   Land area
  *   46 DRGARE   count=    54   Dredged area
  *   86 OBSTRN   count=    30   Obstruction
  *  159 WRECKS   count=    21   Wreck
  *    7 BCNLAT   count=    18   Beacon, lateral
  *   51 FAIRWY   count=    10   Fairway
  *   17 BOYLAT   count=     2   Buoy, lateral

(* = layers consumed by Thalassa inshore router)
```

## Format reference

SENC records are `uint16 type + uint32 length + payload`. `length` includes the 6-byte header.

| Type  | Name              | Payload                                          |
| ----- | ----------------- | ------------------------------------------------ |
| 1-9   | Header records    | version, cell name, dates, scale, datum          |
| 64    | FEATURE_ID        | `u16 class_code, u16 RCID, u8 primitive`         |
| 65    | FEATURE_ATTRIBUTE | `u16 type, u8 value_type, value`                 |
| 80    | POINT geometry    | `double lat, double lon`                         |
| 81    | LINE geometry     | extent + edge-vector indices                     |
| 82    | AREA geometry     | extent + contours + triangulation + edge-vectors |
| 83    | MULTIPOINT        | extent + point_count + (lat,lon)\*               |
| 84    | AREA_EXT          | extended area (post-v2.00)                       |
| 96/97 | Vector tables     | shared edge/node coordinates                     |
| 98/99 | Cell coverage     | `u32 contour_count, lat/lon pairs`               |
| 100   | Cell extent       | 4× double (s,n,w,e)                              |
| 200   | Server status     | sub-record-length sentinel                       |

S-57 feature class codes are an IHO standard (`s57objectclasses.csv` in GDAL).

## License notes

- `reference/` contents are pulled from GPL-licensed upstreams (wellenvogel/ochartsng, hornang/oesenc-export, OpenCPN). They live outside the repo's license boundary on purpose. This extractor is original work written against the openly documented format.
- `samples/` should never be committed — those are decrypted chart data under the o-charts EULA, redistribution-prohibited.
