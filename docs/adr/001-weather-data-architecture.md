# ADR-001: WeatherKit-Primary Multi-Source Weather Architecture

**Status:** Accepted  
**Date:** 2026-01-15  
**Deciders:** Shane Stratton

## Context

Thalassa needs reliable marine weather data worldwide, including offshore zones where coastal-only APIs fall short. No single weather provider covers all marine parameters (wind, swell, tide, current, CAPE, visibility) with global reliability.

## Decision

Adopt a **WeatherKit-primary, multi-source fallback** architecture:

1. **Primary:** Apple WeatherKit — best overall quality, global coverage, includes tide data
2. **Fallback 1:** Open-Meteo — free, no API key required, good European coverage
3. **Fallback 2:** StormGlass — aggregates 7+ models, marine-specific parameters
4. **Supplement:** NOAA NOMADS/GRIB — raw model data for wind fields, isobars, offshore routing

## Architecture

```
WeatherContext (React)
  └→ WeatherService (orchestrator)
       ├→ weatherkit.ts    — primary hourly/daily forecasts
       ├→ openmeteo.ts     — fallback if WeatherKit fails
       ├→ stormglass.ts    — marine-specific supplement
       ├→ beaconService.ts — crowd-sourced coastal data
       └→ WindDataController — GRIB/NOMADS for wind field grids
```

### Source Attribution

Every weather metric displays its source (WeatherKit, Open-Meteo, etc.) in the UI to maintain transparency with mariners who depend on this data for safety.

### Caching Strategy

- **In-memory LRU** with 15-minute TTL for current conditions
- **localStorage** for offline fallback (last known good data)
- **Background prefetch** every 30 minutes when app is active

## Consequences

**Positive:**

- No single vendor lock-in — if WeatherKit goes down, Open-Meteo takes over seamlessly
- Marine-specific data (swell period, drift, set) available from specialized sources
- Source transparency builds trust with safety-conscious mariners

**Negative:**

- Data normalization complexity — each source uses different units, coordinate systems
- Increased bundle size from multiple API clients (~8KB gzipped total)
- Rate limit management across 3+ providers
