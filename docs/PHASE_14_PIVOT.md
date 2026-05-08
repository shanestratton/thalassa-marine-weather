# Phase 14 — The pivot

## Reframe

The original Phase 14 framing was: "users have AusENC subscriptions
they can't decrypt because we don't have an M_KEY." Conclusion:
spend $5k/yr on IHO licensing or close the path.

That framing assumed encrypted ENCs are the only source of
routing-grade vector data. **They're not.** They're the only source
of _SOLAS-certified survey-of-record_ vector data. That's a
different thing.

The Australian Hydrographic Office sells two things bundled together:

1. **Surveyed bathymetry + coastline + obstructions.** The actual
   seabed measurements.
2. **SOLAS certification + IHO encryption + liability assertion.**
   The legal wrapper that makes a chart admissible as the official
   chart of record under maritime regulation.

For commercial vessels under SOLAS, you pay for both. For
recreational cruisers, the second part is irrelevant — they're not
SOLAS-bound. They're paying for survey data wrapped in a license
they don't legally need.

The pivot: **route on the survey data directly, sourced from public
government datasets, formatted into the same ENC-shaped GeoJSON the
Phase 13 inshore router already consumes.** No M_KEY. No
encryption. No subscription per region per year.

## Why nobody else has done this

Three reasons, all addressable:

1. **Liability theater.** Commercial chart vendors lean hard on
   "ours is SOLAS-certified, theirs isn't" to justify pricing.
   True, but irrelevant for recreational use. Cruisers already
   choose to use OpenCPN with OSM-derived charts when the
   commercial option is unaffordable; we'd just be polishing
   that into a usable product.

2. **Engineering effort.** Combining 4-5 public data sources into
   a coherent vector layer is real data-engineering work.
   Commercial vendors avoid it because licensing one source is
   easier; FOSS projects avoid it because nobody owns the
   integration. Thalassa is small enough to do it AND
   product-focused enough to ship it.

3. **No clear monetization.** Free data is hard to charge for.
   But Thalassa's pricing isn't gated on the data layer — it's
   gated on the routing engine, the Pi-cache architecture, the
   weather routing, the Bosun integration. Public chart data is
   a moat-widener, not a moat-renter.

## The data inventory

### Australia (the test case)

| Layer             | Source                                             | License   | Resolution                         | Notes                                    |
| ----------------- | -------------------------------------------------- | --------- | ---------------------------------- | ---------------------------------------- |
| Bathymetry        | **AusBathyTopo (Geoscience Australia)**            | CC-BY 4.0 | 30 m coastal LiDAR, 250 m offshore | Same surveys AHO uses, just the raw grid |
| Bathymetry (deep) | GEBCO 2024                                         | CC0       | ~460 m                             | Already wired                            |
| Coastline         | **OSM (Australian admin boundaries)**              | ODbL      | sub-50 m typical                   | Volunteer-maintained, very good in AU    |
| Wrecks            | **Australian National Shipwreck Database (ANSDB)** | CC-BY 4.0 | ~10 m positions                    | 8000+ wrecks with lat/lon                |
| Obstructions      | AMSA Notice to Mariners (NTM) feed                 | Public    | varies                             | Live updates                             |
| Nav aids          | **OpenSeaMap**                                     | ODbL      | volunteer                          | Patchy coverage but improving            |
| Tide stations     | Bureau of Meteorology                              | Public    | per-station                        | For tide-aware draft (Phase 13.x)        |

The combined data quality for AU coastal waters: **better than GEBCO
by a factor of 15× on bathymetry, with full coastline + wreck +
obstruction coverage.** Compared to AusENC, it's not survey-of-record
but it's plenty for routing decisions — "is this water deep enough
for my draft, is there land here, is there a known wreck."

### Other regions

