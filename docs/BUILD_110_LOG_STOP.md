# Build 110 — End Voyage, Pi-aware status and recorded wind history

Shane reported build 109 freezing on the Log screen after End Voyage on
10 September 2026. The uploaded 109 archive is unchanged; this correction uses
1.2.0 (110).

## Reproduced cause

The Log hook auto-expanded the active voyage when loading its local entries.
End Voyage set tracking false but retained that expansion flag. The page then
replaced its compact live card with an expanded historical VoyageCard, before
GPS teardown had finished.

DateGroupedTimeline rendered every date and every entry. Collapsed entry
details were hidden with CSS, not removed from the DOM. The work at this view
switch therefore grew with the entire recording, not the visible screen.

Rendering the actual timeline with 10,000 synthetic entries, real formatters
and icons produced **530,017 elements / 39,881,083 bytes of HTML** before the
fix. The corrected component produces **1,221 elements / 96,966 bytes**.
Desktop server rendering measured 1,157 ms before and 4 ms after; this is not
an iPhone timing claim. A browser must additionally create/layout these nodes.

This is a reproduced duration-dependent failure mechanism, consistent with the
reported foreground freeze. No live phone trace was captured during this
incident; it is not a claim that every previous Log failure had the same cause.

## Changes

- Begin-stop atomically collapses only the ending voyage before leaving the
  live view; all recorded entries and other cards' choices remain intact.
- Repeated stop taps cannot start duplicate native teardown while it is pending.
- Timeline pages share a **50-entry global render budget**, including voyages
  spanning many dates. Previous/Next can reach every entry. Collapsed dates and
  entry details unmount; editing, deletion, start/end markers and filtering
  remain available.
- Stop reads only the ending voyage's owner-scoped offline entries, rather
  than copying the entire account queue. Its distance maximum uses a loop,
  not an argument spread that throws at the allowed 250,000-entry queue size.
- Optional track-cache preparation yields before work and every 128 entries,
  rejects oversized payloads incrementally, and rechecks account ownership.
  Oversized or stale work does not overwrite an existing valid cache.

The cache and queue changes address separately reproduced allocation hazards.
The spread exception was caught by existing code, so it is **not** asserted to
be the direct cause of the permanent freeze. Recording data is not discarded
or truncated to achieve the smaller display budget. Existing native lease,
durable handoff and final-entry ordering are unchanged.

## Verification

Regression tests were first run against the old behavior: the stopping voyage
remained expanded, duplicate stop calls ran twice, and four queue/cache stress
checks failed. They passed after the respective changes.

- Hook, Log page and existing stop-crash suites: 72 passed.
- Timeline and adjacent presentation suites: 24 passed.
- Recorder identity, queue, synchronization and cache suites: 104 passed.
- Changed-file ESLint passed.
- TypeScript passed (`tsc --noEmit`).

The actual component was also exercised in Chromium and mobile WebKit at
390-pixel phone and 512-pixel pane widths, using production React and the
existing application CSS. All four cases passed all 200 pages, Previous/Next,
final manual-entry edit/delete callbacks, a separate responsiveness button,
and a continuously running timer. Each stayed at at most 50 mounted rows,
1,246 total harness elements, no horizontal overflow and no page errors.
Initial display measured 9–23 ms; the longest observed timer gap was 91 ms.
These are desktop browser-engine measurements, not measurements on Shane's
physical iPhone. The complete 10,000-entry input remained available throughout.

Harness and screenshots: `/private/tmp/thalassa-timeline-stress.LGATWW/`.
Hook before/after logs: `/private/tmp/thalassa-end-voyage-before.log` and
`/private/tmp/thalassa-end-voyage-hook.log`.

The full suite passed with **9,777 passed, three existing expected failures and
five skips**; 1,100 files passed and four were skipped. Exit status zero,
193.41 seconds, Node 24, four workers. Evidence:
`/private/tmp/thalassa-end-voyage-full-unit.log`.

The focused suite totals overlap with this full result; do not add them.

## Initial Log-fix candidate (superseded by the Pi-status candidate below)

Runtime commit **7915248f** was committed and pushed to
`codex/build-107-daylight-split-view`. All four Xcode counters are 110;
the marketing version remains 1.2.0.

