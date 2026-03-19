# Thalassa Architecture

## System Overview

```mermaid
graph TB
    subgraph Client["Client (React + Capacitor)"]
        UI["React UI<br>67 components"]
        Hooks["31 Custom Hooks"]
        Services["65 Services"]
        Workers["Web Workers<br>AIS, Wind GL"]
        Context["ThalassaContext<br>WeatherContext"]
    end

    subgraph Supabase["Supabase Backend"]
        Auth["Auth (Magic Link)"]
        DB["PostgreSQL"]
        RT["Realtime<br>Chat, AIS, Sync"]
        Storage["Storage<br>Photos, Logs"]
        Edge["26 Edge Functions"]
    end

    subgraph External["External APIs"]
        WK["WeatherKit"]
        NOAA["NOAA NOMADS"]
        OWM["OpenWeatherMap"]
        OM["OpenMeteo"]
        RV["RainViewer"]
        RB["Rainbow.ai"]
        SG["StormGlass"]
        MB["Mapbox GL"]
        OSM["OpenSeaMap"]
    end

    UI --> Hooks --> Services
    Services --> Context
    Services --> Workers
    Services --> Edge
    Edge --> WK & NOAA & OWM & OM & SG & RB
    Services --> Auth & DB & RT & Storage
    UI --> MB & OSM
    Services --> RV
```

## Data Flow: Weather

```mermaid
sequenceDiagram
    participant User
    participant UI as React UI
    participant WS as WeatherService
    participant Edge as Edge Functions
    participant APIs as Weather APIs

    User->>UI: Open weather page
    UI->>WS: fetchWeather(lat, lon)
    WS->>WS: Check cache (5min TTL)
    alt Cache hit
        WS-->>UI: Cached data
    else Cache miss
        WS->>Edge: fetch-weatherkit
        Edge->>APIs: WeatherKit (JWT auth)
        APIs-->>Edge: Forecast JSON
        Edge-->>WS: Transformed data
        WS->>WS: Cache result
        WS-->>UI: Fresh data
    end
    UI->>UI: Render dashboard cards
```

## Data Flow: Wind Particles

```mermaid
sequenceDiagram
    participant Map as MapHub
    participant WL as useWeatherLayers
    participant Edge as fetch-wind-grid
    participant NOAA as NOAA GFS
    participant GL as WindParticleLayer WebGL

    Map->>WL: Toggle wind layer
    WL->>Edge: Fetch GFS grid
    Edge->>NOAA: GRIB data request
    NOAA-->>Edge: Binary GRIB
    Edge-->>WL: Decoded UV grid
    WL->>GL: Initialize WebGL engine
    GL->>GL: Create particle VAO
    GL->>GL: Animate particles via rAF
    GL-->>Map: Rendered on canvas overlay
```

## Component Hierarchy

```mermaid
graph TD
    App["App.tsx"] --> Router
    Router --> Dashboard["Dashboard"]
    Router --> MapHub["MapHub"]
    Router --> Chat["ChatPage"]
    Router --> Anchor["AnchorWatchPage"]
    Router --> Guardian["GuardianPage"]
    Router --> Diary["DiaryPage"]
    Router --> Settings["SettingsModal"]

    Dashboard --> HeroSlide
    Dashboard --> TideVessel
    Dashboard --> ForecastSheet

    MapHub --> MapInit["useMapInit"]
    MapHub --> WeatherLayers["useWeatherLayers"]
    MapHub --> PassagePlanner["usePassagePlanner"]
    MapHub --> LayerFAB["LayerFABMenu"]
    MapHub --> VesselSearch

    Chat --> ChannelList
    Chat --> ChatMessages
    Chat --> ChatDMView
    Chat --> CrewFinder
    Chat --> Marketplace
    Chat --> IntelTicker["MaritimeIntelCard"]

    Anchor --> SwingCircle["SwingCircleCanvas"]
    Anchor --> AlarmOverlay["AnchorAlarmOverlay"]
    Anchor --> ScopeRadar
    Anchor --> ShoreWatch["ShoreWatchModal"]

    Settings --> GeneralTab
    Settings --> AccountTab
    Settings --> VesselTab
    Settings --> AlertsTab
    Settings --> AestheticsTab
    Settings --> LocationsTab
    Settings --> PolarManager["PolarManagerTab"]
```

