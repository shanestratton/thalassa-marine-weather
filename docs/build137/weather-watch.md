# 137-03 / 137-04 — weather watch, activation held

The database groundwork is deployed at actual ledgers20261016191458 and20261016191504, with exact SQL bytes from the21-check real PostgreSQL proof. The source files now live under `supabase/migrations` with those ledger names. Five tables have RLS; profiles, registrations, positions and deliveries are empty. All four health rows have function/delivery version0, no entitlement lease and no heartbeat; no matching worker cron is active. Provider, worker and opt-in activation remains held.

## Current behavior

- All four opt-ins default off and are scoped to an explicitly selected owned
  vessel. Crew membership alone cannot configure or read the private watch.
- The Alerts controls require the deployed function **and** delivery guard
  versions, independently reviewed provider permission/entitlement with an
  expiry, a matching active cron command/schedule with a recent successful job,
  and the function's own fresh successful completion heartbeat. A table or key
  alone leaves them hidden. An over-capacity/failed run clears its heartbeat.
- The profile carries at most 16 explicitly authorized point samples. Overnight
  boat checks instead require a separate owner-authorized Pi source registration,
  the authoritative `pi_diary_relays.boat_id` stamp and a fresh matching position
  proof. Phone position, account-selected telemetry and Guardian are never substituted.
  Route snapshots contain at most eight coordinates, expire after 48 hours and
  say that gaps are unchecked. Saved spots expire after 30 days. A route change
  requires registration again; this packet does not pretend a snapshot is a live
  following service. Only coordinate samples cross the seam: no full encoded
  route, chart objects, depths, marks, grades or licensed chart evidence.
- Morning/convective checks reuse the existing `wx2:` point publications. No
  paid Open-Meteo fan-out is added. The worker refreshes only the explicitly
  authorized anonymous 0.25° interests through existing `announce_wx_cell`;
  the existing wx publisher supplies new cells while the phone is closed.
  Cache misses stay unknown until that publisher has produced actual data.
  The strict subset checks original run,
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

