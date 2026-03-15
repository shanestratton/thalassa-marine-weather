# ADR-003: Isochrone Weather Routing with Safety Corridors

**Status:** Accepted  
**Date:** 2026-02-15  
**Deciders:** Shane Stratton

## Context

Passage planning across open water requires weather-aware routing. Simple A\* pathfinding doesn't account for wind, waves, or vessel performance. Mariners need routes that optimize for safety and comfort, not just shortest distance.

## Decision

Implement a **tiered routing system** (the "Trip Sandwich"):

1. **Coastal corridors** — A\* on safe-water graph (avoids land, shallow water, TSS zones)
2. **Offshore routing** — Isochrone expansion using vessel polar data and GRIB weather forecasts
3. **Seamless handoff** — Automatic transition between coastal and offshore at configurable distance

## Algorithm

```
Route Request (A → B)
  1. Classify segments: coastal (<20nm from shore) vs offshore
  2. Coastal: A* on bathymetric-aware graph (GEBCO depth data)
  3. Offshore: Isochrone expansion
       - For each timestep (1hr):
         - Expand frontier in all bearings (10° increments)
         - Apply vessel polar to compute VMG for each bearing
         - Sample GRIB wind/wave at each candidate point
         - Reject points on land (rasterized coastline check)
         - Reject points in shallow water (< vessel draft × 1.5)
       - Connect optimal frontier points
  4. Smooth route with cubic spline
  5. Push route offshore from land (minimum 2nm clearance)
```

### Vessel Polar Integration

The router uses the vessel's polar diagram (speed vs. true wind angle at each wind speed) to compute realistic speed-made-good for each candidate direction. This means:

- Upwind routes automatically tack
- Downwind routes jibe to optimize VMG
- Heavy weather routes avoid dangerous beam seas

## Consequences

**Positive:**

- Weather-optimal routes that reflect actual vessel performance
- Safety corridors prevent routes from crossing land or shallow water
- Tiered approach handles both coastal hopping and ocean crossings

**Negative:**

- GRIB data required for offshore routing (100-500MB per forecast)
- Isochrone computation is CPU-intensive (~2-5s for 500nm route)
- Polar data accuracy directly affects route quality