`VITE_APP_BUILD=110 npm run ship:beta` passed under Node 24: source gates,
TypeScript, production bundle, local route/byte-identity checks, bundle budget,
iOS sync, secret/artifact checks and **140 release contracts**. Evidence:
`/private/tmp/thalassa-build110-ship.log`.

- Main: `main-DFjgoEyc.js`.
- SHA-256: `90a40191fbf73faf2ea9a256a594f476f44cf40569e2154342a45bbca9752531`.
- CSS: `index-BmvGv2el.css`.
- Built entry contains runtime `7915248f` and release `thalassa@1.2.0+110`.
- Every `dist/assets` file matches its synced iOS counterpart byte-for-byte.

Final immutable production startup/Log smoke: **13 passed, one existing
conditional skip**, zero retries, Chromium and mobile WebKit, 33.4 seconds.
Evidence: `/private/tmp/thalassa-build110-smoke.log`.

The full 10,000-entry standalone component stress matrix was repeated using
the final build's CSS: all four browser/width cases passed every page and
manual callback again. Initial rendering measured 7–19 ms, with a maximum
timer gap of 73 ms, 1,246 harness elements and no page errors or horizontal
overflow. This exercises the real component in an isolated harness, not a
claim of an end-to-end native GPS stop. Evidence:
`/private/tmp/thalassa-build110-timeline-browser.log`.

## Device acceptance

Update the installed app, end the long recording, and confirm the Log remains
responsive with its history collapsed. Open that voyage and page through its
entries; confirm the final recorded point and deliberate manual notes survive.
Repeat offline and verify any failed native teardown remains retryable rather
than claiming a successful stop. Physical-device acceptance is still required.

Build 110 has not been uploaded to TestFlight at this checkpoint.

## Pi-aware NMEA Backbone status — same unuploaded build 110

Shane then reported that the ⓘ screen still offered **FIX** while instruments
were arriving through the Pi/tailnet/cloud. The row used only
`NmeaListenerService.getStatus()`, which measures the phone's direct gateway
socket. Pi-first transport deliberately leaves that socket disconnected while
`NmeaStore` is receiving the vessel's instruments through a remote lane.

Runtime commit **3bd549c50bdb** fixes that mismatch:

- A usable, fresh Pi feed marks the backbone active and identifies the Pi,
  tailnet or cloud route. An unused direct socket's old error cannot override it.
- Both source and receipt timestamps must be current. Empty snapshots, old
  metrics, invalid clocks and phone-sourced cloud positions do not prove an
  active NMEA feed. Valid zero readings do count.
- The panel subscribes to store and socket changes, ages cached data every
  five seconds, and rechecks immediately on foreground. Unchanged diagnoses
  retain their React state rather than repainting on every instrument sample.
- Opening the panel retains the existing shared cloud reader; closing or
  unmounting releases that interest. Existing RLS/source ordering is unchanged.
- Only diagnosed gateway faults offer **Fix**; inactive/quiet/stale feeds offer
  **View**. Direct-socket sentence-rate charts stay hidden for Pi/cloud feeds.

No gateway settings, yacht software, cloud data or sharing permissions changed.
The existing cloud service's in-flight-poll lifecycle was not redesigned here;
after its last release an already-running read can still finish once. This
pre-existing transport caveat is separate from the corrected status inference.

Verification on the corrected sources:

- Focused status, Pi, cloud, GPS and legacy diagnosis regressions: **113 passed**.
- Full unit suite: **9,815 passed**, three existing expected failures and five
  skips; 1,101 files passed, four skipped; exit zero in 223.65 seconds.
- TypeScript, changed-file ESLint and formatting checks passed.
- `VITE_APP_BUILD=110 npm run ship:beta` passed, including iOS sync and all
  **140 artifact release contracts**.

Evidence: `/private/tmp/thalassa-build110-nmea-focused.log`,
`/private/tmp/thalassa-build110-nmea-full-unit.log`,
`/private/tmp/thalassa-build110-nmea-types.log`,
`/private/tmp/thalassa-build110-nmea-ship.log`.

Pi-status candidate, replacing 7915248f and superseded by the wind candidate below:

- Main: `main-CNwCTRNp.js`.
- SHA-256: `1c85a28b01590d8f298db02e0ad45b56210f43d25a9af5a6e5a780a3e418fcc3`.
- CSS: `index-BmvGv2el.css`.
- Entry contains `3bd549c50bdb` and `thalassa@1.2.0+110`.
- Every `dist/assets` file matches its synced iOS counterpart byte-for-byte.

Final production-bundle startup, Log and system-status browser checks:
**15 passed, one existing conditional WebKit GPS skip**, zero retries, in
33.2 seconds. Chromium and mobile WebKit both opened the real status panel and
confirmed the neutral inactive row offers View, not Fix, without page errors.
Evidence: `/private/tmp/thalassa-build110-nmea-smoke.log`.

The 10,000-entry timeline harness was repeated against this candidate's CSS in
both engines at 390/512 px. All four cases passed every page and manual
edit/delete callback: at most 50 mounted rows, 1,246 elements, no overflow or
page errors, 7–23 ms initial display and maximum observed timer gap 92 ms.
Evidence: `/private/tmp/thalassa-build110-nmea-timeline-browser.log`.

Physical-device acceptance: with live Pi instruments, open ⓘ and confirm the
NMEA Backbone row identifies the actual route without FIX. Check LAN/tailnet,
cloud-only and a disconnected feed. This code has not been exercised on
Shane's physical iPhone; installed build 109 remains unchanged.

This updated build 110 is built, synced, committed and pushed. It has not yet
been archived, validated or uploaded to TestFlight.

## Rolling wind history — same unuploaded build 110

Shane found the wind page only began collecting peaks when it opened. Its
ten-minute array and lifetime maximum were component-local. Leaving the page
discarded both; the lifetime maximum also never expired while the page stayed
open. Existing Pi telemetry supplied current values, not preceding-hour history.

Runtime commit **5afea6ebd1f6** replaces that page-local state:

- **Max · 1h** is the highest recorded true wind in the preceding hour.
  **Gust 10m** stays the highest sampled true wind in the preceding ten minutes,
  including for existing sail-plan advice. It is not a meteorological
  three-second gust measurement. Both figures are independent of page mounts.
- The Pi collects a bounded hour from local Signal K every five seconds,
  independently of internet, pairing and open screens. Original wind-leaf
  timestamps and physical source identity are required; cached values do not
  create observations. Real zero is preserved, absent history remains absent.
- Atomic, identity-fenced persistence survives normal restarts. Dirty peaks
  flush even when the sensor stops reporting. Delayed previous-source readings
  cannot replace a newer source's record.
- Versioned scalar summaries use the existing LAN/cloud telemetry payload.
  No schema, RLS, sharing-default or cloud-function change is needed.
- The app's shared store retains known same-source observations and expires
  them by original sample time. A peak the app observes between Pi polls
  cannot disappear when the next Pi summary has a lower maximum.
- Cloud reads are now fenced by reader lifetime and account generation. This
  resolves the in-flight-read caveat noted in the earlier NMEA-status section:
  late reads cannot repopulate a released feed or previous account's history.
- The same three-card footprint is retained. Tapping a peak opens the existing
  status sheet's short explanation of windows and potentially partial history.

Verification on the final frozen sources:

- Full app suite: **9,875 passed**, three existing expected failures, five
  skips; 1,106 files passed, four skipped; exit zero in 194.13 seconds.
- Pi suite: **249 passed**. After the final source-provenance guard, the Pi
  rebuilt and all **41** wind, telemetry, adapter and sensor tests passed again.
- TypeScript, changed-file ESLint and formatting passed. The Glass file's
  12 existing lint warnings remain; no lint errors were introduced.
- `VITE_APP_BUILD=110 npm run ship:beta` passed, including iOS sync and all
  **140 release contracts**. Source commit is pushed.
- Immutable production startup, Log and system-status smoke: **15 passed**,
  one existing conditional WebKit GPS skip, zero retries, 27.2 seconds.
- Actual wind-card component plus final production CSS: all 12 Chromium/WebKit
  cases passed at 320/390/512 px in day/dark modes. No horizontal overflow,
  wrapped labels/units or page errors; both detail buttons worked. This is
  desktop browser-engine testing, not a physical-iPhone measurement.

