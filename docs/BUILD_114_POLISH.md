# Build 114 — polish candidate

Status: **release held for a CI-discovered Radio layout repair; not uploaded to TestFlight**.
Build 113 and its archive are unchanged. Version remains 1.2.0; the next native
build counter is 114.

Superseded compiled source: `f781d6192747cb732600ba348a753e490ca4e678` on
`codex/build-107-daylight-split-view`.

## Scope

- Keep Routine / Pan-Pan / Mayday selectors in the same measured screen slot
  on the Radio Console, VHF instructions and transcript, including split panes.
- Separate offshore source selection from the inshore atmospheric preference.
  Preserve the selected point during model refresh, account/selection fences,
  and truthful provider/fallback provenance.
- Use the vessel name or “Vessel location” while the vessel fix resolves.
- Add authenticated self-PM testing, including a reversible DM-only self block,
  server enforcement, no self notification, and server-ID echo reconciliation.
- Make Music Stop return to the compact playlist-first state; Pause retains
  the current queue. Improve existing playlist presentation without discovery
  features or new account integrations.
- Account & Cloud says “Sign in”; the next page offers Apple, Google and Email.
  Email retains the existing email-code flow, not a new password system.

## Server changes — verified

Only project `pcisdplnodrphauixcau` (Thalassa Marine Forecasting) was changed.

`20260911141000_chat_self_test.sql` is applied. Readback verified both complete
function bodies, pinned `pg_catalog, public` search paths, authenticated-only
RPC execution, the exact migration ledger text, and unchanged existing peer
policies/consent helpers. New INSERT permission is exactly
`sender_id = recipient_id = auth.uid()`, with payload, moderation and fail-closed
block checks. No customer messages, block rows or account records were deleted,
sent or modified during verification.

The migration passed **57 isolated PostgreSQL/RLS assertions twice**, using
temporary fixture tables and transformed function definitions, followed by
ROLLBACK. This is server-policy proof, not a real handset delivery test. A
guarded recovery script and pre-change catalog snapshot are retained locally.
An initial concurrent CLI login attempt failed before connecting; a serialized
read proved it had not applied. The successful guarded apply was then read back;
ledger quoting was corrected to byte-match the committed migration text.

`proxy-stormglass` is active at **version 33**. Its bounded source allowlist now
accepts the documented `noaa` GFS selector and two-source fallbacks, retaining
legacy app keys without passing invalid selectors upstream. ICON atmospheric
data uses DWD/Open-Meteo; it is not relabelled StormGlass/DWD wave data.
Downloaded deployed files match the changed local proxy/helper. The existing
session/quota checks remain in place; an unauthenticated request returned 401.
No paid provider call was made merely to exercise deployment.

