# Three-Tier Routing Architecture

> **Current production contract (2026-06-23):** the implementation now follows
> Shane's four-tier brief, inside-out: **tier 1 = canals/marinas**, **tier 2 =
> channels leading out from canals/marinas to deeper water**, **tier 3 = inshore
> bay/coastal routing**, **tier 4 = offshore/bluewater**. This historical design
> note is retained for the seam/gluer rationale, but its older numeric mapping
> (`1=offshore`, `2=bay`, `3=channel`) is superseded.

**Status:** design (synthesis of three takes), 2026-06-17
**Author:** routing synthesizer
**Supersedes:** the implicit splice chain in `services/inshoreRouterEngine.ts` `routeInshoreOnce`
**Read first:** `docs/INSHORE_ROUTING_MASTERPLAN.md`, `lesson_enc_over_osm_for_routing.md`, `project_inshore_routing_masterplan.md`

---

## 0. The thesis (and what we rejected)

Every recent field bug — the 175° Brisbane-bar double-back, the ±171° Newport approach spike, the dense stepped centreline, the "stepping at each gate" at a marina exit, and the just-reproduced Newport→Murrarie bead-through — is the **same** bug: tier _N+1_ silently mutates tier _N_'s polyline across an **implicit splice** that has no shared-boundary contract, no heading-continuity gate, and no refusal path. The monolith's `applyFairleadAtGrid` / `applyLeadingLineSnap` / `applyLeadingLineApproach` chain (`inshoreRouterEngine.ts:3457–3465`) runs on the **whole** polyline, decides at runtime whether to act, and on a near-miss score (0.59 vs 0.60) returns `passthrough` (`:3552, :3596`) — the raw A\* preferred-disc beads — for the entire route. That is the stepping bug, verbatim.

**We make that class of bug structurally impossible** by adopting, in order of how load-bearing each idea is:

- **The seam is the product** (Take 1). One immutable `Leg` contract, one `Gluer` that _admits or refuses_ a join and never mutates a leg interior. This is the spine.
- **Segment first, route second** (Take 2). A single pre-pass classifies the corridor into ordered tier spans from chart data alone; routers never decide "should I act here." This kills the silent-passthrough decision point at the source.
- **Re-label, don't rewrite** (Take 3). Tier 2 is the _existing_ engine A\* run with marks/leads OFF and a depth-only mask ON, fenced into the open-water span between portals. Tier 3 is the _existing_ fairlead/leadingLine/marinaCenterline re-homed onto tier-3 spans. We ship the seam, not a greenfield router.

**What we rejected, and why:**

- _Take 1's "tiers are pure `(BoundaryNode, BoundaryNode, Env) → Leg` and never touch the engine grid."_ Correct in spirit, but a from-scratch tier-2 router is not shippable this fortnight and throws away a hardened, fixture-pinned A\*/cost ladder/DEPARE rasteriser. **Rejected the rewrite, kept the contract.** Tier 2 reuses the engine grid (Take 3) but is still handed only two `BoundaryNode`s and emits a frozen `Leg` (Take 1).
- _Take 2's continuous depth sample._ The DEPARE truth is banded, not continuous; a continuous sample invites flicker at band edges. **Adopted Take 2/3's discrete DEPARE-band membership test.**
- _Take 3's 50 m `SEAM_TOL_M`._ Too loose — it readmits the fuzzy-bridge that hides the marina-disconnect bug. **Adopted Take 1's referential-identity-plus-1 m-epsilon:** segmentation hands the _same_ `BoundaryNode` object to both adjacent spans, so the shared-point check is an identity assert, and the 1 m epsilon only guards float round-trip between graph space and grid space.
- _Two competing turn thresholds._ All three converge on the engine's proven 120° (`:3603/:3789`). **Adopted, promoted from post-hoc warning to a hard seam gate.** We keep Take 1's note that a _genuine_ dog-leg mouth may need a per-boundary-kind value — pinned against the real corpus before tightening.

The result favours the pragmatic where takes conflict (reuse the engine; ship tier-2 + the 2↔3 seam first) while keeping the glue contract rigorous (immutable legs, identity boundary, hard heading gate, first-class refusal).

---

## 1. The three tiers — definitions, responsibilities, I/O, predicate, threshold

### 1.1 The one new contract: `Leg`, `BoundaryNode`, `Refusal`

Every tier is a leg producer behind a **uniform, frozen** type. This is the only genuinely new artifact in the system; the tiers themselves are existing code behind it.

```ts
// services/routing/legContract.ts  (new, ~80 lines, pure types + freeze helper)

export type LatLon = readonly [number, number]; // [lon, lat], the engine convention

export interface BoundaryNode {
    /** The shared seam point. Adjacent spans receive the SAME object (identity). */
    readonly at: LatLon;
    /** OUTBOUND heading through the node — the direction the route travels
     *  THROUGH this node, in deg true. The Gluer tests continuity against this
     *  without re-deriving it from polylines. */
    readonly headingDeg: number;
    readonly kind: 'origin' | 'dest' | 'last-lead' | 'channel-mouth' | 'shelf-edge';
    /** Charted controlling depth AT the node, or null if GEBCO-only/unvouched. */
    readonly depthM: number | null;
    /** false ⇒ the boundary could NOT be deep-snapped (connector honesty flag).
     *  A tier MUST refuse rather than route to an unsnapped node. */
    readonly snapped: boolean;
}

export interface Leg {
    readonly tierId: 1 | 2 | 3;
    readonly entry: BoundaryNode;
    readonly exit: BoundaryNode;
    readonly polyline: readonly LatLon[]; // frozen; never re-smoothed downstream
    readonly cautionMask: readonly boolean[]; // per-vertex; true ⇒ render red
    readonly depthSource: 'charted' | 'marks-vouched' | 'gebco' | 'none';
    readonly controllingDepthM: number | null; // min charted depth along polyline
    readonly provenance: string; // e.g. 'coastal-deepwater', 'seaway-gate-graph'
}

export interface Refusal {
    readonly refused: true;
    readonly reason:
        | 'no-deepwater-corridor'
        | 'exit-not-deepwater'
        | 'entry-unsnapped'
        | 'uncharted-run'
        | 'disconnected-grid'
        | 'boundary-gap'
        | 'double-back'
        | 'caution-discontinuity';
    readonly atNM?: number;
    readonly measuredTurnDeg?: number;
}

export type LegResult = Leg | Refusal;
```

