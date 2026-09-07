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
- [x] Build number bumped 102 → 103 on all four configurations, commit c9fbd246 (2026-09-06).
- [x] `npm run ship:beta` green under Node 24 (24.19.0) on 231e58d3, 2026-09-07 12:31: 132 release + 140 artifact contracts; bundle 13.17/18 MB, JS 9.73/9.90 MB (98%); iOS bundle main-BkgZEbDP.js, byte-identical to `dist`. 103 carries everything committed to that point — the matrix fixes below **and** the Pi-as-primary section that follows; nothing was held back for 104.
- [x] Archived 2026-09-07 12:43 in Xcode 26.6: 1.2.0 (103), `com.thalassa.weather`, product `Thalassa Marine Weather.app`. Verified from the shell: `public/` byte-identical to the gated `ios/App/App/public` (bundle main-BkgZEbDP.js), 0 source maps, no Watch folder, no PlugIns, dSYMs present, background modes audio / location / fetch, ITSAppUsesNonExemptEncryption=false. Signed Apple Development as normal; the Distribution re-sign happens at export.
- [x] Organizer → Validate App passed 2026-09-07 ≈12:55 — "Thalassa Marine Weather 1.2.0 (103) validated. Your app successfully passed all validation checks." No stale-record retry needed this time.
- [x] Uploaded 2026-09-07 ≈13:00 — "Thalassa Marine Weather 1.2.0 (103) uploaded"; no export-compliance prompt. Processing → internal group Skipper (tester INSTALLED since 102, so the build should appear in the TestFlight app on its own). **Beta Skippers stays untouched and the public link stays OFF** until the matrix passes.

### TestFlight (2026-09-06)

- [x] Build 102 processed — _Ready to Submit_, expires in 90 days.
- [x] Internal group **Skipper** (Shane) with 102 — no review. Tester sat at NOT_INVITED (no email, TestFlight app empty; remove/re-add did not help) until an invitation was created through App Store Connect's own API from the logged-in session (HTTP 201) → state INSTALLED, 2026-09-06.
- [x] External group **Beta Skippers** with 102 submitted to Beta App Review 2026-09-06 10:03 AEST (_Waiting for Review_). Its tester shows "No Builds Available" / NOT_INVITED — expected until Apple approves; auto-notify is on, so the invite sends itself. **Public link OFF** until the device matrix below passes. Funnel: Founding Skippers approval emails carry the link.
- [x] Test Information: contact, OTP review notes, privacy URL; age rating 13+ (UGC + messaging, Terms say not for under-13s).
- [x] Build 103 processed 2026-09-07 ≈13:10 (about ten minutes after upload) — _Ready to Submit_, expires in 90 days, in internal group **Skipper** only; Beta Skippers still holds 102 (_Waiting for Review_). No processing email arrived for 102 or 103: every notification on Shane's App Store Connect user is off ("App Status Reports" = No Countries or Regions), so the signal is the TestFlight app on the phone or the iOS Builds page, not mail.

### Bugs found during the matrix (2026-09-06)

Process: reproduce → find the cause in code or production → fix with a test that would have caught it → ship (edge function deploy, or the next build) → re-check on the phone. Recorded here so the evidence trail shows what beta found.

