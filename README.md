<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# ⚓ Thalassa Marine Weather

**Professional-grade marine weather intelligence for iOS and web**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb)](https://react.dev/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8-119eff)](https://capacitorjs.com/)
[![CI](https://github.com/shanestratton/thalassa-marine-weather/actions/workflows/ci.yml/badge.svg)](https://github.com/shanestratton/thalassa-marine-weather/actions)
[![Tests](https://img.shields.io/badge/Tests-530%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/License-Private-red)]()

</div>

---

## Overview

Thalassa is a maritime weather application that delivers real-time coastal, offshore, and inland weather forecasting with professional-grade accuracy. Built with React + Vite and deployed natively to iOS via Capacitor.

### Key Features

| Feature                  | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| **Multi-Source Weather** | WeatherKit (primary) → StormGlass → OpenMeteo fallback chain         |
| **Adaptive Forecasting** | Coastal / Offshore / Inland detection with zone-specific widgets     |
| **Ship's Log**           | GPS-tracked voyages with auto entries, waypoints, and equipment logs |
| **Anchor Watch**         | Real-time drag monitoring with configurable swing radius alerts      |
| **Tide Intelligence**    | WorldTides integration with animated tide graphs                     |
| **Passage Planning**     | Route planner with weather windows, risk dashboards, and float plans |
| **AI Voyage Analysis**   | Gemini-powered passage reports and coordinate intelligence           |
| **Community Tracks**     | Share and download voyage tracks via Supabase                        |
| **PDF Export**           | Professional deck log generation with map snapshots                  |
| **Offline-First**        | Full offline queue with background sync                              |

---

## Tech Stack

| Layer         | Technology                                 |
| ------------- | ------------------------------------------ |
| **Frontend**  | React 18, TypeScript 5.4, TailwindCSS 3    |
| **Build**     | Vite 7, PostCSS, Autoprefixer              |
| **Native**    | Capacitor 8 (iOS)                          |
| **State**     | React Context + `useReducer` pattern       |
| **Charts**    | uPlot (lightweight, GPU-accelerated)       |
| **Maps**      | MapLibre GL · Mapbox GL · Leaflet (legacy) |
| **Backend**   | Supabase (Auth, Database, RPC)             |
| **AI**        | Google Generative AI (Gemini)              |
| **Testing**   | Vitest + Testing Library + Playwright      |
| **Animation** | Framer Motion, CSS animations              |

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
npm run lint         # ESLint check
npm run lint:fix     # Auto-fix lint issues
npm run format       # Format with Prettier
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

├── components/ # React components (156 files)
│ ├── dashboard/ # Weather dashboard (HeroSlide, WeatherGrid, etc.)
│ ├── passage/ # Passage planning (RoutePlanner, RiskDashboard)
│ ├── map/ # MapLibre layers + passage planner
│ ├── anchor-watch/ # Anchor watch canvas visualization
│ ├── chat/ # Crew Talk messaging UI
│ ├── vessel/ # Vessel management pages
│ └── ui/ # Shared UI primitives
├── context/ # React Context providers (6 files)
├── hooks/ # Custom React hooks (38 files)
├── services/ # Business logic services (56 files)
│ ├── weather/ # Weather API clients + processing
│ └── shiplog/ # Ship log sub-modules
├── utils/ # Utility functions + logger
├── pages/ # Top-level page components
├── tests/ # Test suites (40 files, 530 tests)
├── supabase/functions/ # Edge functions (route-weather, etc.)
└── types.ts # Shared TypeScript types

```

### Design Principles

1. **Service Layer Isolation** — Business logic lives in `services/`, never in components
2. **Context Pattern** — Global state via `ThalassaContext` with typed actions
3. **Hook Extraction** — Complex component logic extracted to `hooks/`
4. **Type Centralization** — `types.ts` is the single source of truth
5. **Offline-First** — All mutations queue to `OfflineQueue` when network unavailable
6. **Graceful Degradation** — Silent catches with documented fallback behavior

---

## Testing & Quality

```

530 tests across 31 suites — all passing in ~4s

````

| Layer | Suites | Tests |
|-------|--------|-------|
| **Weather & Scheduling** | 4 | 89 |
| **Navigation Math** | 3 | 88 |
| **Service Logic** | 7 | 120 |
| **Ship's Log** | 3 | 46 |
| **UI Components** | 8 | 47 |
| **Utilities** | 6 | 140 |

### CI Pipeline

- **GitHub Actions**: Lint → TypeScript → Tests → Build on every push/PR
- **ESLint**: TypeScript + React Hooks rules (0 errors enforced, warnings ratcheted)
- **Pre-commit**: Husky + lint-staged catches errors before CI
- **Prettier**: Consistent formatting across all files

Run them:

```bash
npm run test              # All unit/integration tests
npm run test:coverage     # With coverage report
npm run lint              # ESLint check
npm run test:e2e          # Playwright browser tests
````

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for code patterns, conventions, and development workflow.

---

## License

Private — All rights reserved.