## Service Architecture

### Core Services

| Service              | Lines  | Responsibility                                        |
| -------------------- | ------ | ----------------------------------------------------- |
| `WeatherService`     | ~400   | Multi-source weather orchestration with caching       |
| `ChatService`        | ~1,400 | Supabase Realtime messaging, DMs, moderation          |
| `IsochroneRouter`    | ~1,370 | Offshore weather routing with wind-angle optimization |
| `ShipLogService`     | ~1,990 | Voyage logging, GPS tracks, export (GPX/KML/CSV)      |
| `AnchorWatchService` | ~500   | GPS geofencing, swing radius, drag detection          |
| `GpsService`         | ~400   | Capacitor GPS with external device support (Bad Elf)  |
| `AisStreamService`   | ~300   | Real-time AIS via Supabase, vessel tracking           |
| `GuardianService`    | ~300   | Vessel security monitoring, geo-fence alerts          |
| `AlarmAudioService`  | ~200   | Web Audio API alarm with haptic feedback              |

### Weather Data Pipeline

```
WeatherKit (primary)
    -> JWT auth via Edge Function
    -> Hourly + daily forecasts
    -> Cached 5min in-memory + localStorage

NOAA NOMADS (fallback)
    -> GRIB binary data via Edge Functions
    |-- Wind UV grids -> WebGL particle engine
    |-- Pressure grids -> isobar contour lines
    +-- Precipitation grids -> rain overlay

OpenMeteo (free tier)
    -> Direct client API calls
    +-- Marine forecasts, wave data

RainViewer (radar) + Rainbow.ai (forecast)
    -> XYZ tile overlays
    +-- Unified scrubber timeline (past radar + future forecast)

OpenWeatherMap
    -> Direct tile API (requires API key)
    +-- Temperature + cloud overlays
```

### Routing Engine

The passage planner uses a two-stage approach:

1. **Coastal Corridors (A\*)** — Safe-water pathfinding avoiding land, using GEBCO depth data
2. **Offshore Isochrone** — Weather-optimized routing using GFS wind forecasts and vessel polar data

## Database Schema (Supabase PostgreSQL)

Key tables:

| Table               | Purpose                             |
| ------------------- | ----------------------------------- |
| `profiles`          | User profiles with vessel info      |
| `channels`          | Chat channels (public, private, DM) |
| `messages`          | Chat messages with read receipts    |
| `crew_listings`     | Crew finder profiles                |
| `marketplace_items` | Items for sale with escrow          |
| `voyage_logs`       | Ship's log entries                  |
| `community_tracks`  | Shared GPS voyage tracks            |
| `ais_positions`     | Recent AIS vessel positions         |
| `guard_zones`       | Guardian geo-fence definitions      |
| `weather_alerts`    | Automated severe weather alerts     |

## Security Model

- **API keys** proxied through Supabase Edge Functions (never in client bundle)
- **Authentication** via Supabase Auth (magic link email)
- **Row-Level Security (RLS)** on all database tables
- **Content moderation** via `ContentModerationService`
- **CSP headers** configured in deployment
- **No `dangerouslySetInnerHTML`** usage
- **`.env` in `.gitignore`** — no secrets in source

## Performance Optimizations

- **662 `useMemo`/`useCallback`** calls for render optimization
- **Lazy loading** via `React.lazy()` for all route-level components
- **Web Workers** for AIS data ingestion (off-main-thread)
- **WebGL** particle engine for wind visualization (60fps)
- **`createLogger`** with `esbuild.drop` removing all `console.*` in production
- **Virtualized lists** for AIS vessel tables
- **Static tile caching** via service worker

## Accessibility

- **300+ ARIA attributes** across components
- **Global focus-visible rings** (sky-400 2px ring on keyboard focus)
- **Skip-to-content** CSS link
- **Semantic HTML** with `<nav>`, `<main>`, `<section>` landmarks
- **Color contrast** WCAG AA compliance on interactive labels
- **Keyboard navigation** on all interactive elements
- **Screen reader announcements** via `aria-live` regions
