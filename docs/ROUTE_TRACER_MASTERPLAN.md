# Route Tracer Masterplan — the Guided Passage Builder

Owner call (Shane, 2026-07-08): the tracer is the semi-permanent human-in-the-loop
router until the auto-router is 100% trusted, and the curated-fairway flywheel.
Re-cut same day around Shane's guided-builder flow: plan-page entry, marina
bookends at BOTH ends, auto-routed middle, report modal with approvable fixes,
direction arrows, and opt-in community sharing. Grounded in a 3-agent
adversarial audit of the shipped tracer (`24402749`) — every hardening item is
a confirmed finding, not speculation.

**Prime directives** (every phase):

1. **Never lie.** A verdict states what it checked (keel, margin, datum) and
   says "unchecked" rather than inherit a stale or defaulted answer.
2. **Never hard-block.** The skipper owns the line — acknowledgment gates
   ("Sail anyway?"), never refusal.
3. **The line you validated is the line you sail.** Nothing downstream may move
   a traced route's geometry, ever.
4. **Local knowledge on the hard bits, the machine on the tedious bits.** The
   punter traces marinas/bars/rivers (tiers 1–2, where charts are worst); the
   four-tier router runs the open water (tiers 3–4, where it's proven).

---

## The target flow (north star UX)

1. **Plan page**: punter picks origin + destination as normal (most routes
   begin AND end in a marina). App flies to the origin berth at close zoom.
2. **Trace out**: punter drops pins out of their marina — legs grade live,
   green/amber/red, with direction chevrons. If a curated/community lane
   exists, it renders as a **ghost line**: "proven lane — tap to accept, or
   trace your own."
3. **Handoff chip**: when a pin lands in open tier-3/4 water, a chip offers
   **"⚡ Auto to destination"** — an OFFER, never a silent takeover (punter may
   be dodging crab pots). One tap: the four-tier router completes the middle.
4. **Course chip at the handoff**: the first auto leg's true initial course —
   "↘ head 168° — Newport 32 NM" — the exit-the-bar-turn-SOUTH moment.
5. **Arrival bookend**: the router completes to the ARRIVAL HANDOFF (where the
   route enters the destination's berth-dense/marina-mile span —
   `spanNearBerths` detects this today), not to the berth. Camera flies to the
   destination at close zoom for "take her in":
    - **Proven lane exists** → ghost: "proven by _Serene Summer_ (2.4 m) —
      re-checked for your 1.8 m keel ✓". Accept in one tap.
    - **Punter knows it** → trace it, same as departure.
    - **Neither** → router's best guess with an honest caution: "no proven lane
      into this marina — verify with the marina / VHF." Arrival only needs the
      marina entrance/fairway (berths are allocated on arrival).
6. **Report modal**: X clear / Y caution / Z no-go, grouped by severity, each
   issue with a flyTo spot and a one-tap **Fix** (micro-A\* detour on the
   already-built grid) or **Acknowledge** (uncharted/conflict — no fake fixes).
   Approve all or one at a time. Headline: **ONE departure window** — "leave
   09:10–13:30 and every tide gate on this route clears" (intersect all legs'
   `computeTidalWindows`).
7. **Save / Sail / Share**: sail-it starts follow mode instantly (logbook in
   background); **opt-in** community share (default OFF, anonymised, nothing
   publishes without owner review — the harbourmaster queue).

**The network effect**: locals trace their HOME marina exit (what they know
best); every other punter consumes it as their ARRIVAL lane, auto-re-graded
against THEIR OWN keel (shared routes are pin lists — the validator re-grades
per-vessel for free). Locals produce, visitors consume. Navionics has nothing
like it.

---

## Phase 1 — TRUTH & SAFETY (hardening) — FIRST, before any builder work

The audit's three criticals + everything that can put a keel in the mud. These
poison the guided-builder flow identically, so they land first.

