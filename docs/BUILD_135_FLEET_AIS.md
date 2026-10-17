# Build 135-04: bounded fleet AIS

The prepared worker follows active Thalassa areas worldwide using bounded rotating
rectangles. One persisted database claim is shared by every replica. There is no
per-boat provider timer, global rectangle or parallel provider fetch. The new
service remains held until deployment and display rights are reviewed.

## Limits and honest coverage

- A normal completed poll starts a 61 second database cooldown. An abandoned claim
  consumes three minutes; its lease expires after two. The worker rejects a claim
  whose local round trip exceeded five seconds, and has a 25 second streamed-body
  deadline, redirect rejection and a 1 MiB body cap. The provider key stays in the
  worker. The old uncoordinated poller has been removed.
- At most 64 active coarse centres are read before box planning. A centre is
  rounded to a quarter degree. Padding covers that rounding; rectangles split at
  the dateline and into widths of at most 16 degrees, including polar areas.
  Each centre creates at most 24 boxes. Only one box is fetched per claim and
  receives at most 500 decoded rows. Nearby API queries cap at 200 NM and 500 rows.
- A map centre is polled or queued. A successful centre poll is **not proof that
  its entire 200 NM circle is covered**. Busy boxes truncate; ships outside the
  first 500 rows may be absent. At the cap of 64 widely separated active centres,
  a single provider request per minute cannot refresh all regions inside the
  fifteen minute age window. Polar splitting increases that delay. The UI says
  partial/sparse, queued, held, unavailable or stale, and never claims complete
  global or satellite coverage.
- Phone viewport interest is one coarse row per account, updated at most once
  every five minutes. Fresh Pi telemetry also contributes coarse interests.
  Selection has bounded indexed source reads. Interest retention is one hour;
  fresh coverage retention is fifteen minutes and at most 256 receipts; expired
  vessel rows are removed in bounded batches after 24 hours. No fleet positions,
  provider keys or boat recordings are in the new fixtures.
- Actual position observation time is preserved separately from database write
  time. No legacy timestamps are backfilled as observations. Rows older than
  fifteen minutes are absent from the nearby endpoint. A static update cannot
  renew a position's age. Draught and yearless UTC ETA travel only when static
  values change. Repeated stationary packets are filtered in memory and again
  transactionally in Postgres, so worker restarts do not reset write protection.
- The persisted upper bounds are 20,000 changed vessel writes/day and 1,000/hour,
  shared by legacy and new writers. Limits can be lowered, never raised above
  those ceilings through configuration. A partial batch is labelled limited;
  its unsaved static values are not marked saved by the worker. These ceilings
  are a cost check, not measured future IO: applying the historic approximately
  6.8 blocks/write to 20,000 writes is roughly 1.1 GB/day before other database
  work. Actual index/WAL amplification must be measured after reviewed activation.

## Receiver and Internet separation

Internet transport always stays `cloud`, including another boat's relayed radio.
The app normalizer forces informational mode. Internet targets do not enter the
phone's collision/guard alarm grading; the popup does not offer Internet-derived
CPA risk. Positioned 970/972/974 beacons and fresh message 14 evidence use the shared
distress classifier but stay silent and carry actual report age. Tests never
sound. This boat's own receiver keeps its existing local alarms and precedence.

Message 14 without a transmitter position is stored without a fake coordinate.
It appears in the phone's nearby Internet picture only when joined to a real
position. There is no unbounded worldwide unlocated-beacon endpoint, and the
receiving boat's centre is never substituted for the transmitter's location.
The own-receiver unlocated distress path continues to show its explicit unknown
position. This is a documented limit of 135-04, not complete unlocated relay delivery.

The compact map credit remains visible when the chart key is collapsed; Targets
and the full key show coverage and the informational/no-navigation/no-siren limit.

## Rights and activation hold

Primary sources checked on 16 October 2026:

