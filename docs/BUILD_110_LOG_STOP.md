# Build 110 — End Voyage freeze and Pi-aware system status

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

Current synced candidate, replacing the earlier 7915248f bundle:

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
