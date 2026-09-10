# Build 112 — Boat Network hardware setup

## Scope

Source commit: `ae5a13b4`. Native counters: **1.2.0 (112)**.

The former Settings → Advanced → Boat Pi setup controls now have one home:
**Vessel → Boat Network → Boat hardware & integrations**. The expandable card
sits below the network status and before chart management. It uses the existing
Pi panel, settings store and save action without changing pairing, installation,
cache, anchor-dashboard or pinned-transport security behavior. Remote Access
remains a single existing section. Stale Settings tab hints fall back safely.

Controls load only when expanded and use the existing page scroll area. The
header follows the day/dark theme and remains inside its tablet pane.

## Verification

- 48 focused tests passed across eight suites, including settings persistence,
  disclosure lifecycle, stale hints, identity isolation and the native Pi gate.
- Eight browser scenarios passed: 320 × 568 phone and 1024 × 768 half-pane,
  light/dark, Chromium/WebKit. The fixture mounts the real lazy Pi panel, blocks
  external requests, and keeps settings changes in memory. No yacht or account
  settings were changed by the tests.
- Browser checks cover horizontal overflow, pane containment, fixed header,
  access to the final Wi-Fi setup button by normal scrolling, and collapse.
  Representative WebKit screenshots were inspected.
- Scoped formatting and ESLint passed with no errors. Five existing AvNavPage
  warnings remain; unrelated connection behavior was not changed.
- `VITE_APP_BUILD=112 npm run ship:beta` passed: TypeScript, production build,
  web-release checks, bundle budget, route audit, iOS sync and artifact scans.
  All 140 final beta contracts passed. Local build log:
  `/private/tmp/thalassa-boat-hardware112.PyLomj/ship-beta.log`.
- All 418 compiled files exactly match their iOS public copies. Main bundle:
  `assets/main-DhqHm82t.js`, SHA-256
  `1b9e3db40f2c1ebe3d808f3b58a0e42504858bf80fb3baa956c655928dfc5846`.

## Delivery boundary

This is preparation for the next native build, not a TestFlight release.
Delivered build 111 and its archive are unchanged. Real-device confirmation of
the moved panel with an already-paired Pi remains a release check; automated
layout tests used an unpaired fixture and did not operate physical hardware.
