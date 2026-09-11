# Build 114 — native release evidence

Status: **1.2.0 (114) is Testing in the existing Skipper TestFlight group**.
Apple processing, saved test-note readback and actual group availability were
verified by **18:24 AEST, September 11, 2026**. Installation is
TestFlight → Thalassa → Update.

## Source and scope

Compiled runtime: `02a7784094d64537ca34d0b074565bb7e45599ec`.
Green-CI release checkout: `c1b4830655f6a8434eb983903b123750679156f1`, pushed
on `codex/build-107-daylight-split-view` and clean at archive/upload verification.
The only differences between these commits are `e2e/radio-console-flow.spec.ts`
and `docs/BUILD_114_POLISH.md`: no application, native, dependency, configuration
or backend changes. The tested and synced runtime bundle was not rebuilt for
test/documentation-only changes. This final report is also documentation only.

- Radio Console selectors remain in the same measured position across console,
  VHF instructions and transcript, including iPad split panes.
- Offshore source choices are separate from the inshore model preference;
  refresh preserves the selected point and truthful provider/timestamp labels.
- Vessel acquisition initially displays the boat name or “Vessel location”.
- Authenticated self-PM and reversible DM-only self-block testing, with server
  enforcement, no self push/unread notification and server-ID echo reconciliation.
- Music Stop returns to the compact playlist-first state and clears its active
  queue; Pause retains it. Playlist presentation is polished without discovery.
- Account & Cloud says “Sign in”, followed by Apple, Google and Email options.
  Email retains the existing sign-in code flow.

## Verification

- `VITE_APP_BUILD=114 npm run ship:beta`: TypeScript, production compilation,
  secret scans, web-release parity, bundle budgets, route checks, native sync
  and all **140** final beta contracts passed.
- Full local unit suite: **10,326 passed**, three existing expected failures,
  five skips; **1,132 test files passed**, four skipped.
- Full local exact-production browsers: **205 passed**, seven existing skips,
  zero retries. Source daylight/keyboard/split-pane matrix: **218 passed**,
  zero retries. Controlled browser/native fixtures are not physical yacht tests.
- The final test-only Radio regrouping independently passed **28 cases** in
  Chromium and iPhone-profile WebKit, zero skips/retries (1.5 minutes).
- [CI 34573385941](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34573385941),
  [CodeQL 34573385930](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34573385930)
  and [Lighthouse 34573385929](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34573385929)
  passed for the exact release checkout `c1b48306`. All four CI jobs succeeded.
- Final CI unit tests: **10,326 passed**, three expected failures, five skips.
  Edge behaviour: **113 passed**; AIS: **145 passed**; Pi cache: **249 passed**.
  Production browsers: **221 passed**, seven existing skips (24.9 minutes).
  Source-layout browsers: **218 passed** (9.3 minutes). Direct log counts found
  no failing attempts, retries or flaky classifications; run attempt was 1.
- Lint, formatting, dependency/security/migration audits, TypeScript, changed
  Deno checks, artifact parity and budgets passed. No budgets or assertions
  were relaxed and no tests were quarantined for this release.

The production-case count increased from 205 to 221 because the same three-mode
Radio journey became independently bounded cases per mode and viewport. Each
retains its 90-second limit, strict one-pixel geometry and safety/readback
assertions. The earlier combined test exceeded its whole-case time budget;
the final test split did not change the compiled app. The prior transform-anchor
defect was separately reproduced, repaired and regression-tested. Historical
trace and candidate details remain in [the polish record](./BUILD_114_POLISH.md).

All **418** dist files exactly match native public; sync adds only the two
Cordova stubs, giving **420** native public files. JavaScript is **10,377,309
bytes**, approximately 3,593 bytes below its unchanged 9.9 MiB budget.

| Asset                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `assets/main-CfrfUo2f.js`   | `2778360847856998f2bd715fec31cf0eab08cce065dc9b5307359fbe0361fecc` |
| `assets/index-D-TXmAXb.css` | `17eabbd70917e166d22330d2975b34519a2673e99cb7605a3360d6476b99bb65` |

## Archive and Apple validation

