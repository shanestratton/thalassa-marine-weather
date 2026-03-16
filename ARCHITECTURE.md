# Thalassa Architecture Guide

> Officer on Watch Assistant — Maritime weather, navigation, and voyage planning.

## Stack

| Layer | Technology |
|---|---|
| UI | React 18 + TypeScript + Tailwind CSS |
| Build | Vite 5 |
| Mobile | Capacitor 8 (iOS + Android) |
| Backend | Supabase (Auth, PostgreSQL, Edge Functions, Realtime) |
| Maps | Mapbox GL JS + MapLibre GL + Leaflet (velocity overlay) |
| Weather | WeatherKit Primary → NOAA GRIB2 fallback → Open-Meteo tertiary |
| AI | Google Gemini (passage planning, content moderation) |
| Monitoring | Sentry (error tracking, performance) |
| CI | GitHub Actions (lint, typecheck, test, build, bundle size) |

## Directory Structure

```
├── App.tsx                 # Root component — layout shell, tab bar, page router
├── index.tsx              # Entry point — React root, Sentry init, global providers
├── index.css              # Design system: theme tokens, Tailwind overrides, light/dark/night modes
│
├── components/            # UI components (largest directory)
│   ├── Dashboard.tsx      # Landing page — hero carousel, weather cards
│   ├── ChatPage.tsx       # Community chat with channels, DMs, crew finder
│   ├── map/               # MapHub, weather layers, wind particles, passage planner
│   ├── passage/           # Voyage analysis cards (customs, resources, emergency, model comparison)
│   ├── vessel/            # Ship's office (inventory, maintenance, equipment, documents, NMEA)
│   ├── dashboard/         # Hero slides, DnD grid, weather cards
│   ├── chat/              # Channel list, message list, composer, DM views
│   ├── crew-finder/       # CrewProfileForm (extracted from LonelyHeartsPage)
│   ├── ui/                # Shared UI primitives (PageTransition, ConfirmDialog, Skeleton, etc.)
│   └── settings/          # Aesthetics, vessel, and app settings tabs
│
├── context/               # React Context providers
│   ├── WeatherContext.tsx  # Global weather state — coordinates, forecasts, loading
│   ├── SettingsContext.tsx # User preferences — units, theme, pro status
│   ├── UIContext.tsx       # Navigation state — currentView, transitions
│   └── ThalassaContext.tsx # Vessel profile, onboarding state
│
├── hooks/                 # Custom hooks
│   ├── useAppController.ts    # App lifecycle — onboarding, orientation, display mode
│   ├── chat/              # Chat-specific hooks (messages, DMs, pin drops, track sharing)
│   └── useFollowRouteOverlay.ts  # GPS-based follow-route with ETA, deviation alerts
│
├── services/              # Business logic and API clients
│   ├── ChatService.ts         # Supabase-backed chat (channels, DMs, moderation, admin)
│   ├── WeatherOrchestrator.ts # Multi-source weather aggregation
│   ├── weather/               # Wind field, OpenMeteo, geocoding, API clients
│   ├── MarketplaceService.ts  # Buy/sell listings
│   ├── LonelyHeartsService.ts # Crew finder matchmaking
│   ├── AnchorWatchService.ts  # GPS-based anchor alarm with drift detection
│   └── vessel/                # Local-first CRUD (SQLite via Capacitor)
│
├── data/                  # Static data modules
│   └── customsDb.ts       # 28-country customs clearance database (1,165 lines)
│
├── utils/                 # Pure utility functions
│   ├── fetchWithRetry.ts  # Exponential backoff with jitter
│   ├── createLogger.ts    # Scoped logger (strips logs in production)
│   └── logExport.ts       # GeoJSON/CSV export for ship's log
│
├── pages/                 # Page-level components
│   └── LogPage.tsx        # Ship's log with GPS tracking and waypoint recording
│
├── supabase/              # Backend
│   └── functions/         # Edge Functions (wind velocity, precipitation, overpass proxy)
│
├── tests/                 # Test suites (Vitest)
├── e2e/                   # E2E tests (Playwright)
└── .github/workflows/     # CI pipeline
```

## Key Architecture Patterns

### 1. Multi-Source Weather Orchestration

```
WeatherKit (primary) → NOAA GRIB2 (fallback) → Open-Meteo (tertiary)
                    ↓
           WeatherOrchestrator
                    ↓
         ConsensusMatrixEngine → confidence scoring per metric
```

### 2. Isochrone Weather Routing

```
A* Safe-Water Corridors (coastal) → Isochrone Expansion (offshore)
                                         ↓
                                    land avoidance (ETOPO + coastline)
                                         ↓
                                    route smoothing + safety scoring
```

### 3. Dual Theme System

CSS custom property overrides applied at `:root` level:
- **Offshore** (default): Cool navy/slate
- **Onshore**: Warm stone/earth tones
- **Light mode**: Full color inversion via `display-light` class
- **Night mode**: Red-tinted overlay via `mix-blend-multiply`

### 4. Lazy Loading Strategy

All page-level components use `React.lazy()` with `lazyRetry()` wrapper that handles stale module hash errors by reloading once per session.

### 5. Security Headers (Vercel)

- CSP whitelisting Supabase, Mapbox, OWM, Sentry, Google Fonts
- HSTS with 2-year max-age and preload
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy: camera, microphone, payment, USB all disabled

## CI Pipeline

```yaml
Lint (max 200 warnings) → TypeCheck → Unit Tests → Build → Bundle Size (< 5MB) → E2E
```

## ESLint Rules

| Rule | Level | Rationale |
|---|---|---|
| `no-explicit-any` | **error** | Zero `:any` policy — all 68 legacy uses eliminated |
| `exhaustive-deps` | **warn** | Catches stale closures; intentional suppression via inline comment |
| `no-empty` | warn | Empty catch blocks should have comments |
| `no-fallthrough` | warn | Switch fallthroughs should be explicit |
