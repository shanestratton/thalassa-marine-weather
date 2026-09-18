# Build 113 — native release evidence

Status: **1.2.0 (113) is Testing in the existing Skipper TestFlight group**.
Apple processing and the saved test-note readback were verified by
**10:36 AEST, September 11, 2026**. Installation is TestFlight → Thalassa → Update.

## Compiled source and scope

Source: `5bcf73acb40b78315abcd2470e97b9c1e6d6563b`, pushed on
`codex/build-107-daylight-split-view`. Version is **1.2.0 (113)**.

- Guardian sender receipts and recipient-feed repairs, plus less repeated
  armed/disarmed text. Explicit slider state and operational failures remain.
- Neutral cold-start GPS acquisition and protection against delayed cache reads
  repainting an obsolete place name over a newly resolved position.
- Stable one-row Glass footer, including wider platform fonts.
- VHF instructions first, followed by a pane-contained full voice transcript.
  A bounded, receiver-scoped GPS reader retains honest last-known fixes and
  does not replace an accepted boat fix with an ashore phone.

The receiver must be checked before its coordinates enter the radio script.
An unconfirmed or missing fix does not block the call; manual-position prompts
remain available. The app does not transmit VHF or confirm DSC distress delivery.

## Verification

- Release-fix tests: **53 passed** across three suites; scoped lint, format and
  whitespace checks passed before commit.
- `VITE_APP_BUILD=113 npm run ship:beta`: TypeScript, production build, secret
  scans, web-release parity, bundle budgets, route lint, native sync and all
  **140** final beta contracts passed.
- Full local unit suite: **10,153 passed**, three existing expected failures,
  five skips; **1,119 suites passed**, four skipped (165.85 seconds).
- Exact-production browsers: **203 passed**, seven existing skips, zero
  retries, Chromium and iPhone-profile WebKit (4.9 minutes).
- Source keyboard/daylight/split-pane matrix: **200 passed**, zero retries,
  Chromium and WebKit (3.9 minutes).
- Final footer and complete-radio-transcript screenshots were visually checked.
  Browser positions/providers were controlled fixtures, not a physical yacht test.
- An additional **20/20** packaged cold-start checks passed with zero retries:
  five live and five timeout cases per engine. All live cases retained the exact
  coordinate-label assertion; no stale cached-name resurrection was observed.
- [CodeQL 34542682729](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34542682729)
  and [Lighthouse 34542682754](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34542682754)
  passed for the compiled-source commit. Full
  [CI 34542682797](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34542682797)
  passed all four jobs for the same commit. CI unit coverage: **10,153 passed**,
  three existing expected failures and five skips. Production browsers:
  **203 passed**, seven existing skips (20.4 minutes). Source-layout browsers:
  **200 passed** (7.9 minutes). No retry or flaky-test classifications were found
  in the browser logs. No tests were quarantined for this release.

All **418** web files match their native copies; sync adds two Cordova stubs.
Bundle total **13.35 MB / 18 MB**, JavaScript **9.88 MB / 9.90 MB**,
entry **18.0 KB / 800 KB**. No budgets or test assertions were relaxed.

| Asset                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `assets/main-B4F7W5gP.js`   | `28f66e3aa64db5953001fd0c95d291bd8b866daa40da0614b437aae0c802f9a7` |
| `assets/index-z3JpzvuJ.css` | `cca293b2c18842a60845ef7475f2137c34fe0754816104339dc89e528dae7985` |

## Archive and Apple validation

