# Build 110 — long-voyage End Voyage freeze

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
Packaging and delivery results will be recorded below when complete.

## Device acceptance

Update the installed app, end the long recording, and confirm the Log remains
responsive with its history collapsed. Open that voyage and page through its
entries; confirm the final recorded point and deliberate manual notes survive.
Repeat offline and verify any failed native teardown remains retryable rather
than claiming a successful stop. Physical-device acceptance is still required.

Build 110 has not been uploaded to TestFlight at this checkpoint.
