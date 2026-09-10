# Build 111 preparation — GPS transitions and OBS investigation

Build 110 was uploaded on 10 September 2026 and remains immutable. These
changes are the next native candidate, 1.2.0 (111), not a replacement 110.
The historical preparation results below are superseded by the current
[native release evidence](BUILD_111_TESTFLIGHT.md), including the reconciled
source, rebuilt bundle and Apple validation. Keep the earlier candidate's
hashes and CI status separate from that final release record.

## Fixed: phone error during vessel selection

Selecting a receiver previously published `unavailable` before the read had
completed. The target-change listener also immediately created an error, and
the old phone error could survive while the new boat lookup was pending.

The transition now publishes `resolving`, clears the outgoing error and
forecast, and displays “Finding boat location…” or “Finding phone location…”.
The position row is neutral while resolving. Actual failed reads still become
unavailable; source, identity and selection-epoch checks are unchanged.

Three new regressions failed before the correction. Seven relevant suites
then passed all 148 tests; scoped lint and formatting passed.

## Fixed: unintended ENC prewarm work

The OBS map previously started its boot chart merge regardless of the ENC
switch, including in lightweight pickers and after a deferred import outlived
the map. This made switching ENC off an unreliable diagnostic isolation step.

Boot prewarm now checks the live ENC/plotting intent and map lifetime. Normal
visible-chart loading and plotting remain enabled. No memory limits were
changed and no chart records were deleted. A merge already admitted may be
shared with the ordinary renderer and is not cancelled by this narrow fix.

## Confirmed: Town Common → OBS memory-limit termination

After the phone was unlocked, targeted read-only diagnostic retrieval succeeded.
Two iOS Jetsam reports on 10 September 2026, at 15:14:10 and 16:24:12 AEST,
identify Thalassa's WebContent process as `per-process-limit`. The second was
the user's fresh Town Common → OBS reproduction. Its WebContent process used
131,134 resident 16-KiB pages (about 2,049 MiB), while the native app remained
alive at about 122 MiB. Capacitor reloads the terminated web view, explaining
the return to the default Glass screen without exiting to the home screen.

This establishes the restart mechanism, not the precise allocating function.
It is stronger evidence than an unclean-exit flag or a missing error-boundary
record. Neither a generic lazy-module retry nor a native-app crash explains
these two matched Jetsam events.

The saved fatal trail shows an 11-cell, 20.5-MB chart merge followed by a
six-cell glaze-worker dispatch; the old reported clone weight was 125,115.
A later nine-cell merge was superseded/failed before termination. A census
JSON recovered from historical SQLite bytes is timestamped 0.84 seconds before
the second kill: 13 chart cells, one live WebGL context, about 14 MB of canvas
backing storage and 35 MB estimated raster textures. These counters do **not**
measure parsed chart objects, geometry-worker heaps or Mapbox's vector indexes.
The recovered historical census is a forensic candidate, not a transactionally
validated current database row; its timestamp and boot age align with the
native report and saved fatal trail.

Read-only chart metadata replay reproduces the first 11-cell selection at the
saved Town Common coordinate and the actual initial camera zoom of 10. The
`map:create z5` breadcrumb reported a prop, not the actual camera zoom. There
is no evidence that the app mistakenly loaded Brisbane charts, nor enough
camera history to attribute the later selection change to a user gesture.

Device reports and the narrow diagnostic-storage copies remain outside git.
The former “Last Flight” UI was removed in build 105; the recorder still exists.

## Corrected: geometry admission before expensive work

Two demonstrable holes were found in the existing chart safeguards:

- The structured-clone budget counted each subject feature as **one**, even
  when a single polygon contained hundreds of thousands of coordinates. It
  counted coverage vertices but not the subject vertices about to be copied.
- The polygon-boolean guard admitted up to 12,000 input vertices and checked
  the result only **after** the operation allocated it. Valid intersecting
  strips with just 800 input vertices produced 32,400 result vertices and
  roughly 32 MB of transient heap in a bounded ESM reproduction. Input count
  alone did not bound the potentially quadratic intersection work.