- [AISHub API](https://www.aishub.net/api): maximum one request/minute;
  bounded latitude/longitude arguments and a last-known-state timestamp.
- [AISHub terms, updated 8 October 2026](https://www.aishub.net/terms): the display
  provision and linked `Data: AISHub contributors` credit are distinct from the
  prohibition on redistribution of raw messages, positions and tracks, and the
  prohibition on navigation/safety use. Existing member transition is listed as
  1 January 2027; new members use the new terms immediately.
- The older recorded public-display permission in
  `20260905103000_public_ais_permission_recorded.sql` is not evidence of permission
  for navigation, alarms, or a bulk raw-position endpoint.

`ais_fleet_control.enabled` defaults false and a nonempty reviewed
`licence_reference` is also required. A string in that field is an operator audit
reference, **not legal permission by itself**. Root must review app display versus
the transport endpoint's raw-position semantics and obtain any missing written
permission before activation. Do not reuse this data for navigation decisions.
No production provider polling, database change or Railway/Edge deployment was
performed while preparing this feature.

## Exact deployment sequence for review

1. Freeze and validate the whole 135 candidate, including app/worker tests, Deno
   handler checks, build budget, isolated PostGIS replay/concurrency, and native
   release gates. Record the exact source SHA and deployment artifacts.
2. Audit all consumers of the provider credential; stop every old aggregate
   poller/replica first. A service outside this shared claim cannot be rate limited
   by our database. Leave the licence gate false. Do not enable a global legacy
   AISStream socket as a fallback.
3. Apply the additive migration with the gate false. Existing merge RPC writers
   now share the persisted write cap; old nearby callers inherit the hold and
   freshness filter. No observation-time backfill is performed.
4. Deploy the matching `vessels-nearby` Edge entry and worker from that same
   validated SHA. The worker requires `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and,
   eventually, `AISHUB_API_KEY`. Missing claim service means no provider request.
   Edge needs its existing server role key; no browser gets that credential.
5. Verify held health/empty held response first. Review the primary terms and
   endpoint transport rights. Only after root approval, write the reviewed
   licence reference and enable the gate. This is a separate production action.
6. Observe shared claim/receipt state, bytes, accepted rows, skipped writes,
   `budgetLimited`, position ages and actual disk/WAL metrics for a week. Stop
   immediately if another credential consumer or write amplification defeats the
   intended ceiling. A green synthetic replay is not live-cost evidence.

Rollback: set the gate false first, stop the provider worker, retain the additive
schema and bounded legacy merge wrapper. Do not restore the uncoordinated poller
or remove write protection to recover coverage. Preserve own-receiver operation.

## Evidence

The SQL-only checkpoint is `af8a4c8df971b56e04dae00258384c4ec0c0307f`.
Isolated GitHub PostGIS workflow 38870158245 passed its real migration replay and
sixteen independent connection claim race. No production rows or keys were used.
From an empty disposable PostGIS database, with synthetic `PG*` environment:

```sh
psql -X -v ON_ERROR_STOP=1 -f tests/sql/ais-fleet-replay.sql
node tests/sql/ais-fleet-concurrency.mjs
```

The Deno handler test imports the actual Edge entry, intercepts every transport
and refuses unexpected hosts. It verifies auth/quota ordering, the held gate,
200 NM/500 row bounds, actual observation age and malformed/stale/oversized rows:

```sh
deno test --cached-only --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY supabase/functions/vessels-nearby/index.test.ts
```

Worker and app fixtures are generated/fictional. Local browser checks exercise
the real target sheet and compact credit at 300/375 pixels in Chrome and WebKit,
with external traffic blocked. Release-wide validation and reviewed live-cost
monitoring remain separate from these scoped proofs.

Scoped checkpoint proof: 651 app AIS/collision/distress tests; 159 worker tests
and standalone worker TypeScript; five actual Edge handler tests with Deno type
checking and lint; four real browser checks; full shared app TypeScript; 218-file
migration audit. Owned formatting and ESLint pass (three existing MapHub warnings).