Three invariants, enforced by `Object.freeze` on construction and by review:

1. **No tier receives another tier's polyline.** A tier sees two `BoundaryNode`s and its `Env`. There is no input polyline to silently pass through — the exact mechanism of the stepping bug has no parameter to exist in.
2. **No tier mutates another tier's leg.** The only code that touches two legs is the Gluer, and it only concatenates.
3. **"I can't serve this span" is a typed `Refusal`, not the unchanged input.** A refusal renders red / refuses; it never leaks stale geometry past a seam.

### 1.2 TIER 1 — OFFSHORE (weather-dominated)

|                    |                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Responsibility** | Weather-optimal open-ocean routing on GEBCO bathymetry + wind/wave isochrones.                                                                                                                                                                                                                                                                  |
| **Inputs**         | `entry` = origin or seaward shelf-edge node; `exit` = shelf-edge or first channel-mouth node; vessel polar; wind/wave grids.                                                                                                                                                                                                                    |
| **Output**         | `Leg{ tierId:1, depthSource:'gebco' }`.                                                                                                                                                                                                                                                                                                         |
| **Implementation** | Existing `IsochroneRouter.ts` / `weatherRouter.ts`, **unchanged**, wrapped to emit a `Leg`. These are already clean `VoyagePlan → VoyagePlan                                                                                                                                                                                                    | null` pure functions. |
| **Predicate**      | A sample is **tier-1** iff it sits in **no routing-grade installed ENC cell** — reuse `findCorridorCoverageGap`'s grade filter (`InshoreRouter.ts:201–221`). Tier 1 is defined by the **ABSENCE of chart truth** (GEBCO is the only depth source), not by a depth value. GEBCO hazard floor `−(draftM·1.5 + 0.5)` ≈ −4.25 m is a backstop only. |

Most SE-QLD dock-to-dock routes are fully ENC-covered → **no tier-1 span**; segmentation degrades cleanly to tier-2 + tier-3 (the Newport→Murrarie case). Tier 1 is wrapped last (Phase 3), not first.

### 1.3 TIER 2 — COASTAL / BAY DEEP WATER (skip the marks) — _build first_

|                    |                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility** | Depth-safe, **marks-free** open-water crossing from a channel's seaward end to the next channel mouth (or dest), on charted depth alone. Avoid shoals/land; few fat hand-steerable waypoints; never thread marks.                                                                           |
| **Inputs**         | `entry` = upstream channel's seaward **portal** (or origin if it starts in deep water); `exit` = downstream channel-mouth portal (or dest); the **same cached `NavGrid`** the engine already builds (`getCachedNavGrid`, read-only — no second grid build); `draftM, safetyM, tideSafetyM`. |
| **Output**         | `Leg{ tierId:2, depthSource:'charted' }` (or `'gebco'` where DEPARE is absent but GEBCO vouches).                                                                                                                                                                                           |
| **Implementation** | The **existing engine A\*** run in `mode:'deepwater'`: skip all fairlead/leadingLine calls, drive A\* off the navigable-deep mask (§4) instead of the marks/FAIRWY-preferred grid. ~120 lines of wrapper.                                                                                   |
| **Predicate**      | A span is **tier-2** iff both endpoints are inside routing-grade ENC **AND** the span does **not** lie in any channel corridor: no `BOYLAT`/`BCNLAT` chart channel within `MARKER_CHANNEL_RADIUS_M`, no `FAIRWY`/`DRGARE` polygon, no OSM canal.                                            |

### 1.4 TIER 3 — CHANNELS / CANALS / MARINA (mark / lead / centreline guided)

|                             |                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Responsibility**          | Thread the marks/leads through dredged channels, canals, marina berths with **side-correctness by construction**.                                                                                                     |
| **Inputs**                  | `entry` = seaward portal; `exit` = berth / junction / landward dest; `BOYLAT`/`BCNLAT` marks, `NAVLNE` leads, `FAIRWY`/`DRGARE` polygons, fine marina grid; the Seaway gate-graph.                                    |
| **Output**                  | `Leg{ tierId:3, depthSource:'charted' \| 'marks-vouched' }`.                                                                                                                                                          |
| **Implementation (today)**  | Existing `fairlead.ts` + `leadingLine.ts` + `marinaCenterline.ts`, **re-homed** behind the `Leg` contract so they run on the **tier-3 span only**, never the whole polyline.                                          |
| **Implementation (target)** | The **Seaway gate-graph** (`services/seaway/`), an ordered-gate router built to Stage-IV spec, currently a shadow. Promoted in Phase 4 once it clears the dense-corridor corpus. Same `Leg` contract, no glue change. |
| **Predicate**               | A span is **tier-3** iff it contains a `parseLateralMarks` channel (≥3 marks) **OR** a `FAIRWY`/`DRGARE` polygon **OR** an OSM canal LineString.                                                                      |

### 1.5 The exact depth predicate + threshold (key deliverable)

There is **one** named constant. It does not fork the engine's depth data; it raises the bar over the engine's existing per-cell verdict.

