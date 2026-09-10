# Build 113 — cold-start foreground GPS

This extends the unshipped 1.2.0 (113) candidate containing the Guardian fixes.
Build 112 and its uploaded archive are unchanged. No native upload is implied
by rebuilding and syncing the candidate.

## Source-backed failure mechanism

The installed Capacitor Geolocation 8 iOS implementation does not forward
`maximumAge` to its native location library. Its first callback can therefore
contain an old OS-cached location. Thalassa correctly rejected a timestamp
outside the requested freshness bound, but returned `null` immediately, turning
an acquisition still warming up into “Phone GPS unavailable”. The independent
GPS warm-up and later five-second follower could then recover it.

Local evidence:

- `node_modules/@capacitor/geolocation/ios/Sources/GeolocationPlugin/GeolocationPlugin.swift`:
  `onLocationPermissionGranted` passes timeout, and `handleLocationRequest`
  configures accuracy; neither forwards maximum age.
- `services/BgGeoManager.ts`: the separate background service already documents
  the stale-first-iOS-sample behavior. Weather must not switch to that
  background-capable path to solve foreground acquisition.
- `GeolocationError.swift` defines `OS-PLUG-GLOC-0002` as position unavailable,
  separately from denied, disabled, restricted, invalid-input and timeout errors.

These explain reproducible code paths consistent with the report, not a capture
of the skipper's actual cold-start native callback.

## Correction

- Reacquire after a stale native sample or exactly `OS-PLUG-GLOC-0002`, throttled
  to 250 milliseconds and bounded by the original caller's total timeout.
  Every native retry receives only the remaining time; an overall JavaScript
  deadline also bounds a native request that does not resolve.
- Preserve the original request-time freshness boundary. Do not accept the old
  sample, invent a position, borrow the vessel GPS or use cached weather as
  proof of a live phone fix.
- Recheck already-granted permission before retrying. Revoked permissions stop
  acquisition; approximate-only permission cannot be upgraded by a retry.
  Denied/disabled/restricted/unknown errors, malformed coordinates and invalid
  or future timestamps still fail closed. No new permission prompt or background lease.
- The implicit first GPS-follow read now publishes the existing neutral
  “Finding phone location…” / “Finding boat location…” UI while pending.
  Later genuine outages are not cleared by every retry, and selection/account
  guards still discard obsolete callbacks.

## Verification

- Seven native regressions failed before the service correction; all **54**
  native/general GPS and foreground-permission boundary tests then passed.
- Four new startup/context regressions failed before the UI correction;
  **96** context, GPS-glyph, identity and foreground-boundary tests then passed.
  These totals overlap at the shared boundary suite; they are not additive.
- Full app suite: **10,050 passed**, three expected failures and five skips;
  **1,117 suites passed**, four skipped. Exit 0, 194.18 seconds.
- Scoped ESLint, Prettier and `git diff --check` passed.
- Independent read-only review found no blocker in timeout, privacy or
  selection/account fencing.

- `VITE_APP_BUILD=113 npm run ship:beta` passed TypeScript, the production build,
  byte-identical local preview routes/assets, unchanged bundle budgets, route
  audit, Capacitor sync, secret scans and **140** final beta contracts.
- All **418** files in `dist` byte-match their copies in the iOS app. Main bundle:
  `main-VKUr8H-4.js`; SHA-256:
  `f6d973211d69affc5a10d4bd72dbc70bb9698d808f9de318c99461d7ca8e4dcf`.
- Bundle total **13.34 MB**, JavaScript **9.87 MB** under the unchanged 9.90-MB
  limit. All native build counters remain 113; this candidate is not uploaded.

- All **six** packaged GPS browser checks passed serially in Chromium and
  mobile Safari (final run: 43.7 seconds): pending cold start → fresh fix, pending cold
  start → genuine timeout, and same-location outage → automatic recovery.
  No application store/context was patched; browser GPS and scoped cache were
  controlled and external requests blocked. This is not provider integration
  or physical GPS evidence.
- Mobile pending/recovered captures were visually inspected: the neutral
  acquisition text is readable with navigation available, and the existing
  dashboard returns after acquisition without the phone-GPS error, including
  the asserted WIND 12 kts fixture reading. Captures disable entry animations.
  Weather is
  a controlled cache fixture with external requests blocked, not proof of live
  provider readings or tide availability.

Local test/build evidence: `/private/tmp/thalassa-113-cold-gps.ckSTU7/`.

The JavaScript deadline bounds the caller's wait. Capacitor has no cancellation
API for an outstanding one-shot request, so a late native completion is ignored
rather than cancelled. The initial permission-status query remains outside
that acquisition timeout, as before. Physical-device cold-launch acceptance
remains required; simulated native/browser fixtures cannot certify that timing.