| Region          | Bathymetry                             | Coastline  | Obstructions            | Status                             |
| --------------- | -------------------------------------- | ---------- | ----------------------- | ---------------------------------- |
| US              | NOAA ENC (already free + survey-grade) | NOAA + OSM | NOAA AWOIS database     | **Already covered by Phase 13**    |
| NZ              | LINZ public ENCs                       | LINZ + OSM | LINZ wrecks             | **Already covered** (LINZ is free) |
| UK              | EMODnet bathymetry, UK Met Office data | OSM        | UKHO public NTM         | **Tractable**                      |
| EU              | EMODnet                                | OSM        | National sources        | **Tractable**                      |
| Pacific Islands | SPC bathymetry, GEBCO infill           | OSM        | SPC, NOAA Pacific Atlas | **Big win** — currently unserved   |
| Caribbean       | NOAA partial, GEBCO infill             | OSM        | National sources        | **Tractable**                      |
| Asia            | GEBCO + national datasets where public | OSM        | varies                  | **Patchier** but possible          |

The Pacific Islands case is the killer marketing story: **cruisers
crossing Tahiti → Tonga → Fiji → Vanuatu → New Cal currently have
no affordable vector chart option.** Commercial ENCs for the SW
Pacific are $200–400/yr per region. A free public-data layer for
the whole Pacific basin is a clear product win.

## The architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PI-CACHE                                                        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Regional pack store                                      │    │
│  │   /opt/thalassa-pi-cache/regional-packs/                │    │
│  │   ├── au-coastal-2026.tar.zst  (300MB compressed)       │    │
│  │   ├── pacific-2026.tar.zst     (1.2GB)                  │    │
│  │   └── eu-2026.tar.zst          (800MB)                  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ ENC chart store (per-cell GeoJSON, same format as       │    │
│  │ Phase 11/12 NOAA imports)                                │    │
│  │   /opt/thalassa-pi-cache/enc-charts/cells/              │    │
│  │   ├── US5GA22M.json     ← NOAA-imported, survey-grade   │    │
│  │   ├── AU-PUBLIC-001.json ← Public-data pack             │    │
│  │   └── ...                                                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 13 inshore router (UNCHANGED)                      │    │
│  │   Doesn't care which cells are survey-grade vs public    │    │
│  │   Just routes through whatever GeoJSON it has            │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
                  ┌───────────┴────────────┐
                  │ thalassa-charts CDN     │
                  │ (GitHub Releases?       │
                  │  Cloudflare R2?)        │
                  │                         │
                  │ Pre-built regional      │
                  │ packs, attributed       │
                  │ properly, refreshed     │
                  │ quarterly               │
                  └─────────────────────────┘