Evidence: `/private/tmp/thalassa-wind-history-final-full-unit.log`,
`/private/tmp/thalassa-wind-pi-full-tests.log`,
`/private/tmp/thalassa-wind-history-final-lint.log`,
`/private/tmp/thalassa-build110-wind-ship.log`,
`/private/tmp/thalassa-build110-wind-smoke.log`,
`/private/tmp/thalassa-build110-wind-layout.log`.

Current synced candidate:

- Main: `main-DSJgpLSI.js`.
- SHA-256: `63085896aec4028ad208582cb123f74bb3243b2b054f5be5e47409bd78c3bcf0`.
- CSS: `index-BmvGv2el.css`.
- Entry contains runtime `5afea6eb` and release `thalassa@1.2.0+110`.
- All **283** `dist/assets` files match the synced iOS files byte-for-byte.
- All four Xcode build counters remain 110; marketing version remains 1.2.0.

**Not activated aboard or uploaded to TestFlight.** The Pi update requires
explicit safe-interruption approval and anchor-watch reassignment/verification;
see [wind-history deployment notes](../pi-cache/docs/wind-history.md). The
running yacht services and installed build 109 have not been changed. First
activation must collect observations before a full hour exists. Device
acceptance must then confirm LAN/cloud backfill after leaving/reopening the
page and app, while disconnected/expired data stays honestly unavailable.

## Transient Glass GPS loss — same unuploaded build 110

Shane reported the Glass briefly replacing its forecast with a large red
"Phone GPS unavailable" card, then recovering. The five-second GPS follower
set a page-level error after one unsuccessful receiver read; App rendered that
error instead of the forecast even when the existing report remained usable.
The phone reader returns no fix for several native failure modes, so this is
not a claim that a particular timeout or permission error was observed on his
phone.

Runtime **047ae1f6** retains only a report associated with an actual accepted
fix for the same receiver, selection epoch and authenticated identity. Its
position must remain within the follower's existing half-nautical-mile
name-update radius; ordinary GPS drift must not turn a subsequent missed fix
into a page failure. A loading placeholder does not qualify. First-use failures,
unknown caches, newly selected receivers and known distant positions continue
to expose the unavailable state rather than borrowing another location.

The retained forecast keeps its original values, coordinates and generated
time. The existing location field says **Last location · [name]** and its left
icon becomes a compact retry button. No extra header row is added. GPS remains
explicitly unavailable; the status panel reports the original fix's age.
Automatic recovery clears the retained label. No fallback from phone to vessel
or vice versa, automatic permission prompt, background GPS watcher or yacht
service change was introduced.

The focused seven-suite check passed **145 tests**. The placeholder regression
was observed failing before its guard, then passing. Other retention tests were
first run after implementation; no pre-fix red run is claimed for those.
Changed-file ESLint and Prettier passed. Evidence:
`/private/tmp/thalassa-110-gps-focused-final.log` and
`/private/tmp/thalassa-110-gps-placeholder-before.log`.

The full unit run completed with **9,897 passed**, three existing expected
failures and five skips (1,106 files passed, four skipped; 222.58 seconds).
The small placeholder guard was completed during that run and verified again
in the focused suite; final frozen-source release tests follow the remaining
Log/Cast Off/map fixes. `VITE_APP_BUILD=110 npm run ship:beta` passed, including
TypeScript, iOS sync and all 140 artifact release contracts.

The new production browser test first reproduced the old bundle's error
takeover after accepting a working phone fix. Against the corrected bundle,
the five-file startup/Log/status/GPS matrix passed **21 checks**, one existing
conditional WebKit GPS skip, zero retries, in 51.8 seconds. Both Chromium and
mobile WebKit kept the forecast, original metrics and location-card height
through a timeout and unsuccessful compact retry, then recovered automatically.
The mobile screenshot was inspected. These are desktop browser-engine checks,
not a claim of native iPhone acceptance.

Evidence: `/private/tmp/thalassa-110-gps-full-unit.log`,
`/private/tmp/thalassa-110-gps-ship.log`,
`/private/tmp/thalassa-110-gps-browser-before.log`,
`/private/tmp/thalassa-110-gps-browser-final.log` and
`/private/tmp/thalassa-110-gps-browser-final-results/`.