Archive completed **09:48:03 AEST, September 11, 2026**, with Xcode
**26.6 (17F113)**, App / Release / generic iOS and fresh DerivedData:

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-11/Thalassa-1.2.0-113-5bcf73ac.xcarchive`

Independent verification passed: correct version/build/bundle/team, all **420**
public files byte-identical, all **23 arm64 binaries** with nonempty matching
dSYM UUID pairs, strict/deep signing, identical privacy manifest, and no Watch,
PlugIns or source maps. The workspace was clean at the compiled-source commit.

Apple validation completed **09:50:46 AEST**, reporting **Validated App /
EXPORT SUCCEEDED**, exit 0. Automatic build-number management was disabled.
The distribution-signed app also passed independent verification: Apple
Distribution, `get-task-allow=false`, production APNs, beta reports, Apple sign-in,
WeatherKit and time-sensitive capabilities intact; matching App Store profile,
all 420 files and all 23 binary/dSYM pairs unchanged from the archive.

## Upload and TestFlight delivery

The same verified archive was uploaded once. Xcode reported **Upload succeeded /
Uploaded App / EXPORT SUCCEEDED**, exit 0, at **10:21:57 AEST**. App Store
Connect displayed **1.2.0 (113) — Processing**, created at 10:21 AM, with upload
identifier `facfc1c2-507b-4113-843f-ec2c01480294`.

The actual distribution package sent to Apple independently passed verification:
all **420** public files and **23** arm64 binary/dSYM pairs match the archive;
Apple Distribution signing and production capabilities are correct, privacy
metadata is unchanged, and there are no Watch apps, PlugIns or source maps.
No further upload was performed.

Apple subsequently reported **Complete** for the upload. The existing
[Skipper group](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/groups/443260d3-cb60-4c4d-a115-1613b719f3ef/builds)
automatically received the build and displayed **1 Tester · 12 Builds**, with
**1.2.0 (113) — Testing**. Its displayed upload date was September 11 at
**10:32 AM**, with 90 days remaining. No testers or new groups were added,
and no external beta-review submission was made.

The [build's Test Information](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/ios/facfc1c2-507b-4113-843f-ec2c01480294)
was saved in **English (Australia)**. After reloading, the exact **1,318-character**
What to Test text below remained, with the Save button disabled and the correct
build and locale still selected. Final Skipper status was then read back as Testing.

The final report and historical-notice changes are documentation only. They do
not change the compiled source identified above or require another upload.

### What to Test — English (Australia)

Saved in App Store Connect and verified after reloading:

> 1.2.0 (113) - Radio Console, Guardian and Glass polish
>
> Radio Console: VHF instructions open first; Continue opens the full voice transcript with a Close button. Check Routine, Pan-Pan and Mayday layouts on iPhone and iPad split screen. Ordinary scripts should fit; unusually long text remains scrollable. Check the vessel identity and actual persons aboard. Readback stays fixed until Update position.
>
> GPS: verify the receiver belongs to the vessel before using its coordinates in a call. Temporary loss should retain clearly labelled last-known position/time, not silently switch from boat GPS to an ashore phone. Cold starts should show a neutral locating state and then the correct selected position, without a brief red Phone GPS unavailable screen or stale cached place-name overwrite.
>
> Glass footer: Inshore/Offshore stays on the left, selected model on the right, without changing the pill height or clipping text on narrow phones.
>
> Guardian: fewer repeated armed/disarmed messages; explicit slider state remains. Confirm own and nearby alerts appear in the feed when testing safely. Genuine GPS and connection failures remain visible.
>
> Do not transmit a real DSC distress alert, Mayday or live Guardian emergency merely to test this build. The Radio Console does not transmit VHF or confirm a distress alert.

## Superseded candidate — never uploaded

CI `34539392314` for `90717317` found six Chromium footer failures and one
WebKit cached-name failure. The footer's 56px age column could not contain
58px platform-font text; a wider-font regression reproduced it locally. A
trace separately proved a delayed startup cache read repainted Sydney after
the coordinate label was already correct. Deterministic unit regressions failed
before the cache guard and passed after it. Neither browser assertion was removed.

That candidate was superseded by the final source above, rebuilt and synced.
No archive from the superseded candidate was uploaded.

Local evidence: `/private/tmp/thalassa-release113.UULIPj/`.

## Physical acceptance

After installing 113, check cold launch and phone/boat switching, ordinary radio
readback fit and last-known GPS labels on the actual device and paired Pi.
No physical radio, DSC distress or live Guardian emergency was transmitted to
test this release. Feed storage checks do not prove APNs delivery or receipt.
