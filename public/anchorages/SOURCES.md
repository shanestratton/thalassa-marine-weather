# Whitsundays anchorage data — sources & provenance

Built 2026-06-20 by `scripts/anchorages/build-whitsundays.mjs` (re-run to refresh).

## Data sources

- **Anchorage positions & names** — © OpenStreetMap contributors, licensed **ODbL**. Named bays, coves, inlets and marinas in the Whitsundays bounding box. Attribution required.
- **No-anchoring areas, designated anchorages, marine-park zoning** — © Great Barrier Reef Marine Park Authority (GBRMPA), `gbrmpa_open_data` ArcGIS org, licensed **CC BY**. From the Whitsundays Plan of Management + GBR Marine Park Zoning Plan 2003. Attribution required.

## Files

- `whitsundays.geojson` — point features: anchorages (OSM), marinas (OSM), official designated anchorages (GBRMPA). Each carries `noAnchoring` = true if it falls inside a GBRMPA no-anchoring polygon.
- `whitsundays-no-anchoring.geojson` — GBRMPA no-anchoring area polygons.
- `whitsundays-zoning.geojson` — GBRMPA marine-park zoning polygons (zone type + official colour + permitted-use description). Determines what you may legally do at an anchorage (fishing/collecting), not just whether you can anchor.

## ⚓ Safety note (surface this in-app)

This is a **planning reference built from open data**, NOT a navigational chart and NOT a substitute for official charts, the GBRMPA zoning maps, or the skipper's judgement. OSM bay positions are approximate and carry **no depth, holding or protection data**. Always verify against official sources (GBRMPA zoning, AHO charts, Beacon to Beacon) and your own eyes before anchoring. No-anchoring areas change — confirm current GBRMPA data before relying on it.