```ts
// services/tier2/depthThreshold.ts
export const TIER2_NAVIGABLE_DEPTH_M = (draftM: number, tideSafetyM: number) =>
    clampToDepareBand(Math.max(draftM + tideSafetyM, 2 * draftM));
// Tayana (draft 2.4, tideSafety 0.5):
//   draft + tideSafety = 2.9 m   (the BAR/pilotage number — Shane-confirmed)
//   2 × draft          = 4.8 m   (open-water, all-tide, no-pilotage comfort floor)
//   max                = 4.8 m  → clampToDepareBand → 5.0 m (the charted DEPARE band)
```

**Why the `max(draft + tideSafety, 2·draft)` form, decisively:**

- `tideSafetyM = 0.5 m` is Shane's **CONFIRMED rising-tide BAR margin** — a pilotage number for an _attended shallow crossing_ where you watch the tide and thread the marks. It is **not** the number that licenses cutting straight across, marks-free, unattended.
- "Skip the marks entirely" requires clearance at **all** tide states without pilotage. That is the `2 × draft` comfort floor: 4.8 m for the Tayana.
- Clamp **up** to the nearest DEPARE band (5.0 m) because the chart truth is banded — this lands on the de-facto **5 m industry contour** (PredictWind / Orca default, Garmin's sub-resolution clamp precedent) and matches the engine's own `canalDepth = Math.max(draftM + safetyM, 5.0)` floor at `inshoreRouterEngine.ts:1023`.

**The cell verdict** reuses the engine's existing per-cell array — **no new ENC fetch**:

```
depareVerdict[idx]  // Float32Array, built at inshoreRouterEngine.ts:800, 955–963
                    // = shallowest real charted DRVAL1 in metres for the cell,
                    //   or CAUTION sentinel, or NaN (unvouched/uncharted)
```

| `depareVerdict[idx]`                         | tier-2 classification              | render                       | A\* treatment                            |
| -------------------------------------------- | ---------------------------------- | ---------------------------- | ---------------------------------------- |
| `≥ TIER2_NAVIGABLE_DEPTH_M` (≈5 m)           | **DEEP — routable, marks-free OK** | clean                        | cost 1.0×                                |
| `[draftM + safetyM, TIER2)` (≈2.6–5 m)       | **PASSABLE-WITH-CAUTION**          | **red** (`cautionMask=true`) | cost 4.0×, used only if no all-deep path |
| `[0, draftM + safetyM)` (CAUTION sentinel)   | non-navigable                      | red                          | engine 40×/caution                       |
| `NaN` (unvouched / uncharted, strict policy) | **BLOCKED for tier-2** → refuse    | red, never clean             | not traversed                            |

**The key distinction:** the engine's existing draft filter accepts `draft + safety` ≈ 2.6 m ("won't ground", fine for a _marked_ channel). Tier-2's **higher** ≈5 m threshold is precisely what licenses cutting straight across **without pilotage**. Water that is merely draft-deep but below 5 m (Bramble Bay flats at ~3.5 m) is deliberately **off-limits to marks-free crossing** — that is the whole point of the split. Such water, if it is near marks, was already classified tier-3 by segmentation and tier-2 never sees it. **Uncharted is never tier-2-navigable** — house doctrine.

---

## 2. Route segmentation — start → dest → ordered tier spans

`segmentRoute` is the **only** place tiers are chosen. It runs **once**, after the planned start→dest line is known, **before** any tier router. It classifies; it does not route. Routers never decide "should I act here" — that decision is the silent-passthrough bug, and it is deleted here.

```ts
// services/routing/segmentRoute.ts  (new, pure)
function segmentRoute(
    origin: LatLon,
    dest: LatLon,
    grid: NavGrid,
    marks: ParsedMarks,
    graph: SeawayGraph | null,
    draftM: number,
    safetyM: number,
    tideSafetyM: number,
): TierSpan[] | Refusal; // TierSpan = { tier:1|2|3, entry: BoundaryNode, exit: BoundaryNode }
```

**Algorithm:**

1. **Sample** the straight start→dest line at **half-cell steps (~25 m)** — the engine's existing sweep cadence (`inshoreRouterEngine.ts:3489`). Reuse `latLonToGrid`.
2. **Classify each sample** with `tierOf(sample)` in **priority order tier-3 > tier-2 > tier-1**, plus a 4th verdict `UNCHARTED`:
    - `t3` if within `MARKER_CHANNEL_RADIUS_M` of a chart channel, or inside `FAIRWY`/`DRGARE`/OSM-canal, or in a `RECTRC`/`NAVLNE` capture window;
    - else `t1` if no routing-grade ENC coverage;
    - else `t2` if `depareVerdict[idx] ≥ TIER2_NAVIGABLE_DEPTH_M`;
    - else `unknown` → forces caution/refuse.
3. **Run-length-encode** into contiguous spans. Apply **hysteresis**: a routable-tier span shorter than one median gate-spacing is absorbed into its neighbour (kills single-cell flapping at band edges — the same noise that makes A\* bead). **Never absorb an `unknown`/CAUTION span** — a red patch always survives as its own span. An `unknown` span longer than `UNCHARTED_MAX_RUN_M` (1852 m, the existing 1 NM rule) makes `segmentRoute` **refuse**, before any router runs.
4. **Resolve boundary nodes** between spans (§2.1) — one `BoundaryNode` object per transition, **shared by identity** with both adjacent spans.
5. **Emit** ordered `TierSpan[]`. Origin/dest become `origin`/`dest` nodes with headings taken from the first/last span. A coarse first cut: each tier router may deviate **within** its span (bow around a shoal), but its endpoints are pinned to the shared boundary nodes.

For Newport→Murrarie this yields `[t3 Newport-out, t2 bay crossing, t3 Brisbane River-in]`.

### 2.1 Boundary detection — the two load-bearing detectors

These are **principled, not geometric guesswork**. They already exist, are deep-snapped, and are unit-tested; segmentation only **reads** them.

- **LAST-LEAD (tier-3 → tier-2).** The seaward boundary of a marked channel is the Seaway **terminal portal**: `synthesizePortals` (`connector.ts:497–561`) emits a node **one median gate-spacing seaward** of the outermost (lowest-station) gate, **deep-snapped to vessel-deep water**, carrying a `snapped:boolean` honesty flag. The portal **is** the last-lead node:
    - `at` = the deep-snapped point;
    - `headingDeg` = the terminal gate's `buoyageBearingDeg` (`types.ts:56`) — the channel's _true_ along-channel axis, so tier-2 arrives lined up with the channel and the seam has no kink;
    - `snapped` = the portal flag.
      This is canonical — **not** "where the marks happen to stop."
      **Fallback** (sparse/unnumbered marks, no graph): the channel's outermost-gate midpoint from `gateExtractor` / `fairlead`'s `groupChannels`, then FAIRWY/DRGARE polygon terminus. The fallback boundary is snapped to the nearest `≥ TIER2` cell with `snapped:false` flagged honestly.
- **CHANNEL-MOUTH (tier-2 → tier-3).** The seaward portal of the **next** channel — symmetric.
- **SHELF-EDGE (tier-1 ↔ tier-2).** The sample index where routing-grade ENC coverage flips (charted ↔ GEBCO-only). Snapped to deep water. Secondary cue: DEPARE depth crossing the regional shelf threshold (~20 m). Coverage-first, depth-second, regionally configurable.

---

## 3. The GLUE contract — the seam

The Gluer is the **only** code that touches two tiers' outputs. It concatenates; it never re-smooths an interior.

```ts
// services/glue/gluer.ts  (new)
function glue(legA: Leg, legB: Leg): { joined: Leg } | Refusal;
function stitchLegs(legs: LegResult[]): GluedRoute; // folds glue() across the span list
```

Four clauses, each **unit-tested independently**. A `Refusal` is first-class: the route returns **up to the failed seam** plus an explicit red/refused tail with the reason — never a silently-mutated polyline.

**Clause 1 — SHARED BOUNDARY POINT (positional continuity).**
`legA.exit` and `legB.entry` are the **same `BoundaryNode` object** (segmentation handed both adjacent spans the identical portal). The check is therefore a **referential-identity assert**, with `dist(legA.exit.at, legB.entry.at) ≤ JOIN_EPS_M (1 m)` guarding only float round-trip between graph space (110 540 m/°) and grid space (111 320 m/°). Glue drops the duplicate shared vertex exactly as the existing run-stitch does (`inshoreRouterEngine.ts:3443`). Violation → `Refusal('boundary-gap')`. **Kills the marina-disconnect class** (A\* ending 2 km from the centreline start) — there is no fuzzy bridge to paper over a gap.

**Clause 2 — HEADING CONTINUITY (the double-back killer).**
`angularDiff(legA.exit.headingDeg, legB.entry.headingDeg) ≤ SEAM_MAX_TURN_DEG (120°)`. Both headings are **outbound-through-the-node**, so a double-back is a >120° diff at the seam — the **exact** 175°/±171° field bugs. This is the engine's proven turn check (`inshoreRouterEngine.ts:3603, 3789`) **lifted out of its single approach-only call site into the Gluer**, where it now guards **every** seam, and **promoted from a warning into a hard gate**. On violation, the Gluer may ask the downstream tier to **re-emit with a heading hint** (`entry.headingDeg = legA.exit.headingDeg`); still violating → `Refusal('double-back', measuredTurnDeg)`. No tier ships a reversing turn past the Gluer.

**Clause 3 — DEPTH / CAUTION CARRY-ACROSS.**
The glued `controllingDepthM = min` over legs; `depthSource` degrades to the **worst** of the two (`charted > marks-vouched > gebco > none`); the boundary vertex is stamped with the **shallower** of the two adjacent verdicts (conservative). `cautionMask` is concatenated minus the shared vertex. A leg that ends red must not meet a leg that starts confident-clean at the same point → `Refusal('caution-discontinuity')`. A `'none'`/uncharted leg keeps the route honest-red or refused — the Gluer **never** upgrades a `'none'` seam to clean. House doctrine, enforced at the seam.

**Clause 4 — NO INTERIOR MUTATION.**
`joined.polyline = legA.polyline ++ legB.polyline[1:]` — **pure concat**. No leg interior is re-smoothed, re-faired, or re-spliced. "Geometry is the law" (Seaway §4) extended to the seam. There is **one** join operator and it adds nothing.

### 3.1 How each seam is unit-tested

A seam test is a pure assertion over two adjacent legs — the smallest testable unit, isolated from the routers:

```ts
expect(glue(legA, legB)).toSatisfy(j =>
  j.joined.entry === legA.entry &&                     // identity preserved
  shareBoundary(legA.exit, legB.entry, JOIN_EPS_M) &&  // clause 1
  angularDiff(...) <= SEAM_MAX_TURN_DEG &&              // clause 2
  monotoneCumulativeDistance(j.joined.polyline) &&      // no backtrack
  maskContinuous(j.joined.cautionMask));                // clause 3
```

The **regression corpus seeds three real field cases as planted-mismatch fixtures**, each asserting the exact `Refusal` code:

1. **Brisbane bar 175°** → planted double-back → `expect Refusal('double-back')`.
2. **Newport approach ±171°** → planted double-back → `expect Refusal('double-back')`.
3. **Newport-exit stepping**, reconstructed as two legs (a tier-2 bay leg + a tier-3 channel leg) whose naïve join would step → `expect` a clean concat with no interior bead, OR `Refusal` if a gap is planted.

Reuse the existing `seawayConnector` parity / cross-line fixture harness. The bug class becomes a **test row, not a field report.**

---

## 4. TIER 2 — detailed spec (the build-first piece)

```ts
// services/tier2/coastalRouter.ts  (new, ~120 lines — reuses engine grid/A*/cost)
function routeDeepWater(
    grid: NavGrid, // the SAME cached grid the engine builds (read-only)
    entry: BoundaryNode, // upstream seaward portal, or origin
    exit: BoundaryNode, // downstream channel-mouth portal, or dest
    draftM: number,
    safetyM: number,
    tideSafetyM: number,
): Leg | Refusal;
```

It is deliberately small because it **reuses** the engine's grid, A\*, cost ladder, `smoothPath`, and `douglasPeucker`. It adds only a depth mask, the leg wrapper, and the honesty refusals.

### 4.1 Inputs

- `entry` = the tier-3 seaward portal (deep-snapped Seaway portal) **or** the voyage origin if origin is already in open deep water.
- `exit` = the next channel-mouth portal **or** the destination.
- `grid` = the **same cached `NavGrid`** (`getCachedNavGrid`, the connector's read-only-cache pattern — **no second grid build**).
- `draftM, safetyM, tideSafetyM`.

### 4.2 The navigable-deep mask (the deliverable's core)

Derive it **once** from the existing grid — **do not build a parallel grid**. The source is the engine's existing `depareVerdict: Float32Array` (per-cell shallowest charted DRVAL1, `inshoreRouterEngine.ts:800, 955–963`). The mask is a **threshold over existing data, no new ENC pass**, cached on the grid:

```ts
const TIER2 = TIER2_NAVIGABLE_DEPTH_M(draftM, tideSafetyM); // ≈ 5.0 m for the Tayana
const draftFloor = draftM + safetyM; // ≈ 2.6 m

function tier2CellCost(idx: number): number | 'blocked' {
    const v = grid.depareVerdict[idx];
    if (Number.isNaN(v)) return 'blocked'; // unvouched/uncharted → refuse, never clean
    if (v >= TIER2) return 1.0; // DEEP — marks-free is FINE here
    if (v >= draftFloor) return 4.0; // PASSABLE-WITH-CAUTION (red; won't ground,
    //   but marginal without pilotage)
    return 'blocked'; // CAUTION sentinel / below draft floor
}
```

`tier2Navigable[idx] = (tier2CellCost(idx) === 1.0)`. This deliberately treats merely-draft-deep-but-shallow water (3.5 m, which the engine accepts for _marked_ channels) as **off-limits to marks-free crossing**. `LNDARE` land and uncharted are `'blocked'`. **DRGARE/OSM-canal-covered water is treated as `≥ TIER2` by fiat** where charted depth is coarse (the Brisbane shipping channel reads ~2 m at 30 m AusBathyTopo; the engine already protects it via `protectedCells` — tier-2 inherits that protection so a genuinely-deep dredged crossing is not falsely refused). Implemented as a **discrete DEPARE-band contour membership test** (steal PredictWind), with a **published honesty floor of `draftM + 0.5 m`** (steal Garmin's 3 ft clamp).

### 4.3 Algorithm

1. **Snap** `entry`/`exit` to the nearest `tier2Navigable` cell within one gate-spacing (`snapToCell`, `connector.ts:525` pattern). If `entry.snapped === false` → `Refusal('entry-unsnapped')` (do **not** route to a fictional deep node — that reintroduces the marina-disconnect bug). If `exit` cannot reach a `≥ TIER2` cell → the dest side is genuinely shallow → that is **tier-3's job** → `Refusal('exit-not-deepwater')`. Validate `entry` and `exit` are in the **same grid component** before routing; a disconnected component (the Fisherman Islands bbox-padding problem, `inshoreRouterEngine.ts:2767–2778`) → `Refusal('disconnected-grid')`, **never** a straight-line bridge.
2. **A\*** on the grid (`inshoreRouterEngine.ts:2077`), 8-neighbour, substituting `tier2CellCost` for `cellCostMultiplier`. **No preferred-disc multipliers** — tier-2 has no marks to bead through, which is _structurally_ why it cannot step. Cost is pure geometric metres on deep cells. If no all-deep path exists, the 4.0× CAUTION cells are admitted and those vertices flagged `cautionMask=true` (red).
3. **Simplify**: `smoothPath` (`inshoreRouterEngine.ts:3204`) **unconstrained** (no discs to honour) → then `douglasPeucker` (`:3440`) to a **handful of vertices** at a coastal tolerance (~1 cable / 185 m, ≈ 2× cell res). Open water wants **few, fat, hand-steerable legs**, not a dense raster. Because there are no discs to preserve, simplification is **lossless w.r.t. intent** (unlike the monolith, where `smoothPath` fights `fairlead`).
4. **Re-validate** the simplified polyline against `tier2Navigable` at half-cell steps; if simplification cut a corner into a non-navigable cell, **re-insert the pinch waypoint** (cost-no-worse, mirroring the engine's `fairPath` discipline).
5. **Pin endpoints** to `entry`/`exit` exactly; set `exit.headingDeg` = bearing of the final simplified segment **into** the node, so the Gluer's clause-2 has a true value to test against tier-3's channel-mouth heading.
6. **No fairlead / leadingLine / marina calls** — they are _structurally not invoked_ in tier-2. That is the whole point.

### 4.4 Output

```ts
return Object.freeze({
    tierId: 2,
    entry,
    exit,
    polyline,
    cautionMask, // all-false unless step 2 admitted CAUTION cells
    controllingDepthM: minDepareVerdictAlong(polyline),
    depthSource: anyGebcoSampled ? 'gebco' : 'charted',
    provenance: 'coastal-deepwater',
});
```

### 4.5 How its leg glues to tier 3 at the last lead

The `entry`/`exit` `BoundaryNode`s **ARE** the Seaway portals. Tier-2 routes **portal → portal**, and `glue(coastalLeg, channelLeg)` joins on the **shared portal identity** (clause 1 passes by construction). The portal sits one gate-spacing seaward, directed along the channel axis via `buoyageBearingDeg`, so tier-2's final-segment bearing naturally lines up with the channel's entry heading → clause 2 passes with no seam kink. **No new boundary machinery** — the connector already produces the deep-snapped node.

### 4.6 What makes it honest

- A\* finds no `tier2Navigable` path (continuous shoal blocks the marks-free crossing) → `Refusal('no-deepwater-corridor')`. It does **not** downgrade to routing through shallow/uncharted water dressed as clean.
- `entry.snapped === false` → `Refusal('entry-unsnapped')` rather than route to a fictional deep node.
- A crossing that needs >1 NM of `UNCHARTED` → `Refusal('uncharted-run')` (reuse `UNCHARTED_MAX_RUN_M = 1852`, the sweep at `inshoreRouterEngine.ts:3487–3516`) — the Bribie / Newport→Mooloolaba field bug, refused instead of drawn as a confident straight line.
- **Shallow stays red because it is simply not in the navigable mask.** Tier-2 can never draw a confident line over it; the refusal/red path is the only option when deep water runs out. A no-data bay never renders as confident tier-2 water.

---

## 5. Phased migration plan

Each phase is shippable and reversible. **Tier-2 + the 2↔3 seam ship first**, because that is the exact span where the field bugs live, and it touches the smallest amount of live code.

**PHASE 0 — the seam (this week, risk-free).** Introduce `services/routing/legContract.ts` (`Leg`/`BoundaryNode`/`Refusal`), `services/glue/gluer.ts` (4-clause contract + `stitchLegs`), and the **three seam fixtures** (Newport stepping, Brisbane 175°, Newport ±171°). Lift the 120° check (`inshoreRouterEngine.ts:3603/3789`) into the Gluer. **Nothing wired live** — types, gluer, and failing-then-passing fixtures only.

**PHASE A / 1 — tier-2 + segmentation, in shadow.** Build `services/tier2/coastalRouter.ts` (`routeDeepWater`, reusing engine grid / A\* / `depareVerdict` / `smoothPath`) and `services/routing/segmentRoute.ts` (reusing `parseLateralMarks` + `findCorridorCoverageGap` + `synthesizePortals`). Pin `TIER2_NAVIGABLE_DEPTH_M` in a fixture, **owner-confirmed before any mark-skipping ships**. Run `segmentRoute` and tier-2 in **shadow** beside the live monolith (mirror `SEAWAY_SHADOW_ENABLED` at `InshoreRouter.ts`), logging the span breakdown and seam refusals for Newport→Murrarie (expect ~5 NM tier-3 + ~15 NM tier-2). **Zero user impact**, and it exercises exactly the seam where the field bugs live. Tier-2 unit-tested in isolation against synthetic bay fixtures + the real corridor fixture (§5.1).

**PHASE B / 2 — promote, minimal orchestrator change.** In `routeInshoreOnce`, **gate** the existing splice block (`inshoreRouterEngine.ts:3457–3465`) behind segmentation: run fairlead/leadingLine/marina **only on tier-3 spans**; run `routeDeepWater` on tier-2 spans; `stitchLegs` joins them. The monolith's whole-polyline mutation becomes **per-span**. This is the smallest change that kills stepping: on the Newport bay span, fairlead is **simply never called**, so it cannot return raw beads. Promote per-corridor when the seam tests + the existing `scorecard-baseline.test.ts` gate beat the hardened monolith baseline on the pinned corpus. **Keep the old whole-route path behind a flag for one release** as fallback + output diff (Newport→Mooloolaba must stay clean; Newport→Murrarie must lose the step).

**PHASE C / 3 — tier-1 seam.** Wrap `IsochroneRouter`/`weatherRouter` to emit a tier-1 `Leg`; `segmentRoute`'s leading/trailing GEBCO runs hand off at the shelf-edge portal. The `useVoyageForm` inshore-vs-isochrone all-or-nothing fallback (456–543) becomes per-span.

**PHASE D / 4 — promote Seaway as tier-3.** When the Seaway corpus clears `'no-compliant-path'` on the 98-gate Brisbane corridor (collab plumbing armed, reply 25/33), swap fairlead/leadingLine for graph edges on tier-3 spans — **same `Leg` contract, same Gluer, no orchestrator change**.

**KEPT:** the engine's `NavGrid` + cost ladder + DEPARE rasterisation (tier-2 and the connector consume them); `IsochroneRouter`/`weatherRouter` (wrapped); `fairlead`/`leadingLine`/`marinaCenterline` (re-homed to tier-3 spans, **not** rewritten).
**DELETED** (once Phase B is proven on the corpus): the in-place splice chain (`inshoreRouterEngine.ts:3457–3465`) as a blanket whole-polyline pass; the post-hoc `maxTurnDeg` diagnostic (`:3603`, replaced by Gluer clause 2); the silent `passthrough` returns in `applyFairleadAtGrid` (`:3552, :3596`) — under the leg contract, no-marks on a tier-3 span returns a **refused leg with a reason**, never raw beads.

### 5.1 The first concrete PR

**`feat(routing): tier-2 coastal deep-water router + 2↔3 seam (shadow)`**

New files:

- `services/routing/legContract.ts` — `Leg` / `BoundaryNode` / `Refusal` + `freezeLeg`.
- `services/tier2/depthThreshold.ts` — `TIER2_NAVIGABLE_DEPTH_M` + `clampToDepareBand`.
- `services/tier2/coastalRouter.ts` — `routeDeepWater` (§4).
- `services/routing/segmentRoute.ts` — `segmentRoute` (§2).
- `services/glue/gluer.ts` — `glue` / `stitchLegs` (§3).
- `tests/tier2/coastalRouter.test.ts` — **fixture-backed** against `tests/fixtures/newport-rivergate-marks.corridor.json.gz` (the real Newport→Murrarie corridor: `from −27.2135,153.0875` → `to −27.4268,153.1267`, draft 2.4 m, all ENC class layers incl. `BOYLAT/BCNLAT/FAIRWY/DRGARE/RECTRC/NAVLNE`).
- `tests/glue/seam.test.ts` — the three planted-mismatch seam fixtures.

The fixture test asserts the full pipeline on real data:

```ts
import corridor from '../fixtures/newport-rivergate-marks.corridor.json.gz'; // {cells, osm, request, _meta}

const grid = buildNavGrid(corridor.cells, corridor.osm, corridor.request); // reuse engine builder
const marks = parseLateralMarks(corridor.cells);
const spans = segmentRoute(origin, dest, grid, marks, /*graph*/ null, 2.4, 0.2, 0.5);

// 1. Segmentation: three spans, tier-3 / tier-2 / tier-3.
expect(spans.map((s) => s.tier)).toEqual([3, 2, 3]);

// 2. Tier-2 bay leg: deep, marks-free, FEW waypoints, no bead-stepping.
const bay = spans.find((s) => s.tier === 2)!;
const leg = routeDeepWater(grid, bay.entry, bay.exit, 2.4, 0.2, 0.5) as Leg;
expect(leg.refused).toBeUndefined();
expect(leg.polyline.length).toBeLessThan(8); // fat hand-steerable legs
expect(maxTurnDeg(leg.polyline)).toBeLessThan(45); // no stepping
expect(leg.controllingDepthM).toBeGreaterThanOrEqual(5.0); // honest 5 m floor

// 3. The 2↔3 seam: shared portal identity + heading continuity.
const channelLeg = wrapFairleadAsLeg(grid, marks, bay.exit, dest);
const seam = glue(leg, channelLeg);
expect('refused' in seam).toBe(false);
expect(seam.joined.entry).toBe(leg.entry); // clause 1, by identity
```

Wiring: `segmentRoute` + tier-2 run in **shadow only** behind a flag mirroring `SEAWAY_SHADOW_ENABLED`. No live route changes. `TIER2_NAVIGABLE_DEPTH_M` is fixture-pinned and flagged for owner sign-off before Phase B.

---

## 6. How this kills the stepping / seam bug class

The class is: _"a downstream splice silently mutates — or silently no-ops on — the WHOLE polyline, with no contract about the seam."_ Five structural changes make it impossible.

1. **Immutable legs + concat-only glue.** No tier ever receives another tier's polyline; the Gluer only concatenates (`legA.polyline ++ legB.polyline[1:]`) and never re-smooths an interior. The fairlead-overwrites-smoothPath, snap-overwrites-fairlead, approach-re-splices-tail chains (the four implicit seams) **have no code path to exist** — there is one join operator and it adds nothing.

2. **No mid-route splice decision.** The Newport stepping bug is literally `applyFairleadAtGrid` scoring the bay gate at 0.59 < 0.60 and returning `passthrough` — the raw A\* beads — for the entire route (`inshoreRouterEngine.ts:3552, 3596`). Under segmentation-first there is no "decide whether to splice": the segmenter already decided, up front, that the bay span is tier-2. There is **no input polyline** to silently pass through, and on a tier-2 span **fairlead is never called**. The bay leg is tier-2's flat-1.0× geodesic on the deep mask — inherently un-stepped because it sets **no preferred discs to bead through**.

3. **No competing owners.** The 175°/±171° double-backs were fairlead AND leading-line snap both mutating the same stretch with no agreement. After segmentation, exactly **one** tier owns each metre (priority tier-3 > tier-2 > tier-1 over **disjoint** spans). Two routers can never write the same vertex.

4. **Heading continuity is a hard gate, not a warning.** The double-backs were detected post-hoc by a diagnostic that logged and stopped nothing (`:3603`). Clause 2 promotes `|Δheading| > 120°` to a `Refusal` at **every** seam: the route refuses (renders red) rather than ships a reversing turn. The bug becomes a unit-test fixture, not a field report.

5. **Refusal is first-class; no silent fallback to stale geometry.** Under the leg contract a tier that cannot serve a span returns a typed `Refusal` (not the unchanged input). The Gluer sees it and the route is honest-red / refused up to that seam. The invisible "returned input unchanged" path (`:3552`) — the exact line the survey fingered — **no longer exists** as a way to leak geometry past a seam. "Confident clean water over no-data" is gone because a `'none'`/uncharted leg propagates as red and the Gluer never upgrades it.

**Net:** stepping dies because the stepping span is no longer any splice's responsibility (it is a disc-free tier-2 geodesic); double-back dies because every seam enforces heading continuity at shared-identity boundary nodes; confident-clean-over-no-data dies because refusal/red propagates and is never silently upgraded.

---

## Appendix — risks carried forward (must-watch)

1. **`TIER2_NAVIGABLE_DEPTH_M` ≈ 5 m is safety-critical.** Must be **owner-confirmed and fixture-pinned before any mark-skipping ships**. Reusing `tideSafetyM = 0.5` (the bar/pilotage number) as the open-water number would let tier-2 cut marks-free across marginal water = grounding / wrong-side, a house-doctrine violation. The `2×draft` floor is a proposal; Shane signs off exactly as he did `tideSafetyM = 0.5`.
2. **Seaway tier-3 is not yet promotable on dense corridors** — the 98-gate Brisbane corridor returns `'no-compliant-path'`. Phases must keep the interim fairlead/marinaCenterline legs (behind the same `Leg` contract) until that verdict resolves. Phase D is not assumed reachable soon; the FAIRWY/DRGARE-extent fallback boundary stays **first-class**, not an afterthought.
3. **Portal honesty (`snapped:false`) must be respected.** `synthesizePortals` only emits terminal portals for ≥2-gate channels; single-gate/regional channels get none. Tier-2 must **refuse** rather than route to an unsnapped portal, or the marina-disconnect bug reappears at the seam. Phase 1/2 may use the lightweight outermost-gate-midpoint boundary first, adopting `synthesizePortals` only once it is proven outside shadow.
4. **Coarse (30 m) bathymetry mis-tags.** A real shallow flat (Bramble Bay) could read as a single deep sample and mis-tag a tier-3/shallow stretch as tier-2. Mitigations: run-length **min-span** + per-vertex `cautionMask` + **never absorb a CAUTION/UNCHARTED span**. The **DRGARE/OSM-canal carve must run before the mask is derived** (engine Pass 1b/4) so dredged corridors are tier-3, not blocked. The tier predicate inherits all DEPARE data-gap risk.
5. **120° vs a genuine dog-leg mouth.** A legitimate sharp channel entry (>120° real turn) would be refused. The boundary node must carry the channel's **true** `buoyageBearingDeg`, and the threshold may need a **per-boundary-kind** value (looser at a genuine mouth). Pin against the real corpus before tightening.
6. **Two metre conventions coexist** (engine 111 320 m/°lat vs graph 110 540). Tier-2 prices on the engine grid; the portal lives in graph space. The boundary-node conversion must be exact or clause-1's 1 m epsilon spuriously fails. **Pin a round-trip fixture.**
7. **The segmenter samples the straight planning line**; the actual tier-2 route may bow into a different regime. Mitigation: **re-validate** tier classification along each emitted leg (not just the planning line) and re-segment once if a leg's samples disagree with its declared tier — bounded to one re-pass.
8. **Shadow grid-build cost / bbox.** `segmentRoute` in shadow must reuse the cached `NavGrid` (never a synchronous build) or marina-scale fine-pass routes pay a latency tax. Tier-2 inherits the cached grid's bbox/relax params; a tier-2 span whose corridor sits outside the cached bbox sees a disconnected component → must surface `Refusal('disconnected-grid')`, never a straight-line bridge. Phase-A shadow must explicitly cover the marina-mile spans, or the promotion corpus stays blind to the tier-3 case the graph most needs to prove.

---

## 6. Red-team verdict + applied corrections (2026-06-17)

**Verdict: sound-with-changes.** The spine — immutable `Leg` + concat-only `Gluer` + first-class `Refusal` — genuinely makes the implicit-splice bug class structurally impossible, and the 5 m all-tide depth gate is sound and owner-confirmed. The line-reference audit passed. Three FATAL flaws and one honesty bug must be fixed as the phases land:

**Applied in PHASE 0 (this commit):**

- **Clause 2 is heading + cross-line, not heading-only.** A `≤120°` heading match at a single node does NOT guarantee side-correctness: a tier-2 approach laterally offset from the channel can agree on heading yet cross the outermost gate on the wrong side. The Gluer now wrong-side-checks the seam segment against the boundary gate's span by reusing `services/seaway/crossLine.ts` → `Refusal('wrong-side')`. (`BoundaryNode.crossLine` carries the gate span.)
- **Clause 1 is positional (≤ `JOIN_EPS_M`), not strict object identity.** Co-located distinct nodes each carry their own tier's through-heading (so clause 2 can SEE a reversal); the positional check is exactly what catches a tier that re-snapped its endpoint OFF the shared boundary (the red-team identity bug) — no fuzzy bridge papers a gap.

**Required in PHASE 1+ (segmentation / tier-2), NOT yet built:**

- **FATAL — segment the REAL A\* route, not the rhumb.** The navigable corridor bows off the straight line (Newport→Murrarie is 22.26 NM navigable vs ~13 NM straight, crossing ~10 NM of Bramble Bay drying flats). `segmentRoute` must run the engine A\* FIRST and classify the ACTUAL polyline; classifying the straight planning line would refuse the working route. (Keep segment-first only for the offshore/coverage cut.)
- **MAJOR — depth honesty: `NaN` ≠ blocked.** `depareVerdict === NaN` means "no DEPARE polygon here" (incl. deep OSM-vouched water), not uncharted. Gate tier-2 `'blocked'` on `grid.unvouched` (`inshoreRouterEngine.ts:1626`), the real no-evidence signal — not on `NaN`.
- **MAJOR — fixture.** `newport-shane`/Newport→Murrarie has **no tier-2 span** (the deep water IS the dredged channel; 8/1681 box samples ≥5 m). It is the tier-3-only regression (must still resolve at 22.26 NM). Tier-2 must be proven on a genuine open-bay deep crossing fixture (a Moreton Bay deep leg) — capture one before building `coastalRouter`.
- **Reconcile the snap predicates:** portal deep-snap (`connector.ts:474`, `cells>0`) vs tier-2 deep (`depareVerdict≥5`). Define the `BoundaryNode` as authoritative; tier-2 must not re-snap entry/exit off it (clause 1 enforces this).
