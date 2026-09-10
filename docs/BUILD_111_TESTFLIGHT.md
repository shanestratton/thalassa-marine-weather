# Build 111 — native release evidence

## Status

**1.2.0 (111) is available in the Skipper internal TestFlight group.** It was
built, synced, archived, Apple-validated and uploaded from **14e7e756**. Both
complete local browser matrices and GitHub CI passed. Apple processing is
complete; the group shows **Testing**, and the saved test notes were verified
after reloading. This record supersedes the
pre-merge candidate and conflict status in
[the initial investigation](BUILD_111_GPS_OBS.md).

## Compiled source and scope

Source: **14e7e756834f9a88633a6d9cd3b6d78441646bd8**, pushed on
`codex/build-107-daylight-split-view`. Master `2b5fa8d1` was merged into this
branch, not the other way around. The newer September 10 sail-plan layout
(Yankee guide beside the hull, traveller below, warnings in document flow)
and existing instrument dot-rail removal are preserved. Incoming Pi runtime
and CI contracts remain together. No yacht or production-service deployment
was performed.

- The captured Town Common ENC refinement payload is rejected before worker
  dispatch when over budget. Optional shading stays simpler; base chart depths,
  soundings, hazards and navigation-check inputs are unchanged. This does not
  prove every possible iOS allocation path safe: physical-phone acceptance is
  still required.
- Switching GPS receivers clears the outgoing receiver's error while resolving
  the new selection. Genuine unavailable states remain visible.
- The ENC coverage notice retains readable text, a 44px Library button and
  separation from map controls, including wider fallback fonts.
- Vessel section reveal waits for the actual finite expansion rather than a
  fixed 280ms timer. Close, unmount, reopening and newer gestures fence obsolete
  scrolling; existing snap behavior is unchanged.
- The gauge screenshot test waits for settled frames. Exact colour maps and
  final byte-for-byte comparison remain unchanged; no instrument colour change
  was made to resolve its capture race.
- Keyboard tests wait for committed pane height, finite animations and paint
  before checking all four input edges. A delayed-transition regression and
  an intentionally covered input verify both successful settlement and genuine
  obstruction rejection. These latest changes do not alter application code.

## Verification

- Reconciled-source focused tests: **69 passed** across five suites.
- Final section-reveal unit slice: **20 passed** (14 lifecycle, six adjacent).
- Final Vessel source-browser matrix: **16 passed**, zero retries, Chromium
  and WebKit, including delayed expansion, short phones, iPad and wheel input.
- Final gauge capture stability: **10 passed**, five repetitions per browser,
  zero retries, preserving the exact-colour and byte-equality assertions.
- Final Scuttlebutt source-browser matrix: **26 passed**, zero retries,
  Chromium and WebKit, including delayed layout and obstruction rejection.
- Fresh `VITE_APP_BUILD=111 npm run ship:beta`: passed TypeScript, build,
  production-route parity, unchanged bundle budgets, route audit, native sync,
  client-secret checks and all **140** final artifact release contracts.
- Final exact-production browser matrix: **177 passed, seven existing skips**,
  no failures or retries, Chromium and iPhone-profile WebKit, 4.3 minutes.
- Final daylight/keyboard/split-pane source matrix: **192 passed**, no failures
  or retries, Chromium and WebKit, 3.8 minutes.
- Final [CI 34456958374](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34456958374):
  **passed** for `14e7e756`. Unit coverage: **9,985 passed**, three expected
  failures and five skips, across 1,114 passed suites and four skipped suites.
  Production browsers: **177 passed**, seven existing skips (13.9 minutes).
  Source-layout browsers: **192 passed** (8.0 minutes). All four CI jobs passed;
  no test retries or new quarantines were required.
- Final [CodeQL 34456958385](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34456958385)
  and [Lighthouse 34456958379](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34456958379):
  both passed for the final source commit.

All four native counters are **111**, marketing version **1.2.0**. Total bundle
13.33 MB; JavaScript remains within the unchanged 9.90 MB limit. All **418**
production files byte-match their native copies; native sync adds only two
empty Cordova bridge stubs.

| Entry | Asset                     | SHA-256                                                            |
| ----- | ------------------------- | ------------------------------------------------------------------ |
| Main  | `assets/main-B74WBV-Z.js` | `c23bbac497ddeec101b0f25d9b29f7046233fa69c255c1a468b7e4b093b2f209` |
| Logs  | `assets/logs-BBe1ZNre.js` | `2ecbdfa7dbed31e159a7ca72ed28dfbe0e1ee5864be238b1a5a2534d3e8a3d22` |

## Final archive and Apple delivery

