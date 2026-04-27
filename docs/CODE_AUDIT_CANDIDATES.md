# Code Audit Candidates

Running notes compiled during the page-by-page pre-TestFlight QA cycle.
Items in here are things noticed _while doing feature work_ — not a
formal audit. The formal code audit runs after Charts + Scuttlebutt +
Nav Station audits are all locked.

Each item carries:

- **Severity**: `critical` (shipping risk) / `high` (tech debt with
  active cost) / `medium` (cleanup opportunity) / `low` (nitpick)
- **Effort**: rough hours to fix
- **Confidence**: how sure I am this is a real issue vs. context-
  dependent

---

## 1. Typography — design tokens exist but are ignored

**Severity**: high · **Effort**: 2–4h for a systematic pass · **Confidence**: certain

`index.css` already defines a 5-step type scale as CSS custom
properties:

```css
--text-micro: 11px; /* Hints, sub-counts, badges — WCAG floor */
--text-label: 11px; /* Form labels, section headers, metadata */
--text-body: 14px; /* Body text, input values */
--text-title: 18px; /* Page titles, card headings */
--text-hero: 24px; /* Hero numbers, stats */
```

And utility classes:

```css
.text-micro {
    font-size: var(--text-micro);
}
.text-label {
    font-size: var(--text-label);
}
```

But the codebase has **1,504 instances of hardcoded `text-[Npx]`**
across components — most of them the same sizes the tokens already
express:

| Raw pattern     | Count | Semantic equivalent         |
| --------------- | ----- | --------------------------- |
| `text-[11px]`   | 1266  | `text-micro` / `text-label` |
| `text-[10px]`   | 114   | no token yet (sub-micro)    |
| `text-[13px]`   | 36    | no token yet                |
| `text-[9px]`    | 31    | no token yet (WCAG-below)   |
| `text-[12px]`   | 24    | no token yet                |
| `text-[7..8px]` | 16    | no token yet (decorative)   |
| `text-[14px]`   | 4     | `text-body`                 |

**Cost**: every new component has to make a fresh decision about
typography rather than pulling from a system. My own recent work
(swing-radius banner, pin sheet, anchor view, coach mark) all use
raw brackets. I did it wrong.

**Fix**:

1. Add `--text-sub` (10px) and `--text-body-sm` (13px) tokens for the
   two most-used sub-body sizes
2. Mechanical codemod: replace raw `text-[Npx]` with the semantic
   utility where it matches
3. Leave decorative sizes (7/8/9px) as-is — they're context-specific
   labels where the bracket notation is actually clearer

---

## 2. Haversine — 10+ duplicate implementations, subtly different

**Severity**: high · **Effort**: 1–2h · **Confidence**: certain

Counted ten distinct haversine definitions, each in a different file
and using a different output unit:

| File                                    | Name                | Unit |
| --------------------------------------- | ------------------- | ---- |
| `services/AnchorWatchService.ts:127`    | `haversineDistance` | m    |
| `services/shiplog/GpsTrackBuffer.ts:41` | `haversineMeters`   | m    |
| `services/AisGuardZone.ts:74`           | `haversineNm`       | Nm   |
| `services/gpxService.ts:512`            | `haversineNM`       | Nm   |
| `services/isochrone/geodesy.ts:12`      | `haversineNm`       | Nm   |
| `services/WeatherRoutingService.ts:309` | `haversineNm`       | Nm   |
| `components/marketplace/helpers.ts:6`   | `haversineNm`       | Nm   |
| `components/map/useRouteNudge.ts:98`    | `haversineNm`       | Nm   |
| `components/map/useVesselTracker.ts:26` | `haversineM`        | m    |
| `components/map/GhostShip.tsx:33`       | `haversineNM`       | Nm   |
| `services/MobService.ts:55`             | `distanceMeters`    | m    |

Several share the same name but live in different modules. Several
differ only in unit (× 0.000539957 for m → Nm). No tests cross-verify
them.

**Risk**: if one gets a bug fix (e.g. pole-crossing edge case, short-
distance rounding), the others silently drift.

**Fix**: a single `utils/geo.ts` exporting `haversineMeters` and
`haversineNm` (and maybe `haversineKm`). Every other file imports and
deletes its local copy. Mechanical, high-confidence refactor.

---

## 3. Cardinal ↔ degrees — 5 implementations, 4 variants

**Severity**: medium · **Effort**: 30min · **Confidence**: certain