Archive completed **18:08:04 AEST** with Xcode **26.6 (17F113)**, App / Release /
generic iOS, fresh DerivedData, automatic signing and two build jobs:

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-11/Thalassa-1.2.0-114-c1b48306.xcarchive`

Independent archive verification passed: **1.2.0 (114)**, bundle
`com.thalassa.weather`, team `D4TW8A23QZ`, all **420** public files byte-identical,
all **23 arm64 binaries** with nonempty matching dSYM UUID pairs, strict/deep
signing, identical privacy manifest, and no Watch apps, PlugIns or source maps.

Apple validation completed **18:11:03 AEST**, reporting **Validated App /
EXPORT SUCCEEDED**, exit 0, with no validation errors or warnings. Automatic
build-number management was disabled. Independent verification of the
distribution-signed validation package also passed: Apple Distribution,
`get-task-allow=false`, production APNs, beta reports, Apple sign-in, WeatherKit
and time-sensitive capabilities intact, matching App Store profile/privacy,
all 420 files and all 23 binary/dSYM pairs unchanged.

## Single upload and TestFlight delivery

The same archive was uploaded **once**. Xcode reported **Upload succeeded /
Uploaded App / EXPORT SUCCEEDED**, exit 0, at **18:15:11 AEST**. App Store Connect
initially displayed **1.2.0 (114) — Processing**, created at 6:15 PM, with upload
identifier `37011dc2-b050-4496-8d1a-c7fc13a4b32e`.

The actual distribution package sent to Apple independently passed the same
version/signing/privacy checks and byte/UUID comparisons: **420** public files,
**23** binary/dSYM pairs, no failures or warnings. No repeat upload occurred.

The refreshed Apple Build Uploads list subsequently showed **Complete**. The
existing [Skipper group](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/groups/443260d3-cb60-4c4d-a115-1613b719f3ef/builds)
automatically received the build and displayed **Internal Group · 1 Tester ·
13 Builds**, with **1.2.0 (114) — Testing**, uploaded September 11 at **6:16 PM**,
and 90 days remaining. No testers/groups were added, no duplicate association
was created, and no external or production review was submitted.

The [build's Test Information](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/ios/37011dc2-b050-4496-8d1a-c7fc13a4b32e)
was saved in **English (Australia)**. After reload, the exact **1,409-character**
What to Test text below remained, with the correct build/locale, **2,591**
characters remaining and Save disabled. Skipper was then read back as Testing.
This confirms availability to the existing internal tester, not that the
physical device has already installed or accepted the build.

### What to Test — English (Australia)

> 1.2.0 (114) - Radio, weather, messaging and playlist polish
>
> Radio Console: Routine, Pan-Pan and Mayday should stay in the same top position on the console, VHF instructions and voice transcript. Check cold opening, closing, rotation and iPad split view. Read the entire script through the final Over; Close and Continue remain reachable. Verify vessel identity, persons aboard and the position receiver before using coordinates. The app does not transmit VHF or confirm DSC delivery; do not send a real distress alert merely to test.
>
> Glass: offshore locations offer the appropriate offshore sources, separately from your inshore preference. Changing source should preserve the exact selected location and refresh its weather, with honest timestamps and fallback labels. Vessel mode should initially show your boat name or Vessel location, not Current Location.
>
> Scuttlebutt PMs: send yourself a private test message, block yourself, check sending is blocked, then unblock and send again. Self-block is DM-only and should not block your own public chat. A self-PM should appear once, without a self push notification or unread badge.
>
> Apple Music: Stop returns to the compact playlist-first screen and clears the active queue; Pause retains it. Check playlist readability and playback after stopping.
>
> Account & Cloud: Sign in opens Apple, Google and Email options. Email uses the existing sign-in code flow.

## Server state and physical acceptance

The authenticated self-test migration `20260911141000_chat_self_test.sql` and
`proxy-stormglass` version 33 were already deployed and verified before release;
neither was redeployed during TestFlight delivery. The migration passed **57
isolated PostgreSQL/RLS assertions twice**, rolled back after each fixture run.
No customer messages, block rows or accounts were modified for verification.

The reported nine-day SPITFIRE age was investigated separately: the publication
was approximately 14 minutes old when checked, while startup can display an
older cached report. The actual phone report was not captured. This release
does not invent a fresh timestamp, claim that incident was reproduced, or add
a new cache-retention policy; see the linked polish record.

After installing, check the actual iPhone/iPad, Pi position source, self-PM/block,
email sign-in and Music Stop/Pause. No real music playback, authentication email,
self-PM, VHF/DSC distress or Guardian emergency was sent merely to test this
release. The Radio Console does not transmit VHF or confirm DSC delivery.

Local evidence: `/private/tmp/thalassa-release114.EIIB06/`, including
`ci-evidence.md`, archive/validation/upload logs and independent JSON checks.
