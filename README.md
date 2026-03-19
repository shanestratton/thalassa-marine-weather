# Thalassa — Marine Weather & Navigation

> Officer on Watch Assistant — Weather routing, AIS, anchor watch, and crew community for offshore sailors.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB)](https://react.dev/)
[![Tests](https://img.shields.io/badge/Tests-914_passing-brightgreen)]()
[![License](https://img.shields.io/badge/License-Proprietary-red)]()

---

## Features

| Category         | Features                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weather**      | Multi-model forecasts (WeatherKit, NOAA NOMADS, OpenMeteo), wind particles, rain radar (RainViewer + Rainbow.ai), isobars, temperature/cloud/satellite overlays |
| **Navigation**   | A\* Safe‑Water Corridor routing, isochrone weather routing, GEBCO depth contours, ETOPO bathymetry                                                              |
| **AIS**          | Real-time vessel tracking, guard zones, vessel search, anchor watch radar overlay                                                                               |
| **Anchor Watch** | GPS geofencing, swing circle visualization, shore remote monitoring via Supabase Realtime, drag alarm with audio                                                |
| **Community**    | Crew Talk real-time chat, crew finder profiles, maritime marketplace with escrow payments                                                                       |
| **Voyage**       | Ship's log with Gemini AI diary entries, GPS track recording, community track sharing                                                                           |
| **Guardian**     | Vessel security monitoring, push notifications, geo-fence alerts                                                                                                |

---

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests (914 tests, 56 suites)
npm test

# Type check
npx tsc --noEmit --skipLibCheck

# Lint
npx eslint .

# Build for production
npm run build

# Bundle analysis (generates bundle-stats.html)
npx vite build -- --analyze
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full architecture diagrams and service documentation.

```
thalassa-marine-weather/
├── components/              # 67 React UI components
│   ├── anchor-watch/       # Swing circle, alarm overlay, radar, shore modal
│   ├── chat/               # Crew Talk messaging, DMs, pin drops, intel ticker
│   ├── dashboard/          # Weather dashboard, hero slide, tide/vessel cards
│   ├── map/                # MapHub orchestrator, weather layers, AIS, passage planner
│   ├── onboarding/         # First-run wizard (6 steps)
│   ├── settings/           # 7 extracted tab components (General, Account, Vessel, etc.)
│   ├── ui/                 # Shared primitives (ModalSheet, PageHeader, ConfirmDialog)
│   └── vessel/             # Equipment lists, checklists, polar manager
├── services/               # 65 business logic & API integration services
│   ├── weather/            # WeatherKit proxy, NOAA GRIB, wind data pipeline
│   ├── AisStreamService    # Real-time AIS via Supabase
│   ├── IsochroneRouter     # Offshore weather routing engine
│   ├── ChatService         # Supabase Realtime messaging
│   └── GpsService          # Capacitor GPS with Bad Elf support
├── hooks/                  # 31 custom React hooks
│   ├── chat/               # useChat, useChatDM, useChannelMembers
│   └── passage/            # usePassagePlanner, useFollowRoute
├── context/                # React Context (ThalassaContext, WeatherContext)
├── types/                  # 9 TypeScript type definition files
├── utils/                  # Shared utilities (createLogger, system, logExport)
├── workers/                # Web Workers (AIS ingest)
├── supabase/functions/     # 26 Supabase Edge Functions
├── data/                   # Static data (customs DB, ports, country flags)
└── public/                 # Static assets, PWA manifest, service worker
```

---

## Tech Stack

| Layer            | Technology                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Frontend**     | React 18 + TypeScript 5 + Vite                                                              |
| **Styling**      | Tailwind CSS + custom dark maritime design system                                           |
| **Maps**         | Mapbox GL JS (vector tiles, WebGL wind particles)                                           |
| **Backend**      | Supabase (Auth, PostgreSQL, Realtime, Storage, Edge Functions)                              |
| **Native**       | Capacitor (iOS/Android) — GPS, keyboard, haptics, background location                       |
| **Weather APIs** | WeatherKit, NOAA NOMADS/GRIB, OpenMeteo, OpenWeatherMap, RainViewer, Rainbow.ai, StormGlass |
| **Testing**      | Vitest + React Testing Library (914 tests, 56 suites, 4 E2E specs)                          |
| **Linting**      | ESLint + Prettier + lint-staged + Husky pre-commit hooks                                    |
| **Monitoring**   | Sentry error tracking, createLogger service                                                 |
| **Analysis**     | rollup-plugin-visualizer (bundle-stats.html)                                                |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable                 | Required | Description                                           |
| ------------------------ | -------- | ----------------------------------------------------- |
| `VITE_SUPABASE_URL`      | ✅       | Supabase project URL                                  |
| `VITE_SUPABASE_ANON_KEY` | ✅       | Supabase anonymous key (public, RLS-protected)        |
| `VITE_MAPBOX_TOKEN`      | ✅       | Mapbox GL access token for map rendering              |
| `VITE_OWM_API_KEY`       | ⚡       | OpenWeatherMap API key (temp/cloud tile overlays)     |
| `VITE_RAINBOW_API_KEY`   | ⚡       | Rainbow.ai API key (1km precipitation forecast tiles) |
| `VITE_APP_VERSION`       | —        | App version string (auto-set by CI)                   |
| `VITE_SENTRY_DSN`        | —        | Sentry DSN for error reporting                        |

> **⚡ Optional but recommended** — these enable premium weather overlays. Without them, core forecasting still works via Supabase Edge Function proxies.

---

## Supabase Edge Functions

26 serverless functions handle API key protection and server-side computation:

| Function                                                                          | Purpose                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `fetch-weatherkit`                                                                | Apple WeatherKit proxy (requires server-side JWT) |
| `fetch-wind-grid` / `fetch-wind-velocity`                                         | NOAA GFS wind data (GRIB decoding)                |
| `fetch-precip-grid` / `fetch-pressure-grid`                                       | NOAA precipitation & pressure grids               |
| `proxy-rainbow`                                                                   | Rainbow.ai tile proxy (API key hidden)            |
| `proxy-stormglass`                                                                | StormGlass marine data proxy                      |
| `proxy-openmeteo`                                                                 | OpenMeteo forecast proxy                          |
| `proxy-tides`                                                                     | Tide prediction proxy                             |
| `route-weather` / `route-bathymetric`                                             | Server-side route analysis                        |
| `gebco-depth`                                                                     | GEBCO bathymetry depth queries                    |
| `maritime-intel`                                                                  | Maritime news aggregation for ticker              |
| `gemini-diary`                                                                    | Gemini AI ship's log diary entries                |
| `vessels-nearby` / `lookup-vessel`                                                | AIS vessel data queries                           |
| `send-push` / `send-anchor-alarm`                                                 | Push notification delivery                        |
| `check-weather-alerts`                                                            | Automated severe weather alert checks             |
| `create-marketplace-payment` / `capture-escrow-payment` / `sweep-expired-escrows` | Marketplace payment flow                          |

---

## iOS Development

```bash
# Build web assets
npm run build

# Sync to iOS project
npx cap sync ios

# Open in Xcode
npx cap open ios

# Live reload during development
npx cap run ios --livereload --external
```

---

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific suite
npm test -- --grep "AisGuardZone"

# Watch mode
npm test -- --watch
```

**Test coverage:** 914 tests across 56 suites covering:

- Weather data transformation and caching
- AIS guard zone geographic calculations
- Routing engine A\* and isochrone algorithms
- Chat service message formatting
- Anchor watch geofencing logic
- GPS coordinate utilities

---

## Contributing

1. Branch from `master`
2. Run `npm test` and `npx tsc --noEmit` before committing
3. Commits are validated by lint-staged (ESLint + Prettier)
4. Keep components under 500 lines — extract sub-components early
5. Use `createLogger('ServiceName')` for debug logging (stripped in production)
6. All new services should have corresponding test files

---

## License

Proprietary — © Thalassa Marine Weather
