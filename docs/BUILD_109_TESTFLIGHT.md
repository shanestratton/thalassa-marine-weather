# Build 109 — native TestFlight delivery

## Candidate supersession

Shane authorised archive, validation and TestFlight delivery on 10 September 2026. The first archive used runtime `f40e0e0e` (archive-time HEAD `d316b2d7`).
It passed signature, embedded-asset, symbol and Apple validation checks, but
**was not uploaded and must not be distributed**.

The complete packaged-browser matrix found two startup regressions: an empty
first run started GPS following before the user chose a location, and a passive
boot probe replaced a saved port before a usable fix was available. Eight
journeys failed across Chromium and mobile WebKit (welcome, dashboard,
onboarding and wind/tide); 151 passed and seven existing conditional cases were
skipped. The browser assertions were not weakened or changed.

Runtime `17844e97` corrects both boundaries:

- An empty location waits for user intent; it does not start GPS polling.
- Passive boot retains the saved port/report when the receiver is unavailable,
  fails, or the WAN is offline. A successful passive fix is reused directly.
- Delayed boot probes cannot override a newer favourite, receiver choice or
  authenticated identity.
- Explicit phone/vessel GPS choices retain their existing unavailable states
  and do not silently substitute another receiver or a cached named port.

Four focused suites passed 62 checks, including new no-fix, failed-fix,
offline, deferred-selection, receiver-change and account-change regressions.
The independent review found no further blocker in these boundaries.

The initial full unit run passed 9,755 checks, with three expected failures and
five skips, but its StrictMode startup assertion exceeded Testing Library's
default one-second wait under concurrent archive load. Six isolated unchanged
file runs passed 48 checks. Its identical ready-state assertion now has a bounded
five-second wait; it is neither skipped nor retried automatically.

## Corrected production artifact

`VITE_APP_BUILD=109 npm run ship:beta` passed from `17844e97` using Node 24:
TypeScript, production packaging, local byte-identical release/route checks,
bundle budget, iOS sync with 19 plugins, artifact secret checks and all 140
release contracts. The built and synced asset trees are identical.

- Main entry: `main-CBvTe7ch.js`, SHA-256
  `b94baa8b5712c28d1495391062d85022898590f6199e52c501cb91d856ce744c`.
- Application shell: `ApplicationShell-LDCdkQVT.js`, SHA-256
  `6c4cb7fe970845d1acda1bc3430682bab0d07e930404aa5256e18de27c78f2df`.
- Instrument page: `TheGlassPage-DMm0A2mS.js`, SHA-256
  `119f289e9b5428e65732984022ccce35e27ad60304a08046e1b503332650e809`.
- Public logs: `logs-BAlJ4052.js`, SHA-256
  `ff4a57aaa0b482aa07989eaaafe3e37341b946157de6b5bc078a39606501339e`.

Full lint passed with zero errors and 61 existing warnings; all 163 migration
checks passed. See `ship-beta109-final.log` and `lint.log`.

## Final regression evidence

The complete unit suite passed from frozen runtime `17844e97`: **9,765 passed,
three existing expected failures and five skips**, with 1,099 files passed and
four skipped. Exit status was zero; duration 200.79 seconds. Evidence:
`full-unit-quiet.log`.

The preceding full run overlapped compilation and exceeded the unchanged NMEA
network-flap test's 20-second limit. That entire file then passed unchanged in
isolation (12 checks), and the complete quiet run above passed it too. No NMEA
test was modified, skipped or quarantined. The earlier failed run is retained in
`full-unit-final.log`; isolated evidence is `nmea-network-isolated.log`.

The complete immutable production-browser matrix also passed: **159 passed,
seven existing conditional skips**, zero retries, in 3.5 minutes across
Chromium and mobile WebKit. All eight previously failing startup-dependent
journeys passed without changing their assertions. The matrix includes GPS
selection races, Scuttlebutt/PM layout, Glass gestures, sail guides, public
voyage mobile views, OBS display defaults and the non-scrolling wind/tide card.
Evidence: `full-production-final.log` and `production-final-results/`.

## Signed archive and Apple validation

The corrected Release archive completed on 10 September 2026 at 07:29:59 AEST
using Xcode 26.6 (17F113):

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-10/Thalassa-1.2.0-109-17844e97.xcarchive`

Verification confirmed `com.thalassa.weather`, version 1.2.0 (109), minimum
iOS 17.0, all 420 embedded public files byte-identical to the synced build,
23 binaries with matching dSYMs and zero packaged source maps. The strict/deep
code-signature check passed. Apple then returned `Validated App` and
`EXPORT SUCCEEDED` for this corrected archive, without changing the build number.

Evidence: `archive-final.log`, `archive-final-verification.json`,
`archive-final-signature.log` and `validation-final.log`.

## Delivery status

The corrected archive uploaded successfully on 10 September 2026 at
**07:40:18 AEST**. Xcode returned `Uploaded package is processing`,
`Upload succeeded`, `Uploaded App` and `EXPORT SUCCEEDED`, with exit status zero.
Evidence: `upload-final.log`. Build-number auto-management was disabled; the
uploaded build remains **1.2.0 (109)**. Do not rebuild or reuse 109 after upload.

App Store Connect's existing **Skipper** group was verified as internal, with
one tester and **Automatic for Xcode Builds** enabled. No group settings were
changed. Browser security policy subsequently blocked navigation back to the
build list; Shane was asked to open TestFlight manually. Processing completion,
109's actual group assignment and saving its testing notes remain unverified.

App record: `6809058745`; internal group:
`443260d3-cb60-4c4d-a115-1613b719f3ef`. The prepared notes are in
`/private/tmp/thalassa-upload109.fWApFk/What-to-Test.txt`.

Do not distribute the earlier `f40e0e0e` archive or use its older bundle hashes.

Evidence directory: `/private/tmp/thalassa-upload109.fWApFk/`.
The first candidate's `archive.log`, `archive-verification.json`,
`archive-signature.log`, `validation.log`, `full-unit.log` and
`full-production.log` are retained as superseded/negative evidence.

## What to Test

1. Current Location follows the phone; selecting the vessel follows her GPS.
   Compare the place while ashore, deny phone location permission, use Retry,
   and rapidly switch phone/vessel/favourite. The latest choice must remain.
   A saved port should survive startup without a passive fix; a new user should
   see the welcome actions.
2. In Scuttlebutt and PMs, type/send and dismiss/reopen the native keyboard.
   Check the header, input and Send in empty/busy conversations, landscape and
   iPad split view. With a consenting test account, verify both directions of
   block/unblock and permission Retry without losing a draft.
3. On iPad, hold Glass to open two panes. A short tap returns its forecast to
   live without closing the neighbouring page; hold again to close split view.
4. In Sail Plan, check the full hull, Yankee-car guide beside it, traveller
   beneath it and both complete warnings in day/dark/night and split view.
   These remain trim guides, not live hardware-position readings.
5. Update over 108 and verify saved vessel, diary and settings remain intact.

Physical GPS, keyboard, upgrade and sunlight checks remain separate from local
browser and unit evidence. This internal delivery does not change external-beta
groups, public links, the website, the yacht or production services.