Primary provider references: [StormGlass weather parameters](https://docs.stormglass.io/weather.md)
and [source catalogue](https://docs.stormglass.io/sources.md).

Local evidence: `/private/tmp/thalassa-polish114.UPW95r/`.

## SPITFIRE age observation — diagnosis, not a new expiry policy

At 14:25 AEST on September 11, the public SPITFIRE artifact was approximately
14 minutes old (`generated_at` 04:12 UTC). Its loader rejects artifacts older
than six hours. The visible picker label represents the saved model preference,
however, whereas the age comes from the complete cached report's `generatedAt`.
The last-report startup cache has no maximum age; it can appear before a new
request completes or remain when offline/providers fail. History-cache expiry
does not expire that separate last-report cache. A nine-day initial report is
therefore possible without the current SPITFIRE publication being nine days old.

No automatic selection of SPITFIRE was found; the default is ICON and model
preferences may restore from disk/cloud. The user's actual phone report was not
captured, so these are verified code paths, not proof of the particular incident.
The model-refresh repairs above preserve coordinates and request the selected
source. Existing data is not made artificially “fresh” by changing its timestamp;
no new cache-retention policy or publisher restart was introduced for this audit.

## Completed integration checks

- Full final unit suite: **10,322 passed**, three existing expected failures and
  five skips; **1,132 suites passed**, four skipped. The first combined run found
  two obsolete inline-source assertions after extracting the location-title
  helper. Those now check its wiring and behaviour, with five additional
  phone/vessel-state cases; the full suite was rerun successfully.
- Full final exact-production browser suite: **205 passed**, seven existing
  skips, zero failures or retries, Chromium and iPhone-profile WebKit (5.1 minutes).
  This includes all 12 radio, 12 footer, six GPS-recovery and four location/model
  selection cases. Final radio screenshots were reviewed in both browsers,
  including the reduced-height night phone and iPad half pane.
- Existing phone, keyboard, daylight and split-pane matrix: **200 passed**, zero
  retries, Chromium and WebKit.
- Music matrix: **18 passed**, zero retries, both browsers at 390px/430px phone
  sizes and an iPad half pane, in day/dark/night themes. Initial and stopped
  player bounds match without a test-side scroll reset. Screenshots were reviewed.
- All **12** packaged radio cases passed in both browsers, with zero retries.
  Exact selector geometry, minimum 14px transcript type, final "Over.", retained
  script positions and unverified-receiver safeguards remain asserted.
- Music lifecycle and accessibility: **49 tests passed**. Delayed native results,
  Stop/Pause ordering, failure messages and same-track replay are covered.
- Whole-project lint passed: zero errors and 59 warnings in unchanged files.
  All **166** migration files passed their audit. Whole-project formatting passed.
- Changed StormGlass edge code passed Deno **2.9.4** type and formatting checks.
- Xcode **26.6 (17F113)** compiled the iOS app successfully, unsigned Debug,
  generic iOS destination, in fresh DerivedData. This checks native MusicKit
  types and linking; it is not App Store validation or a device audio test.
- Model-refresh regressions cover a nine-day cached report: successful refresh
  retains the replacement provider's actual timestamp; failure retains the old
  age and exposes the failure rather than pretending the report is fresh.

Music evidence: `/private/tmp/thalassa-music114.AvQhrP/music-checks.md`.
Browser/native adapters in these tests are fixtures; no real music playback,
authentication email, self-PM or emergency transmission was used for testing.

## Packaged candidate

`VITE_APP_BUILD=114 npm run ship:beta` passed TypeScript, production compilation,
client-secret checks, web-release parity, bundle budgets, route checks, native
sync and all **140** final beta contracts. All **418** web files exactly match
their native copies; sync adds two Cordova stubs.

Unsigned Debug native compilation was repeated after final sync and passed.
Its plist reads **1.2.0 (114)**, and all **420** bundled public files match.
No archive, distribution signing or App Store upload was performed.

JavaScript payload is **10,376,746 bytes**, within the unchanged 9.9 MiB budget
by only **4,156 bytes**. Future additions need size review; no limit was raised.

| Asset                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `assets/main-DyPeVe84.js`   | `a7e3444b483b059e744ae6cacffeffe5e5aa25896b76f39fb03c92b4e575875f` |
| `assets/index-D-TXmAXb.css` | `17eabbd70917e166d22330d2975b34519a2673e99cb7605a3360d6476b99bb65` |

The first full production browser run passed 202 cases and skipped seven existing
cases, but three Chromium phone-resize checks measured a selector mid-transition.
The captured button height was 59.625px; both settled base and dialog were
61.375px, with identical x/y/width. Fluid root font sizing changes the button's
rem padding by exactly 1.75px. The test now awaits actual running/pending selector
animations before capturing the resized baseline. No application animation was
disabled and the strict 1px comparisons were retained. Both the 12-case radio
rerun and the full 205-pass browser rerun used the same compiled bundle.

## Release boundary

### CI-discovered follow-up — September 11

CI run `34564476570` for `926387dc` failed five Linux mobile-Safari Radio
cases (200 passed, seven skipped). CodeQL and Lighthouse passed. No archive
or upload was started. The local macOS WebKit results above did not reproduce
this cross-platform timing sequence.

The traces show the real defect: the portal anchor and browser baseline could
be measured while `PageTransition` was in its staged `entering` pose, before
its double-animation-frame CSS transition began. At that instant no CSS
animation was running and subsequent transform changes did not resize the
element. A phone dialog retained a 405.59375px left offset in a 390px viewport;
the split-pane baseline was displaced by one 498px pane width.

The follow-up observes ancestor style/transition-phase changes and transition
completion/cancellation, with complete listener/observer cleanup. The browser
test also requires the page transition to be idle before capturing its reference
geometry; the strict one-pixel placement and visibility assertions remain.
New hook regressions exercise delayed transform-only changes with no resize
notification and no initially observable animation. Against the original hook,
the identical suite fails all four new cases and passes its two original cases;
with the repair, all six pass. The combined Radio layout, emergency-honesty,
anchor and page-transition suites pass all 34 checks. Scoped lint, formatting
and whitespace checks pass. A replacement build, packaged-browser checks and
green CI are required before release.

CI evidence: `/private/tmp/thalassa-114-radio-ci.8h9aPU/`.
New release evidence directory: `/private/tmp/thalassa-release114.EIIB06/`.

### Superseded candidate boundary

The final follow-up commit changes only this evidence document and the radio
browser test's transition wait; application code and packaged assets remain
those of the compiled-source commit above. The branch is to be pushed together,
with GitHub CI reported separately from these completed local checks.

No archive, upload, external beta submission, authentication email or live music
playback is implied by this file. App Store validation/upload and physical
device acceptance remain separate steps; Build 113 stays the delivered beta.
