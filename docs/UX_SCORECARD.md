# UX / UI scorecard — 2026-09-25

Shane's brief: score the app for UX and UI only, target 90 or better, **without
adding, removing or changing any feature**. Every fix below is presentational —
spacing, size, colour, alignment, label and aria wording, scrims, scroll cues,
ordering within a screen.

## How the score is made

- **Captures.** Playwright WebKit renders of all 27 registered views plus 32
  sub-pages, sheets, pickers, onboarding and landscape states: 393×852 dark and
  daylight, 375×667 dark, 852×393 landscape. Each capture carries an automated
  scan (text under 12 px, WCAG contrast, targets under 44 pt, unnamed controls,
  truncation) and its accessibility tree. Harness: session scratchpad `ux/`
  (`capture.mjs`, `extras.mjs`, `scan.mjs`) against `npm run preview` of `dist`.
- **Panel.** Six reviewers each score a group of screens on eight dimensions
  (0–10) and list defects; a seventh judges the whole app for consistency,
  accessibility, copy, daylight mode and state honesty. A referee weights them
  (Legibility 15, Touch 15, Layout 15, Consistency 15, Feedback 15, Navigation
  10, Accessibility 10, Copy 5; the five main tabs ×2; the app row ×3 on
  C/A/W/F/L; a HIGH defect caps its dimension at 7.5), merges and ranks the
  defects, and separates the ones whose fix would change a feature.
- **Noise.** A fresh panel each run moves individual dimensions by 0.2–0.5
  either way. The second run scored 72.7 on a build the third run's panel
  would have put in the mid-70s; read the dimension deltas, not the decimal.

## Runs

| Run               | Build    | Score    | L    | T      | Y    | C    | F    | N    | A    | W    |
| ----------------- | -------- | -------- | ---- | ------ | ---- | ---- | ---- | ---- | ---- | ---- |
| Baseline          | 8644ca8c | 72.7     | 7.24 | 7.50\* | 7.05 | 7.03 | 7.07 | 7.81 | 7.49 | 7.19 |
| After batches 1–2 | 06a8c3e3 | 72.7     | 7.96 | 7.50\* | 7.12 | 6.78 | 6.52 | 7.65 | 7.70 | 7.01 |
| After batch 3     | 705b9103 | **75.4** | 8.10 | 8.06   | 7.26 | 7.13 | 6.85 | 7.91 | 7.56 | 7.60 |

\* capped at 7.5 by a HIGH touch defect (the anchor watch arming bar below the
fold at 375×667, then over the controls). No cap bites in run 3.

Automated scan, all capture sets, baseline → run 3: text under 12 px 1,191 →
41 (the Vessel hub safety words at 9.5 px — kept on Shane's 2026-09-05 call so
OVERBOARD stays one word — and the frozen Instrument Panel clock labels);
daylight contrast failures 286 → 9 (eight on the frozen Glass); truncations
34 → 2 (frozen model picker); unnamed controls 15 → 0.

Weakest screens after run 3: landscape Glass 5.75, the cross-cutting row 5.88,
Vessel hub expanded 6.38, Glass end-of-carousel 6.5, chart with passage strip
6.5, Notifications 6.5, Vessel hub 6.62, Glass 6.75.

## What changed

Commits 8fd4deee, 06a8c3e3, 6cbc1dff, 705b9103 (all presentational):

- **Legibility.** The 12 px floor now covers `text-[6–9px]` and `text-xs`;
  ScopeRadar and polar-chart SVG captions render at 12 CSS px; tab labels are
  12 px and fixed light-on-dark in every palette (they measured 1.08:1 in
  daylight); the beta badge is one 11 px line. Daylight: ~30 muted tints moved
  to their 700/800 shades, white text stays white on red and emerald controls,
  the two hard-coded slate slabs use the soft light surface.
- **Touch.** Alert threshold inputs, Preferences and clock-zone selects
  (appearance-none with a drawn chevron — WebKit ignores height on a native
  menulist), the shared FormField inputs, Factory Reset, Sign In, the polar
  gateway link and the saved-location rows are 44 pt targets. Anchor watch and
  comfort sliders have 28 pt bordered thumbs.
- **Layout.** PageHeader titles wrap instead of truncating; Vessel hub rows
  truncate the status, never the label, and labels wrap; the anchor watch
  arming bar is sticky above the tab bar, the radar keeps its height on short
  phones and sits beside the controls in landscape; the Vessel Profile save
  bar is pinned, opaque, with room beneath the form; the polars page scrolls
  and its diagram is a width-sized square; base picker clear of the MOB rail;
  landscape chart controls and the Mapbox credit clear of the nav toggle and
  the Locate button; totals-tile labels clear their icons.
