# wx → Supabase publisher contract

Ruled 2026-08-20: the tailnet wx server never talks to the app. It publishes
into Supabase; phones read Supabase. This file is the complete interface —
the publisher (wx-server repo) is built against it, nothing else.

## Tables (migration `20260820100000_wx_publish_contract`, live in prod)

### `wx_point_forecasts` — publisher WRITES (service role), phones READ

| column         | type        | meaning                                                                                                                                                                                                                                                                  |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cell_id`      | text PK₁    | 0.25° cell, SW corner ×100: `'-2725_15300'` = lat −27.25, lon 153.00                                                                                                                                                                                                     |
| `model`        | text PK₂    | `dwd_icon`, `ecmwf_ifs025`, `ecmwf_aifs025_single`, `ukmo_global_deterministic_10km`, `jma_gsm`, `spitfire`                                                                                                                                                              |
| `run_at`       | timestamptz | model-run initialisation time — the forecast's TRUE age; the app's staleness pill reads this                                                                                                                                                                             |
| `published_at` | timestamptz | defaults `now()`                                                                                                                                                                                                                                                         |
| `payload`      | jsonb       | **Open-Meteo-response-shaped**: `{ current: {...}, hourly: { time: [...], temperature_2m: [...], ... }, daily: {...}, utc_offset_seconds, ... }` — the app parses it with the same code that parses the live API, so match the field names of `GET /v1/forecast` exactly |

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

| column         | type        | meaning                                         |
| -------------- | ----------- | ----------------------------------------------- |
| `cell_id`      | text PK     | same format                                     |
| `last_seen_at` | timestamptz | refreshed by any phone in the cell (≥6 h apart) |

Publisher loop: `select cell_id from wx_subscriptions where last_seen_at > now() - interval '3 days'`
→ compute the six models per cell → upsert forecasts. Cells idle 14 days are
swept. Coverage follows the fleet with no configuration.

## Credentials

As deployed 16 October 2026, the service-role credential stays in the
`wx-publisher` Edge runtime. wx has a dedicated random 256-bit token in its
root-owned 0600 `/etc/thalassa/wx-point-publisher.env`; source contains only
its public SHA256 verifier. Work pages expose coarse cells/run versions;
validated publications are limited to six actual models and active cells.
No service-role credential is exported to wx.

## Version 2 rows (build134)

Database model keys are `wx2:<actual-domain>` for IFS025, AIFS025, ICON,
UKMO10km, JMA and GFS seamless. API/provenance model IDs remain raw actual
domains. Builds132/133 do not consume these namespaced rows, preserving their
existing fallback. Build134 maps only the six approved aliases; fine IFS9km
and regional capabilities retain separate exact-point validation.

`thalassa_provenance` records version2, source wx, sea selection, cell ID,
0.25° cell-centre query, raw model identity, actual source domains/runs and
horizons. GFS age is the oldest GFS013/GFS025 run. Returned model grid
coordinates are separate from the query centre; this does not certify the
boat's exact coastal point. UI identifies the source/coarse sampling and shows
true model-run age.

Changed runs alone are written. The phone projects current values from the
current UTC hourly slot, trims hourly/daily axes together after midnight, and
reprojects its memo at each UTC hour boundary. Null gusts/diagnostics remain
missing. Marine data is requested in UTC for this path and matched by valid
hour; daily wave maxima require 24 actual hourly heights. Invalid identity,
age, axes, units, horizon or physical values fall through to the existing proxy.

## What the app already does (live as of `4a17815d`+)

- Announces its cell (change-detected, anonymous) on every weather fetch
- Prefers a fresh published row for pinned models; falls back to the
  commercial proxy when absent — so the publisher can come up incrementally,
  cell by cell, model by model, and the app just gets faster
