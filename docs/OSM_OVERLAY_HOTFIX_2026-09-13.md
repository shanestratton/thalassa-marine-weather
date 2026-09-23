# Canal obstacle feed — 13 September 2026

## Status

**Historical hotfix result (v15): public upstreams remained unavailable.**
The skipper subsequently approved the regional-data implementation. Newport
now uses the controlled dataset in v16; see
[regional deployment evidence](NEWPORT_REGIONAL_DATA_2026-09-13.md). The upstream
failure documented below still applies outside controlled coverage.

Only `osm-overlay` was deployed to project `pcisdplnodrphauixcau`; hotfix version
15 is ACTIVE. Gateway JWT
verification remains enabled and `requireAuthenticatedOrPublicQuota` retains
its existing signed-in/public quotas. No client build, sync, TestFlight upload,
Pi activation, routing activation, database migration or credential change.
The pre-patch v13 source was downloaded to the task's temporary diagnostics
directory before deployment. No existing user/worktree changes were reverted.

## Evidence and cause

- The Supabase function logs repeatedly recorded `Overpass returned HTTP 406`.
  This is the cloud failure, not the separate HTTP 504/busy response observed
  during an earlier request from the Mac.
- v13 converted the upstream failure into HTTP 200 and nine empty feature
  collections with `X-Overlay-Cache: error`. The strict canal adapter rejected
  that response, correctly refusing to substitute a line through the canals.
- The corrected-order Newport area loaded all 30 required Mapbox water tiles
  (30 water features). Water tile download was not this failure.
- The first patched deployment returned 503 after the primary returned 406
  and the Kumi backup timed out; its logs verified both events.
- The final patch uses the backup operator's current canonical endpoint,
  `overpass.private.coffee`. A fresh Newport lookup still returned 503 with
  `OVERLAY_UPSTREAM_UNAVAILABLE` in about 21.9 seconds. The two hostnames resolve
  to the same addresses; changing the name alone did not restore availability.

## Changes

- At most two upstream attempts, with a 20-second deadline per attempt covering
  both headers and body. Same query and identifiable Thalassa User-Agent; no
  forwarded credentials, spoofed browser identity or repeated host retry loop.
- Fail closed on non-success responses, oversized payloads, malformed JSON,
  invalid element lists and Overpass runtime-error `remark` fields (which can
  accompany HTTP 200 and partial results).
- Explicit non-cacheable HTTP 503 on failure, with Retry-After and browser-
  exposed cache/error headers. Never an empty successful obstacle inventory.
- v6 cache keys identify the **exact requested bounding box**. Old rounded-area
  entries can omit neighbouring obstacles and are not reused. Cache hits still
  require all nine collections and an age from zero to less than seven days.
  Old cache rows were not deleted or altered.
- The canal geometry, endpoint selection, wall margins, water-mask checks,
  known-bridge blocking and SevenCs handover rules are unchanged.

## Verification

71 focused tests passed across upstream recovery, Edge trust boundaries, canal
orchestration/geometry and water tile handling. Deno check/lint, TypeScript,
scoped ESLint and `git diff --check` passed. No full CI run.

Live endpoint checks:

| Check                         | Result                                               |
| ----------------------------- | ---------------------------------------------------- |
| Invalid bearer                | HTTP 401                                             |
| Invalid/inverted bounding box | HTTP 400                                             |
| Corrected-order Newport area  | HTTP 503; no invented route or empty-success payload |

This verifies the error/authorization behavior, **not** a successful real-world
canal route. No SevenCs calculation was made after the failed obstacle lookup.

Source SHA-256 at deployment:

- `osm-overlay/index.ts`: `d33bc6628d52184e45b2747d654ec4f35f6ceebca3673eeafe4449df93e1b6f5`
- `_shared/overpass-fetch.ts`: `7bbc8d22e8b00815351f2f51db30e2375a4dea0ac11d61d4578073e380f18297`

## Next decision

This decision was subsequently approved and implemented for Newport. A
maintained regional obstacle dataset or an agreed reliable provider is
needed if public upstreams stay unavailable. A regional dataset must carry
coverage and source timestamps, reject incomplete extracts, and never present
geometry-only data as depth/bridge/navigation clearance. Creating that new
data pipeline or signing up for a paid provider is outside this targeted patch
and needs the skipper's direction. No paid service was created.

Provider references: [Private.coffee endpoint and usage terms](https://overpass.kumi.systems/),
[OSM instance list and public-server limitations](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