- **Consistency.** Warnings and Galley render through PageHeader (breadcrumb,
  h1); kebabs share one style and the name "Page actions"; Plan front-door
  icons come from the Icons set, not emoji; the system status button has its
  own glyph and is named "Systems and GPS source".
- **Accessibility.** Settings h1 titles and h2 sections; sr-only h1 on the
  Glass; breadcrumb is a landmark with aria-current; every Notifications
  switch and threshold, the Satellite Mode toggle, the default-port field and
  each task menu ("Options for <task>") have names; decorative icons are
  aria-hidden across the icon set; maintenance badges say "3 overdue · 2 due ·
  37 ok" visibly; the parent tab stays selected on Settings, Voice, Music and
  Warnings; the landscape hamburger names the tab under it.
- **Copy.** Account & Cloud rows in skipper words (Marine forecast, Assistant,
  Charts, Cloud sync, Weather models — one status word, no key tail); settings
  descriptors; one term "Primary device" on the hub card; coach marks in
  sentence case.

## What the referee says 90 needs

Ceiling model (every affected screen-dimension to 9, the app row to 8.5):

| Fix list                                                                | Score       |
| ----------------------------------------------------------------------- | ----------- |
| Now                                                                     | 75.4        |
| + every presentational, non-frozen fix (61 items, ranked in the report) | ≈ 86.0      |
| + the frozen Glass items (17 items, need Shane's sign-off)              | ≈ 87.7      |
| + the non-presentational items (18 items, need Shane's yes)             | ≈ 89.9–90.1 |

Both referees reached the same conclusion: presentational fixes alone stop
around 86. The Feedback dimension is the anchor — its causes are missing
states and invented numbers, which are feature changes.

Next presentational batch, by value: daylight surface tokens for
`bg-white/5|10` and `border-white/5|10` (+0.84), every sub-page through
PageHeader incl. the parked Voice page (+0.72), chart coach marks reworded
and anchored to controls that exist (+0.72, in `MapHub.tsx`), focus trap and
Escape on the Route Planner actions dialog (+0.72), heading structure on the
map, vessel, voice, maintenance, music and GPX pages (+0.36).

## Decisions only Shane can make

Non-presentational (listed by the referee, none actioned):

1. **Glass renders missing marine values as real numbers** — `WAVE 0 m` with a
   worsening arrow, `PER. 0 s`, `UV 0` (`openmeteo.ts` `wave_period || 0`,
   `MultiModelWeatherService.ts` `waveHeight ?? 0`, `unified.ts`,
   `transformers.ts`). Carrying null through so the existing `--` path fires is
   worth about +1.3 on its own. HIGH.
2. **MOB idle shows READY with no GPS fix** while Radio and NMEA say "No fix"
   (`MobPage.tsx`). HIGH.
3. Anchor Watch setup has no GPS-fix pill and the wind chip has no source/age.
4. Active Warnings empty state carries no checked-at time, area or offline flag.
5. Saved-port trash (star menu and Settings › Locations) deletes on one tap
   with no confirm or undo.
6. "Locate me" has no busy state and returns silently when no fix arrives.
7. Guardian's sign-in gate offers no Sign In control.
8. Maintenance seeds 40 dated tasks and shows engine hours 0 before any entry.
9. Notifications: High Seas threshold hard-coded in ft; a row tap flips an
   alarm; iOS permission state never shown. Vessel Profile has two wave-height
   fields in different units.
10. Slide-to-add on every Ship's Office page with no tap fallback; Route
    Planner NOW enabled while the pill says LEAVING NOW.
11. Clock-zone picker lists ~400 raw cities; Galley active-meals empty state
    has no add action; Polars "choose one in Settings" is not a link; the
    disclaimer's accept button appears only after scrolling; the tide failure
    card repeats on all 24 slides with no Retry.

Frozen Glass items (need sign-off before any change to `components/dashboard/*`,
`components/Dashboard.tsx`, `TheGlassPage.tsx`): landscape reflow (the weakest
screen), 375×667 clipping of the chips and tide card, rain card light tokens,
carousel dots, duplicate-slide aria, RAIN / PRESSURE grid labels, pin sheet
wording, model picker line-clamp, three 44 pt targets, rain-detail formatting,
hero coach mark placement, Instrument Panel swipe cue / section headings /
copy, nowcast NOW caption, footer provider credit.

Deliberate exception kept: the Vessel hub safety-tile words stay at 9.5 px
(Shane, 2026-09-05/06) and that size is excluded from the legibility floor.
