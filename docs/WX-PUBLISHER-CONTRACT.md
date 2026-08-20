# wx → Supabase publisher contract

Ruled 2026-08-20: the tailnet wx server never talks to the app. It publishes
into Supabase; phones read Supabase. This file is the complete interface —
the publisher (wx-server repo) is built against it, nothing else.

## Tables (migration `20260820100000_wx_publish_contract`, live in prod)

### `wx_point_forecasts` — publisher WRITES (service role), phones READ
| column | type | meaning |
|---|---|---|
| `cell_id` | text PK₁ | 0.25° cell, SW corner ×100: `'-2725_15300'` = lat −27.25, lon 153.00 |
| `model` | text PK₂ | `dwd_icon`, `ecmwf_ifs025`, `ecmwf_aifs025_single`, `ukmo_global_deterministic_10km`, `jma_gsm`, `spitfire` |
| `run_at` | timestamptz | model-run initialisation time — the forecast's TRUE age; the app's staleness pill reads this |
| `published_at` | timestamptz | defaults `now()` |
| `payload` | jsonb | **Open-Meteo-response-shaped**: `{ current: {...}, hourly: { time: [...], temperature_2m: [...], ... }, daily: {...}, utc_offset_seconds, ... }` — the app parses it with the same code that parses the live API, so match the field names of `GET /v1/forecast` exactly |

Rules:
- Upsert on `(cell_id, model)` **only when a new run lands** — never rewrite an
  unchanged forecast (the app DB is a Micro; see the AIS-worker incident).
- Rows older than 48 h are swept hourly (`sweep-wx-publish` cron). The app
  ignores rows whose `run_at` is >24 h old, so publish at least twice a day
  per model or the row goes unused.
- Spitfire: publish only for cells inside its domain. Absence of a row IS the
  availability signal — the app's model picker offers exactly the models that
  have fresh rows for the boat's cell. No geography lives in the app.

### `wx_subscriptions` — phones WRITE, publisher READS (service role)
| column | type | meaning |
|---|---|---|
| `cell_id` | text PK | same format |
| `last_seen_at` | timestamptz | refreshed by any phone in the cell (≥6 h apart) |

Publisher loop: `select cell_id from wx_subscriptions where last_seen_at > now() - interval '3 days'`
→ compute the six models per cell → upsert forecasts. Cells idle 14 days are
swept. Coverage follows the fleet with no configuration.

## Credentials
The publisher uses the project's **service-role key** (Shane holds it; never
in a repo). URL + key as env vars on the wx server, same pattern as the AIS
worker's `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.

## What the app already does (live as of `4a17815d`+)
- Announces its cell (change-detected, anonymous) on every weather fetch
- Prefers a fresh published row for pinned models; falls back to the
  commercial proxy when absent — so the publisher can come up incrementally,
  cell by cell, model by model, and the app just gets faster