| #    | Fix                                                                                                                                                                                                                                                                                                                                                                      | Where                            | Finding                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1.1  | **Draft-change invalidation**: `needsBuild` compares `ctx.draftM !== vesselDraftMetres(settings.vessel)` as well as bbox; clear `tracerCtxRef` on Done (frees the 10–30 MB grid)                                                                                                                                                                                         | MapHub validation effect         | CRITICAL — trace stays green after a draft edit / boat switch                                               |
| 1.2  | **Fix the resolution clamp + hard size cap**: drop `Math.min(60,…)` (inverts the cell budget — a 300 NM trace allocates ~800 MB → jetsam kill); bbox span ceiling ~40 km → `tracerStatus='toolarge'`, grade marks/gates/leads only, "trace too long for depth checks — split it". Rebuild pad → max(0.02°, 25% of span)                                                  | routeTracer `buildTracerContext` | CRITICAL — unbounded memory, main-thread freeze, quadratic rebuilds                                         |
| 1.3  | **No stale verdicts, ever**: clear verdicts + tide labels when a rebuild starts AND on Clear — new pins render grey "pending", never the previous trace's green                                                                                                                                                                                                          | MapHub validation effect         | MAJOR — old area's greens painted onto unchecked water                                                      |
| 1.4  | **Weather refresh must not touch traced geometry**: `refreshRoute` detects `routeGeoJSON.properties._source === 'route-tracer'` → skip the waypoint-replacement merge (weather = display only). Belt-and-braces: `computeRouteFromPlan` prefers `routeGeoJSON` coordinates whenever present                                                                              | followRouteStore, weatherRouter  | CRITICAL — 3 h refresh swaps the validated line for a corridor-optimised one (30 NM lateral allowance)      |
| 1.5  | **Draft honesty in the header**: always show "checking 2.4 m keel + 0.5 m margin"; unset draft (silent 2.5 m fallback) renders amber "default draft — set your vessel" and downgrades `clear` → `caution` until a real draft exists                                                                                                                                      | MapHub panel + routeTracer       | UX CRITICAL — a 3.5 m keelboat gets green lies today                                                        |
| 1.6  | **Sail-it never wedges, never silently fails**: `startFollowing` FIRST (instant, local) → flash → logbook save in background under a `utils/deadline.ts` bound, voyageId patched in when it lands. Uniquify unnamed labels (HH:MM + pins) so the same-day duplicate check can't collide; `DUPLICATE_PASSAGE_PLAN_ERROR` gets its own toast. In-flight flag on the button | MapHub `sailTrace`               | MAJOR ×2 — minutes of dead UI on bad signal; second unnamed trace silently loses its logbook entry          |
| 1.7  | **Sub-hour duration parse**: minutes branch in `parseDurationToHours` (30-min trace currently → 32 log entries spread across 12 h); dedupe origin/destination from the waypoint list                                                                                                                                                                                     | PassagePlanSave, routeTracer     | MAJOR + MINOR                                                                                               |
| 1.8  | **No-go acknowledgment**: `traceHealth.danger > 0` → Sail button turns red "Sail anyway?" requiring a second tap. Never refuses                                                                                                                                                                                                                                          | MapHub panel                     | MAJOR — the green button endorses a route the same screen graded as crossing land                           |
| 1.9  | **Router-consistency golden**: grade the LIVE router's Mooloolaba route through the tracer — must be free of tracer-red. Permanent drift tripwire between `assembleTracerLayers` and `tryInshoreRouteInner`                                                                                                                                                              | tests/repro                      | Structural — keeps the two assemblies honest forever                                                        |
| 1.10 | Small but real: gate false-red fix (`Math.max(halfM*2, 300)` → gate-scaled cutoff); `saveTrace` returns `persisted` so quota failures say "storage full" not "Saved ✓"; in-flight promise dedupe in `fetchTideCurve`                                                                                                                                                     | routeTracer, TideHeightService   | MINOR ×3                                                                                                    |
| 1.11 | **Direction arrows (Phase 1½)**: chevrons along every leg (`symbol-placement: line`, auto-rotated, white + dark halo) on BOTH the tracer line and the follow-mode line — the followed route today has NO direction indication at all                                                                                                                                     | MapHub, useFollowRouteMapbox     | Shane 2026-07-08 — "head south when they exit the bar, not north"; gap affects every route, not just traces |

**Exit criteria**: suite green incl. new goldens; a draft edit mid-trace
visibly re-grades; a 300 NM trace refuses politely; a sailed trace's line is
byte-identical after a forced weather refresh; arrows render on trace + follow.

---

## Phase 2 — GUIDED BUILDER (the flow above, buildable core)

| #   | Feature                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | **Plan-page entry**: "Build it on the chart" from the passage planner — origin/destination flow into the tracer; fly-to-origin-berth at close zoom (kills the zoom-guidance problem structurally)                                                                                                                                                                  |
| 2.2 | **Pin editing**: tap a leg (or its panel row) → "insert here", next tap splices; long-press a pin → delete, neighbours re-join + re-grade. Kills "Undo 24 pins to fix pin 5"                                                                                                                                                                                       |
| 2.3 | **Ghost lanes**: curated/community fairway at either bookend renders dotted grey — "proven lane — tap to accept"; acceptance splices its points as pins                                                                                                                                                                                                            |
| 2.4 | **"⚡ Auto to destination" chip**: appears when the last pin sits in open tier-3/4 water; runs the four-tier router from that pin to the ARRIVAL HANDOFF (berth-dense span boundary at the destination); splices the result as auto-legs (visually distinct)                                                                                                       |
| 2.5 | **Arrival bookend**: camera flies to destination; proven-lane ghost / hand-trace / router-guess-with-caution (three honesty tiers)                                                                                                                                                                                                                                 |
| 2.6 | **Course chips at handoffs**: "↘ head 168° — Newport 32 NM"                                                                                                                                                                                                                                                                                                        |
| 2.7 | **Problem spots ON the map**: ⚠︎ markers at every `issue.at`/`minAt` (computed today, thrown away); tap a row → flyTo + pulse                                                                                                                                                                                                                                       |
| 2.8 | **Pin-on-land diagnose + snap**: "pin 4 is on charted land — drag it seaward"; on drop, spiral-search ≤2× res for nearest navigable cell, snap + haptic                                                                                                                                                                                                            |
| 2.9 | **Ergonomics + copy pass**: 44 pt targets, hit-slop pins, collapse-to-pill panel, saved-route delete confirm, colour legend, plain-English verdict rewrites, tide labels with day context + "(approx)", colour-blind dashes + ⛔/⚠️ prefixes, Done semantics + in-progress persistence, hide Fairway behind dev gate, gate tracer out of embedded/pin/picker views |