- [x] **Public Voyage Log shows "the video is still making its way ashore" for a clip that landed.** Photos through, video not. Cause: `diary-video` went private on 2026-09-04 (20260904120000) but `voyage-log` still passed the row's public-bucket URL through; production answers 400 "Bucket not found" and the page reads any non-OK as "not ashore yet". Fix: `publicVideo()` signs the clip for the entry's owner exactly like photos. Ships with `supabase functions deploy voyage-log`; no app build. Re-test: Check again on the public page → the clip plays.
- [x] **102 upgrade deleted the local vessel database.** See the upgrade-path item below; fix c95b5ade, ships in build 103.
- [x] **The weather followed the phone off the boat.** Driving from Scarborough dragged the Glass and Obs weather along; the GPS follower, the boot path and the orchestrator's "Current Location" all read the phone. Now `services/weatherPosition.ts`: bus → Pi (u-blox inside) → the boat's held last fix → phone last. The Glass status strip says which ("Boat GPS · live", "Boat's last fix · 3h ago · tap to change", "Phone GPS"), and a centred boat-or-phone modal appears once per hold when the phone is ≥ 2 NM from her fix; dismissing it keeps the boat. Ships in build 103. Re-test: leave the boat quiet, drive off → the Glass holds Scarborough and the modal offers the phone.
- [x] **Tide station name and graph did not follow the position.** Reported 2026-09-06 14:30: the station arrived only with the 30 NM forecast refetch while the label renamed at 0.5 NM. Fixed 8908491b: a tide-only refresh every 3 NM (`TIDE_REFRESH_NM`), 24 h cached. Ships in 103.
- [x] **Apple Music had no off switch on its page.** Only the floating bar's X stopped it. Fixed 8908491b: a STOP chip beside SPEAKER (stop = pause + clear the queue). Ships in 103.
- [x] **Radio Console transcript ran off the bottom.** Re-laid out 2026-09-06: no page scroll; the transcript owns the middle box and scrolls inside itself; LAT/LON and SOG/COG/UTC sit under it; the channel line (VHF Ch 16 / DSC Ch 70; HF DSC 8414.5 / 6312 / 4207.5 kHz, voice 8291 / 6215 / 4125 kHz) and the three call buttons are pinned 8 px above the tab bar and never move. Ships in 103. Re-test: Distress mode with MOB nature on the phone — everything visible without scrolling.
- [x] **Ship's Log inconsistencies** (2026-09-06 14:23 screenshot) — fixed same day, ships in 103 (+ `supabase db push` for 20260906150000): day rows and the Today group now read the gated total the card uses; day's runs only for passages ≥ 24 h, labelled by dates sailed; LIVE only while recording; recorded speed = receiver SOG (or a gate-confirmed hop), so jitter no longer reads 7.4 kts; per-leg distance kept to 4 dp; a track whose whole footprint fits in a 150 m box prunes at stop and at load (the boat on the hard). Original finding: 0.1 nm on the card vs 2.6 NM in the day rows (gated cumulative vs raw per-leg sum, plus 0.01 NM rounding that inflates jitter legs); "Day 1 05 Sep" on a same-day track (noon-to-noon windows labelled by window start, panel shown for any track crossing noon); LIVE badge means "dated today", not tracking; 7.4 kts max is jitter speed (the accrual fix gated distance only); tiles read zero because the track is classed on land (by design); 0.1 NM sits above the 0.05 empty-track prune. Fix list awaiting Shane's call.

- [x] **Skipper Device card was hard to read.** Re-laid 2026-09-06: vessel name on top, the GPS order beneath (Boat GPS › This device, or just This device), the button says "Press to make this the Primary Device" / "Release — this is not the Primary Device", a faint emerald/cyan edge; same 120 px footprint. Ships in 103.

### Also in 103 — the Pi as primary device (agreed 2026-09-06 evening, built that night and 2026-09-07)

Planned and written up as 104; the 103 bundle was rebuilt after each of these landed, so they ship in 103 and the matrix below covers them too.

