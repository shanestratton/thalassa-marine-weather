# 137-03 / 137-04 — held weather watch

This packet prepares source; it does not enable a cron, acquire provider data,
send a push, claim a locked-phone test or provision a provider account.

## Current behavior

- All four opt-ins default off and are scoped to an explicitly selected owned
  vessel. Crew membership alone cannot configure or read the private watch.
- The Alerts controls require the deployed function **and** delivery guard
  versions, independently reviewed provider permission/entitlement with an
  expiry, a matching active cron command/schedule with a recent successful job,
  and the function's own fresh successful completion heartbeat. A table or key
  alone leaves them hidden. An over-capacity/failed run clears its heartbeat.
- The initial profile carries at most 16 explicitly authorized point samples.
  Boat samples preserve the actual instrument position clock and expire after
  15 minutes; phone position and account-wide Guardian data are not substituted.
  Route snapshots contain at most eight coordinates, expire after 48 hours and
  say that gaps are unchecked. Saved spots expire after 30 days. A route change
  requires registration again; this packet does not pretend a snapshot is a live
  following service. Only coordinate samples cross the seam: no full encoded
  route, chart objects, depths, marks, grades or licensed chart evidence.
- Morning/convective checks reuse the existing `wx2:` point publications. No
  paid Open-Meteo fan-out is added. The strict subset checks original run,
  source domains, model/cell identity, UTC axes and units. A coarse 0.25° sea
  cell is always described as such. Missing CAPE/LI/CIN/gust/code stays unknown.
- Storm/gust pushes require two distinct ECMWF/ICON/UKMO members in the same
  three-hour window as 129-07. UKMO is counted/named, never numerically quoted
  or included in numeric derivatives. CAPE alone cannot trigger a storm push.
  Display bands are a conservative app heuristic, higher in the tropics, not
  an official severe-weather scale. Every CAPE phrase carries the thunder count.
- Cached official matching and actual per-owner delivery receipts reuse 129-07's
  classifier/cover policy. A merely matched but not delivered warning suppresses
  nothing. Morning text puts a known official warning first; an absent/failed
  feed says unverified, never all-clear. No extra official-provider fetch occurs.
- Rain uses only the existing fixed Rainbow global-nowcast endpoint and server
  key name. Current public OpenAPI specifies numeric mm/h, Unix-second interval
  bounds, response coordinates and precipitation type. A fresh current dry
  interval followed by two contiguous rainy/mixed intervals within 30 minutes
  qualifies. Snow, null/blank rates, another point, gaps, already-wet/stale data
  do not become “rain arriving”. No lightning claim is made.
- All new notices use the existing ordinary `weather_alert` priority. Anchor,
  AIS/collision/distress priorities are unchanged. The sender rechecks original
  queue receipt, owner, current configuration revision, opt-in and sample expiry
  before each APNs attempt. False retires; unavailable retries, without sending.
- One atomic database claim inserts both queue and receipt. Vessel quotas are
  one morning per local day, rain once per two hours/max six per 24h, and each
  of storm/gust once per three hours/max four per 24h. Independent account caps
  are ten mornings, twelve rain, eight storm and eight gust
  per 24h (the morning cap permits the next day at a 23-hour DST transition).
  Receipt retention is 32 days. Quotas never consume another alarm family's budget.
- A morning tap validates the fixed typed handoff and opens a separate briefing
  page for the exact owned registration. It cannot reuse another dashboard
  point's official warnings or silently replace a revised registration. The card
  reads the latest cache and explicitly labels its run and original position
  clock; it is not a reconstruction of the historic push. Text share uses the
  same deterministic briefing object. The Warnings page also has an optional
  source/policy-gated cache card; Satellite Mode adds no background WAN reader.
- The existing desk wind comparison now shows peak gust spread from the same
  loaded day/window, requiring two complete comparable members and excluding
  display-only/UKMO numeric derivatives. It makes no extra model request.

## Actual gaps before activation

1. **Vessel-bound position publisher/registration is still required.** A 15-minute
   explicit sample cannot honestly provide overnight/closed-phone morning or
   moving-boat rain coverage. Do not alias account-only Guardian to a vessel.
   The next packet investigates the existing `pi_diary_relays.boat_id` binding.
