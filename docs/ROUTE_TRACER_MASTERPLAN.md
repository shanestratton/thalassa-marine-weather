# Route Tracer Masterplan — bulletproof + punter-proof

Owner call (Shane, 2026-07-08): the tracer is the semi-permanent human-in-the-loop
router until the auto-router is 100% trusted, and the curated-fairway flywheel.
This plan hardens what shipped in `24402749` and makes it effortless for the
punter. Grounded in a 3-agent adversarial audit (code / punter-UX / sail-fidelity)
run against the shipped commit — every item below is a confirmed finding or a
deliberate product decision, not speculation.

**Prime directives** (apply to every phase):

1. **Never lie.** A verdict must state what it checked (keel, margin, datum) and
   say "unchecked" rather than inherit a stale or defaulted answer.
2. **Never hard-block.** The skipper owns the line — we gate with explicit
   acknowledgment ("Sail anyway?"), never refusal.
3. **The line you validated is the line you sail.** Nothing downstream may move
   a traced route's geometry, ever.

---

## Phase 1 — TRUTH & SAFETY (bulletproof core) — first, before anything else

The three criticals + everything that can put a keel in the mud.

| #    | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                            | Finding                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.1  | **Draft-change invalidation**: `needsBuild` must compare `ctx.draftM !== vesselDraftMetres(settings.vessel)` as well as bbox; clear `tracerCtxRef` on Done (frees the 10–30 MB grid too)                                                                                                                                                                                                                                                    | MapHub validation effect         | CRITICAL — trace stays green after the skipper edits draft / switches boats                                      |
| 1.2  | **Fix the resolution clamp + hard size cap**: drop the `Math.min(60,…)` (it inverts the cell budget — a 300 NM trace allocates ~800 MB and jetsam-kills the app); add a bbox span ceiling (~40 km): beyond it `tracerStatus='toolarge'`, grade marks/gates/leads only, tell the punter "trace too long for depth checks — split it". Grow rebuild pad to max(0.02°, 25% of span) so coast-following traces stop rebuilding every second pin | routeTracer `buildTracerContext` | CRITICAL — unbounded memory, main-thread freeze, quadratic rebuilds                                              |
| 1.3  | **No stale verdicts, ever**: `setLegVerdicts([])` + clear tide labels when a rebuild starts AND on Clear — new pins render grey "pending", never the previous trace's green                                                                                                                                                                                                                                                                 | MapHub validation effect         | MAJOR — old area's greens painted onto unchecked new water                                                       |
| 1.4  | **Weather refresh must not touch traced geometry**: in `refreshRoute`, when `routeGeoJSON.properties._source === 'route-tracer'`, skip the waypoint-replacement merge (weather = conditions/ETA display only). Belt-and-braces: `computeRouteFromPlan` prefers `routeGeoJSON` coordinates whenever present (kills the load-bearing coincidence)                                                                                             | followRouteStore, weatherRouter  | CRITICAL — 3 h refresh swaps the validated line for a corridor-optimised one (30 NM lateral allowance), silently |
| 1.5  | **Draft honesty in the header**: always show "checking 2.4 m keel + 0.5 m margin"; when `vessel.draft` is unset (silent 2.5 m fallback) render amber "default draft — set your vessel" and downgrade all `clear` grades to `caution` until a real draft exists                                                                                                                                                                              | MapHub panel + units             | UX CRITICAL — a 3.5 m keelboat gets green lies today                                                             |
| 1.6  | **Sail-it never wedges, never silently fails**: `startFollowing` FIRST (instant, local), flash "Following ✓", then logbook save in the background under a `utils/deadline.ts` bound, patching voyageId in when it lands. Uniquify unnamed labels (append HH:MM + pin count) so the same-day duplicate check can't fire; catch `DUPLICATE_PASSAGE_PLAN_ERROR` with its own toast. In-flight flag on the button                               | MapHub `sailTrace`               | MAJOR ×2 — minutes of dead UI on bad signal; second unnamed trace loses its logbook entry while flashing success |
| 1.7  | **Sub-hour duration parse**: minutes branch in `parseDurationToHours` (a 30-min trace currently becomes 32 log entries spread across 12 h); dedupe origin/destination from the waypoint list (32→30 rows, no zero-length legs)                                                                                                                                                                                                              | PassagePlanSave, routeTracer     | MAJOR + MINOR                                                                                                    |
| 1.8  | **No-go acknowledgment**: `traceHealth.danger > 0` → Sail button turns red "Sail anyway?" and requires a second tap listing the no-go legs. Never refuses                                                                                                                                                                                                                                                                                   | MapHub panel                     | MAJOR — today the green button endorses a route the same screen graded as crossing land                          |
| 1.9  | **Router-consistency golden test**: route Mooloolaba berth→bar with the LIVE router, then grade its polyline through the tracer — must come out all-green. Any disagreement = recipe drift between `assembleTracerLayers` and `tryInshoreRouteInner` (the known mirror risk) or a grading bug. This test is the permanent drift tripwire                                                                                                    | tests/repro                      | Structural — keeps the two assemblies honest forever                                                             |
| 1.10 | Small but real: gate false-red fix (`Math.max(halfM*2, 300)` → `Math.max(halfM*2, 60)`, or downgrade far crossings to caution); `saveTrace` returns `persisted:boolean` so quota failures say "storage full" instead of "Saved ✓"; in-flight promise map in `fetchTideCurve` (concurrent same-bucket fetches)                                                                                                                               | routeTracer                      | MINOR ×3                                                                                                         |

