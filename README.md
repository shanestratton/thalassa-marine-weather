# Thalassa — Marine Weather & Navigation

> Officer on Watch Assistant — Weather routing, AIS, anchor watch, and crew community for offshore sailors.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit --skipLibCheck

# Lint
npx eslint .

# Build for production
npm run build
```

## Architecture

```
├── components/          # React UI components
│   ├── chat/           # Crew Talk messaging system
│   ├── dashboard/      # Weather dashboard widgets
│   ├── map/            # MapHub, weather layers, AIS
│   ├── onboarding/     # First-run wizard steps
│   ├── settings/       # Settings modal tabs
│   ├── ui/             # Shared primitives (ModalSheet, PageHeader, etc.)
│   └── vessel/         # Vessel management & equipment
├── services/           # Business logic & API integrations
│   ├── weather/        # Multi-model weather data (WeatherKit, NOAA, OWM)
│   ├── ais/            # AIS vessel tracking
│   └── routing/        # Passage planning & isochrone engine
├── hooks/              # Custom React hooks
├── types/              # TypeScript type definitions
├── utils/              # Shared utilities
└── workers/            # Web Workers (wind particles, GRIB decoding)
```

### Key Services

| Service           | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `WeatherService`  | Multi-source weather orchestration               |
| `AisService`      | Real-time vessel tracking via Supabase           |
| `RoutingEngine`   | A\* corridor + isochrone weather routing         |
| `GpsService`      | Capacitor-based GPS with external device support |
| `GuardianService` | Vessel security monitoring & alerts              |
| `ChatService`     | Real-time messaging via Supabase Realtime        |

### Tech Stack

- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS + custom design system
- **Maps:** MapLibre GL JS (via Mapbox GL compatible API)
- **Backend:** Supabase (auth, database, real-time, storage, edge functions)
- **Native:** Capacitor (iOS/Android) with GPS, keyboard, haptics
- **Testing:** Vitest + React Testing Library
- **Linting:** ESLint + Prettier + lint-staged + husky

## Environment Variables

Copy `.env.example` to `.env` and configure:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_MAPBOX_TOKEN=your-mapbox-token
VITE_OWM_KEY=your-openweathermap-key
VITE_SENTRY_DSN=your-sentry-dsn
```

## iOS Development

```bash
# Sync web build to iOS project
npx cap sync ios

# Open in Xcode
npx cap open ios
```

## Contributing

1. Branch from `master`
2. Run `npm test` and `npx tsc --noEmit` before committing
3. Commits are validated by lint-staged (ESLint + Prettier)
4. Keep components under 500 lines — extract sub-components early

## License

Proprietary — © Thalassa Marine Weather
