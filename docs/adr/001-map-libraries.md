# ADR-001: Map Library Architecture

**Date:** 2026-03-23
**Status:** Accepted
**Authors:** Claude (Antigravity), Shane Stratton

## Context

Thalassa uses three map libraries:

| Library                                 | Usage                                                                                     | Files    |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| `mapbox-gl`                             | Primary WebGL map (MapHub), AIS, passage planner, cyclone layers, wind particles, isobars | 10 files |
| `maplibre-gl` + `react-map-gl/maplibre` | ThalassaMap (OSM-based), SpatiotemporalMap (passage visualization), GRIB download         | 4 files  |
| `leaflet`                               | Wind velocity overlays, offline tiles, LiveMiniMap, WeatherMap, TrackMapViewer            | 7 files  |

## Decision

**Keep all three libraries.** Each serves a distinct architectural purpose:

1. **mapbox-gl** — The main interactive map with proprietary Mapbox tiles. Powers all real-time navigation features (AIS, passage planning, cyclone tracking). Cannot be replaced without losing Mapbox satellite imagery and styling.

2. **maplibre-gl** — Open-source fork used for the ThalassaMap component with OpenStreetMap tiles. Provides the spatiotemporal passage visualization. Uses `react-map-gl/maplibre` for declarative React bindings. Cannot be consolidated with mapbox-gl because it serves the purpose of providing a free/open tile source alternative.

3. **leaflet** — Canvas-based rendering for weather overlays (wind velocity, GlobalWind). Uses `leaflet-velocity-ts` and `leaflet.offline` plugins that have no mapbox/maplibre equivalents.

## Consequences

- Bundle includes ~500KB+ of map libraries (chunked separately via Vite)
- Three different rendering paradigms (WebGL mapbox, WebGL maplibre, Canvas leaflet)
- Future consolidation would require finding mapbox/maplibre replacements for leaflet velocity plugins