**Exit criteria**: all 16 existing tests + new goldens green; a draft edit
mid-trace visibly re-grades; a 300 NM trace refuses politely instead of dying;
a sailed trace's line is byte-identical after a forced weather refresh.

---

## Phase 2 — PUNTER-PROOF UX ("easy as")

Ordered by how often the punter hits it.

| #   | Feature                              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | **Insert + delete pins**             | Tap a leg (or its panel row) → arms "insert here", next map tap splices at that index. Long-press a pin → delete it, neighbours re-join and re-grade. Kills the "Undo 24 pins to fix pin 5" disaster on a 29-pin trace. Pure index ops — the pipeline already re-grades on any change                                                                                                                                          |
| 2.2 | **Problem spots ON the map**         | ⚠︎/red dot markers at every `issue.at` / `minAt` (data already computed, currently thrown away); tap a panel row → flyTo + pulse the spot. Converts "2.1 m charted somewhere on a 2 NM leg" into an actionable chart position — decide "drag around it" vs "wait for tide"                                                                                                                                                      |
| 2.3 | **Pin-on-land: diagnose + snap**     | Pin-level message "pin 4 is on charted land — drag it into the water" (today: two cryptic red legs). On drop, spiral-search ≤2× grid res for nearest navigable cell and snap with a haptic + "snapped to water" flash                                                                                                                                                                                                          |
| 2.4 | **Ergonomics pass**                  | 44 pt touch targets (buttons are ~28 px, pins 22 px — give pins invisible hit-slop), 13–14 px body text, collapse-to-pill ("● Tracer (7) · 1 no-go") so the chart underneath stays tappable, confirm before deleting a saved route                                                                                                                                                                                             |
| 2.5 | **Legend + copy rewrites**           | Persistent one-line key: "● green = good water for your keel · ● amber = check it · ● red = no-go at low tide". Reword the four jargon verdicts: "goes the wrong side of the green (starboard) mark — pass between the pair"; "depth data conflicts here — treat as unproven"; "cuts through marina berths"; "…at low tide (LAT)". Tide windows get day context ("clears 08:45–14:30 **today**") and "(approx)" instead of "≈" |
| 2.6 | **Zoom guidance**                    | Pin dropped below ~z13 → amber hint "zoomed out — pins are rough here, zoom in for channel work"; add to empty-state copy                                                                                                                                                                                                                                                                                                      |
| 2.7 | **Done semantics + crash safety**    | Done with unsaved pins → "Trace kept — reopen to continue" + badge the 🧭 button ("🧭 Trace route (7)"); persist the in-progress trace to localStorage so an app restart doesn't eat 20 taps                                                                                                                                                                                                                                   |
| 2.8 | **Colour-blind channel**             | Dash caution legs, double-dash danger legs (`line-dasharray` match on grade); ⛔/⚠️ prefixes in panel rows. ~8% of the punter demographic can't split our exact green/red pair                                                                                                                                                                                                                                                 |
| 2.9 | **Hide 'Fairway', gate the surface** | Fairway JSON export moves behind the dev/debug gate (it's Shane's flywheel, not a punter button — reads as "show me the fairway" and appears to do nothing). Wrap the whole tracer block in `!embedded && !isPinView && !pickerMode` like its neighbours — today it renders in embedded mini-maps and swallows picker taps                                                                                                     |