```

The killer detail: **the Phase 13 router doesn't know or care**
which cells came from NOAA vs which came from a public-data pack.
Same `DEPARE` / `LNDARE` / `OBSTRN` shape going in, same A\* coming
out. The chart store is a flat namespace.

This means **composition just works**:

- User in Savannah has imported NOAA US5GA22M → routing uses it.
- User in Brisbane has installed AU public pack → routing uses it.
- User does Brisbane → Savannah → routing uses both, smoothly
  transitioning between data sources at the regional boundary.
- User _later_ buys an AusENC license and gets the M_KEY problem
  solved (somehow) → cells go in the same store, override public
  data where they overlap, no other code changes.

## Quality grading

Borrow the IHO **CATZOC** convention for honesty:

| Grade  | Meaning                             | When to assign                                 |
| ------ | ----------------------------------- | ---------------------------------------------- |
| **A1** | Survey-grade, recent                | NOAA, LINZ, AusENC (post-decryption)           |
| **B**  | Survey-grade, older                 | Older official charts                          |
| **C**  | Derived from public surveys, recent | AusBathyTopo, EMODnet recent                   |
| **D**  | Derived from public surveys, older  | GEBCO, older public datasets                   |
| **U**  | Crowdsourced or unverified          | Pure OSM / OpenSeaMap, community contributions |

Each cell carries its own grade. The route results panel shows
worst-grade encountered: "This route passes through CATZOC C areas
— verify visually where contours are sparse." Cruisers already
understand CATZOC; honest signaling beats false confidence.

## Implementation phases

### Phase 14a — AU pack generator (the test case)

Build a small CLI tool, `thalassa-pack-builder`, that:

1. Downloads AusBathyTopo from GA's public S3 mirror.
2. Downloads OSM AU extract from Geofabrik (free, weekly refreshed).
3. Downloads ANSDB CSV from data.gov.au.
4. Pulls AMSA NTM RSS for current obstructions.
5. Converts everything to ENC-compatible GeoJSON FeatureCollections.
6. Splits into ENC-cell-sized chunks (so the Phase 13 router
   doesn't choke on continent-wide polygons).
7. Bundles + compresses (zstd) into `au-coastal-YYYYMM.tar.zst`.

Estimated effort: 1-2 weeks. Most of the work is the bathymetry
contour extraction (AusBathyTopo is a continuous raster; ENCs
expect quantized DEPARE polygons at 0/2/5/10/20/30/50m bands).

### Phase 14b — Regional pack distribution

- Pi-cache adds `POST /api/regional-pack/install` endpoint:
  takes a region code (`au`, `pacific`, `eu`), downloads the
  corresponding pack from our CDN, decompresses, persists each
  cell to the chart store.
- Device adds "Install regional pack" UI alongside the existing
  ENC import paths.
- Packs auto-update quarterly when re-released.

Estimated effort: 3-5 days.

### Phase 14c — Quality grading UI

- Each cell tagged with its CATZOC-equivalent grade at pack-build time.
- Route results panel surfaces the worst-grade segment encountered,
  with explanatory copy.
- Map layer can color-code by quality grade (toggleable).

Estimated effort: 2-3 days.

### Phase 14d — Pacific pack + EU pack

Apply the AU-pack pipeline to other regions. Each region needs
adaptation for different data source formats but the pipeline shape
stays identical.

Estimated effort: 1-2 weeks per region, parallelizable.

### Phase 14e (much later) — IHO M_KEY

If/when Thalassa goes commercial and budget allows, get the M_KEY
and add survey-grade ENC import on top. Existing public-data
packs continue to work as a fallback baseline; M_KEY-decrypted
cells override where they cover. Composition unchanged.

## Why this is "better than anything else on the market"

**Today's market for recreational vector charts:**

| Product                      | Coverage      | Cost           | Lock-in               |
| ---------------------------- | ------------- | -------------- | --------------------- |
| Navionics                    | Most of world | $200/yr/region | App-locked            |
| C-Map                        | Most of world | Similar        | App-locked            |
| AusENC via o-charts          | AU only       | $120/yr        | Dongle + OpenCPN only |
| AusENC via TimeZero etc.     | AU only       | Hundreds/yr    | OEM-locked            |
| Free options (OpenCPN + OSM) | Anywhere      | Free           | Crufty UX, no routing |
| **NOAA ENC**                 | **US only**   | **Free**       | **None**              |

**Thalassa with Phase 14 done:**

| Product                              | Coverage              | Cost                    | Lock-in  |
| ------------------------------------ | --------------------- | ----------------------- | -------- |
| Thalassa public-data layer           | Most populated waters | **Free**                | **None** |
| + NOAA ENC import                    | US (survey-grade)     | Free                    | None     |
| + LINZ ENC import                    | NZ (survey-grade)     | Free                    | None     |
| + commercial ENC import (Phase 14e+) | World (survey-grade)  | User's existing license | None     |

**This is the gap.** No commercial product offers free vector
routing for the Pacific Islands, for AU coastal cruising, for
parts of EU. We can ship that. The data exists; nobody's wrapped
it into a product yet.

## The marketing line

> **Thalassa: routing-grade marine charts, anywhere there's water.**
>
> Built on free public bathymetry, OpenStreetMap coastlines,
> community-contributed nav aids, and government wreck databases —
> integrated with our Pi-resident vector router. Optionally
> compose with your commercial ENC subscriptions where you have
> them. Quality-graded, transparent, no per-region subscriptions.

That's a story. That's a product. That's a moat.

## What I'd do first

Don't wait for the OpenCPN spike to resolve. The o-charts /
plugin-bridge investigation is a side path now — the public-data
pivot delivers the same user value (AU vector routing) without
being gated on uncertain plugin-API behavior or M_KEY licensing.

Concrete next steps when you're back:

1. Spike a small AusBathyTopo download + GeoTIFF→GeoJSON contour
   extraction for one bbox (say, Brisbane harbor). Verify the
   output looks ENC-shaped and the inshore router can consume it.
2. If yes (it will): scope Phase 14a properly (pack generator
   for all of AU coastal waters).
3. Skip the OpenCPN spike entirely or deprioritize it to "fun
   side project" — neither outcome (works/dead) changes the
   public-data plan.

The answer was sitting in the public-data inventory all along.

— Claude
