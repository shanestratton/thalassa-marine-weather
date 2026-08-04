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

## Second source: S-63 charts (`extractS63.ts`)

Areas o-charts doesn't sell — New Caledonia among them — are reachable as
official S-63 cells from a PRIMAR reseller (we buy from ChartWorld against an
o-charts UserPermit). Those arrive through a completely separate path:

```
S-63 exchange set (ENC_ROOT/…, cell permits in PERMIT.TXT)
    ↓ OpenCPN s63 plugin — "Import Cell Permits" then "Import Charts/Updates"
.es57 in ~/.opencpn/s63/s63SENC/   (plaintext SENC under a repeating XOR pad)
    ↓ s63Decrypt.ts — OCPNsenc -n regenerates the 1024-byte pad, then XOR
line-oriented SENC
    ↓ s63SencParser.ts
    ↓ geojsonEmitter.ts (shared with the .oesu path)
GeoJSON cells → same ENC_CHART_DIR as above
```

```bash
npx tsx src/extractS63.ts --out ./cells
# or straight into the live chart store, alongside the AU cells:
npx tsx src/extractS63.ts --pi-cache-store /opt/thalassa-pi-cache/enc-charts
```

Permits are read from where the plugin already put them — `Userpermit` and
`Installpermit` in `opencpn.conf`, per-cell permits from the `cellpermit:`
line of each `.os63` — so there is nothing to pass on the command line.
`--pi-cache-store` writes the same wrapped-cell + index.json format
`decryptBatch.ts` writes for `.oesu` charts (shared shapes in
`piCacheStore.ts`), so the cell shows up in `/api/enc/installed` and the
app's ENC sync immediately.

Two things differ from the o-charts path and are worth knowing:

- **No daemon.** S-63 has no `oexserverd` equivalent. The plugin's OCPNsenc
  helper re-derives a one-time pad per file from the three permits; the eSENC
  is that pad XORed over plaintext SENC. Pads are bound to the file's absolute
  path — move the `.es57` and it stops decrypting.
- **No dongle.** The o-charts SG-Lock does not cover S-63. The UserPermit binds
  to a machine fingerprint made by the plugin (Options → Charts → S63 Charts →
  Keys/Permits), so the fingerprinted machine must be the one that runs this.

### Where line geometry actually lives

The `LINESTRING` blob preceding each `LSINDEXLIST` looks like WKB and states a
vertex count, but **its coordinate array is uninitialised heap memory** — it
decodes to values like 4.8e34 while the trailing float32 bounding box in the
same blob decodes correctly. OCPNsenc never fills it and the plugin never reads
it (`AssembleLineGeometry` walks the tables instead). Do not be tempted by it.

Real line vertices come from the two shared tables at the end of the file:

```
VETableStart\n  repeat{ int32 edgeIndex, int32 count, count × (double x, double y) } until index -1
VCTableStart\n  repeat{ int32 nodeIndex, double x, double y }                       until index -1
```

Each `LSINDEXLIST` entry is four int32s — start node, edge, end node, direction
— and a feature's line is those segments concatenated. Note the tables store
**doubles**, unlike the binary format's float32 edge vertices, so lines come out
more precise than the float32 triangulated areas.

The direction flag is not trusted: the reference convention is `1 == forward`
(anything else reverse), but each edge is oriented geometrically — whichever
orientation puts its endpoints nearest the segment's connected nodes — which is
self-validating; the flag is only the last-resort tiebreaker when neither node
exists to measure against.

A feature's entries may be legitimately **discontinuous** (70 of FR466870's
1158 line features): S-57 lets one feature map disjoint edge runs, and OpenCPN
renders each segment independently. Concatenating across a break would draw a
chord the chart never asserted, so a break starts a new part and multi-part
features emit as `MultiLineString` (single-part stays `LineString`).

### How it's verified

Every line feature is checked against the bounding box the chart itself recorded
in that (otherwise junk) blob — an independent per-feature assertion, reported
by the CLI on every run:

```
FR466870: 3457 features, 2804 emitted
    3267 edges / 2418 nodes; lines verified against recorded extents: 1158 (70 multi-part), withheld: 0 mismatched + 0 damaged
```

Failures are **withheld from the output** — wrong geometry is worse than absent
geometry in a navigation pipeline — so non-zero withheld counts are the only
trace they existed; treat the cell as suspect until they're explained. The same
policy applies to a decrypt whose plaintext doesn't open with `SENC Version=`
(a well-formed but WRONG cell permit produces a full-length pad and high-entropy
noise; `s63Decrypt` refuses it rather than parse garbage). Two further checks
were run by hand on FR466870 and are worth repeating when the format shifts:

- **Georeferencing** — the light at the entrance to Boulari Pass decodes as
  Fl(2) 10s, 53 m, 20 NM: Phare Amédée's published characteristic.
- **Internal consistency** — sampled DEPCNT contours sit ~4 m from the boundary
  of DEPARE polygons carrying the same depth, i.e. within the float32
  quantisation of the area triangles.

## Status

- [x] SENC binary format reverse-engineered (record types 1-9, 64-65, 80-86, 96-101, 200)
- [x] `scan` utility — walks records, identifies all feature classes via S-57 catalog
- [ ] `extract` CLI — decode FEATURE_ID + ATTRIBUTE + GEOMETRY records into per-feature GeoJSON
- [ ] AREA geometry reconstruction via VECTOR_EDGE_NODE_TABLE / VECTOR_CONNECTED_NODE_TABLE
- [ ] CLI for batch decrypt via `oexserverd` (port of hornang/oesenc-export protocol)
- [ ] Pi-side daemon: watch `~/.opencpn/SENC/` and auto-extract on cache write
- [x] S-63 path: pad-based decrypt + line-oriented SENC parser (`extractS63.ts`)
- [x] S-63 line geometry via `LSINDEXLIST` → `VETable`/`VCTable` walk
- [ ] S-63 area outlines: PolyTessGeo areas emit as triangle MultiPolygons.
      The edges to assemble true rings are in the same `LSINDEXLIST` the line
      path now walks, so `resolveAreaRings`-style output is within reach.

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