| File                                                   | Name                      | Notes                                             |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------- |
| `utils/format.ts:112`                                  | `degreesToCardinal`       | 16-wind, canonical                                |
| `utils/format.ts:148`                                  | `cardinalToDegrees`       | inverse, canonical                                |
| `utils/logExportHelpers.ts:21`                         | `degreesToCardinal16`     | duplicate of the format.ts one                    |
| `services/weather/api/weatherkit.ts:296`               | `degreesToCardinalSimple` | 8-wind version                                    |
| `components/dashboard/HeroWidgets.tsx:295`             | `cardinalToDeg`           | inline duplicate                                  |
| `components/dashboard/hero/EssentialAnchorView.tsx:63` | `windDirToDeg`            | yet another inline duplicate (my recent addition) |

I added one of these myself in `EssentialAnchorView` without checking
if it existed elsewhere. Mea culpa.

**Fix**: settle on `utils/format.ts` as the source of truth, delete
the duplicates, consider whether the 8-wind "simple" variant is
actually needed or if 16-wind coerces cleanly for all callers.

---

## 4. Type-safety escapes — 155 total

**Severity**: medium · **Effort**: 4–8h to actually type them properly · **Confidence**: high

- `as any` / `: any` / `<any>`: **122 occurrences**
- `as unknown as` / `@ts-ignore` / `@ts-expect-error`: **33 occurrences**

Most are in legacy paths (`services/weather/api/*` transformers, the
old StormGlass types). A targeted pass on the hottest offenders would
be worth it; a blanket sweep is diminishing returns.

**Fix**: prioritise by file — transformer modules first (most
business-logic impact), leave low-traffic scripts / migration files
alone.

---

## 5. Dead code — underscore-prefixed throwaways

**Severity**: low · **Effort**: 1h to audit, delete most · **Confidence**: medium

**102 instances** of `const _somethingUnused = ...` — the linter
pattern for "variable is unused, silence the warning".

Most are either:

- Dead refactoring scars (the `_forceLabel = rowDateLabel` I found
  during the date-label bug)
- "Kept for hook-order stability" (React Rules of Hooks — legit)
- Computed values that used to render but don't anymore

**Fix**: walk the list, delete the truly dead ones, comment the
legit-kept ones (`// kept for hook order stability` etc.) so the next
auditor doesn't wonder.

---

## 6. Magic-number safe-area math in Dashboard layout

**Severity**: medium · **Effort**: 30min · **Confidence**: high

`components/Dashboard.tsx` has multiple fixed-position blocks stacked
by hand-calculated offsets from the safe-area inset:

```tsx
top: 'calc(max(8px, env(safe-area-inset-top)) + 126px)'; // header bar
top: 'calc(max(8px, env(safe-area-inset-top)) + 173px)'; // hero header
top: 'calc(max(8px, env(safe-area-inset-top)) + 251px)'; // conditions card
top: 'calc(max(8px, env(safe-area-inset-top)) + 340px)'; // hero container (collapsed)
top: 'calc(max(8px, env(safe-area-inset-top)) + 420px)'; // hero container (expanded)
```

Each layer's offset is the sum of the heights of all layers above it
plus gaps. When one layer changes height (which it does — we've done
this several times this week), all downstream offsets need to be
recomputed by hand. Nothing catches a mis-count.

**Fix**: declare CONSTANTS at the top of Dashboard.tsx (or a layout
helper):

```ts
const LAYOUT = {
    COMPACT_HEADER_H: 126,
    HERO_HEADER_H: 78, // 251 - 173
    CONDITIONS_CARD_H: 89, // 340 - 251
    HERO_EXPANDED_DELTA: 80, // 420 - 340
};
```

Derive each top/height from the constants. One source of truth per
region, mis-counts impossible.

---

## 7. Dashboard.tsx — 1000+ lines, multiple concerns

**Severity**: medium · **Effort**: 4h for a proper split · **Confidence**: high

`components/Dashboard.tsx` is ~1000 lines handling:

