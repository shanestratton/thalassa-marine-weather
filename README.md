# Thalassa — Marine Weather & Navigation

> The Sailor's Assistant — Weather routing, AIS, anchor watch, and crew community for offshore sailors.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB)](https://react.dev/)
[![License](https://img.shields.io/badge/License-Proprietary-red)]()

---

## Features

| Category         | Features                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weather**      | Multi-model forecasts (WeatherKit, NOAA NOMADS, OpenMeteo), wind particles, rain radar (RainViewer + Rainbow.ai), isobars, temperature/cloud/satellite overlays |
| **Navigation**   | A\* depth-aware corridor planning, isochrone weather routing, GEBCO depth contours, ETOPO bathymetry                                                            |
| **AIS**          | Real-time vessel tracking, guard zones, vessel search, anchor watch radar overlay                                                                               |
| **Anchor Watch** | GPS geofencing, swing circle visualization, drag alarm with audio, and shore remote monitoring pending final physical-device verification                       |
| **Community**    | Crew Talk real-time chat, direct messages, and crew finder profiles                                                                                             |
| **Voyage**       | Ship's log with Gemini AI diary entries, GPS track recording, and explicitly opt-in public Voyage Logs                                                          |
| **Guardian**     | Held and unavailable in the public beta; vessel-security source remains for a later release                                                                     |

---

## Quick Start

```bash
# Install dependencies
npm ci

# Start development server
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit

# Lint source and audit migrations
npm run lint

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
├── components/              # React UI components
│   ├── anchor-watch/       # Swing circle, alarm overlay, radar, shore modal
│   ├── chat/               # Crew Talk messaging, DMs, pin drops, intel ticker
│   ├── dashboard/          # Weather dashboard, hero slide, tide/vessel cards
│   ├── map/                # MapHub orchestrator, weather layers, AIS, passage planner
│   ├── onboarding/         # First-run wizard (6 steps)
│   ├── settings/           # Settings tabs (General, Account, Vessel, etc.)
│   ├── ui/                 # Shared primitives (ModalSheet, PageHeader, ConfirmDialog)
│   └── vessel/             # Equipment lists, checklists, polar manager
├── services/               # Business logic & API integration services
│   ├── weather/            # WeatherKit proxy, NOAA GRIB, wind data pipeline
│   ├── AisStreamService    # Real-time AIS via Supabase
│   ├── IsochroneRouter     # Offshore weather routing engine
│   ├── ChatService         # Supabase Realtime messaging
│   └── GpsService          # Capacitor GPS with Bad Elf support
├── hooks/                  # Custom React hooks
│   ├── chat/               # useChat, useChatDM, useChannelMembers
│   └── passage/            # usePassagePlanner, useFollowRoute
├── context/                # React Context (ThalassaContext, WeatherContext)
├── types/                  # TypeScript type definitions
├── utils/                  # Shared utilities (createLogger, system, logExport)
├── workers/ais-ingest/     # Independently deployed Node AIS ingest service
├── cloudflare-worker/      # Independently deployed Deepgram voice proxy
├── pi-cache/               # Held development-only Pi companion boundary
├── supabase/functions/     # Supabase Edge Functions
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
| **Testing**      | Vitest + React Testing Library + browser E2E specs                                          |
| **Linting**      | ESLint + Prettier + lint-staged + Husky pre-commit hooks                                    |
| **Monitoring**   | Sentry error tracking, createLogger service                                                 |
| **Analysis**     | rollup-plugin-visualizer (bundle-stats.html)                                                |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable                   | Required   | Description                                       |
| -------------------------- | ---------- | ------------------------------------------------- |
| `VITE_SUPABASE_URL`        | ✅         | Supabase project URL                              |
| `VITE_SUPABASE_KEY`        | ✅         | Supabase publishable key (public, RLS-protected)  |
| `VITE_MAPBOX_ACCESS_TOKEN` | ✅         | Mapbox GL access token for map rendering          |
| `VITE_OWM_API_KEY`         | ✅ release | OpenWeatherMap API key (temp/cloud tile overlays) |
| `VITE_APP_VERSION`         | ✅ release | App version string; must match `package.json`     |
| `VITE_SENTRY_DSN`          | ✅ release | Sentry DSN for error reporting                    |

> **⚡ Optional but recommended.** Paid provider credentials—including Rainbow.ai, Open-Meteo, Spoonacular, WeatherKit, Stripe, and voice/AI keys—belong only in Supabase/worker secrets. Never prefix them with `VITE_`; Vite embeds every such value in the browser and native bundle.

Production feature switches and public endpoint choices come from
[`config/public-beta-features.json`](./config/public-beta-features.json), not ignored `.env.local` state. Every build
emits `public-beta-features.json` with the exact profile, credential-presence booleans, and a deterministic SHA-256
fingerprint. The artifact contains no credential values.

The canonical public-beta profile selects four live-data overlays: CMEMS currents, sea-surface temperature,
chlorophyll, and the Australian marine-protected-area overlay. Waves, sea ice, and mixed-layer depth remain explicitly
parked and false in the release profile; their publisher and renderer plumbing stays in the repository for a later
reviewed rollout. A true selection is not release evidence by itself. Each enabled overlay's immutable publisher
manifest, bounded client decoder, freshness/integrity checks, attribution, and live hosted publication smoke must pass
on the frozen candidate; any enabled overlay that misses that gate must be switched off before packaging.

The checked-in marine publisher writes generation assets into ISO-week shards and updates only the inactive
`manifest-v2-a.json` / `manifest-v2-b.json` discovery slot after source-science and bundle validation. The Edge proxy
independently validates both slots, selects deterministically by source time, publication time, generation, and slot,
and exposes the result only at `/api/{dataset}/manifest-v2.json`. The first successful publication seeds both slots;
later runs never replace the active slot, so GitHub's delete-then-upload release-asset replacement cannot make v2
discovery disappear. Responses report the selected slot and the number of currently client-acceptable slots; release
gating requires two. New clients request only the virtual v2 path and generation-qualified immutable assets.

Marine cutover is deliberately two-phase. In Phase A, keep the Vercel production alias on the previous deployment,
land the publisher support, manually run and verify the currents, SST, chlorophyll, and MPA publishers, and confirm two
valid slots for each public-beta feed. Only then may Phase B deploy the dual-slot proxy and v2 clients. A combined push
without holding production deployment is unsafe. Stable `hNN.bin`, `mpa.geojson`, and MPA v1 manifest routes return
`410` with `no-store`. The CMEMS v1 manifest bridge is emergency-only, default off, enabled solely by exact
`THALASSA_CMEMS_V1_BRIDGE_ENABLED=true`, limited to fresh source windows, and permanently disabled after
2026-08-20T00:00:00Z. It synthesizes generation-qualified filenames and is not a Phase A dependency. Phase B must
leave the flag off, purge the production-alias CDN if necessary, and prove bare as well as cache-busted legacy URLs
return `410`; this prevents old full-cube clients from retaining an unsafe memory and stale-data path.

Workflow artifacts are named by run ID, not attempt. Rerunning only a failed publish job therefore reuses the sealed
producer artifact while it remains within its one-day retention window; rerunning all jobs overwrites that run-stable
artifact with the new attempt. After expiry, rerun all jobs rather than only the publisher. Map timing reads v2
manifests only. A visible CMEMS layer then downloads and verifies just its selected immutable frame, with a 16 MiB
response ceiling, a two-frame / 32 MiB decoded LRU, and explicit abort/release on hide, scrub, refresh, or failure. The
UI permits only one decoded CMEMS marine product at a time. Currents retain their 12-hour source-age limit; the
12-hourly waves publisher permits exactly 15 hours, one three-hour source-cadence margin, without weakening the current
contract.

CMEMS currents are a display overlay only in this candidate. Passage routing performs no CMEMS network request and
returns no current field, so current-adjusted route timing remains unavailable until a separately reviewed bounded,
signed regional or tiled routing source exists.

### Public-beta feature holds

Raspberry Pi integration is intentionally unavailable in production public-beta builds. The app does not discover,
configure, or exchange private data with a Pi and replaces Pi control screens with an unavailable notice. Development
work remains in the repository, but it must not be presented as a beta feature until authenticated encrypted LAN
transport is complete. Server-side development flags and the exact fail-closed defaults are documented in
[`pi-cache/README.md`](./pi-cache/README.md).

The Apple Music client and AISHub contribution are also compile-time fail-closed for this candidate. Apple Music's
local Edge Function source returns an unavailable response as well, but that server hold must still be proved deployed.
MusicKit capability/profile and signed-device playback also remain unverified. Native NMEA/AIS reception remains
available, but the retired Capacitor 3 UDP bridge has been removed and the beta does not transmit sentences to AISHub.

Guardian and precise community-track sharing are also unavailable in the public beta. Their screens are held in this
client, and the AIS ingest worker's privileged Guardian watchdog is now a strict, default-off
`GUARDIAN_WATCHDOG_ENABLED=true` opt-in. That source hold is not a deployed server security boundary: the worker must be
deployed and verified off, live Guardian RPCs still require an approved hold, and the precise-track hold migration must
be deployed and verified before release. This does not affect a skipper's separate, explicitly enabled public Voyage
Log.

MPA categories are presented only as classes inferred from CAPAD metadata. A feature-gated `MPAs` control in the map's
route/chart tools makes the overlay reachable without presenting it as a tactical danger or activity-permission layer.
The popup tells users to verify current fishing and anchoring rules with the managing authority, labels the overlay as
neither legal advice nor navigation, shows the verified CAPAD snapshot date, preserves tiny positive official areas,
and provides a keyboard-visible 44 px dismiss target that returns focus to the prior control. The layer revalidates
while visible and switches itself off if either data verification or Mapbox style mounting fails. A generation change
drops the old Mapbox source and parsed cache before the replacement asset is downloaded. It must never turn a broad
protection class into a claim that an activity is permitted or prohibited.

### Production deployment boundaries

- The AIS worker is packaged by a multi-stage Node 22 Dockerfile: it installs from its lockfile, compiles to `dist`,
  prunes development dependencies, and runs the compiled entry point as the non-root `node` user. Railway is pinned to
  that Dockerfile and the same compiled start command. This is deterministic source packaging, not proof of a current
  hosted worker.
- Pi first-install and redeploy scripts perform clean lockfile installs, compile, and prune development dependencies.
  The Pi remains outside the public-beta product boundary regardless of that package hygiene.
- The obsolete Railway `vessel-scraper` source is fail-closed: its Docker build and start command exit 78, it has no
  cron, and its inert watch pattern cannot provide a build path. The old external Railway service still has to be
  verified disabled or removed.
- The obsolete CMEMS Mapbox tile-probe and tileset-status workflows remain only as exit-78 tombstones. They have empty
  token permissions and no action, secret, environment, or network path; the immutable release-asset pipeline is the
  only current CMEMS publication path.
- The LINZ/Maritime NZ navigational-warning workflow uses Node 22, its committed lockfile, dependency audit/tree/tests,
  sandboxed Chromium, a strict browser environment allowlist, non-cancelling concurrency, stale/count-collapse bounds,
  and a no-write dry-run path. A real master-branch run against Cloudflare, the configured GitHub secrets, and the live
  `linz_warnings` table is still required.
- Every GitHub Action is pinned to a reviewed 40-character commit with a version comment, every hosted runner is fixed
  to Ubuntu 24.04, and every workflow declares token permissions explicitly. Deno is exact at 2.9.4; supported Node LTS
  majors intentionally receive the latest security patch within their selected major.

> **Candidate status:** this source snapshot is not yet approved for public beta. The fresh unsigned Xcode 26.6 Release
> archive closes local compilation/package evidence only. Exact local/remote migration and Edge Function parity, the
> account-deletion concurrency and retained-identifier blocker (the production UI/service are held fail-closed), final
> CMEMS/MPA trust gates, live LINZ and worker verification, Distribution signing/export, physical-device testing,
> hosted CI/preview, ENC rights, and legal/store gates must all close before it is shippable.

---

## Supabase Edge Functions

The local source tree contains 47 Supabase Edge Function entry points for API-key protection and server-side
computation. The table below describes representative local source, not verified remote deployment:

| Function                                    | Purpose                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `fetch-weatherkit`                          | Apple WeatherKit proxy (requires server-side JWT) |
| `fetch-wind-grid` / `fetch-wind-velocity`   | NOAA GFS wind data (GRIB decoding)                |
| `fetch-precip-grid` / `fetch-pressure-grid` | NOAA precipitation & pressure grids               |
| `proxy-rainbow`                             | Rainbow.ai tile proxy (API key hidden)            |
| `proxy-stormglass`                          | StormGlass marine data proxy                      |
| `proxy-openmeteo`                           | OpenMeteo forecast proxy                          |
| `proxy-tides`                               | Tide prediction proxy                             |
| `route-weather` / `route-bathymetric`       | Server-side route analysis                        |
| `gebco-depth`                               | GEBCO bathymetry depth queries                    |
| `maritime-intel`                            | Maritime news aggregation for ticker              |
| `gemini-diary`                              | Gemini AI ship's log diary entries                |
| `vessels-nearby` / `lookup-vessel`          | AIS vessel data queries                           |
| `send-push` / `send-anchor-alarm`           | Push notification delivery                        |
| `check-weather-alerts`                      | Automated severe weather alert checks             |

Public-beta release requires the live migration ledger and deployed Function inventory to match the frozen reviewed
source exactly. At this snapshot, the community precise-track and Cast Off migrations are local-only; the Guardian
worker's default-off source hold is not deployed or verified and an explicit Guardian RPC hold is not yet approved or
prepared; and remote MusicKit, Float Plan, and account-deletion handlers predate their local boundaries. Three retired
Marketplace handlers also remain remote-only. A green local Function check therefore does not establish backend
release parity.

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
npm run test:coverage

# Run specific suite
npx vitest run -t "AisGuardZone"

# Watch mode
npm run test:watch
```

The 2026-08-05 baseline run covered **733 Vitest files** and reported **6,575 passing assertions**, plus **3 expected
diagnostic failures** from intentional negative-path fixtures. Current CMEMS/MPA and release-profile hardening
supersedes that baseline; record new counts only after the final stable-tree rerun. Test evidence does not close the
backend, native packaging, signing, device, or legal release gates.

A fresh manual Storybook pass also exercised the full Float Plan at 1280 px desktop, 414 × 896 portrait, and 896 × 414
short landscape. It found no horizontal overflow, confirmed 44 px visible actions and channel-specific Email,
WhatsApp, Text, and More payloads, verified crew changes update persons aboard, and confirmed every copy/handoff action
stays disabled until a rescue contact is supplied.

Coverage includes:

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
