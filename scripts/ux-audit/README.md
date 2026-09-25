# UX audit harness

Playwright WebKit renders of every registered view, used for the UX/UI
scorecard (see `docs/UX_SCORECARD.md`). Kept in the repo because the first
copy lived in a temp scratchpad and was cleaned away overnight (2026-09-26).

Run against a production preview of the built `dist`:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
node scripts/ux-audit/capture.mjs <out-dir> dark 393 852      # phone, dark
node scripts/ux-audit/capture.mjs <out-dir> light 393 852     # phone, daylight
node scripts/ux-audit/capture.mjs <out-dir> dark 375 667      # small phone
node scripts/ux-audit/extras.mjs  <out-dir> dark ABCD         # sub-pages, sheets, onboarding, landscape
```

Each screen produces `<screen>.png` (2x), `<screen>.scan.json` (text under
12 px, WCAG contrast via canvas-resolved colours, targets under 44 px,
unnamed controls, truncation, off-right overflow) and `<screen>.aria.txt`
(the accessibility tree). `_summary.json` collects the scan per folder.

Seeded storage skips the disclaimer, onboarding and install prompts and
pins the display mode; nothing is written to the app's real data.