- [x] **The Pi is the primary device when she's aboard** (built 2026-09-06 evening, ships in 103). The Pi posts a live snapshot of the whole bus every 5 s to `telemetry-relay` (pairing credential, skipper's internet policy, five-minute backoff) → one row per skipper in `vessel_telemetry`. While that row is under a minute old the Skipper Device card reads "Primary: the Pi" and replaces the claim button with "calypso publishes the boat · phones stand down"; the public page's live marker prefers the Pi's snapshot when it is fresher than the phone's last track point. Ship's log track recording stays on the phone for now. **Deploy:** `supabase db push` (20260906170000), `supabase functions deploy telemetry-relay voyage-log`, then on the Pi `cd ~/thalassa-marine-weather && git pull && cd pi-cache && ./redeploy.sh`. Verify: the row appears in `vessel_telemetry`; `THALASSA_TELEMETRY_PUBLISH=0` in pi.env switches it off.
- [x] **Crew see the Instrument Panel anywhere, no VPN** (built 2026-09-06 evening, ships in 103). Shane's order for the phone: a) the gateway socket — boat LAN, or the same LAN over Tailscale — always wins; b) the cloud row, read every 5 s (60 s on a satellite link) while the panel or the Skipper card is open and fed into the same instrument store, the header saying "Remote · calypso reported 6 s ago"; c) nothing older than a minute is shown. RLS: the skipper, `boat_members` and accepted `vessel_crew` read; only the relay writes. Re-test: Marta's phone, invited as crew, opens the Instrument Panel off the boat.
- [x] **The Pi keeps its internet gate open across restarts when the operator says so** (built 2026-09-07). `THALASSA_PI_WAN_UPLINK=ordinary` in the Pi's `.env` declares a 4G/ordinary uplink and the diary + telemetry relays no longer stand down after a reboot until a phone reconnects; `satellite` pins the gate shut; undeclared keeps the fail-closed default. The app's own policy pushes still apply. Serene Summer's `.env` carries the line. Verified 2026-09-07: the Pi was redeployed at 07:13 and again at 12:24; each boot banner reads "WAN uplink: ordinary (declared) — internet gate stays open across restarts" and the publisher logged `sent` one second later with no phone on the LAN.
- [x] **NMEA Gateway card and page say how the boat is being read** (built 2026-09-07, ships in 103): "Connected · instruments & AIS" aboard, "Away · reading her via calypso" when the cloud feeds the panel, "connect when aboard" otherwise. The socket remains the best source aboard; nothing connects to the Pi directly for instruments any more.
- [x] **Ship's clock keeps the boat's time** (39c090dd, ships in 103): the zone picker defaults to "Ship's position", following the weather's boat position; the phone only while none has been seen.

### Next build (104) — what is actually left

- [ ] The Pi records the Ship's Log track itself (today the phone still records; the Pi only publishes the live snapshot).
- [ ] Verify a claimed phone that leaves the boat while tracking cannot publish the skipper's position as the boat's.
- [ ] Realtime subscription on `vessel_telemetry` instead of the 5 s poll (the table is already in the publication).
- [ ] Whatever the 103 matrix finds.

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
      iPhone → Thalassa: no `vessel_*.json` (the S-63 fingerprint and the
      enc-cells / offline*map_v1 / osm-overlay folders are expected there).
      \_102 FAILED this on 2026-09-06 (checks 1 and 2 passed): Capacitor's
      Filesystem resolves `Directory.Data` to Documents on iOS, so the 102 move
      found every file "already at the destination", skipped the copy and
      deleted the only copy; the sync then re-pulled the server's records, and
      anything edited offline since the last sync was lost. Fixed in
      LocalDatabase (`Directory.Library` + a same-folder guard that refuses to
      delete) for build 103 — re-run this check on the 102 → 103 upgrade.*
- [ ] 103 first look, straight after the upgrade check: Account shows 1.2.0 (103); the Ship's Log no longer lists the on-the-hard 0.1 NM track (150 m footprint prune at load); Vessel → Skipper Device reads "Primary: the Pi" while calypso is publishing; the Glass status strip names its position source ("Boat GPS · live", or "Boat's last fix · … · tap to change").
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

Cloud telemetry (off the boat, no VPN):

- [ ] Tailscale OFF on the phone, away from the boat LAN: Vessel → NMEA Gateway reads "Away · reading her via calypso"; the Instrument Panel header reads "Remote · calypso reported N s ago" and wind / depth / SOG move. Tailscale back ON → the gateway socket wins and the header returns to it.
- [ ] Marta's phone, invited as crew, opens the Instrument Panel off the boat and sees the same — no VPN, no configuration.
- [ ] Ship's clock on "Ship's position" shows the boat's zone and stays there when the phone's zone is changed (Settings → General → Date & Time, Set Automatically off).

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
- [x] Bumped to 103 on every configuration, 2026-09-06 afternoon, for the matrix fixes (vessel database, boat-first weather, tides, STOP, Radio Console, Ship's Log, Skipper card, In irons / wing and wing). `VITE_APP_BUILD = 103` in CI vars still to set.
- [x] Uploaded as 1.2.0 (103) on 2026-09-07 ≈13:00. As packaged, the 103 bundle also carries the Pi-as-primary section (§18). 103 can never be reused; next bump is 104.
