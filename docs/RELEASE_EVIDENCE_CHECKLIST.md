# Release Evidence Checklist — audit items 18–22

Written 2026-09-05 for the public-beta candidate, from the external audit of
`919b8cb1` and what was verified against the repo and production that day.
This is the device / archive / App Store Connect work that only a signed
physical run can produce. Tick boxes as evidence lands; put dates beside them.

Decisions already made (do not re-open here): **Watch is cut** from this beta
(2026-09-05). **Apple Music is live** and stays live. **In-app deletion is on**.

---

## 18 · Native release evidence

Facts the audit found and that still hold: there is no XCTest/XCUITest target,
`ship:beta` runs no native tests, and the last archive evidence is an unsigned
Release archive from 2026-08-06 (with a Watch binary that must now be gone).

### Archive

- [x] Xcode 26.6 selected (2026-09-06; `xcode-select` had been on the 27.0 beta).
- [x] Build number bumped 101 → 102 on all four configurations, commit 0606365b (2026-09-06).
- [x] `npm run ship:beta` green under Node 24 (Homebrew node@24): 132 release + 140 artifact contracts; bundle 13.15/18 MB, JS 9.71/9.90 MB — 98% of the JS budget, watch it (2026-09-06).
- [x] Archived 2026-09-06 08:58 in Xcode 26.6: 1.2.0 (102), `com.thalassa.weather`, product `Thalassa Marine Weather.app` (icon label stays Thalassa), bundle main-DhSzDRmW.js, 0 source maps, dSYMs present. Archive signature is Apple Development as normal; the Distribution re-sign happens at export.
- [x] Organizer → Validate App passed 2026-09-06 ≈09:15 — "Thalassa Marine Weather 1.2.0 (102) validated. Your app successfully passed all validation checks." First attempt hit Xcode's stale app-record cache (it created the App Store record itself, then could not see it); a relaunch fixed it. App Store record: `com.thalassa.weather`, SKU `com.thalassa.weather`, primary language English (Australia), created by Xcode at 09:04.
- [x] Archive verified: no Watch folder, no PlugIns; background modes = audio, location, fetch (2026-09-06).
- [x] Uploaded 2026-09-06 ≈09:20 — "Thalassa Marine Weather 1.2.0 (102) uploaded". ITSAppUsesNonExemptEncryption=false, so no export-compliance prompt. App Store Connect now holds two records: **Thalassa Marine Weather** (`com.thalassa.weather`, this one) and the older **Thalassa** (`com.thalassa.weather-2025`, never had a build — it is what made the name "Thalassa" look taken).

### TestFlight (2026-09-06)

- [x] Build 102 processed — _Ready to Submit_, expires in 90 days.
- [x] Internal group **Skipper** (Shane) with 102 — no review; installable immediately.
- [x] External group **Beta Skippers** with 102 submitted to Beta App Review (_Waiting for Review_). **Public link OFF** until the device matrix below passes. Funnel: Founding Skippers approval emails carry the link.
- [x] Test Information: contact, OTP review notes, privacy URL; age rating 13+ (UGC + messaging, Terms say not for under-13s).

### Physical-device matrix (Distribution-signed build, from TestFlight)

iPhone:

- [ ] Fresh install → email OTP sign-in → onboarding shows once and only once.
- [ ] Sign out → sign in again on the same install → **no** onboarding (item 14
      fix: a returning account must never be walked through onboarding).
- [ ] Airplane mode at cold boot with a signed-in account → no onboarding, no
      wizard; dashboard shows the empty-state card. Back online → nothing pops.
- [ ] Upgrade path: install the previous TestFlight build, create data, upgrade
      in place → vessel records, diary entries, ship log intact. **Item 10**: the
      vessel database moved out of Documents — after upgrade, open Files → On My
      iPhone → Thalassa: only the S-63 fingerprint file should be visible, no
      `vessel_*.json`.
- [ ] Anchor Watch controlled ashore test (audible check, arm, lock screen,
      background, acknowledge) — do not rely on it as the only alarm.
- [ ] MOB tile: "OVERBOARD" fully legible at Display Zoom → Larger Text.
- [ ] Apple Music: connect on device (MusicKit permission prompt appears),
      play a playlist from the helm, ask Bosun to skip a track. Confirms the
      developer token is issued by `musickit-token` (see 22 · MusicKit).

iPad:

- [ ] Install + launch; tablet split view (long-press The Glass) at ≥1024 pt.
- [ ] Rotation; keyboard does not cover sheet inputs.

Pi / NMEA (aboard):

- [ ] Pair over the pinned HTTPS lane; diary relay; chart sync; AvNav.
- [ ] Wind overlay + passage planner fetch wind through the Pi (GRIB cache).
- [x] ~~JWT reconciliation, Pi half~~ — no longer needed (2026-09-06). The
      dashboard's own toggle text recommends verify_jwt **OFF** with auth in
      the function; all four Pi-called functions guard themselves and stay
      off. Nothing to check aboard.

Offline / reconnect:

- [ ] Airplane mode mid-passage: chart, instruments, ship log keep working;
      entries queue. Reconnect → queue drains, no duplicates.
- [ ] Satellite Mode on (Account → Satellite Mode): confirm in Safari Web
      Inspector network tab that **no** GRIB / radar / AIS / vessel-metadata /
      offline-download / diary media requests are made for 5 minutes of normal
      use; forecast JSON still refreshes.

Authentication and deletion (disposable Apple ID + disposable account):

- [ ] Native Sign in with Apple: fresh authorisation, retained-token
      registration, `/auth/revoke` on sign-out.
- [ ] Typed-confirmation account deletion from Settings → Account.
- [ ] Interrupt the deletion (kill the app mid-way) → relaunch → it resumes and
      completes; the account is locked meanwhile.
- [ ] After deletion: cannot sign back in as that user; Storage has no objects
      under the user id (photos, audio, **diary-video** — added to the inventory
      2026-09-05); local caches cleared or the app says uninstall clears them.
- [ ] Other users' rows survive: a voyage where the deleted user was weather
      master still exists with `weather_master_id` null (item 3 fix).

---

## 19 · OVERBOARD wrap — done in code (`161d6060`)

- [ ] Visual check on device at Display Zoom → Larger Text (covered above).

---

## 20 · Background push contract

Facts: `Info.plist` declares `remote-notification` in `UIBackgroundModes`, and
both `send-push` and `send-anchor-alarm` set `content-available: 1`, but
`AppDelegate.swift` has no `didReceiveRemoteNotification:fetchCompletionHandler:`
— nothing ever runs in the background on a push. The code change removes the
unused declaration and flag rather than adding a handler nobody needs (an
alert push does not need `content-available` to be delivered).

- [ ] After the code change ships: a real anchor alarm push still arrives on a
      locked phone as a Time Sensitive alert and routes to the Anchor screen on
      tap.
- [x] Both Functions redeployed (`send-push`, `send-anchor-alarm`) on
      2026-09-06 — `verify_jwt` pinned `false` in `supabase/config.toml`.

---

## 21 · Production diagnostics

Facts: Sentry (`@sentry/react`) tags releases `thalassa@<VITE_APP_VERSION>` only;
production builds have `sourcemap: false`; there is no native Sentry SDK, so
iOS crash dSYMs are not collected anywhere but Apple.

Code side (in the repo): release becomes `thalassa@<version>+<build>` with the
commit SHA and platform as tags, and production emits **hidden** source maps.

You:

- [ ] Add `SENTRY_AUTH_TOKEN` (org: Thalassa, project: thalassa-web) as a CI
      **secret**, and `SENTRY_ORG` / `SENTRY_PROJECT` as vars, so the upload
      step runs. Without the token the build still succeeds and simply skips
      the upload.
- [ ] Set `VITE_APP_BUILD` in CI vars to the same number as
      `CURRENT_PROJECT_VERSION` for each archive (or wire it from the pbxproj).
- [ ] dSYMs: in Xcode Organizer → the uploaded archive → **Download Debug
      Symbols**, then either upload to Sentry
      (`sentry-cli debug-files upload --org … --project … <archive>.xcarchive/dSYMs`)
      or accept that native crashes are read only in App Store Connect → Crashes.
      Decide once and record it here.
- [ ] Confirm one deliberate test error from a TestFlight build appears in
      Sentry with the right release, build, commit and `platform: ios` tag.

---

## 22 · App Store compliance

### Privacy labels (App Store Connect → App Privacy)

Reconcile against what the app actually collects. Ground truth per data type:

| Data type                       | Collected?                                    | Linked to user                            | Used for tracking | Source of truth                   |
| ------------------------------- | --------------------------------------------- | ----------------------------------------- | ----------------- | --------------------------------- |
| Precise location                | Yes                                           | Yes (voyage/ship log, anchor, float plan) | No                | `services/shiplog`, `GpsService`  |
| Coarse location                 | Yes (0.25° wx cell, anonymous)                | No                                        | No                | `services/weather/wxPublished.ts` |
| Email address                   | Yes (sign-in)                                 | Yes                                       | No                | Supabase Auth                     |
| Phone number                    | Last 4 digits + fingerprint only (Crew List)  | Yes                                       | No                | Terms §Crew List; Twilio Verify   |
| Photos / videos                 | Yes (diary, recipes, profile)                 | Yes                                       | No                | `DiaryService`, Storage buckets   |
| Audio                           | Yes (diary voice, Bosun)                      | Yes                                       | No                | Deepgram token proxy              |
| User content (chat, diary text) | Yes                                           | Yes                                       | No                | `chat_messages`, `diary_entries`  |
| Crash data / diagnostics        | Yes (Sentry, PII stripped)                    | No                                        | No                | `services/sentry.ts`              |
| Product interaction / analytics | No                                            | —                                         | —                 | none shipped                      |
| Advertising / tracking          | No                                            | —                                         | No                | none                              |
| Apple Music library             | Processed on device; **not** sent to Thalassa | —                                         | No                | `AppleMusicPlugin.swift`          |

- [x] App Privacy questionnaire completed in App Store Connect from the table above (2026-09-06).
- [x] Privacy Policy URL set to https://www.thalassawx.app/terms (v2.9) on the App Privacy page (2026-09-06).

### UGC moderation and support procedures (Guideline 1.2)

- [ ] Report a message: works from the message menu and lands in the report
      table (`reportMessage` in `ContentModerationService`).
- [ ] Block a user: available and hides their messages for the blocker.
- [ ] Moderation pipeline: after the item-5 change ships, a message from a
      throwaway account containing an obvious slur is **never seen** by a
      second device (fail-closed pending → rejected), and a normal message
      appears on the second device within ~2 s.
- [ ] Support contact published in the App Store listing and in-app
      (privacy@thalassawx.com is in the Terms; add a support address if
      different).
- [ ] **Reviewer sign-in for App Store review.** Sign-in is email one-time code (no password), so the App Review form's mandatory username/password cannot be filled truthfully. Before submission: a review-only mailbox whose codes you relay via the review notes, or a documented test account. (TestFlight beta review 2026-09-06 worked with "Sign-in required" unticked + notes explaining OTP.)
- [x] TestFlight Test Information saved 2026-09-06: contact, review notes (OTP explained), privacy URL; standard Apple EULA (License Agreement left blank).
- [ ] Written moderation procedure (who reviews reports, within what time)
      exists somewhere you can point Apple at if asked. One paragraph is enough.

### Rights

- [x] AIS redistribution: AISHub written permission (Desimir, 2026-09-02) recorded live in the `public_ais_enabled` column comment (20260905103000 applied 2026-09-05). Shane keeps the email.
- [ ] Charts: S-63 permits per cell; o-charts licence; OpenSeaMap attribution
      shown in the map attribution control.
- [ ] Weather: CC-BY-4.0 attribution for ECMWF/DWD/UKMO/JMA/Météo-France/NOAA
      wherever forecasts are shown or shared; Rainbow.ai, Stormglass,
      WeatherKit per their terms (WeatherKit attribution link required by
      Apple — check it is visible where WeatherKit data appears).
- [ ] Bathymetry: GEBCO attribution.
- [ ] Notices to mariners: AMSA / NGA / UKHO / LINZ source lines shown.

### MusicKit

- [ ] Developer portal → Identifiers → `com.thalassa.weather` → App Services →
      **MusicKit** enabled. (Not an `.entitlements` key; it is an App ID
      service plus `NSAppleMusicUsageDescription`, which is present.)
- [x] Production secrets: `MUSICKIT_ENABLED=true` set and `musickit-token` v15
      deployed in that order on 2026-09-05 (verified 2026-09-06). Apple Music
      stayed up.
- [ ] Verified on a real device (see 18 · iPhone).

### Build number

- [x] `CURRENT_PROJECT_VERSION` = 102 on every configuration (0606365b), uploaded as 1.2.0 (102). `VITE_APP_BUILD = 102` in CI vars still to set (§21).
