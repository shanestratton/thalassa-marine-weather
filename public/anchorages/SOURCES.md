# QLD anchorage data — sources & provenance

Built 2026-08-25 by `scripts/anchorages/build-qld.mjs` (re-run to refresh).
Layout: 2°x2° tiles under `qld/`, directory in `qld/index.json`.

## Data sources

- **Anchorage positions & names, coastline, reefs** — © OpenStreetMap contributors, licensed **ODbL**. Named bays/coves/inlets, charted seamark anchorages and marinas along the QLD coast. Attribution required.
- **No-anchoring areas, designated anchorages, marine-park zoning** — © Great Barrier Reef Marine Park Authority (GBRMPA), `gbrmpa_open_data` ArcGIS org, licensed **CC BY**. Attribution required.
- **Forecasts consumed at verdict time** (not stored here) — Open-Meteo via the app's proxy; the verdict UI attributes them.

## Fetch tables

Every point carries `fetchLandNM` and `fetchReefNM`: 36 sectors x 10° true, distance (NM, capped 15) to the first OSM coastline / coastline-or-reef crossing, ray-cast at build time. They encode SHELTER GEOMETRY only — no depth, no holding, no weather.

## ⚓ Safety note (surface this in-app)

This is a **planning reference built from open data**, NOT a navigational chart and NOT a substitute for official charts, GBRMPA zoning maps, or the skipper's judgement. OSM positions are approximate and carry **no depth or holding data**; fetch tables inherit every gap in OSM coastline/reef mapping. Verdicts are advisory reads of this geometry plus a forecast — verify against official sources and your own eyes before anchoring.
