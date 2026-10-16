# 137-07 — buddy boats, held source

Live deployment requires the complete135 fleet AIS prerequisite, `supabase/migrations/20261016072703_ais_fleet_budget.sql`, plus its reviewed ingestor. A live metadata preflight found that it has not been deployed: `ais_fleet_control`, measured `position_at` and `data_source` are unavailable. The fixture models that prerequisite; it does not authorize adding two isolated columns. The complete migration also changes legacy merge/nearby permissions and budget behavior, so it remains held with the existing AIS display/transport rights review. No legacy `updated_at` value is backfilled as a measurement clock and no old row is labelled AISHub. Buddy SQL, producer and cron are undeployed.

Targets has a lazy Follow action for real AIS vessel identities, including a
proven AIS/radar association, and a Buddy boats list. Radar-only contacts and
distress beacons cannot become invented MMSIs. The list is private to the
selected vessel's owner; at most ten follows exist across an account. Adding a
follow always starts off. A different owner's account or hull retires pending
reads and hides prior private fields immediately. Satellite Mode makes no WAN
list or save request. This is an informational convenience, not a check-in,
navigation, collision or rescue service.

Optional owner-chosen circles accept a point, label and radius0.2–50NM. They
mean entered/left that circle in available AIS reports, not verified port
arrival. The database alone computes geodesic distance through its installed
PostGIS extension; no provider coordinate leaves the service-only adapter.
Both circle crossings and movement need distinct original reports sustained
for two minutes. Circle boundaries have10% hysteresis; moving uses at least2kt,
stopped at most0.5kt. AIS anchored/moored status needs the low-speed report and
is described exactly as reported. Unknown/intermediate values interrupt the
candidate. Missing/stale/future/repeated/out-of-order evidence never confirms a
movement or arrival. A first observation or recovery after a gap establishes a
new baseline without a catch-up notice.

The worker reads **only** existing `vessels` rows stamped `aishub`, using their
original `position_at`, and never requests a provider, expands fleet interests,
opens another socket or stores track history. It keeps one latest state per
follow. After a previously observed report ages beyond15minutes, at most one
notice says not seen in available coverage, current position unknown. It makes
no claim that the transmitter stopped or the boat is in distress. User labels,
not provider names, appear in fixed server-generated notice text, accompanied by
the original report's UTC minute. Positions, raw frames, route/chart data and
provider credentials are absent from notice data and owner list responses.

`20261016171547_buddy_watch.sql` remains in held migrations. Owner reads and
configuration use fixed RPCs; direct writes, foreign boat access and private
state/credential reads are denied. Configuration/removal uses owner-wide lock,
exact revision CAS and live, unarchived boat ownership. Source changes reset the one latest
state. Apply checks current configuration, state revision and the exact cached
facts again under the watch row lock. One atomic transaction updates the latest
state, consumes an independent owner quota and creates the queue row. The caps
are12 notices/owner/UTCday and one/watch/30minutes. No existing alarm budget or
priority is changed. No append-only buddy history table is created.

The cache reader has32-row ordered pages and eight pages/16seconds of work,
with4second database response/body bounds and128KB maximum responses. A tail,
error, malformed evidence, failed commit response or deadline clears the
function heartbeat. A complete sweep supports at most255 armed follows globally
within this first bounded deployment; larger rollouts need reviewed sharding.
Exactly256 rows fail closed because the next empty page has not been proven.
Capacity or source loss cannot report healthy complete coverage.

## Rights and activation prerequisites

Primary [AISHub terms](https://www.aishub.net/terms), checked16October2026, permit
credited derived work but prohibit raw redistribution and navigation/safety
decisions. The [API](https://www.aishub.net/api) permits at most one request per
minute and supplies the original report time. The existing fleet licence hold
remains unchanged. Buddy notices have a **separate** default-off reviewed-rights
gate with a required expiry; a database string or a present key is not permission.
The phone credits [Data: AISHub contributors](https://www.aishub.net).

Before activation, root must review/apply this migration, prove the actual
PostGIS distance adapter and PostgreSQL concurrent CAS/quota cases, verify the
deployed fixed `buddy-watch` function and the separately reviewed sender source.
The composed `buddy_notice` sender calls `createBuddyDeliveryGuard` before token
lookup and before **each** APNs attempt through `buddy_notice_delivery(queueId)`.
It uses passive, silent delivery and a separate buddy thread/collapse identity.
Queue rows expire after30minutes and APNs cannot store a notice for later
delivery; no critical/time-sensitive setting is used. The SQL
guard rechecks current owner/boat/configuration, source/delivery rights, receipt,
original report and latest state. Opt-out/removal/transfer or a newer assessment
retires an old queued notice. Delivery outages remain retryable; false retires.
This sender source is integrated and tested but has not been deployed. The live
sender and all buddy activation gates remain unchanged.

The exact cron command/schedule, a successful recent full function sweep,
deployed function version and separately reviewed sender version must all prove
ready before an owner can enable notices. `held-crons/buddy-watch.sql` is a
manual review packet using the existing Vault invocation helper. It neither
populates rights nor resumes/replaces an existing job. No provider purchase,
poller activation, migration, cron or notification is performed here.

## Evidence

Source checks:26 focused app/rule/client/Targets/radar/upload-boundary regressions, six Deno
handler/stream/body/deadline/delivery checks, and45 disposable PGlite ACL/CAS/
quota checks. The latter uses generated nonspatial latest rows; it does not
exercise PostGIS or prove PostgreSQL transaction races. Browser fixtures use
generated public-water AIS and a synthetic REST origin, with all other WAN
blocked. All four actual Chrome/WebKit300/375px follow/save/area/held/close
cases passed; screenshots were inspected and the long form has a fixed reachable
footer close. Full app TypeScript and scoped ESLint/format checks passed.
The adapter uses the installed extension namespace and
[PostGIS geography ST_Distance](https://postgis.net/docs/ST_Distance.html), whose
result is in metres; no flat longitude approximation is substituted.
Physical AIS coverage, provider entitlement, scheduled operation and
locked-phone delivery are separate unperformed acceptance steps.