Shane then supplied the additional Log route-duplicate, abandoned Cast Off
setup and split-pane map-attribution issues, and confirmed full internal
TestFlight delivery after these corrections. No build 110 archive has been
uploaded at this checkpoint.

## Approved yacht wind-history activation — 10 September 2026

Shane explicitly approved Pi activation and supplied the correct connection,
`shanes@100.86.90.84`. The saved `serene-summer` SSH alias pointed elsewhere
and rejected authentication; no changes were made there. The supplied host
was verified as `calypso`, Raspberry Pi 5, running the cache as `shanes` from
`/opt/thalassa-pi-cache`.

The installed `server.ts` and `trackSignalk.ts` exactly matched the pre-wind
commit. The package manifest and compiler configuration matched; the yacht's
existing dependency lockfile was retained. The validated, separately built
wind patch replaced only these two modules plus new `windHistory`, including
their source/declaration/map artifacts. Target Node 22 syntax and a staged
read of the real Signal K wind source passed before installation. No dependency
upgrade, broad pull, native app bundle deployment or producer change occurred.

Immediately before restart the anchor relay was verified **off**, with no
assignment. The approved `thalassa-cache` restart completed at **09:16:11 AEST**.
It remains off; the skipper must enable and confirm a current assignment in
the app before relying on it. Signal K was not restarted (its original
09:07:41 start time was retained). The track recorder stayed enabled/running
and loaded all 1,306 prior stored points, then recorded point 1,307.

The environment, Pi identity and TLS certificate were byte-verified unchanged.
Exact replaced software originals remain recoverable at
`/home/shanes/thalassa-wind-backup.yX7tzD/`; staging remains at
`/home/shanes/thalassa-wind-stage.yxc3Yw/`. These are software rollback backups,
not a pre-update backup of the track database. Local execution evidence is in
`/private/tmp/thalassa-wind-activation.2R2pRm/`.

Verified LAN telemetry carried `wind_history_v: 1`, fresh original wind times,
source `ydwg-tcp.YD`, stable Pi identity and growing sample counts with both
peak windows. Heel and trim remained present. The existing cloud publisher
returned `sent` with a new post-restart timestamp. This verifies successful
publication acknowledgement, not an independent authenticated read of the
stored Supabase row. Native/cloud-only display acceptance awaits build 110.
No pre-activation readings are invented; a full preceding-hour window needs
one hour of valid collection.

## Final Log / Cast Off / split-map corrections

The Log following-route picker previously exposed legacy planned-log mirrors
which Plan already reconciled with saved routes. It now uses canonical links
or a complete, direction-sensitive route-geometry match. Stored full curves
take precedence over sparse waypoint rows; names, distance and shared endpoints
alone cannot merge routes. Whole passages remain distinct from their first-leg
anchor. Grouping identity is separate from geometry proven safe to follow.
Unresolved or ambiguous rows remain visible; no database rows are deleted.

Compatibility reads are restricted to twelve suspected small planned mirrors,
three workers, with an actual query limit of expected count plus one (at most
401 rows). Overruns are rejected, reads abort after six seconds or unmount,
and account-change fences prevent late results entering another session. All
other voyage readers retain their existing default limits. Eight focused suites
passed 98 tests, including complete-curve, passage, bounded-read and abort cases.
There is no evidence that these display duplicates caused the earlier lock-up.

Cast Off now keeps new preflight setup in memory until confirmed Cast Off.
Selecting a route, entering details and backing out no longer create a draft
or private voyage channel. The chooser offers saved routes, not abandoned
unlinked setup rows; old planning/crew/log records remain intact. Explicit
Passage Planning selections still work. A successfully created server ID is
retained for activation retries; a failed activation never deletes a potentially
live voyage. Loss of the create response itself can still leave an unknown
server planning row; this change does not claim globally idempotent creation.
The focused Cast Off set passed 77 tests. Cross-review additionally corrected
busy-control cleanup after an account change, without applying old-account data.

Map attribution uses Mapbox's genuine compact control in map containers at or
below 640 px, or split panes narrower than 960 px. The existing resize observer
refreshes the control as pane geometry changes. All source credits, their
expandable control and the Mapbox logo remain; no attribution is hidden by CSS.
Eleven focused tests passed. Production-browser acceptance and the final frozen
110 archive/delivery checks are recorded in the final release handoff.
