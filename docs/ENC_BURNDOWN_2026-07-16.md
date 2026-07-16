# ENC Layer Burn-down — frozen scope, 2026-07-16

**Baseline: 79.6/100** (11-agent adversarial audit `wgdm8rtbl`, red-teamed both
directions). This document FREEZES that audit's finding set as the
certification scope for the quality mission's 96 floor.

## Why frozen scope

Six adversarial audit cycles on 2026-07-16 (74.6 → 75.45 → 80.75 → 79.1 → 79.6)
showed a consistent dynamic: every round's fixes verified sound (+~3 pts
recovered), and every round's deeper digging found ~3 pts of new deductions.
The audit's own words: _"the score barely moving while the code improved is
the audit getting sharper, not the work regressing."_ An ever-sharpening bar
is unwinnable by iteration; a frozen, priced list is real engineering.

**Certification protocol (agreed with Shane 2026-07-16):**

1. Burn this list to zero. Score = 79.6 + points banked (labelled "vs the
   2026-07-16 bar" — never presented as an open adversarial number).
2. On completion, run ONE final open adversarial audit as the honesty check,
   so we never grade our own homework. New findings from that run seed the
   NEXT burn-down; they do not retroactively unbank these points.
3. Every item ships with the usual gates: tsc clean, tests, explicit-path
   commits, build + `cap copy ios`.

Total scope: **18.5 pts** (device-gated: 1.75). 79.6 + 18.5 = 98.1;
without the device item, 96.35 — **96 is reachable fully non-device.**

## The list

### Banked (fixed same day, commits noted)

- [x] **1.5 — Exhaustion advisories + loud fail-open** — advisories
      (no-data/CATZOC/caution-crossings) now run on the exhaustion path with the
      exhaustion caution leading; the silent hazard-query fail-open now clears the
      stale report + posts an unmissable caution. (`98a546fc`)
- [x] **0.75 — Caution wash stops stealing the water tap** — over charted
      water a caution tap answers as WATER with the restriction folded in
      (extras.caution); standalone caution popup only where no water lies under.
      (`e66eacc5`)
- [x] **0.5 — GEBCO LAT/MSL datum guard** — no positive tide credit on
      MSL-referenced GEBCO depths (was anti-conservative by ~half the tidal
      range). (`98a546fc`)

**Banked: 2.75 → running score vs this bar: 82.35**

### Safety / routing

- [x] **1.5 — Wire depthCostMultiplier into route selection** — DONE
      (`72751355`): capped (1.5×) depthCostPenalty inflates the isochrone
      candidate's RANKING distance only; arrival acceptance unaffected, no-grid
      sessions skip it. Honesty comments updated.
- [x] **1.5 — Grounding-query edges** — DONE (`d2baa0eb`): SOUNDG never
      grants `insideCharted` (soundingOnly flag; queryHazards demotes a
      draft-cleared sounding-only result to GEBCO); the sub-231 m zero-sample
      break removed (crossing test always runs); >5 m draft clamp surfaced as a
      loud caution.
- [ ] **1.0 — Spatial tide honesty** — per-region tide curves on long routes,
      or a station-distance advisory (Broad Sound ~8 m vs Moreton ~2 m on one
      mid-route curve today).

### Performance

- [x] **1.75 — Chunk the merge's three indivisible main-thread passes** —
      DONE (`caa339da`): tagAndPush yields per-64-features through the
      cooperative slicer; the sounding ladder self-slices every 1024 points;
      the JSON.parse pass already yielded per-cell (verified).
- [x] **1.2 → 0.8 banked — GEBCO cache bound (20k LRU) + INDEX_CACHE_MAX
      12→24** — DONE (`f909cb3d`). VTS-from-data (0.4) DEFERRED WITH REASON:
      OSM does not reliably carry MSQ's gazetted VTS boundary — needs curated
      gazetted geometry, not a code change.

### Code quality

- [ ] **1.2 — End-to-end merge-fold tests** (task #27) — shadow-drop +
      line-dedup + cull interplay through buildMergedVectorData.
- [ ] **1.6 — Seam tests + dedupe** — HazardQueryService phase-1/2 split +
      outage catch tests; EncVectorLayer logic extraction/tests
      (fillDepareTideWindow, click routing); dedupe the triplicated
      candidate-resolution boilerplate with a determinism sort.

### Rendering

- [ ] **0.75 — INT1 glyph set** for UWTROC/WRECKS/OBSTRN with CATWRK/WATLEV
      differentiation (dangerous vs swept wreck).
- [ ] **0.75 — TSS directionality end-to-end** — read ORIENT in
      buildCautionAreas, lane arrows on the wash, direction row in the popup.
- [ ] **0.5 — S-52 day/dusk/night palette** for the chart layers (the white
      ramp kills night vision at the helm).
- [ ] **0.5 — Missing charted-area classes** — CTNARE, TSEZNE, ACHARE,
      MARCUL, CBLSUB/PIPSOL lines; render the already-extracted FAIRWY.

### UX

- [x] **1.75 — UX cluster** — DONE (`e58c8f8d`): severity-tiered crossings
      (entry-prohibited/-restricted = caution), caution-aware panel headlines,
      RESTRN raw-code fallback in advisory + popup, aria-expanded on both
      collapsible panels. (Accent unification + micro-type were already
      delivered in `8c005171` / the earlier 10 px legibility pass.)

### Device-gated

- [ ] **1.75 — Ship the martinez true-coverage glaze on-device**
      (process-isolated worker or precomputed coverage) + verify shallow-wash
      visuals + the de-dup gate on live partial-coverage cells. Needs Shane's
      iPhone + profiling.

## Ledger

| Date       | Item                                                           | Pts  | Commit     | Running (vs 79.6) |
| ---------- | -------------------------------------------------------------- | ---- | ---------- | ----------------- |
| 2026-07-16 | Exhaustion advisories + loud fail-open                         | 1.5  | `98a546fc` | 81.1              |
| 2026-07-16 | Caution wash tap fold-in                                       | 0.75 | `e66eacc5` | 81.85             |
| 2026-07-16 | GEBCO LAT/MSL datum guard                                      | 0.5  | `98a546fc` | 82.35             |
| 2026-07-16 | depthCost nudge wired into selection                           | 1.5  | `72751355` | 83.85             |
| 2026-07-16 | Grounding-query edges (soundingOnly / sub-231 m / draft clamp) | 1.5  | `d2baa0eb` | 85.35             |
| 2026-07-16 | Advisory UX cluster (tiers / headlines / raw codes / a11y)     | 1.75 | `e58c8f8d` | 87.1              |
| 2026-07-16 | Merge main-thread passes sliced (fold + ladder)                | 1.75 | `caa339da` | 88.85             |
| 2026-07-16 | GEBCO cache bound + index LRU resize (VTS deferred w/ reason)  | 0.8  | `f909cb3d` | 89.65             |
