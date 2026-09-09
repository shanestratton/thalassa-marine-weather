# Build 109 — Sail Plan layout follow-up

Runtime source commit: `9ed309cd`.

This follow-up updates the **unreleased** build 109 after its Scuttlebutt fixes.
It does not alter build 108, archive/upload to Apple, or change GPS selection,
connection-status diagnostics, Signal K, Supabase, or sailing recommendations.

## Change

- The entire hull remains visible. The old second warning badge ended ten units
  beyond the SVG viewBox; warnings now take their own height in normal document
  flow, before Parts of a sail and the existing explanatory text.
- The Yankee-car guide sits beside the aft hull, clear of sails, boom and wind.
  The fore/aft setting is not measured or selected in the current plan: a dashed
  travel outline and explicit caption avoid inventing a position. Existing
  leave-set, rail/pole and pole/gybe guidance is retained, with its detailed
  conditions in the unchanged prose.
- The traveller guide is directly below the drawing, with port/centre/starboard
  labels and a qualitative suggested-position marker that mirrors with the tack.
  No marker is shown for unknown wind/plan, a lowered main, or Running's
  “not controlling trim” advice.
- Gybe down may depict a broad-reaching rig while the plan still gives Running
  advice. The actual advice band is passed separately so the new guide cannot
  silently substitute a different recommendation.
- Day, dark and night use the existing instrument palette. Text and warning
  badges wrap on narrow screens; no surrounding panel receives a new fixed height.

## Verification

- 66 focused unit tests passed across SailPlanDiagram, SailPlanLegibility,
  SailPlanStaysail, SailPlanStability and sereneSailing.
- 34/34 final source-browser checks passed: 24 Sail Plan cases plus the existing
  10 instrument-theme/layout checks, with no retries or skips (1.4 minutes).
  Log: `browser-combined.log` in the evidence directory.
- TypeScript passed. Changed-file ESLint has no errors; TheGlassPage retains its
  twelve pre-existing unused-variable/directive warnings.
- The isolated layout fixture uses the production diagram, actual TRIM prose,
  following Parts of a sail, real daylight styles and the app's night scrim.
  It does not access a user account, yacht, GPS or backend.
- Phone widths 320/390/430 and a 1024px iPad half-pane are checked in both Chromium
  and WebKit, across day/dark/night, both tacks and all five bands, plus unknown
  wind/band, stowed sails and gybing. Both warning badges are individually scrolled
  into view and checked for viewport containment and occlusion.
- Preview captures use a taller viewport only after the real phone-height
  assertions, avoiding WebKit's cropped capture of a tall element inside a
  scrolling panel. Phone width and production layout remain unchanged.

Evidence: `/private/tmp/thalassa-sail-plan.aJVhEY/`.

## Production artifact

`VITE_APP_BUILD=109 npm run ship:beta` completed successfully: production build,
local web-release verification, bundle budget, route audit, client-secret checks,
iOS sync with 19 plugins, and **140 release contracts**. All four Xcode build
counters remain 109. No archive, Apple validation/upload or distribution was run.

- Main entry: `main-CSkVsodo.js`, SHA-256
  `a503fa7644e4cf4b289b00d280339176d800353ef000fef577634dcd95599124`.
- Instrument page: `TheGlassPage-vI4meTkq.js`, SHA-256
  `66f8116c42db7cc597ffccbbc03b9a4c1f17ad7d87e9397d0fe132da0f13983e`.
- Instrument stylesheet: `TheGlassPage-B2f-6tpG.css`, SHA-256
  `bff3905e4bb3a92d643f7d977537976a3497b5fbcbe2cb11b73bb27c5dee59c4`.
- Public logs entry remains `logs-BAlJ4052.js`, SHA-256
  `ff4a57aaa0b482aa07989eaaafe3e37341b946157de6b5bc078a39606501339e`.
- All four assets have identical hashes in `dist/assets` and the synced iOS
  `public/assets`. The compiled instrument chunk contains both new guide marks
  and the not-live/not-measured captions.
- Main stylesheet remains `index-ZFrs0ZGH.css`; the new scoped diagram styles are
  in the instrument page's stylesheet. Total bundle 13.31 MB; JavaScript 9.84 MB
  against the existing 9.90 MB limit.

Build evidence: `ship-beta109.log` in the evidence directory above.

## Physical-device check

In the next installed beta, open Vessel → Instrument Panel → Sail Plan →
Where everything goes. Check both tacks, the Yankee guide beside the hull,
traveller underneath, and both complete warnings before Parts of a sail. Repeat
in daylight and iPad split view. Browser layout evidence is not a physical-iPhone
test or a measurement of actual control positions.