---

## Phase 3 — REPORT MODAL (review → approve → sail)

| #   | Feature                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | **The report**: on route completion — X clear / Y caution / Z no-go, grouped by severity, each row flyTo-able                                                                                         |
| 3.2 | **One-tap Fix**: micro-A\* between the offending leg's pins on the ALREADY-BUILT grid → splice detour → re-grade. Approve all or cherry-pick                                                          |
| 3.3 | **Acknowledge** (no fake fixes): uncharted / chart-conflict issues get an ack recorded on the route, not a fabricated detour                                                                          |
| 3.4 | **THE departure window**: intersect every tide-gated leg's windows → "leave 09:10–13:30 and every gate clears" (reuse `computeTidalWindows` + departure-sweep machinery). The screenshot-to-crew line |
| 3.5 | **Grades survive into follow mode**: verdicts stashed on `routeGeoJSON.properties`; `useFollowRouteMapbox` renders per-leg match colours (sky-blue fallback for non-traced plans)                     |
| 3.6 | **Live leg awareness while sailing**: current-leg verdict + next shallow spot + tide countdown ("bar clears in 1 h 40 m") in the banner; Bosun voice reads `issues[]` verbatim                        |

---

## Phase 4 — FLYWHEEL & SHARING (the moat)

| #   | Feature                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **Consent**: default OFF; one-time ask at save — "Help other skippers: share this route anonymously for review?"; persistent settings toggle; identity stripped                                                                                                     |
| 4.2 | **Harbourmaster queue**: Supabase table — submitted traces → review → promote to curated fairway (per-region packs, Pi-syncable). Nothing publishes unreviewed. Shane approves                                                                                      |
| 4.3 | **Draft-relative consumption**: shared routes carry the tracer's draft; consumers get the line RE-GRADED against their own keel automatically ("proven by _Serene Summer_ 2.4 m — re-checked for your 1.8 m ✓"). Directional: reversal re-grades + flips the arrows |
| 4.4 | **Paste-import** (ship first — an afternoon): "Paste coords" parsing the exact Copy format → pins → auto-graded. Mate-sharing over Messages, zero backend                                                                                                           |
| 4.5 | **Share sheet**: Copy payload framed as Share (GPX later)                                                                                                                                                                                                           |
| 4.6 | **Track → trace**: decimate a ship's-log track (Douglas-Peucker ≤50 pins) → trace → validate → save. "Sail it once, save it forever." Also the honest crowd evidence for charted-drying-but-locals-know water (#24)                                                 |

---

---

## Phase 5 — DESKTOP BUILDER (Shane 2026-07-08: "easier from a desktop sometimes")

A gated web page (same auth as the app) that looks like the plan page and runs
the SAME guided-builder flow with a mouse — precise pins, big screen, the
validator is pure TypeScript and runs in any browser. Routes save to the
punter's account (the Phase-4 Supabase routes table IS the sync channel) and
appear on their device ready to sail. Needs a cloud-served layer source for
web contexts (the app reads ENC/OSM from device/Pi) — serve the pi-cache
overlay + installed-cell extracts through Supabase storage or an edge proxy.
Sequenced AFTER Phase 4 because consent + the routes table are prerequisites.

| #   | Feature                                                                                           |
| --- | ------------------------------------------------------------------------------------------------- |
| 5.1 | Auth-gated /plan web page (thalassawx.app), plan-page look, mouse-precision tracing               |
| 5.2 | Cloud layer source: ENC extracts + OSM overlay served from Supabase/edge (web can't reach the Pi) |
| 5.3 | Account-synced routes: build on desktop → sail on the phone (Phase-4 routes table)                |

## Non-goals / deliberate stances

- **No hard blocks** — acknowledgment gates only; the skipper owns the line.
- **No guessed tide windows** — offline red legs stay red with the depth message.
- **No silent takeover** — auto-routing is always an offered chip, never a grab.
- **Solo-lateral side stays advisory** until Wave-3b buoyage-direction
  derivation is wired as a real verdict.
- **Drying-chart false reds** (Tangalooma class) accepted until #24 bathymetry;
  4.6 track-traces are the interim crowd evidence.
- **Worker-thread grid build** is shared tech debt with the live router (same
  UI-lockup root cause) — one fix serves both; 1.2's size cap bounds the damage
  meanwhile.

## Verification per phase

- Unit suite grows with every behavioural fix; 1.9's router-consistency golden
  runs in the repro suite (Pi-gated).
- On-water acid test each phase: Shane traces the Mooloolaba exit against his
  own knowledge — the tracer must agree with the skipper who taps it.
