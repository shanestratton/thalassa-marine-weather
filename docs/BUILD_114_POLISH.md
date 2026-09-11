# Build 114 — polish candidate

Status: **implementation and verification in progress; not uploaded to TestFlight**.
Build 113 and its archive are unchanged. Version remains 1.2.0; the next native
build counter is 114.

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

- Existing phone, keyboard, daylight and split-pane matrix: **200 passed**, zero
  retries, Chromium and WebKit.
- Music matrix: **18 passed**, zero retries, both browsers at 390px/430px phone
  sizes and an iPad half pane, in day/dark/night themes. Initial and stopped
  player bounds match without a test-side scroll reset. Screenshots were reviewed.
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

## Remaining release verification

Complete the combined production build, native sync, full tests and visual
checks before marking this candidate ready. No archive, upload, external beta
submission, authentication email or live music playback is implied by this file.
