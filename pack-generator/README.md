# Thalassa Pack Generator

> Builds **routing-grade vector chart packs from public data** — the
> Phase 14 PIVOT (`docs/PHASE_14_PIVOT.md`). Output is ENC-shaped
> GeoJSON FeatureCollections that drop directly into Phase 13's
> inshore A\* router unchanged. No M_KEY, no IHO licensing, no
> dongles required.

## What this is

The Phase 13 inshore router consumes `DEPARE` / `DRGARE` / `LNDARE` /
`OBSTRN` / `WRECKS` / `UWTROC` / `SEAARE` / `ADMARE` features from
GeoJSON. NOAA cells provide them survey-grade. AusENC and other
encrypted ENCs CAN provide them but cost money and require dongles.

This generator produces **the same shape of features from public-domain
data**:

- `DEPARE` polygons ← from public bathymetry (AusBathyTopo, EMODnet,
  NOAA bathymetry, GEBCO) via `gdal_contour` at 0/2/5/10/20/30/50m
  bands.
- `LNDARE` polygons ← from OpenStreetMap coastline data (very high
  quality in most regions).
- `WRECKS` points ← from national shipwreck databases (ANSDB for AU,
  NOAA AWOIS for US, UKHO public NTM for UK, etc.).
- `OBSTRN` points ← from notice-to-mariners feeds where licensing
  permits.
- `SEAARE` polygons ← named water bodies from OSM (`natural=bay`,
  `natural=strait`, `place=sea` etc.).
- `ADMARE` polygons ← from national admin-boundary datasets.

Quality-graded via CATZOC-equivalent labels:

- **D** — derived from public surveys, typical of public datasets
- **U** — crowdsourced or unverified (pure OSM areas)

Comparable to commercial ENCs in coverage decisions but explicitly
not survey-of-record. Honest about its origin.

## Status

In active scaffolding. Spike-first approach:

- [ ] Phase 14a-spike: Brisbane bathymetry → DEPARE GeoJSON
      (proves the data pipeline works end-to-end on one bbox)
- [ ] Phase 14a: full AU pack generator (all coastal AU, all layers)
- [ ] Phase 14b: regional pack distribution (CDN, install endpoint)
- [ ] Phase 14c: quality-grading UI in Thalassa
- [ ] Phase 14d: Pacific + EU + UK packs

## Spike — Brisbane bathymetry

The first concrete deliverable. Run on the Pi (which already has
GDAL installed via `pi-cache/install.sh`):

```bash
cd pack-generator
./spikes/brisbane-bathymetry.sh
```

What it does:

1. Downloads a small AusBathyTopo GeoTIFF tile covering Brisbane
   harbour (Geoscience Australia, CC-BY 4.0).
2. Runs `gdal_contour -fl 0 -fl 2 -fl 5 -fl 10 -fl 20 -fl 50` to
   extract depth contours as GeoJSON polygons.
3. Tags each polygon with `DRVAL1` / `DRVAL2` properties matching
   S-57 conventions, and `_layer: "DEPARE"` for the inshore router.
4. Writes `out/brisbane-depare.geojson`.

You can then point Phase 13's inshore router at this file via:

```bash
curl -X POST http://localhost:3001/api/enc/install-public \
  -H "Content-Type: application/json" \
  -d '{"region":"au-brisbane-test","geojsonPath":"/path/to/out/brisbane-depare.geojson"}'
```

(Endpoint to be added in pi-cache as part of Phase 14b.)

## Architecture

```
┌──────────────────────────────────────────────┐
│  pack-generator (Node CLI, runs on dev box)  │
│                                              │
│  src/sources/    ←  public data fetchers     │
│   ├── ausBathyTopo.ts                        │
│   ├── osmCoastline.ts                        │
│   ├── ansdb.ts                               │
│   └── ...                                    │
│                                              │
│  src/transforms/ ← data → ENC-shape GeoJSON  │
│   ├── bathymetryToDepare.ts                  │
│   ├── coastlineToLndare.ts                   │
│   └── wrecksToFeatures.ts                    │
│                                              │
│  src/packagers/  ← split + bundle            │
│   ├── cellSplitter.ts (regional → cells)     │
│   └── packBuilder.ts (cells → tar.zst)       │
└──────────────────────────────────────────────┘
                     │
                     ▼
       au-coastal-2026-MM.tar.zst
       (~300MB, hosted on GitHub Releases)
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  pi-cache (boat Pi)                          │
│                                              │
│  POST /api/regional-pack/install?region=au   │
│   ↓                                          │
│  Downloads pack, decompresses, writes cells  │
│  to enc-charts/cells/ (same as NOAA imports) │
│   ↓                                          │
│  Phase 13 inshore router consumes unchanged  │
└──────────────────────────────────────────────┘
```

## Why a spike first

Bathymetry-to-DEPARE is the riskiest data transformation in this
plan. Public bathymetry datasets are continuous rasters (every
pixel has a depth); ENCs expect discrete polygons at standard
contour intervals (0/2/5/10/20m).

`gdal_contour` is the standard tool for raster-to-vector contour
extraction. It SHOULD produce the polygons we need with the right
flags. But we won't know if the output is actually consumable by
Phase 13's inshore router until we run it through.

The Brisbane spike validates this end-to-end on one small area
(~5 NM × 5 NM) before we commit to building the full pipeline.

## License notes

Data sources:

| Source                              | License               | Notes                        |
| ----------------------------------- | --------------------- | ---------------------------- |
| AusBathyTopo (Geoscience Australia) | CC-BY 4.0             | Attribution required         |
| OpenStreetMap                       | ODbL                  | Share-alike on derivative DB |
| ANSDB (data.gov.au)                 | CC-BY 4.0             | Attribution required         |
| GEBCO                               | CC0                   | Public domain                |
| EMODnet                             | Free with attribution | EU bathymetry                |
| LINZ                                | Public domain         | NZ data                      |

Generated packs include attribution baked into a `LICENSES.txt`
shipped inside the `.tar.zst`. Pi-cache surfaces this in the chart
locker UI when the pack is installed.

Generator code itself: MIT.