Final archive created **18:49:06 AEST on September 10, 2026**, using Xcode
**26.6 (17F113)**, App / Release / generic iOS device and fresh DerivedData:

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-10/Thalassa-1.2.0-111-14e7e756.xcarchive`

Archive verification passed: source/build fingerprints and entry hashes match;
all **420** public files byte-match the native copy; all **23** binaries have
matching dSYMs; zero source maps; no Watch or PlugIns; iOS 17 minimum;
background audio/location/fetch and `ITSAppUsesNonExemptEncryption=false`.
Strict/deep signature verification passed. Apple Sign In, WeatherKit and Time
Sensitive notification entitlements remain intact; the archived privacy manifest
matches source. Development APNs / `get-task-allow=true` on the archive is
expected before distribution re-signing.

Apple validation completed **18:52:16 AEST** (validation-log completion time):
**Validated App / EXPORT SUCCEEDED**, exit 0, with automatic build-number
management disabled. Upload started after the final CI gate passed. This receipt
belongs to the final `14e7e756` archive, not an earlier candidate.

An independent read-only verification also passed, requiring nonempty UUID
sets for every binary: all **23 arm64 slices** have matching dSYM UUID and
architecture pairs, with no simulator slices. All four build counters and all
compiled/native/archive file comparisons agree.

The same archive was uploaded after CI passed, with automatic build-number
management disabled. Apple reported **Upload succeeded / Uploaded App /
EXPORT SUCCEEDED** at **21:18:55 AEST on September 10, 2026**, exit 0. It
reported the package processing; Apple subsequently marked that upload
**Complete**. No rebuild or re-upload of 110 occurred.

At **21:24 AEST on September 10, 2026**, the existing Skipper internal group
showed **1 Tester / 10 Builds**, with **1.2.0 (111) — Testing**. Build ID:
`f46ba8fe-e3df-4c61-83a2-00500ea2fbd7`.
The 1,340-character **What to Test** notes were saved under English (Australia)
and read back after a reload, matching the prepared text exactly. No tester
or group was added manually; the existing automatic-build assignment applied.

[Build 111 in App Store Connect](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/ios/f46ba8fe-e3df-4c61-83a2-00500ea2fbd7)

Only this documentation was updated after delivery. The uploaded archive
remains the immutable `14e7e756` build; the later documentation commit is not
a rebuilt or re-uploaded binary. The green CI evidence above belongs to that
compiled-source commit.

Final local evidence directory:

`/private/tmp/thalassa-release111-delivery.lUb441/`

Skipper's existing **Automatic for Xcode Builds** setting was verified enabled.
No group settings, external testers or public links were changed. Uploaded 110
and its artifacts remain untouched.

## Superseded candidates — never uploaded

- **7534ff8c**: local production browser run passed (167 passed, seven skipped),
  but Linux [CI 34447413082](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34447413082)
  found five repeatable ENC warning overlaps (162 passed, seven skipped).
  Its unit coverage passed: 9,968 passed, three expected failures, five skips.
  CodeQL and Lighthouse also passed. A wider-font reproducer failed locally
  before the layout correction and passed afterward.
- Its archive, `Thalassa-1.2.0-111-7534ff8c.xcarchive`, was created
  **17:11:53 AEST** on September 10 using Xcode **26.6 (17F113)** and passed
  Apple validation at **17:14:26 AEST**. It was withheld, not uploaded.
  Historical logs: `/private/tmp/thalassa-release111.Xr5whM/`.
- **46418b04** fixed the ENC notice collisions. All 42 focused chart-browser
  checks passed. The subsequent local suites found a gauge screenshot race
  (187 passed, one failed) and an intermittent Vessel expansion cutoff
  (174 passed, seven skipped, one failed). Its CI was superseded/cancelled
  when the final correction was pushed. Logs:
  `/private/tmp/thalassa-release111-final.AApChv/`.
- **5d73cfd9** passed both complete local matrices (177 production checks,
  seven existing skips; 190 source-layout checks) and Apple validation at
  **18:08:29 AEST**, but was not uploaded. Its archive was created at
  **18:04:17 AEST**. [CI 34452495517](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34452495517)
  passed unit coverage (9,985 passed, three expected failures, five skips)
  and production E2E (177 passed, seven skips), but source-layout finished
  187 passed / three failed. Logs: `/private/tmp/thalassa-release111-ready.Hy6KFE/`.
- In that CI gauge failure, the saved final PNG was byte-identical to the
  baseline, but the nested 15-second deadline stopped confirmation one frame
  short. The corrected helper uses at most eight captures within the unchanged
  60-second whole-test budget, with exact comparison and per-capture timings
  and hashes. Local stress did not reproduce the precise CI timeout; one final
  local repetition required six captures before three consecutive matches.
- The two CI WebKit messaging failures did not capture their original failed
  geometry. Four natural local repeats passed; a controlled delayed transition
  reproduced the same four-point hit failure twice while the chat pane was
  still moving. The corrected settlement check passes, preserves all existing
  containment assertions, and records occluder/animation details on failure.
- Gauge timing proof: the original comparison failed four of five Chromium
  repetitions; unchanged DOM and computed colours eventually produced identical
  screenshots. Two consecutive transient frames could match, so the corrected
  test requires three consecutive exact captures.
- Vessel timing proof: a controlled delayed expansion reproduced the same
  containment failure in both production browsers. Chromium scrolled with
  group height 154.25px; it then grew to 222.25px. The original sporadic failure
  is consistent with this proven race, but its own animation timeline was not
  captured. The final browser regression passes in both engines.

## Physical-device acceptance still required

- [ ] Install 111 over 110. Repeat Town Common → OBS with the same licensed
      chart inventory; pan/zoom and leave OBS open. Confirm no return to Glass
      or WebContent termination.
- [ ] Switch phone ↔ boat: neutral resolving state, no outgoing receiver's
      error flash, genuine unavailable states still correctly labelled.
- [ ] Check the small-screen chart notice and expanded Vessel settings on
      the actual phone.

Desktop browser checks and Apple packaging validation do not replace these
on-device checks.