1. **The position closure below is prepared, with no live installation.** Its
   fixed Pi read must be mounted/classified, included in the reviewed update,
   deployed with the optional telemetry handler and both held migrations, and
   verified against an explicitly consenting owned test vessel before claiming
   actual closed-phone position coverage. No vessel is registered by this packet.
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
5. The runner is bounded at 160 profiles/256 cached cells/30 seconds of work,
   reserving the rest of the existing 55-second invocation for bounded in-flight
   responses and the final heartbeat. Database responses have five-second bounds,
   Rainbow fifteen. It checks the deadline before any subsequent queue claim.
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
- [PostgreSQL17 schema privileges](https://www.postgresql.org/docs/17/ddl-schemas.html):
  schema usage and per-object privileges are independent. Weather's private
  functions use a dedicated schema rather than broadening a shared namespace.

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

## Vessel-bound position closure

`GET /api/weather-watch/position-source` accepts no query/body. It runs behind
the existing app gate and independently requires a currently enrolled phone on
physical boat LAN, including device observe mode. Its callback reads only the
authenticated Signal K read-session cache. It returns version1, server-owned
owner/Pi/relay identity,
SHA-256 self/selected-source keys, an original-clock position and the catalogue
time. No source URL, credential, raw self UUID or arbitrary Signal K path crosses
the seam. Missing `$source`, a parent-only clock, a future/older-than13s fix,
unpaired Pi, changed enrollment/pairing, tailnet peer or unavailable cache refuses.
The route copies the registered owner/Pi/relay tuple before the first enrollment
await and checks it again after the cache and final enrollment waits. The phone
admits it only for the current account and exact selected Pi/pin. A registration
uses the same frozen reviewed source object and rechecks account, pin, LAN and
enrollment; account or pair replacement cannot offer or register the prior source.
The fixed schema admits genuine `(0,0)` positions.

The owner explicitly reviews this local source and saves
`configure_weather_position(boat,expected,relayId,selfKey,sourceKey,enabled)`.
The server checks the live boat owner and persistent relay hull stamp, takes the
same boat transaction lock as watch claims and performs CAS. A changed source,
self or relay needs a new explicit registration. Configured is distinct from
fresh: every registration starts without a position receipt. Source sharing can
be allowed while all four forecast opt-ins remain off. A Stop action changes its
revision and retires existing receipts/queued notices; it never silently retries.

The already-running policy-controlled telemetry POST learns a bounded ten-minute
`weather_position_request` only when sharing is enabled for that exact relay.
Its next normal request may include `weather_position_v1` from the authenticated
cached selected leaf. It adds no WAN request and no telemetry scalar. The
40-key/4KiB extra contract and16KiB full body remain unchanged: optional proof is
dropped if it does not fit; an already oversized base body is refused. Response
JSON is streamed to a2KiB bound and a two-second read timeout. Policy, stop,
credential or source changes retire cached consent. Legacy gauges are preserved;
a genuine GPS-only `(0,0)` source can send a minimal original-clock heartbeat
with unknown legacy coordinates while its separate qualified proof remains valid.

`telemetry-relay` authenticates the existing relay credential and stores the
legacy reading first. Its optional1.5s receipt RPC uses the persistent hull
binding, not `user_active_vessels`, and validates source/revision/owner plus the
original fix clock again. Missing/changed/unqualified proof removes readiness;
an older valid same-source packet cannot overwrite a newer position. Repeated
samples keep their original time. Only the registered receipt (up to15minutes
old) feeds boat work. Timezone comes from the validated point via the existing
pinned tz-lookup version. This15minute limit is weather-location tolerance,
not authority for an onboard alarm, navigation, steering or a fresh gauge.

Both held SQL files must be released together **in filename order**, before the
new telemetry/worker code. The first's claim/work/delivery definitions require
the second's helpers/columns. All new private objects use dedicated
`private_weather_watch`, with exact function ACLs, no phone table grants and RLS;
no shared private-schema privilege is broadened. Claims and every APNs attempt
check the exact position registration again. A morning handoff carries only its
registration revision; the card reads the matching owned current position,
labels its clock and refuses a different/stale registration.

Root integration (no new credentials/environment variables):

```ts
import { createWeatherPositionRoutes } from './routes/weatherPosition.js';
// Inside the existing APP_API_ENABLED block:
app.use(
    '/api/weather-watch',
    requireAppApi,
    createWeatherPositionRoutes({
        devices: chartDevices,
        selfDocument, // existing authenticated cache-only callback; no fallback
        identity: () => {
            const registered = diaryRelayOutbox.getConfiguration();
            return registered.ownerId && registered.relayId
                ? { ownerId: registered.ownerId, piDeviceId: identity.deviceId, relayId: registered.relayId }
                : null;
        },
    }),
);
// piCommandLock's exact read table:
// ['GET /api/weather-watch/position-source', 'read']
```

The guarded Pi source bundle needs `src/weatherPosition.ts`,
`src/weatherPositionWire.ts`, `src/routes/weatherPosition.ts` and the revised
`src/telemetryPublisher.ts`, besides their existing dependencies. Run
`node pi-cache/scripts/sync-weather-position.mjs --check` before bundling; the
canonical app wire is dependency-free and type-checked without Node/Pi files.
This packet deliberately does not edit server mounts, command classifications,
stage scripts, native versions or deployed source.

Position follow-up proof:78 focused app checks plus two actual portable-wire
compile/mirror checks;28 Pi legacy/optional-proof/actual-mounted-router checks;
22 Deno checks;49 isolated SQL behavior/ACL checks; app and Pi full TypeScript;
four actual Chrome/WebKit300/375 browser cases with inspected screenshots.
The separate `supabase/tests/weather-watch-postgres.mjs` passed against the exact
92f8e1cf source on actual PostgreSQL17.6 (run38935427858):21 checks,16 parallel
transactions per feature, two competing source binds, nine account contenders,
zero product-database writes and zero notifications. Its immutable deployment
proof receipt is saved outside Git. The runner requires an explicitly opted-in
empty localhost `weather137_test` database
on PostgreSQL17.6 and a supplied outside-repository node-postgres module. It
checks16 competing transactions per feature, cross-boat account quotas, source
CAS, a verified blocking old-proof/source-replacement race, newer-clock retention
and relay/owner retirement. No provider, webhook or sender exists in its fixture.
This proves database lock behavior, not provider entitlement, scheduled operation
or locked-phone delivery. The owner-envelope follow-up adds16 focused app/wire
checks and38 Pi/legacy telemetry checks, including nine actual mounted handler
ownership changes across the three asynchronous boundaries.

The root integration now mounts this cache-only read behind requireAppApi, its physical boat-LAN and enrolled-device checks, and the chart command-lock classification. Disabling the app API also disables this prefix. Update7 requires the revised telemetry publisher, owner-bound source reader, checked portable mirror, router and sync helper, and refuses missing modules before staging. Full Pi TypeScript, the exact route inventory/lock checks and all eight updater fixtures pass after mounting. This does not enable position sharing, schedule a worker or send a notification.
