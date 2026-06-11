<!--
  INSHORE ROUTING MASTERPLAN — canonical planning doc.
  Produced 2026-06-12 by a 10-agent deep-dive (6 parallel codebase readers →
  3 independent architecture designs → adversarial synthesis), commissioned
  by Shane: "come up with a world beating plan for our inshore routing."
  Companion docs: ROUTING_COLLAB.md (two-Claude scratchpad, lane split),
  INSHORE_ROUTING_STATUS.md (historical status).
  Owner sign-off pending on the 5 open questions in §8.
-->

# Thalassa Inshore Routing Masterplan

**Goal (owner's words):** "routing from A to B without crossing land, taking into account tide, wind drift, etc, making the route the most efficient."
**Pain:** (1) the algorithm doesn't follow seamanship — red/green lateral pairs and white leading marks; (2) bathymetry occasionally an issue (mostly fixed).
**Synthesis rule applied:** the pragmatic perspective set the ORDER (ship value early, fixture-pinned, lowest risk first), the graph-first perspective set the DESTINATION (the Seaway Graph), and the time/physics perspective is layered exactly where data exists today (tide extremes, CMEMS hourly currents, GFS wind) and stubbed behind typed, provenance-tagged interfaces where it doesn't (tidal streams, harmonic tides).

---

## 1. North star + competitive positioning

**North star:** the only marine app where an auto-route _reads like a pilot's plan_ — passes between every red/green pair on the correct IALA-A side, stands off and lines up the leads, and tells you "leave at 11:20, carry the flood up the river, cross the bar at half-tide rising with 1.1 m under the keel." Every leg carries provenance ("BC channel, reds to port") that Bosun can narrate verbatim.

- **vs Navionics dock-to-dock:** Navionics follows channels via chart-object heuristics but routinely wrong-sides marks, has no transit/leading-line concept, and treats tide as a user-entered static offset. Gate cross-line enforcement (route must pass _between_ the marks of every gate, correct side per direction of buoyage) plus capture-window transits are categorically stronger, and the provenance-annotated polyline is explainable in a way Navionics never is.
- **vs Orca:** Orca's auto-routing is corridor-soft like today's Thalassa, with current-aware ETAs offshore but no inshore tidal gating and no channel-discipline guarantee. The scorecard (wrongSidePasses, channelDisciplinePct) turns "better than Orca" from vibes into a number we publish against fixtures.
- **vs PredictWind:** world-class offshore weather routing, zero inshore channel discipline. Thalassa ends up the only product with both, joined at the Seaway Graph's portal nodes where the inshore layer hands off to the existing isochrone stack — and the inshore departure sweep is the inshore analogue of their departure planner, which they don't do inshore.

---

## 2. Target architecture — the layered stack

```
                        ┌──────────────────────────────────────────────┐
  UI / Bosun            │ Route + per-leg provenance, ETAs, set/drift, │
                        │ tide windows, departure sweep, narration     │
                        └──────────────────────────────────────────────┘
                                        ▲
  ROUTERS               tryInshoreRoute (InshoreRouter.ts — gates unchanged: ≤50 NM, ENC coverage)
                          ├─ SEAWAY_ROUTER_ENABLED → seawayRouter (graph Dijkstra, time-labelled)
                          │     • connector.ts: multi-target grid Dijkstra to portal nodes
                          │     • DETOUR_CAP rule: graph route wins when ≤ 1.35× direct
                          │     • any failure → fall through, byte-identical to today
                          └─ routeInshore (existing engine — permanent fallback path,
                                hardened with wings/exit-penalty/reason-codes in Stage II)
                                        ▲
  SEAWAY GRAPH          services/seaway/ — SeawayGraph {GateNode, portal, junction,
  (destination)           transit-anchor, marina-entrance} + edges {channel, transit,
                          fairway, marina, connector} with polyline, controllingDepthM,
                          buoyageBearingDeg, captureWindow, flowAxisDeg, provenance
                          Compiled from: gateExtractor (chart CATLAM marks via fairlead.ts
                          parser + regional PCA pairs lifted from InshoreRouter.ts + the
                          geometric pairer ported from newport_demo.py find_entrance_gate)
                          • corridorBuilder (wraps fairlead.ts corridorCenterline)
                          • transitExtractor (OSM navigation_line + chart NAVLNE)
                          • fairwaySkeleton (lazy-corridor doctrine, EDT ridge)
                          • marinaCompiler (5 m local grids at cell-import time, on Pi)
                                        ▲
  ENV FIELDS            services/routing/env/EnvFields.ts — TideField / CurrentField2D /
  (physics layer)         WindField2D / SpeedModel, all null-tolerant + provenance-tagged.
                          ExtremesTideField (cosine interp, ships first) → StationTideField
                          (heights mode, later). CmemsCurrentField (hourly THCU, ETA-only).
                          Doctrine: tide changes FEASIBILITY AND TIMING, never preference.
                                        ▲
  DATA                  ENC cells (senc-extractor + Pi, NAVLNE/RECTRC added) • OSM overlay
                          • Supabase regional markers • WorldTides extremes (cached) •
                          CMEMS THCU • GFS wind grid (step-index fixed)
```

**The two load-bearing conflict resolutions:**

1. **Soft costs vs structural gates.** The graph-first design is right that cost tuning cannot _create_ compliance (the 400×→40×/18×→8×/reverted-depth-grading history is the proof), and the pragmatic design is right that a mispaired gate in a structural router is a _confidently wrong route_ — the inverted failure mode. Resolution: ship pair wings + corridor-exit penalty on the existing engine first (Stage II) — they deliver wrongSidePasses=0 within weeks, they harden the fallback path forever, and the same pairing pipeline they exercise is lifted verbatim into `gateExtractor`. The Seaway Graph then ships behind a shadow period (Stage IV) and is promoted only when the scorecard beats the hardened baseline. Nothing in Stage II is throwaway: wings become gate cross-line validation data, the metres-correct pairing feeds the gate extractor, the chart-mark fallback becomes gate tier 1.
2. **Where time lives.** The physics design's seconds-denominated grid A* with wait-at-gate is clever (order-isomorphism preserves all tuning) but it is major engine surgery the pragmatic plan correctly defers, and the graph design is right that time-dependent search is trivial on ~10² edges and painful on 10⁶ cells. Resolution: time enters in two steps — first as **post-processing** (TideAwareAnnotator: route → per-leg ETA → tide window labels, zero engine change, Stage III), then **structurally on the graph** (time-labelled Dijkstra over edges with controllingDepthM, Stage IV). The grid never gets a time dimension. The physics design's vector-triangle SOG, EnvFields contracts, degradation ladder, and "tide never changes preference ordering" doctrine all carry over intact; only its grid-A*-in-seconds phases are dropped in favour of the graph landing zone.

Other explicit resolutions: tide curve = **cosine-from-extremes first** (free, offline, the `stormglass.ts interpolateTides` algorithm already shipped) with ±0.3 m conservatism band; WorldTides `heights` mode is a later opt-in upgrade behind a `mode` param (billing). Solo-mark half-discs stay OBSTRN walls on the grid path but become keep-out half-plane _annotations_ on graph half-gates. Pi engine sync = `cp` recipe once at the end of Stage III (freeze the legacy fallback), then `packages/routing-core` extraction in Stage IV when the seaway modules would otherwise double the hand-sync surface.

---

## 3. Phased roadmap

Lanes per `docs/ROUTING_COLLAB.md`: **Claude A** = tests/docs/callers/UI/data plumbing; **Claude B** = `services/InshoreRouter.ts` + `services/inshoreRouterEngine.ts` + seaway engine internals. All test runs: `NODE_OPTIONS="--max-old-space-size=8192"` (known local OOM).

### Stage I — Lockdown (nothing moves until the camera is rolling)

**Phase 0 — Hygiene + golden lock** · Lane A · **S** (~1 day)

- Flip `ENGINE_DEBUG = false` (`services/inshoreRouterEngine.ts:80` — verified still `true` on master, smuggled in via `81b73d9a`; per-route debug compute ships to production today and contaminates every perf baseline).
- Delete orphaned `services/MarinaGridRouter.ts` (verified zero importers).
- New `tests/inshoreRouter.golden.test.ts` wiring the two orphaned fixtures (`tests/fixtures/newport-rivergate.corridor.json.gz`, `newport-tangalooma.corridor.json.gz` — verified present, consumed by zero tests): connected, endpoint snap <100 m, Rivergate distance 20.46 NM ±2%, caution runs ≤ baseline (10), Tangalooma asserts `debug.leadingApproach` truthy, `phaseTimings` loosely bounded. Second run at **draftM 2.44 (real 8 ft Tayana draft)** — closes open ship-blocker #3 from ROUTING_COLLAB.md.
- **Verify:** CI green; both fixture routes byte-identical to recorded baselines.

**Phase 1 — Scorecard + seamanship fixtures** · Lane A · **M**

- `tests/helpers/routeScorecard.ts`: **wrongSidePasses** (segments crossing a mark→outboard wing line — the owner's complaint as a number), **channelDisciplinePct** (% length within 100 m of pair-chain centreline where one exists within 1.3× direct), XTE p50/p95, turnCount (>25° deltas), cautionRunLengthsM, distanceRatio vs great-circle. Baseline JSON committed to `tests/fixtures/scorecard-baseline.json`.
- `tests/inshoreRouter.seamanship.test.ts`, six synthetic fixtures marked `it.fails` where current behaviour is wrong: (1) gate shortcut, (2) staggered pairs, (3) wrong-side temptation, (4) unnumbered CATLAM marks, (5) buoyed channel through shallow bar, (6) the never-added 6th guardrail from ROUTING_COLLAB.md:250-254 (mid-span shoal + parallel marked channel). Distinct lon regions per test (the documented NavGrid cache-collision dodge, `tests/inshoreRouter.marina.test.ts:84-88`).
- **Verify:** baselines committed; later phases flip specific `it.fails` to `it`.

**Phase 2 — Unit + data correctness** · Mixed lanes · **M**

- `services/units.ts`: `vesselDraftMetres(vessel)` — the single feet→metres authority. Replace all raw consumers: `usePassagePlanner.ts:1024/1444/1739`, `isochroneEnhancer.ts:374/418`, `useVoyageForm.ts:637/639`, `bathymetricRouter.ts:173`, `departureWindow.ts:230`, `OnboardingWizard.tsx:195` auto-estimate. (Lane A — callers, not engine.) Closes ship-blocker #2. Hazard-threshold unit test: 7.87 ft Tayana → 2.40 m, not clamped-5 m.
- **projDiff unit fix** (Lane B, `InshoreRouter.ts:2063-2064` — verified: raw-degree comparison ≈1.1 km, unit-blind): scale PCA projections to metres, gate at `PAIR_PROJ_MAX_M = 250`. Diff `pairDiag` counters on the Rivergate golden before merge; if SE-QLD accepted-pair count drops, loosen to 400 m rather than regress the locked route.
- `WindFieldAdapter.ts:32` forecast-step indexing fix (treats the `[0,3,6,9,12,18,24,36,48,72]` GFS step array as hourly — silently distorts today's offshore isochrones too; binary-search `FORECAST_HOURS` + linear interp).
- **Resurrect the dead tide curve, free path:** extract `interpolateTides` from `stormglass.ts:28-30` into a shared helper; `TideHeightService` builds `heightAt()` from already-cached extremes (its `fetchTideCurve` at :204 currently always returns null because `proxy-tides/index.ts:85` only ever requests `?extremes` — verified). Tag provenance `EXTREMES_INTERP`. Assert `datum === 'LAT'` at hydration; refuse non-LAT curves.
- **Verify:** goldens byte-identical; staggered-pairs fixture flips to pass; `fetchTideCurve` non-null on device; release note for the behaviour-visible draft fix (several offshore paths become ~2-3× less conservative overnight — correct, but re-eyeball both goldens).

### Stage II — Seamanship hardening on the existing engine (the fallback path, forever)

**Phase 3 — Pair wings + corridor-exit penalty** · Lane B · **M**

- Orchestrator: new Step 4.5 in `fetchRegionalMarkers` (after midpoint emission ~`InshoreRouter.ts:2167`) — per accepted pair, emit two `_class:'pair-wing'` rectangles extending **outboard** from each mark along the pair axis: length `clamp(pairDistanceM, 60..150)` m, width 30 m, into the merged OBSTRN layer (renders on the debug map).
- Engine: new **Pass 5c** after Pass 5b NAVLINE (~:1325) rasterizes pair-wings to `CAUTION` + `preferred=0` — never `hardBlocked` (a mispair must degrade to a red wiggle, not `no-path`). Ordering is load-bearing: wings apply _after_ the 100 m-half-width synthetic ribbon so the ribbon can't neutralise them on channels <200 m wide (the wrong-side fixture uses a 150 m channel to catch exactly this). `handlePointFeature` (engine :1063-1077) must skip `_class:'pair-wing'`.
- `EXIT_PENALTY_M = 250` metres-equivalent added in `aStar` neighbour expansion (loop after :1727) when stepping `preferred=1 → preferred=0`. Heuristic stays admissible (additive ≥0). `cellCostMultiplier` untouched — flat-preferred doctrine preserved. 250 m is deliberately 14× below the +3.5 NM DRGARE-dogleg failure bar that forced revert `07fea6c8`.
- Hardening path (later, not now): after two clean releases, promote wings of DEPARE-vouched pairs (`acceptedByDepare`) to hardBlocked; never OSM-rescued or chart-fallback pairs.
- **Verify:** gate-shortcut + wrong-side fixtures flip to pass; **wrongSidePasses = 0** on goldens; golden distance ±5%, zero new caution runs. One knob per commit.

**Phase 4 — CAUTION reason codes + fairlead caution fix** · Lane B · **S/M**

- `cautionReason: Uint8Array` side array (1=SHALLOW_FOR_DRAFT, 2=CHART_CONFLICT, 3=RELAX_CORRIDOR, 4=BRIDGE_CARVE, 5=PAIR_WING) populated at the existing assignment sites (Pass 1 shallow, Pass 2 conflict :974-987, relax retry, bridge carve :2424-2468, Pass 5c). Zero behaviour change alone; exported per-caution-run in `debug` with min `depareVerdict` depth — the substrate for tide windows (Phase 7) and the graph's `depthSource` later.
- `applyFairleadAtGrid` (engine :2904-2966): land predicate currently treats _all_ CAUTION as land, aborting splices exactly on buoyed channels through coarse-bathymetry shallows — the highest-value mark-following case. Change: abort only on `hardBlocked` or reason ∈ {RELAX_CORRIDOR, BRIDGE_CARVE}; SHALLOW_FOR_DRAFT is splice-able but the spliced run **keeps its caution mask** (delete the force-false at :2958-2961; mirror `leadingLine.ts`'s honest caution carry).
- **Verify:** buoyed-shallow-bar fixture splices AND stays red; goldens unchanged.

**Phase 5 — Chart-mark pairing fallback** · Lane B · **M**

- Feed chart BOYLAT/BCNLAT with `CATLAM ∈ {1,2}` through the **same** cluster→pair→midpoint→ribbon pipeline as regional marks, deduped at 50 m. Lower-confidence rules: no solo-hazard emission (a solo chart mark must never become a half-disc wall), no wings (preference only). Kills both the SE-QLD-only limitation and the unnumbered-mark blindness (today both the fairlead OBJNAM regex at `fairlead.ts:75-76` and engine Pass 5 :1192-1216 ignore them) using machinery with two months of tuning history.
- **Verify:** unnumbered-marks fixture flips to pass; Tangalooma gains midpoints; SE QLD goldens byte-identical (dedupe proven).

**Phase 6 — Offline leads (chart NAVLNE)** · tools + Lane B · **M** (operational dependency)

- Add `NAVLNE` + `RECTRC` to `ROUTING_CLASSES` (`tools/senc-extractor/src/s57Classes.ts:68-86`) and to the Pi ogr2ogr `ENC_LAYERS` (`pi-cache/src/routes/enc.ts:134`) — and while in there, add the missing `FAIRWY`/`DRGARE` to the ogr2ogr path so S-57-uploaded cells can drive corridor preference at all.
- `InshoreRouter` merges chart NAVLNE LineStrings into the existing NAVLINE layer — Pass 5b corridor, `leadingLine.ts` snap, and the approach machinery all get chart data for free, **offline**. RECTRC is known-empty in this AU SENC (PHASE_14_SPIKE.md); emit anyway for future cells.
- Operational step: re-extract AU cells on the Pi (`calypso.local`, SG-Lock dongle, oexserverd) — also confirms the deployed cell set is post-`5fa40eb9` ring assembly. If blocked, every other phase still ships (leads stay OSM-online-only, status quo).
- **Verify:** leading-line snap/approach fire with the OSM overlay disabled (Pi-off simulation) wherever the chart carries NAVLNE.

### Stage III — Tide value (the feature no competitor has, zero engine surgery)

**Phase 7 — TideAwareAnnotator + tidal windows** · Lane A · **M**

- `services/routing/env/EnvFields.ts`: the physics design's contracts — `TideField`/`CurrentField2D`/`WindField2D`/`SpeedModel`, all null-tolerant and provenance-tagged, so the degradation ladder is a type property. `ExtremesTideField` wraps Phase 2's cosine curve; `MotoringSpeedModel` wraps `vessel.cruisingSpeed` (kn, default 6 — already used at `departureWindow.ts:230`).
- `services/routing/TideAwareAnnotator.ts`: pure post-processing on any `RouteResult` — walk the polyline with the SpeedModel, per-leg ETA; `services/tidalWindow.ts`: per SHALLOW_FOR_DRAFT caution run (Phase 4's reason codes + min `depareVerdict` depth), `requiredRiseM = draft + tideSafetyM − minDepth` → passable windows over 24 h. LAT is consistent end-to-end (chart DRVAL1 below LAT; proxy requests `datum=LAT`). New setting `tideSafetyM` default 0.5 m, distinct from the grounded-on-LAT `safetyM=0.2`.
- UI: caution segment turns **amber with a window chip** ("clears 09:40–15:10") instead of unconditional red; ±0.3 m conservatism band + 30 min edge padding for cosine-interpolation error; windows labelled "approx" on the extremes path. The route geometry never changes — this honours the engine's "chart datum is LAT" doctrine and upgrades the _locked_ Newport→Rivergate UX (straight route + RED bar) into a timed bar warning.
- **Verify:** Bramble Bay window matches the WorldTides table within 30 min on the Rivergate golden; locked geometry untouched. This is the demo sentence no competitor matches.

**Phase 8 — Currents/leeway in ETAs + best-departure sweep v1** · Lane A · **M**

- Vector-triangle SOG in the annotator: `w = current + leeway`, `SOG = w·d̂ + sqrt(STW² − |w⊥|²)`; per-leg heading-to-steer and set/drift annotations. `CmemsCurrentField` over the hourly THCU `WindGrid` already decoded by `services/weather/api/currentsGrid.ts` (today particle-layer-only) with honest hour indexing — **ETA-only, never feasibility** (≈1/12° cannot resolve channel jets; provenance-tag as estimate). Leeway `= 0.035 × windVector10m`, capped at 0.3×STW; cross-corridor set exceeding corridor half-width → steering warning, not geometry change.
- `services/routing/DepartureSweepInshore.ts`: ~25 departure times at 30 min steps over one tide cycle, re-running the annotator against the _same_ static route (grid cached; annotator is O(polyline)) → passage time, waits, gate windows, minUkc per departure. UI mirrors the existing offshore `DepartureWindowSheet`: slider + passage-time sparkline + recommendation sentence ("Leave 11:20 — bar opens 11:30, carries 1.4 kn flood to the river mouth"). Gated behind explicit user action (battery on older devices). Fuel proxy = engine-hours, so time-optimal ≡ fuel-optimal under power.
- **Verify:** sweep <4 s on device; flood-vs-ebb Brisbane River pair shows the expected ETA asymmetry sign/magnitude; best departure beats leave-now on the synthetic bar fixture.

**Phase 9 — Pi resync + cloud re-enable (freeze the legacy fallback)** · Mechanical · **S**

- The documented `cp` + logger-shim recipe for `pi-cache/src/services/inshoreRouter.ts`; run its 9-case test file; polyline parity on both goldens; flip `CLOUD_ROUTER_ENABLED=true` (`InshoreRouter.ts:71` — verified false) and fix its stale 20-line "RE-ENABLED" comment; refresh `ROUTING_COLLAB.md` + `INSHORE_ROUTING_STATUS.md` to shipped reality (both verified stale).
- Done here deliberately: Stages I–II changed the engine ~6 times; syncing once _after_ stabilisation halves the work, and the legacy engine is now frozen as the permanent fallback before graph work begins.
- **Verify:** byte-parity modulo shim; identical polylines both goldens via cloud and local.

### Stage IV — The Seaway Graph (destination architecture)

**Phase 10 — Data model + compiler skeleton, overlay only** · Lane B · **M**

- New `services/seaway/`: `types.ts` (the `SeawayGraph`/`GateNode`/`SeawayEdge` model from §4, incl. a `Metres` brand type that makes residual feet-leaks a compile error in seaway code), `gateExtractor.ts`, `corridorBuilder.ts`, `graphCompiler.ts`, `graphValidate.ts`.
- `gateExtractor` unifies the two mutually-invisible mark pipelines: (tier 1) chart frontend reuses `parseLateralMarks` + `groupChannels` from `fairlead.ts:65/95` then pairs by sequence adjacency; (tier 2) regional frontend lifts Steps 1–3 of `fetchRegionalMarkers` out of the orchestrator (now metres-correct from Phase 2); (tier 3) **geometric pairer** = the TS port of `find_entrance_gate` (`~/Projects/MarinerEE/newport_demo.py:517-595` — the never-ported red/green gate finder: width window, midpoint-in-water rejection, FAIRWY bonus), generalised from marina entrances to any gate, covering unnamed marks. Dedup at 80 m, chart wins geometry. Confidence: chart pair 0.95, regional PCA 0.7, geometric 0.4; pairs below 0.6 never form edges without DEPARE/DRGARE corroboration.
- `corridorBuilder` wraps `corridorCenterline` (`fairlead.ts:168`), slices at gate stations; `controllingDepthM` = min DRVAL1 sampled at 25 m; marks-vouched-but-charted-shallow edges stay traversable-with-caution (`depthSource:'marks-vouched'`) — dissolving Fairlead-v2's CAUTION-as-land flaw at the graph level. Compile-time validation: every edge polyline sampled at 25 m against the rasterized grid; hard-blocked cells abort the edge.
- Output: debug map overlay only. Zero routing change.
- **Verify:** Newport BC channel renders as an ordered gate sequence with correct `buoyageBearingDeg`; gateExtractor unit tests pass on the real 15-mark BC fixture (already hardcoded in `tests/fairlead.test.ts:28-46`).

**Phase 11 — Connector mode + portals** · Lane B · **M**

- `services/seaway/connector.ts`: multi-target Dijkstra from one cell to K portal cells on the existing engine grid (same cost function), terminating when all settled or cost >1.5× direct. Portals synthesized one median gate-spacing seaward of terminal gates, snapped to deep water; junction portals at channel/fairway meets. Connectors attach only at portal/junction/marina-entrance/gate-midpoint nodes — never mid-edge.
- **Verify:** engine test proves origin→{K portals} costs match K independent A\* runs within 1%, at ≤1.3× single-run latency.

**Phase 12 — Shadow router + scorecard arbitration** · Lanes A+B · **M**

- `services/seaway/seawayRouter.ts` runs alongside the live engine on every route, logging gate-compliance, % length on graph edges, detour ratio, per-phase timings; the user still gets the old route. Direct grid route is always computed — it is the baseline candidate and the fallback.
- **Verify:** over the full fixture corpus, graph routes beat the hardened Stage II baseline on gate-compliance with detour ratio ≤1.35 and zero land/caution regressions. **This gate decides promotion; if the graph can't beat wings+exit-penalty here, Stage IV pauses and the owner gets the data.**

**Phase 13 — Promote behind `SEAWAY_ROUTER_ENABLED`** · Lane B · **L**

- Graph route returned when it exists within `DETOUR_CAP=1.35` (applied per-leg, not whole-route — the Newport→Rivergate direct-bay route must survive as a frozen test; if the graph route exceeds the cap there, the direct route ships). Side-correctness by construction: connector polylines validated against gate **cross-lines** (mark→mark segment extended ±1 gate-width) — intersection outside the mark-to-mark span → reject and re-solve with those cells blocked. Solo-mark half-gates carry keep-out **half-plane annotations** (from `orientHazardsTowardLand`'s inference) instead of OBSTRN walls on the graph path — fixing the misclassification double-penalty; cardinals/isolated dangers stay hazards everywhere.
- Post-hoc passes (`applyFairleadAtGrid`, `applyLeadingLineSnap`, `applyLeadingLineApproach`) are **skipped on graph routes** (their job is done structurally) and remain active, untouched, on the fallback path indefinitely. `RouteResult` contract unchanged; `debug.seaway = {edgesUsed, gateCount, gateCompliance, detourRatio}`; per-segment provenance for UI + Bosun narration.
- **Verify:** golden fixtures still pass on the fallback path; new golden asserts Newport→Rivergate via graph passes between every BC gate pair on the correct side per `buoyageBearingDeg`.

**Phase 14 — Transit edges + marina precompile** · Lane B + tools · **L**

- `transitExtractor.ts`: OSM `navigation_line` + chart NAVLNE (flowing since Phase 6) compile into **directed** transit edges with `captureWindow {bearingDeg, halfAngleDeg: 25°, joinRadiusM: 1500}` at the seaward anchor, plus approach chains (the `buildLeadingApproach` ≤1800 m landward-linking logic, compiled permanently). The Tangalooma 72.3°→23.6° dog-leg becomes two graph edges instead of a per-route splice. A connector may join a transit only inside its capture window — structurally producing "stand off, then line up the leads."
- `marinaCompiler.ts`: per OSM marina/canal-estate polygon, a **5 m local grid** of polygon + 300 m apron (the exact ~1.7 m/px regime the MarinerEE spike validated; Newport-sized ≈1200×900 cells), run `routeMarina` (`marinaCenterline.ts:404`) from the entrance gate to interior junction nodes; emit `marina` edges + `marina-entrance` gate. Runs at **cell-import time on the Pi**, never at route time — dissolving the 3.5–50 NM band that today gets neither fine resolution nor centerline; the runtime two-tier fine pass becomes the fallback for uncompiled marinas. Honesty rule preserved: disconnected-at-keel ⇒ null ⇒ no edge. ETag-keyed cache invalidation; device compiler as offline fallback with a latency budget test before shipping.
- **Verify:** Tangalooma routes the dog-leg via graph edges with no splice, offline included; `marinaCenterline` parity tests pass against compiled Newport edges; a 20 NM berth-start route (previously centerline-less) gets true centerline geometry.

**Phase 15 — Time on the graph: tide gates, streams, departure sweep v2** · Lane B · **L**

- Time-labelled Dijkstra: label = (node, ETA); channel/fairway edge passable iff `controllingDepthM + tide.heightAt(ETA) ≥ draftM + tideSafetyM`, else red with **next-opening time** attached (binary search on the curve); "wait at portal" labels produce "depart 14:20 to carry water over the bar." Transit-window slack: the gate run must stay open for the whole crossing + max(15 min, 20%). Tide credit capped at ≤80% of station height until multi-station lands. Edge cost becomes time: `lengthM / (STW ± alongFlowComponent)` with CMEMS sampled at edge midpoints; estuarine edges fall back to a signed dh/dt estimate along `flowAxisDeg`, flagged `'estimated'`. FIFO caveat handled by discretizing departure labels at 10 min — near-optimal, never continuous-time. Departure sweep v2 re-runs the _graph_ search per departure (hundreds of edges — milliseconds), replacing the annotator-based sweep.
- Upgrade the tide source when justified: `proxy-tides` gains an opt-in `mode=heights` branch (`?heights&extremes&datum=LAT`, routing calls only, existing 6 h/0.25° caching) → `StationTideField`; Phase-7-of-TideHeightService multi-station piecewise blend. Pi scheduler prefetches 7–14 day curves per cruising region for offline.
- **Verify:** synthetic bar edge impassable at LAT, opens at +1.2 m → route exists iff departAt in window, wait surfaced; flood-vs-ebb river pair differs by expected stream-carry; env-absent graph runs identical to Phase 13 output.
- **Doctrine, enforced in review:** tide-open gates cost the shallow tier — tide changes _feasibility and timing_, never _preference ordering_. No drying-bank shortcuts merely because the tide is up.

**Phase 16 — Engine unification + cloud graph** · Mixed · **L**

- Extract `packages/routing-core/` (engine + seaway) shared by app and pi-cache — kills the hand-synced byte-copy before the seaway modules make it untenable (this is not optional polish; two more hand-synced modules would be worse than today). Pi compiles and serves regional graph artifacts (`GET /api/seaway/graph?bbox=`); route-prepped wire format gains `departAt` — its first environmental field ever.
- **Verify:** pi-cache CI job (currently its tests are manual-only) runs the same golden + scorecard suite, byte-identical routes to the device engine.

---

## 4. Seamanship rules engine spec

**Gate sequencing.** A channel is an ordered path `portal → gate → gate → … → portal | junction | marina-entrance`. A `GateNode` carries `portMark`/`stbdMark` (either may be absent → half-gate), `gateWidthM`, `buoyageBearingDeg`, `confidence`. Channel edges connect _consecutive_ gates; their polylines are spans of the seq-interpolated Fairlead corridor centreline and pass through gate midpoints — **geometry is the law**, the router never re-smooths edge interiors. Pair construction: sequence-adjacency for OBJNAM-numbered chart marks; PCA-axis pairing (metres-correct, 250 m along-axis gate) for regional marks; mutual-nearest geometric pairing with midpoint-in-navigable-water rejection (the `find_entrance_gate` port) for unnamed marks, max separation 600 m.

**IALA-A side correctness.** `buoyageBearingDeg` = direction of buoyage (heading when returning from seaward): red port-hand marks to port on this heading — Australia is Region A; Region B is a single per-region enum flip, explicitly deferred. Inference: harbour end = chain end with smaller distance-to-LNDARE, tie-broken by ascending OBJNAM seq pointing harbourward (the IALA numbering convention); per-channel override in the region file because river mouths and dual-entrance channels will fool it — the bearing is advisory until confirmed per region; geometry (the centreline) is side-agnostic and unaffected. Enforcement is structural, never cost: (a) connectors attach only at portals/junctions/gate midpoints; (b) every connector polyline is validated against gate cross-lines — crossing outside the mark-to-mark span is rejected and re-solved; (c) half-gates carry a keep-out half-plane (shore-side, from the nearest-LNDARE inference) that connectors may not cross. Interim grid semantics (Stage II, and the fallback path forever): outboard pair wings at CAUTION 40× + `preferred=0`, plus the 250 m corridor-exit penalty — wrong-siding becomes a ~40× detour-equivalent A\* essentially never takes, while a mispair degrades to a red wiggle rather than `no-path`.

**Transit capture windows (leading lines / white marks).** Transits are _directed_ edges (the only one-way kind). A connector may join a transit's seaward anchor only if its terminal bearing falls within `±25°` of the transit bearing inside `joinRadiusM=1500`; otherwise the search routes via the next transit-anchor node upstream — structurally producing the stand-off-and-line-up approach a skipper sails. Approach chains: lines whose landward ends link within 1800 m compile into connected transit edges (the Tangalooma dog-leg), permanently, replacing the per-route `applyLeadingLineApproach` splice on graph routes. Sources: OSM `navigation_line` (category=leading) + chart NAVLNE from Phase 6; RECTRC emitted for future cells.

**Approach legs and marinas.** `marina-entrance` gates come from the geometric pairer over the entrance pair; precompiled marina edges (5 m grids, `routeMarina`, clearance-aware DP at TOL 1.6 cells) own berth-to-entrance; the entrance gate hands to the channel graph exactly as MarinerEE→Fairlead was designed to hand off. Mispair safety: compile-time 25 m validation of every edge, confidence thresholds, the shadow period, and CAUTION-not-blocked wings on the fallback path are the four defences against the inverted failure mode (a bad gate the router structurally prefers).

---

## 5. Tide / current / leeway model + best-departure

**Contracts (`services/routing/env/EnvFields.ts`):** `TideField {heightAt, nextTimeAtOrAbove, envelope, provenance}`, `CurrentField2D`, `WindField2D`, `SpeedModel {stwMs, vMaxMs}` — all null-tolerant, provenance-tagged (`STATION_HEIGHTS | EXTREMES_INTERP | NONE`); the degradation ladder is a property of the types. Draft enters this layer once, in metres, via `vesselDraftMetres()`.

**Tide.** v1 = `ExtremesTideField`: cosine interpolation over already-cached WorldTides extremes (free, offline-capable, the shipped `stormglass.ts` algorithm), ±0.3 m conservatism band, windows labelled approx. v2 = `StationTideField` via opt-in `mode=heights` on proxy-tides (billed per datapoint — routing calls only, existing caching), then multi-station piecewise blend (the TideHeightService Phase-7 TODO) — until then, tide-aware claims capped to gates within ~10 NM of the station. Datum: LAT asserted everywhere, non-LAT curves refused, never converted. Consumption ladder: Phase 7 display windows on caution runs → Phase 15 graph edge gating with next-opening times and portal waits.

**Currents.** CMEMS hourly THCU (already decoded for the particle layer) bilinearly sampled — **ETA-only, never feasibility**, provenance `estimate` (1/12° cannot resolve channel jets). Estuarine graph edges: signed dh/dt-scaled estimate along `flowAxisDeg`, flagged `'estimated'`. Investigate S-57 `TS_FEB` tidal-stream features in the AU SENC (via senc-extractor `--all` dump) as the real inshore stream source — unproven, so it's a spike, not a dependency. OSCAR climatology stays offshore-only.

**Leeway.** Drift-vector model: `leeway = 0.035 × wind10m`, capped 0.3×STW (displacement hull under power); enters the vector triangle `SOG = w·d̂ + sqrt(STW² − |w⊥|²)`; infeasible set (STW ≤ |w⊥|) → leg flagged, treated as closed gate. Cross-corridor set exceeding the edge's `halfWidthM` → per-leg steering warning ("expect 8° set onto the green"), never geometry change inshore. Heel-dependent leeway-angle refinement is a one-function swap later.

**Best-departure sweep.** v1 (Phase 8): ~25 annotator re-runs at 30 min steps over one tide cycle against the static route — windows, waits, ETAs per departure; sparkline + recommendation sentence in a `DepartureWindowSheet`-style UI; explicit user action only. v2 (Phase 15): the sweep re-runs the graph search itself per departure (milliseconds on hundreds of edges) — the principled answer to FIFO violations from streams, instead of any time-expanded grid. Fuel proxy = engine-hours at fixed RPM, so one objective suffices under power.

---

## 6. Verification strategy

- **Golden routes (Phase 0, the seatbelt for everything):** both real-cell corridor fixtures wired into CI — Newport→Rivergate (20.46 NM ±2%, 21 pts, ≤10 caution runs, snap <100 m, at 2.4 m AND 2.44 m draft) and Newport→Tangalooma (`debug.leadingApproach` asserted). Any phase that moves these without an explicit re-pin is reverted.
- **Scorecard (`tests/helpers/routeScorecard.ts`):** wrongSidePasses (target 0), channelDisciplinePct (target ≥95% where a marked channel exists within 1.3× direct), XTE p50/p95 vs chain centreline, turnCount, cautionRunLengthsM, distanceRatio, phaseTimings (+10% bound vs the post-Phase-0 clean baseline — pre-Phase-0 timings are contaminated by ENGINE_DEBUG). Baselines committed; every phase's success is a scorecard delta. Stage IV promotion is decided by this scorecard, not vibes.
- **Synthetic seamanship fixtures (Phase 1):** the six listed, `it.fails` → `it` flips tied to specific phases. Plus existing suites untouched: `inshoreRouter.regression.test.ts` (5 guardrails), `inshoreRouter.marina.test.ts`, `fairlead.test.ts` (real BC channel), `leadingLine.test.ts` (real Tangalooma line), `marinaCenterline.parity.test.ts` (real Newport grid).
- **Physics fixtures (Stages III–IV):** synthetic bar (DRVAL1=1.5 m, draft 2.4 m, scripted curve → window opens/closes correct, wait-vs-detour boundary moves correctly with detour length); vector-triangle unit tests (along/cross/quartering set, infeasible fallback); flood-vs-ebb river ETA asymmetry; two-station phase-lag window shift; env-absent runs byte-identical (degradation ladder enforced by test).
- **Graph fixtures (Stage IV):** gateExtractor on the real 15-mark BC channel; connector cost parity (±1% vs K independent A\*); gate cross-line compliance golden (every BC pair, correct side); shadow-period corpus report before promotion; Pi/device graph parity in CI (Phase 16 finally puts pi-cache tests in CI).
- **Operational:** all local test/build invocations prefixed `NODE_OPTIONS="--max-old-space-size=8192"`; synthetic fixtures use distinct lon regions (NavGrid cache counts-as-fingerprint trap); one numeric knob per commit, each behind a failing-then-passing fixture — the whack-a-mole history is the reason this is a hard rule.

---

## 7. Explicit non-goals / deferred

- **Time-expanded grid A\*** — rejected permanently for <50 NM; cell×time on a 10⁶-cell grid is a memory/latency cliff for negligible gain at 1–8 h passages. Time lives on the graph. (Also drops the physics design's seconds-denominated grid A\* — superseded by the graph landing zone.)
- **Depth-grading inside preferred corridors** — forbidden doctrine (reverted `d55ea29f`); 30 m bathymetry reads dredged channels at 2 m.
- **Drying-bank shortcuts** — tide never changes preference ordering; defended in code review.
- **IALA Region B** — single enum flip by design, validation deferred until the SE QLD scorecard beats Navionics on the agreed corpus.
- **CATLAM 3/4 preferred-channel marks, ML pairing, harmonic tide constituents (licensing TBD), anchorage/ACHARE wait geometry, multi-station tide before Phase 15, Victron/engine anything (Bosun scope rule).**
- **Lazy-corridor / DRGARE connector resurrection on the grid** — subsumed by `fairwaySkeleton`'s connect-only doctrine in the graph (an isolated fairway with no graph connection contributes nothing, by design — the structural fix for the `07fea6c8` dogleg).
- **Tidal streams for feasibility** — no data source resolves channels; ETA-only until S-57 TS_FEB (or a stream atlas) is proven.
- **Offshore isochrone rework** — out of scope except the freebie WindFieldAdapter fix; the graph hands off to the existing isochrone stack at portals.

---

## 8. Open questions for the owner — ANSWERED (Shane, 2026-06-12)

1. **WorldTides heights billing → APPROVED.** Already on a paid WorldTides tier — enable the `mode=heights` proxy branch for routing calls (Phase 15). Cosine-from-extremes still ships first in Phase 7 (free + offline path); heights mode is the accuracy upgrade, and UKC numbers may speak confidently once on it.
2. **Compliant-vs-direct → (a) COMPLIANT BY DEFAULT,** with the direct route one tap away. "Navionics gives you the corner-cutter; we give you the pilot's plan, with the shortcut one tap away." Phase 13 UI builds the toggle; DETOUR_CAP stays the arbiter of when a compliant route exists at all.
3. **Departure sweep trigger → EXPLICIT BUTTON first** (mirrors offshore DepartureWindowSheet); revisit auto-run after measuring on-device cost.
4. **`tideSafetyM` default → 0.5 m CONFIRMED** by the owner as the Tayana's real rising-tide bar margin. Punter-adjustable setting; 0.5 m is the shipped default.
5. **Pi AU-cell re-extraction → OPPORTUNISTIC, delegated to Claude A.** Leads stay OSM/online-only (status quo, zero risk) until the next natural calypso + SG-Lock session; target before Phase 6 merges, but Phase 6 explicitly does not block Stages I–III. Owner note: the Pi layer is being formalised as **"Pi in the Middle" (PIM)** — an optional middle tier: device → Supabase for everyone; device → Pi → Supabase for boat-equipped users (speed, stability, extra functionality). The masterplan already assumes exactly this shape (cloud router with on-device fallback, Pi-compiled marina grids with device fallback, Pi tide prefetch) — PIM is the name for the contract: **every Pi feature must have a device-or-cloud fallback; Supabase remains the single source of truth; the Pi is an accelerator and buffer, never a second master.**