- Dashboard widget context provider
- Rain fetching + caching (Rainbow / WeatherKit)
- Active-day / active-hour state management + rAF batching
- Fixed-layout math (see #6)
- DnD context for metric pin
- Date-label + time-label helpers
- Trend calculation memoisation
- Staleness overlay
- Stop-route confirmation modal

Much of this belongs in hooks: `useRainFeed`, `useActiveCardState`,
`useDashboardLayout`, `useMetricPinDnd`. The render function would
then read like a list of what it composes.

**Fix**: extract in order of least-coupling (rain feed first, then
active-card state, then DnD). Each extract is an independent commit.

---

## 8. Dashboard layout state — binary `essential` vs `expanded`

**Severity**: medium · **Effort**: design-first (4h+ to get right) · **Confidence**: certain

Still only two modes. Every time we've discussed context-aware UI
(anchor view, rain swap, offshore model picker) we've run up against
the limit of "essential is whatever is NOT expanded". A proper
`DashboardMode = 'anchor' | 'transit' | 'essential' | 'expanded'` with
explicit mode-picking logic would unlock the next tier of UX.

**Fix**: not an audit item per se — this is a product decision. Noted
here because the current binary is a constraint on every future
feature that needs "show me X when Y".

---

## 9. No demo / QA mode

**Severity**: high (for testability) · **Effort**: 2–3h · **Confidence**: high

There is no way to force the Glass page into:

- Rain-on-glass scenery (requires actual rain in forecast)
- Anchor view swap (requires AnchorWatchService.state = 'watching')
- Alarm chrome (requires actual drag event)
- Swing-radius auto-suggest banner (requires 30min of position history)
- Offshore model badge different values (requires actual offshore location)

Every visual iteration burns a build + sync + deploy + wait cycle
even for pure cosmetic changes. The three-pass rain drop iteration
this session was partly a tooling problem — I couldn't see what I
was making without the full pipeline.

**Fix**: `?demo=anchor-alarm` / `?demo=rain-heavy` etc. URL params
that force specific states. Gated on `import.meta.env.DEV` so they
can't ship to production. Pure dev-mode scaffolding, paid back in
every future visual iteration.

---

## 10. `components/dashboard/hero/HeroHeader.tsx` is unused

**Severity**: low · **Effort**: 5 min · **Confidence**: high

Discovered during the date-label bug investigation. This file exports
a `HeroHeader` component that isn't imported anywhere. The _other_
`HeroHeader.tsx` at `components/dashboard/HeroHeader.tsx` (same name,
different directory) is the one actually used.

Dead file, with ~400 lines including a `forceLabel` prop that also
isn't used anywhere. Prime deletion candidate.

**Fix**: `git rm components/dashboard/hero/HeroHeader.tsx`. Verify
the build still passes. Done.

---

## 11. Inline Dashboard.tsx settings imports vs. legacy SettingsContext

**Severity**: low · **Effort**: 30min · **Confidence**: medium

Dashboard.tsx uses BOTH:

```ts
import { useSettings } from '../context/SettingsContext'; // legacy
import { useSettingsStore } from '../stores/settingsStore'; // Zustand
```

…and reads from both within the same component:

```ts
const { settings: userSettings, updateSettings } = useSettings();
const subscriptionTier = useSettingsStore((s) => s.settings.subscriptionTier);
```

Indicates an in-flight migration from Context to Zustand that isn't
complete. Two sources of truth for "settings". Which one wins on
write?

**Fix**: trace all writers, pick Zustand as canonical, make the
Context path a read-only facade that delegates to the store. Or just
delete the Context entirely if it's no longer serving anyone.

---

## 12. Pi routing depth — `base.ts` disables Pi shortcut for StormGlass

**Severity**: medium (semi-known) · **Effort**: Pi-side fix required · **Confidence**: high

Found during yesterday's session. `services/weather/api/base.ts`
explicitly disables the Pi shortcut for StormGlass because the Pi's
`/api/weather/stormglass` route drops path/query params and returns
malformed data, which then crashes `transformers.ts` on
`hours[0]`.

This is a latent risk: if anyone re-enables Pi for StormGlass without
knowing the Pi-side bug, we get crashes. It's also a missed perf
win — the Pi cache is otherwise valuable here.

**Fix**: either (a) fix the Pi-side route to preserve path/params and
re-enable, or (b) add a hard assertion in base.ts that explains _why_
the Pi path is off so the next engineer doesn't blindly turn it back
on.

---

## 13. The drop-iteration tooling gap (process, not code)

**Severity**: medium (workflow) · **Effort**: 1–2h (tooling) · **Confidence**: high

The rain-drop saga this session — three iterations from "bubbles" to
"still bubbles" to "windshield drops" — was partly a design-judgment
failure on my part (I should have asked for a reference first), but
it was also a tooling failure: I had no way to preview the modal's
scenery without a full build + sync + TestFlight-free deploy + user
testing on device.

A Storybook-style isolated dev surface for the rain modal (and the
anchor view, and the hero header) would let cosmetic iteration happen
in browser dev-mode, cycling in seconds instead of minutes.

**Fix**: set up Storybook or a simpler `/dev/scenery` route
(import.meta.env.DEV only) that renders the modal in different states.
Tie into #9 (demo mode) — they're the same problem.

---

## 14. AuthBanner + ChatHeader — sub-44px tap targets

**Severity**: high (iOS HIG / a11y) · **Effort**: 1h (visual review needed) · **Confidence**: certain

The Scuttlebutt header bar has multiple buttons below Apple's 44pt
minimum tap target:

- ChatHeader back button: `w-8 h-8` (32×32)
- ChatHeader Profile / DM-inbox / Propose-channel: `w-10 h-10` (40×40)
- ChatHeader Leave-channel: `px-2.5 py-1.5` (~30px tall)
- AuthBanner Sign In + dismiss buttons: ~28–32px tall

UIKit nav-bar pattern is to extend the hit area to 44pt while keeping
the visual chevron small. Tailwind has no built-in "hit area > visual"
helper — either bump to `w-11 h-11` (4–12px bigger circle, mild visual
impact) or wrap the icon in a 44×44 button with a smaller inner
element holding the bg fill.

**Fix**: design call — Shane to confirm whether to bump visual or
split visual/hit-area. Same audit applies to other headers (Charts,
Glass) — do in one sweep so the look is consistent across the app.

---

## 15. Keyboard-offset tracking — FOUR divergent implementations

**Severity**: medium · **Effort**: 1h · **Confidence**: certain

There are now four copies of "track Capacitor keyboard show/hide with
a visualViewport fallback" scattered across the chat surface, each
with subtle differences:

| File                                 | Show event                                            | Hide event         | Cleanup pattern                 | Platform check                  |
| ------------------------------------ | ----------------------------------------------------- | ------------------ | ------------------------------- | ------------------------------- |
| `ChatPage.tsx`                       | `keyboardWillShow`                                    | `keyboardWillHide` | `window.__chatKbCleanup` global | dynamic `import()` + `.catch()` |
| `chat/ChannelProposalModal.tsx`      | `keyboardDidShow`                                     | `keyboardWillHide` | local closure                   | `Capacitor.isNativePlatform()`  |
| `chat/MealCalendar.tsx` (SlotPicker) | `keyboardDidShow`                                     | `keyboardWillHide` | local closure                   | dynamic `import()` + `.catch()` |
| `DiaryPage.tsx`                      | (referenced by ProposalModal comment as the template) |                    |                                 |                                 |

The `Will` vs `Did` event split is the most user-visible bug — `Did`
events fire AFTER the keyboard animation completes, which looks laggy.
ChatPage gets it right; the other two surfaces feel a beat behind on
first focus.

These should converge into a single `useKeyboardOffset()` hook at
`hooks/useKeyboardOffset.ts`. Pin the event names to the smoother
`Will` variant. One source of truth, four call sites collapse to
imports.

**Fix**: extract the hook, return `{ keyboardOffset: number }`,
delete the inline implementations.

---

## 16. Z-index magic numbers — no documented stacking order

**Severity**: medium · **Effort**: 1–2h · **Confidence**: certain

The Scuttlebutt surface alone uses these z-index values:

| Value      | Where                                                                     | Purpose                                     |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `z-10`     | various                                                                   | in-page chrome (status pills, layered text) |
| `z-40`     | ChatComposer attach menu backdrop                                         | dropdown                                    |
| `z-50`     | ChannelProposalModal, multiple modals                                     | "modal"                                     |
| `z-[900]`  | MealCalendar SlotPicker                                                   | full modal                                  |
| `z-[950]`  | RecipeDetail, CustomRecipeForm                                            | recipe modals                               |
| `z-[955]`  | CaptainsTable in MealCalendar                                             | recipe browser takeover                     |
| `z-[9998]` | Track import status toast                                                 | toast                                       |
| `z-[9999]` | PinMapViewer fullscreen, copy/move context, join request, TrackDisclaimer | "make sure this is on top"                  |

The 9998 / 9999 values are the smell. Each was added by a different
PR with the reasoning "I want this above everything else", with no
shared layer dictionary. Result: when two such layers are open
simultaneously, ordering is decided by mount order, not intent. The
TrackDisclaimer (over a track import) and the pin map viewer (over a
pin tap) both claim z-9999 — visible bug if both fire.

**Fix**: add `utils/zIndex.ts` exporting a small dictionary of named
layers (`inPage: 10`, `dropdown: 30`, `bottomSheet: 40`, `modal: 50`,
`fullscreenTakeover: 60`, `toast: 70`, `criticalDialog: 80`).
Replace every magic z-index in components with `Z.modal`, `Z.toast`,
etc. Numbers can grow over time, but the hierarchy stays explicit.

---

## Running list — last updated this morning

Each audit pass (Charts → Scuttlebutt → Nav Station) will likely
surface additional candidates. I'll append to this doc as we go.