The clone check now counts subject and shared coverage geometry before
`postMessage`, stopping as soon as the existing hard cap is exceeded. Exact
clipping also requires a conservative edge-interaction estimate to fit the
existing per-pair and aggregate job budgets **before** calling Martinez.
Failed or subsequently discarded operations are charged too. These are work
admission limits, not promises of an exact process-memory ceiling.

An independent read-only reconstruction using the same 11 chart IDs and
editions on the yacht reproduced **six queued glaze cells and the fatal old
weight of 125,115 exactly**. It contained 340 subject features with 96,091
vertices, plus 124,775 shared coverage vertices. The corrected weight,
including collection overhead, is **227,721**: above the unchanged 200,000
clone cap. The bounded counter returns 200,001 immediately and rejects that
specific workload before `postMessage`. All 435 initial intersecting pairs
also exceed the new exact-work admission limit. This replay counted geometry
only: no old Martinez operation or worker was run, and no licensed geometry
was saved. It proves admission is blocked for the captured payload, not that
every other iOS allocation path is safe.

Over-budget refinement retains the existing fast grade or uses the existing
bounded rectangle-strip fallback. This can show less refined depth shading;
it is not identical chart rendering. Base chart depths, soundings, hazards and
navigation-check inputs are not deleted or rewritten. Empty `stripRects: []`
continues to mean “clip nothing,” not “subtract the entire bounding box.”

## Verification and remaining acceptance

The initial GPS/prewarm candidate at `94a6e4e1` passed the full unit suite
(9,953 passed; three expected failures and five skips), TypeScript, lint,
release gates, native sync, and 50 Chromium/mobile-WebKit browser checks.
Its bundle `main-W5UREiks.js` is superseded by the geometry corrections;
those results must not be represented as final-bundle verification.

The geometry change passed 60 focused suites / 613 tests, scoped lint and
formatting. Regressions were demonstrated red before green for the oversized
single-polygon clone, the 80-by-80 crossing-strip operation, and an admitted
exception incorrectly treating empty strips as a whole-bounding-box clip.
Small exact clips, aggregate budget boundaries and cleanup remain covered.

Pre-merge source candidate: `a25fd660d39a9e2a9c58c5d2ff69d52f916f1707`, pushed to
`codex/build-107-daylight-split-view`.

- Full unit suite: **9,968 passed**, three existing expected failures and five
  skips (1,112 suites passed; four skipped). No unexpected failures.
- Full lint: zero errors, 59 warnings; all 163 migration audits passed.
- TypeScript passed after correcting a test-only mocked coordinate type to
  an explicit two-number tuple. Its ten-test suite was then rerun and passed;
  no runtime production logic or assertion was changed by that correction.
- `VITE_APP_BUILD=111 npm run ship:beta` passed: TypeScript, production build,
  byte-identical preview routes/assets, bundle limits, route audit, iOS sync,
  client-secret checks and all 140 final artifact release contracts.
- All four native build counters are 111. All **418** generated files are
  byte-identical to their copies under `ios/App/App/public`.
- Bundle: `main-CvPkGaJI.js`; SHA-256:
  `fe52be262e913f1f656b6c11180443c7cb80ee26d3fc0642b874ebd171285cb0`.
- Bundle size: 13.33 MB total; 9.87 MB JavaScript, below the unchanged
  9.90-MB JavaScript limit. No budget was raised.

The final production-browser run passed **50 checks** in Chromium and mobile
WebKit against this exact built bundle: location selection, GPS recovery,
chart warnings/attribution, and OBS map mounting/styles. These use controlled
browser fixtures rather than the physical phone's licensed chart inventory.
Local release evidence is in `/private/tmp/thalassa-111-final.MJ6uHX/`.

At the end of that initial preparation, GitHub's draft PR #38 reported
`CONFLICTING` / `DIRTY` against `master`, with no CI workflow run attached to
that source commit. Those local results were not GitHub CI success. The
subsequently authorised reconciliation and native release are recorded in
[the superseding release evidence](BUILD_111_TESTFLIGHT.md).

Desktop/browser checks cannot establish that the physical iOS memory issue is
closed. Acceptance still requires Town Common → OBS on the new native build,
with the same chart inventory, without another WebContent termination. Build
110 has not been altered.
