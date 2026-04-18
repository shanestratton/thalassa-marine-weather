# Infrastructure

A map of what Thalassa runs and where, so future-us doesn't pay for
workers we forgot about. Treat this as the source of truth for anything
that isn't the React app itself.

## At a glance

| Component              | Host            | Why it lives there                         |
| ---------------------- | --------------- | ------------------------------------------ |
| Web + PWA              | Vercel          | Static Vite build + edge rewrites          |
| Capacitor iOS/Android  | App stores      | Native shell around the same bundle        |
| Backend DB + Auth      | Supabase        | Postgres + RLS + `pg_cron`                 |
| Edge functions         | Supabase (Deno) | Short-lived request/response and cron jobs |
| AIS ingest (always-on) | Railway         | Persistent WebSocket to aisstream.io       |
| Pi cache (optional)    | Self-hosted Pi  | Chart tiles + grib cache when onboard      |

## Railway workers

One worker, one reason. Railway is the home for anything that needs a
long-lived process — chiefly an open WebSocket.

### `workers/ais-ingest` — keep on Railway

- **Why Railway:** holds an always-on WebSocket to aisstream.io and
  batches position updates into Postgres. Serverless edge functions
  can't hold a socket open, so this one stays.
- **Shape:** Node + TypeScript, `/health` endpoint, `restartPolicyType =
"ON_FAILURE"` with 10 retries.
- **Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `AISSTREAM_API_KEY`.

### `vessel-scraper` — DEPRECATED (migrated to Supabase)

- **Status:** migrated 2026-04-18 to `supabase/functions/scrape-vessel-metadata`.
- **Keep the directory** in the repo short-term as a reference; stop the
  Railway service once the new edge function's first successful run
  shows up in the `vessel_metadata` table. Delete the directory after
  one full week of clean cron runs.

## Supabase edge functions

Short request/response work and scheduled jobs. Full list in
`supabase/functions/`. Notable crons scheduled via `pg_cron` +
`net.http_post` (see `supabase/migrations/*cron*.sql`):

| Function                 | Schedule     | Purpose                              |
| ------------------------ | ------------ | ------------------------------------ |
| `check-weather-alerts`   | every 30 min | Push notifs for wind/wave thresholds |
| `sweep-stale-vessels`    | every 6 h    | Drop vessels not seen in 24 h        |
| `scrape-vessel-metadata` | every 15 min | Two-phase AIS seed + registry scrape |
| `sweep-expired-escrows`  | daily        | Marketplace housekeeping             |

Edge functions hard-cap at ~150 s wall-clock. `scrape-vessel-metadata`
processes 30 external lookups per run (down from 50 on Railway) to
stay under that ceiling while preserving per-source rate limits.

## Pi cache (optional, user-run)

When the user runs `pi-cache/` on a boat Pi it serves as a local
chart-tile and grib cache. Client auto-discovers and routes through it
via the dedicated `/pi` endpoint — see `968c670 fix(pi-cache)`.

## Environment variables

Supabase edge functions read from the Supabase dashboard (`Functions →
Settings → Secrets`), not from a committed file. Railway reads from
its own dashboard. Keep these aligned:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (edge fns) / `SUPABASE_SERVICE_KEY` (Railway legacy name)
- `AISSTREAM_API_KEY` — Railway only
- `AMSA_API_URL`, `USCG_API_URL`, `EQUASIS_USER`, `EQUASIS_PASS`, `GFW_API_KEY`,
  `ITU_MARS_URL` — scraper-only overrides; optional, have sensible defaults

## Operating rules

- **Default to Supabase edge functions.** They're on-platform, cheap,
  and have pg_cron + service-role auth baked in.
- **Only reach for Railway** when you genuinely need a long-lived
  process (WebSockets, raw TCP, something that can't fit in 150 s).
- When adding a new scheduled job, write the cron in a migration under
  `supabase/migrations/` so it's reproducible. Copy the shape from
  `20260418120000_scrape_vessel_metadata_cron.sql`.