2. The original 130-08 composer/card did not exist. This adds a deterministic
   foundation accepting already-computed Plan Your Day words, explicit source
   clocks, tides/datum/navigation permission and civil light. The scheduled
   cached-weather path has no full day-plan/tide/light input and says unknown.
   Broad retirement of legacy advisory prose and Calypso/TTS integration remains
   separate; do not claim that missing prerequisite was previously delivered.
3. No Rainbow account permission/entitlement or key availability was inspected
   or verified. No provider call was made. `RAINBOW_API_KEY` presence alone is
   insufficient. Permission to use nowcast for scheduled push needs verification.
4. No live backend deployment or cron activation occurred. Exact bundle readback,
   provider permission proof, sender readback and scheduled heartbeat must all
   precede opt-in exposure. Delivery to a locked phone remains a real-device check.
5. The initial runner is bounded at 160 profiles/256 cached cells/45 seconds.
   Exceeding a bound is explicitly unhealthy. Review rollout size and add sharding
   before exceeding it; never silently omit the tail while reporting readiness.
6. Isolated SQL behavior is not a PostgreSQL transaction-race proof. Run the
   prepared CAS/quota cases on disposable PostgreSQL 17.6 before activation.

## Primary references checked 2026-10-16 UTC

- [Rainbow current API documentation](https://doc.rainbow.ai/) and its
  [published OpenAPI](https://doc.rainbow.ai/api-ref/api.fixed.json): fixed
  `/nowcast/v1/precip-global/{longitude}/{latitude}`, header
  `Ocp-Apim-Subscription-Key`, no URL token, four-hour forecast with explicit
  numeric interval units. This is API documentation, not entitlement evidence.
- [Open-Meteo forecast documentation](https://open-meteo.com/en/docs): per-model
  variable availability and units; existing publisher rows are reused. LI/CIN
  are not in the actual publisher contract and remain unknown.
- [NWS convective parameters](https://www.weather.gov/lmk/indices): CAPE describes
  available parcel energy, while inhibition/moisture/forcing affect initiation;
  an index is not storm occurrence, lightning detection or a severity forecast.
- [Supabase Cron](https://supabase.com/docs/guides/cron): jobs and run history
  are separate; an enqueued HTTP request alone is not a successful function run.
  The [changelog](https://supabase.com/changelog.md) was checked; no unrelated
  SDK/platform migration is part of this packet.

## Validation / activation packet

`supabase/tests/weather-watch-db.mjs` runs only against an explicitly supplied
outside-repository PGlite installation. It checks owner isolation, forged bodies,
direct-write refusal, stale CAS, opt-out/owner-transfer retirement, independent
quotas and false readiness from an unrelated cron command. It creates no product
rows and sends no notification. Real PostgreSQL concurrency proof is still owed.

`supabase/held-crons/weather-watch.sql` is deliberately outside migrations and
requires an explicit review setting, existing Vault invocation helper, prior
entitlement/delivery proof and no pre-existing jobs. It never resumes a paused job.
The quarter-hour morning cadence reaches :00 in current half/quarter-hour IANA
zones; each vessel is checked only in the first ten minutes of its chosen hour.
DST's repeated hour is deduplicated by the local calendar date.

First source checkpoint proof: 70 focused app checks across seven suites; 28
Deno behavior checks including the existing sender configuration/wake guards;
28 isolated PGlite ACL/behavior checks; full app TypeScript; scoped ESLint and
Deno formatting/type checks. Actual Chrome and WebKit at 300/375 px passed all
four explicit-opt-in/sample/CAS/save/layout cases against a synthetic REST
origin, with zero provider requests. Screenshots were inspected; native Safari
select styling was corrected to keep the saved-place/hour controls readable.
These are source/browser/isolated-database proofs, not live provider entitlement,
scheduled operation, PostgreSQL concurrency or locked-phone delivery proof.

Before any combined sender deployment, merge the root's later wake source and
preserve its exact guards. This branch started from the frozen 94e15 weather
isolation base; it must not overwrite newer live wake fixes with an older bundle.
