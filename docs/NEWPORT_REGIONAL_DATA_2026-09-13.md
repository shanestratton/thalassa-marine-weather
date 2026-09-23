# Newport regional data — deployment evidence

## Result

Supabase `osm-overlay` **v16 ACTIVE**, project `pcisdplnodrphauixcau`, now serves
the controlled Newport obstacle inventory. JWT verification remains enabled;
the existing user/public quotas are unchanged. No other function, app bundle,
TestFlight build, Pi configuration or saved route was changed by this work.
The old public Overpass dependency remains outside Newport's coverage.

The full source was the dated public Queensland extract from
[Geofabrik](https://download.geofabrik.de/australia-oceania/australia/queensland.html),
with PBF replication timestamp **2026-09-11T20:22:01Z**. Source MD5 was verified
against the publisher; the full-source SHA-256 is
`d42769e84ca9974a3cfc1a025c5df67c50551f0dab5a833d18baa5082c506f73`.
Regional payload SHA-256 is
`e583d1ab43642919e6ff48f54a1e7bf4a16dbc29b3adb194b0ab2a81b97dab62`.

The region contains 52 water-area features, 367 berth/pier/pontoon features,
45 hard-obstacle features (walls/quays/breakwaters/bridges), 42 canal lines,
16 coastline features, four marina areas, two reef features and one aeroway area.
These are GIS features, not counts of unique physical structures; a source
object may have both linear and area representations.

## Verification

- Live corrected-order Newport bbox: **HTTP 200**, `X-Overlay-Cache: regional`,
  source date and payload hash exactly matched the deployed copy; 272 berth
  features, three hard-obstacle features, 19 water areas and 16 canal lines.
  Observed response time 2.76 seconds, versus the previous 21.9-second failure.
- Invalid bearer: HTTP 401. Inverted bbox: HTTP 400.
- Two diagnostic canal departures used fresh Mapbox water plus this dataset,
  through the existing local solver. The corrected 06:20 screenshot pin order
  produced 12 waypoints; the earlier 06:09 screenshot produced nine waypoints.
  Independent Turf sampling at ≤1.5 m found **0 points outside mapped water**
  over 3,198 / 3,338 samples respectively and **0 intersections with mapped
  obstacles**. No SevenCs route was activated or saved by these probes.
- The returned grid is an eroded mask for checking the **provider continuation**,
  not the raw local-endpoint mask. Rechecking the entire local route against
  that returned grid is not an equivalent test: local endpoint joins have their
  own raw-water and maximum-snap checks. Those rules were not changed here.
- 86 focused TypeScript tests and five Python generator tests passed, including
  an existing real Newport bend with the new obstacle copy, incomplete refs,
  crossing walls with vertices outside the region, polygon holes, stale/future
  source dates, damaged inventories, checksums, coverage and unchanged auth.
- Deno check/lint, TypeScript, scoped ESLint and diff whitespace checks passed.
  No full CI run or app build/sync was performed.

## Maintenance

The user approved daily refresh. Codex automation **Refresh Newport canal data**
(`refresh-newport-canal-data`) is ACTIVE at **10:00 Australia/Brisbane daily**.
It runs on the Mac: Mac/Codex availability and Supabase CLI access are required.
It follows the [data-only runbook](../scripts/newport-overlay/README.md), stages
against a download of the live function and publishes only a validated new data
bundle. Unchanged healthy sources do not cause deployment. Broken/delayed sources
raise a notification and never extend the seven-day source-age limit.

The first refresh check correctly reported the latest source unchanged.
The pre-regional v15 source rollback copy is at
`/tmp/thalassa-overlay-pre-regional.wXABKM/supabase/functions/` for this session;
future jobs must take their own current-live rollback snapshot before publishing.

## What this does not prove

This resolves the Newport obstacle-feed outage and exercises mapped canal paths.
It is **not** an on-vessel test, a depth/tide/bridge-clearance validation, a
guarantee that all physical obstructions are mapped, or permission to navigate
the proposal unreviewed. The client's separate Mapbox-water fetch remains a
dependency. Newport coverage is bounded; additional regions need separate data
review and publication. No paid data service was purchased.
