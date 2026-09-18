# Build 113 — radio workflow, retained GPS and a quieter Guardian

> Historical record: candidate-stage statuses below are preserved as history.
> Final release evidence is in [Build 113 — TestFlight](BUILD_113_TESTFLIGHT.md), which supersedes those statuses.

Extends the unshipped 1.2.0 (113) candidate, including the Guardian, cold-start
GPS and stable Glass footer changes. This task does not archive or upload to
TestFlight, transmit radio calls or send test alerts.

## Radio workflow

- Opening Radio Console presents VHF instructions first, with call type,
  distress nature, position source and an always-available Continue button.
- Continue opens a separate full-screen voice transcript with an X. On iPad
  split view, both dialogs stay inside their originating pane.
- Routine, Pan-Pan and Mayday scripts remain available without GPS or a DSC
  acknowledgement. Missing identity/position prompts the operator to state it.
- The script stays fixed while being read. Update position explicitly captures
  the latest accepted fix. Coordinates include their observation's UTC date
  and time; retained coordinates are described as last known. A casualty MOB
  datum remains separate from the vessel's position.
- Ordinary messages fit the available screen; text is never reduced below
  14px. Exceptional long names or accessibility scaling retain a clearly
  signposted scroll fallback, with Close and navigation controls pinned.
- Every receiver requires an operator check before its coordinates enter the
  script. The checkbox is not a gate: leaving it unchecked opens the call with
  a manual-position prompt. Phone GPS is explicitly device GPS, not presumed
  aboard. Receiver, selected-vessel and account changes revoke confirmation.

## GPS correction

The old console started an asynchronous foreground GPS request every three
seconds, although each request could take eight seconds. It also assigned a
failed/null result directly into displayed position state, erasing the last fix.

The radio now uses a scoped, read-only source chain: proven direct NMEA, paired
Pi, authenticated Pi-origin cloud telemetry, then already-granted foreground
phone GPS if no boat fix has yet been accepted in this console session.

- Single-flight acquisition and bounded per-source reads prevent overlapping
  polls or accumulating hung requests. All results are fenced against account,
  selected-boat, receiver and component-lifecycle changes.
- A failed read retains the last accepted coordinates with source/age, drops
  LIVE immediately, and retries. It never silently replaces a previously seen
  boat fix with a phone that may be ashore.
- Pi/cloud age uses `extra.position_at`, not the telemetry heartbeat. Direct
  metrics must have been observed after the direct connection boundary, so old
  remote coordinates/course/speed cannot be relabelled during socket reconnect.
- Local freshness is ten seconds; cloud observation freshness is sixty seconds
  and cloud is never labelled LIVE. Invalid, future and stale incoming fixes
  cannot claim freshness. Unproven movement is omitted, not invented as zero.
- Cloud queries filter the selected `boat_id`, but this is only an account
  selection association: the current relay stamps the owner's active selection,
  not the physical Pi pairing. It is therefore **not** automatic proof that a
  receiver belongs to that boat. Operator confirmation is required even for
  matching cloud rows. Published Pi receiver identity revokes confirmation when
  the physical source changes; legacy unidentified cloud observations cannot
  carry reusable confirmation forward.
- Missing legacy `position_at` cannot prove freshness and falls back honestly.
  No shared telemetry schema, Pi runtime, backend policy or GPS service changed.

## Instructions checked against primary guidance

The VHF steps distinguish routine working-channel traffic, Pan-Pan urgency and
Mayday distress. Channel 16 is voice; Channel 70 is DSC only. A universal
five-second DISTRESS hold and an app acknowledgement gate were removed in favour
of the radio's own manufacturer-specific hold/countdown and channel prompts.

Sources: [Maritime Safety Queensland — marine radios](https://www.msq.qld.gov.au/safety/marine-radios),
[AMSA — VHF DSC capability and radio behaviour](https://www.amsa.gov.au/about/regulations-and-standards/022023-vhf-marine-radios-digital-selective-calling-capability),
[AMSA — GMDSS handbook](https://www.amsa.gov.au/safety-navigation/navigation-systems/gmdss-handbook).

## Guardian cleanup

- Removed the repeated successful arm/disarm banners, own-vessel Armed badge
  and bottom visible status paragraph. These no longer add vertical clutter.
- The arm/disarm slider retains its explicit text and accessible pressed state;
  the vessel name and dot change colour. State is not communicated by colour
  alone. The privacy explanation remains available to screen readers.
- GPS/connection failures, operational warnings, broadcast feedback and alert
  feed behaviour are unchanged. No Guardian service or backend changed.

## Verification

- Full-app run before the final Guardian-only cleanup: **10,146 passed**,
  **3 existing expected failures** and
  **5 skipped tests**; **1,119 suites passed**, **4 skipped** (190.70 seconds).
  No quarantines or global test settings were changed.
- **71** dedicated source/hook checks cover polling overlap, failed/late reads,
  reconnect provenance, timestamps, cloud filtering and identity transitions.
  UI, radio phraseology, pane and focus checks also pass. The foreground-location
  privacy contract follows polling into its new hook; the boundary is unchanged.
- Final scoped ESLint, Prettier and whitespace checks pass. Independent safety
  review checked receiver binding and the existing Pi-to-cloud timestamp wire.
- Guardian cleanup: **53** focused UI/service checks passed, including successful
  arm/disarm transitions without banners and failures that stay visible.
- Combined final radio, Guardian and foreground-location regression run:
  **154 tests passed across 12 suites** after the last runtime change.
- Frozen production bundle: **10/10 browser checks passed** in Chromium and
  mobile WebKit (52.3 seconds). Tested 390×844 daylight, 430×932 dark and
  1024×768 split view; ordinary Routine/Pan-Pan/Mayday calls all fit at 20px.
  Mayday has 188px/263px spare on the two phones and 11px inside the smaller
  split pane. Closing/reopening and the other pane's model picker work.
- Very long identities retain all text at the 14px floor with the final Over
  reachable by scrolling and Close pinned. Unconfirmed phone GPS cannot enter
  the spoken vessel position and does not prevent opening the call.
- Browser GPS and provider data were controlled fixtures; external requests
  were blocked. Screenshots were visually inspected. These are not physical
  iPhone/Pi/DSC-radio integration measurements or real distress transmissions.

## Packaged candidate

- `VITE_APP_BUILD=113 npm run ship:beta` completed successfully after the
  Guardian cleanup: TypeScript, secret scans, web-release checks, route lint,
  unchanged bundle budgets, Capacitor sync and all **140** artifact contracts.
- Version remains **1.2.0 (113)** in all four native build configurations.
- Entry: `main-C-9fXJD_.js`; stylesheet: `index-2zfhDrvq.css`. Web/native copies
  have matching SHA-256 checksums:
    - JS: `b0df9225de6402d1022f0c249256e9afb7453b77a69d7b8a6ffaa6fc53523ab0`
    - CSS: `10220a6800370d90e2d5749db8faf3307dba33c08ecc69ab5a931e6939e3791d`
- Bundle check: total **13.35 MB / 18 MB**, JS **9.88 MB / 9.90 MB**,
  entry **18.0 KB / 800 KB** raw. No budget increased.
- Native sync is complete; no archive, validation, TestFlight upload or
  external operational test was performed by this task.

Local evidence directory: `/private/tmp/thalassa-113-radio.VWP0K6/`.
