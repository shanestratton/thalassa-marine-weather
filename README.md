
<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# ⚓ Thalassa Marine Weather

**Professional-grade marine weather intelligence for iOS and web**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb)](https://react.dev/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8-119eff)](https://capacitorjs.com/)
[![Tests](https://img.shields.io/badge/Tests-325%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/License-Private-red)]()

</div>

---

## Overview

Thalassa is a maritime weather application that delivers real-time coastal, offshore, and inland weather forecasting with professional-grade accuracy. Built with React + Vite and deployed natively to iOS via Capacitor.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multi-Source Weather** | StormGlass API + OpenMeteo + IMOS buoys + BOM beacons |
| **Adaptive Forecasting** | Coastal / Offshore / Inland detection with zone-specific widgets |
| **Ship's Log** | GPS-tracked voyages with auto entries, waypoints, and equipment logs |
| **Anchor Watch** | Real-time drag monitoring with configurable swing radius alerts |
| **Tide Intelligence** | WorldTides integration with animated tide graphs |
| **Passage Planning** | Route planner with weather windows, risk dashboards, and float plans |
| **AI Voyage Analysis** | Gemini-powered passage reports and coordinate intelligence |
| **Community Tracks** | Share and download voyage tracks via Supabase |
| **PDF Export** | Professional deck log generation with map snapshots |
| **Offline-First** | Full offline queue with background sync |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript 5.4, TailwindCSS 3 |
| **Build** | Vite 7, PostCSS, Autoprefixer |
| **Native** | Capacitor 8 (iOS) |
| **State** | React Context + `useReducer` pattern |
| **Charts** | uPlot (lightweight, GPU-accelerated) |
| **Maps** | Mapbox GL JS + Leaflet |
| **Backend** | Supabase (Auth, Database, RPC) |
| **AI** | Google Generative AI (Gemini) |
| **Testing** | Vitest + Testing Library + Playwright |
| **Animation** | Framer Motion, CSS animations |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Xcode** (for iOS builds, Mac only)
- **Apple Developer Account** (for TestFlight / App Store)

### Installation

```bash
git clone <repo-url>
cd thalassa-marine-weather
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
VITE_STORMGLASS_API_KEY=your_key
VITE_GEMINI_API_KEY=your_key
VITE_MAPBOX_ACCESS_TOKEN=your_key
VITE_SUPABASE_URL=your_url
VITE_SUPABASE_ANON_KEY=your_key

# Optional
VITE_OPEN_METEO_API_KEY=your_key
VITE_WORLDTIDES_API_KEY=your_key
```

### Development

```bash
npm run dev          # Start development server (Vite)
npm run build        # Production build (tsc + vite build)
npm run test         # Run all tests (Vitest)
npm run test:watch   # Watch mode
npm run test:e2e     # Playwright end-to-end tests
```

### iOS Deployment

```bash
npm run build        # Build the web bundle
npm run cap:sync     # Sync to Capacitor iOS project
npm run cap:ios      # Open in Xcode
```

In Xcode: select your team → connect device → **Cmd+R** to run, or **Product → Archive** for App Store submission.

---

## Architecture

```
src/
├── components/          # React components (organized by feature)
│   ├── dashboard/       # Weather dashboard (HeroSlide, WeatherGrid, etc.)
│   ├── passage/         # Passage planning (RoutePlanner, RiskDashboard)
│   ├── map/             # Map layers (GlobalWindLayer, MapUI)
│   ├── ui/              # Shared UI primitives
│   └── ...              # Feature components (AnchorWatch, LogPage, etc.)
├── context/             # React Context providers
│   ├── ThalassaContext   # Main app context (weather, settings, UI)
│   └── ...
├── hooks/               # Custom React hooks
├── services/            # Service layer (isolated, testable)
│   ├── weather/         # Weather data orchestration
│   ├── shiplog/         # Ship log CRUD + offline queue
│   ├── AnchorWatchService
│   ├── PushNotificationService
│   └── ...
├── utils/               # Pure utility functions (fully tested)
│   ├── units.ts         # Unit conversions (speed, temp, distance)
│   ├── math.ts          # Weather math (wind chill, haversine, sun times)
│   ├── format.ts        # String formatting (compass, coordinates, TTS)
│   ├── sailing.ts       # Maritime calculations (hull speed, Beaufort)
│   └── advisory.ts      # Weather advisory generation
├── types.ts             # Centralized type definitions
└── theme.ts             # Design system tokens
```

### Design Principles

1. **Service Layer Isolation** — Business logic lives in `services/`, never in components
2. **Context Pattern** — Global state via `ThalassaContext` with typed actions
3. **Hook Extraction** — Complex component logic extracted to `hooks/`
4. **Type Centralization** — `types.ts` is the single source of truth
5. **Offline-First** — All mutations queue to `OfflineQueue` when network unavailable
6. **Graceful Degradation** — Silent catches with documented fallback behavior

---

## Testing

```
325 tests across 21 suites — all passing in ~3s
```

| Layer | Suites | Tests |
|-------|--------|-------|
| **Utility Functions** | 6 | 132 |
| **Service Logic** | 5 | 69 |
| **Component Tests** | 4 | 16 |
| **Navigation Math** | 2 | 47 |
| **E2E (Playwright)** | 4 | 61 |

Run them:

```bash
npm run test              # All unit/integration tests
npm run test:coverage     # With coverage report
npm run test:e2e          # Playwright browser tests
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for code patterns, conventions, and development workflow.

---

## License

Private — All rights reserved.
