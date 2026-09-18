# Build 113 — stable Glass weather footer

> Historical record: candidate-stage statuses below are preserved as history.
> Final release evidence is in [Build 113 — TestFlight](BUILD_113_TESTFLIGHT.md), which supersedes those statuses.

This extends the unshipped 1.2.0 (113) candidate containing the Guardian and
cold-start GPS fixes. It does not upload or change the installed TestFlight build.

The radio-console addition now extends this candidate. Its radio-stage bundle identity
and verification are recorded in [BUILD_113_RADIO_CONSOLE.md](BUILD_113_RADIO_CONSOLE.md);
the footer-stage bundle below is retained only as historical evidence.

## Correction

The location badge included the legacy offshore model label, while the adjacent
picker already showed the selected forecast model. That longer label wrapped
and increased the footer height. It could also name a different model from the
actual selection.

- The left badge now says only INSHORE, COASTAL, OFFSHORE or INLAND.
- The right picker retains the selected model, with the actual served model in
  its accessible label and tooltip when available.
- Both pills use equal-width slots, capped at 8rem, and a single 2rem-high row
  (128px / 32px at the standard root size). They follow the app's viewport-scaled
  spacing, but do not resize when changing location type or forecast model.
  Labels retain the 12px legibility floor. The forecast age has its own column
  with a 56px minimum, growing to fit wider platform fonts; no wrapping or ellipsis.
- Narrow containers prioritize readable labels and age over decorative icons.
  A refresh failure always keeps a visible warning triangle in the normal
  chevron slot, plus the existing failure label and red styling.
- The picker keeps its existing selection and manual refresh behaviour. No
  weather, location classification, provider or backend logic was changed.

## Verification and candidate identity

- All **27** focused status-strip, dashboard and weather-follow tests passed.
  These include every selectable model, offshore override, the forecast age,
  picker interaction and refresh-failure signalling. The previous full-app
  GPS-stage suite is recorded separately; it was not rerun for this UI change.
- `VITE_APP_BUILD=113 npm run ship:beta` passed TypeScript, production build,
  local release parity, unchanged bundle budgets, route audit, Capacitor sync,
  secret scans and all **140** final beta contracts.
- All **418** files in `dist` byte-match their iOS embedded copies. Main bundle:
  `main-BdNdD9V4.js`; SHA-256:
  `e52d5307cdd31325071206f508b3e5c93f683b2deeaa4c1319064914025fc364`.
- Bundle total **13.34 MB**, JavaScript **9.87 MB** under the unchanged 9.90-MB
  budget. All four native version counters remain **113**.

- All **12** packaged browser scenarios passed serially in Chromium and mobile
  Safari (1.1 minutes): 320/390/430px widths, daylight/dark, with both inshore
  and offshore in every scenario. The 320px cases use the longest label,
  SPITFIRE. Checks measure equal/stable pill widths and heights, readable
  single-line labels and age, at least 12px text, and no footer overflow.
  They also open/close the actual picker, change model and check persistence.
- Mobile screenshots were visually inspected, including 320px daylight
  SPITFIRE and 390px dark ECMWF. These are isolated cached-weather fixtures
  with external requests blocked, not live-provider or physical-phone evidence.
- Final TypeScript, scoped ESLint, Prettier and diff whitespace checks passed.
  Independent review's narrow-screen warning-symbol concern was corrected;
  the subsequent review approved it.

Local evidence: `/private/tmp/thalassa-113-footer.1anE0l/`.

## Pre-upload cross-platform correction

[CI 34539392314](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34539392314)
on `90717317` exposed a real forecast-age overflow: Linux Chromium needed 58px
for the 12px “just now” label, but its grid column was fixed at 56px. All six
Chromium width/theme cases failed through both retries. The model labels and
pill heights were not the cause; upload was held at this release gate.

A controlled local reproducer changed only the age label to a normal monospace
font. The unchanged production artifact then failed the same assertion with the
same values: `scrollWidth=58`, `clientWidth=56`, allowed maximum 57. Red evidence:
`/private/tmp/thalassa-ci-90717317.5cEYa3/footer-wide-font-red.log`.

The narrow correction changes the middle grid track to
`minmax(56px,max-content)`. It preserves the minimum reservation and equal
flexible end slots while allocating the actual text width. The existing browser
matrix now exercises the wider font in both location states and retains every
original clipping, single-row, font-floor and equal-pill assertion. Geometry
attachments also record text and font family for future diagnosis.

All 19 status-strip unit tests, scoped ESLint and Prettier passed. A fresh
production rebuild and full browser/CI gates remain required before upload;
the earlier local passes above do not replace those gates.