---

## Phase 3 — MAGIC (the tracer meets the router)

| #   | Feature                              | Detail                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | **"Fix this leg"**                   | One tap on a red leg → micro-A\* between its two pins on the ALREADY-BUILT tracer grid → splice the detour in as real pins → re-grade. The grid is sitting in memory; this is cheap and it's the killer moment: the app doesn't just say no, it shows the way through. Red leg → tap → green path |
| 3.2 | **Grades survive into follow mode**  | Stash `legVerdicts` grades on `routeGeoJSON.properties`; `useFollowRouteMapbox` renders one Feature per leg with the same match-expression colours (sky-blue fallback for non-traced plans). Today the followed line is plain blue — the validation evaporates exactly when it matters            |
| 3.3 | **Live leg awareness while sailing** | Banner shows the CURRENT leg's verdict + distance to the next shallow spot + its tide window countdown ("bar clears in 1 h 40 m"). Feeds Bosun voice verbatim ("why's leg 5 red?" → reads `issues[]`)                                                                                             |

---

## Phase 4 — FLYWHEEL & SHARING (the moat)

| #   | Feature                   | Detail                                                                                                                                                                                                                                                                     |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **Paste-import**          | "Paste coords" in the panel parsing the exact `lat, lon` format Copy produces → pins → auto-graded. Mate-sharing works instantly over Messages with ZERO backend — the app can already produce the format, it just can't consume it. Ship this first, it's an afternoon    |
| 4.2 | **Share sheet**           | Same Copy payload framed as "Share" (native share sheet; GPX later). "Follow my line in" is the killer social feature for this demographic                                                                                                                                 |
| 4.3 | **Track → trace**         | "Save my actual track as a route": decimate a ship's-log track (Douglas-Peucker to ≤50 pins), load as a trace, validate, save. Sail it once on the flood, keep it forever. Also the honest crowd-fix for charted-drying-but-locals-know water (task #24's evidence stream) |
| 4.4 | **Community fairways v2** | Supabase table: submit a validated trace → review queue → promote to curated fairway (per-region packs, Pi-syncable). Replaces the clipboard-paste flywheel. Moderation stays manual (Shane approves) until volume forces otherwise                                        |

---

## Non-goals / deliberate stances

- **No hard blocks** — acknowledgment gates only; the skipper owns the line.
- **No guessed tide windows** — offline red legs stay red with the depth message.
- **Solo-lateral side stays advisory** until the Wave-3b buoyage-direction
  derivation is wired in as a real verdict (candidate for Phase 3).
- **Drying-chart false reds** (Tangalooma class) are accepted until #24
  bathymetry lands; 4.3 track-traces are the interim crowd evidence.
- **Worker-thread grid build** is acknowledged tech debt shared with the live
  router (same UI-lockup root cause) — one fix serves both; scheduled with the
  router's worker migration, not duplicated here (1.2's size cap bounds the
  damage meanwhile).

## Verification per phase

- Unit suite grows with every behavioural fix (16 → ~35 expected).
- 1.9's router-consistency golden runs in the repro suite (Pi-gated).
- On-water acid test each phase: Shane traces the Mooloolaba exit against his
  own knowledge — the tracer must agree with the skipper who taps it.
