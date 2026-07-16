# ENC Layer Burn-down #2 — frozen scope, 2026-07-17

**Baseline: 83.75/100** (final open adversarial audit `wf_d5a64621-927`, 11
agents, zero refuted verdicts). This is the honesty-check audit that closed
[burn-down #1](ENC_BURNDOWN_2026-07-16.md) per its certification protocol:
the 2026-07-16 bar was burned to zero (97.7 vs that bar, device-verified),
and this fresh, unanchored audit priced what deeper digging found. Those
findings freeze HERE as the next certification scope.

Dimension scores: safety 26/30 · rendering 16.75/20 · perf 12.75/15 ·
code quality 16/20 · UX 12.25/15.

**The chief auditor's headline:** the layer's failure mode is _confident
silence_ — a route can silently degrade to GEBCO (corrupt cell), ship
unvalidated (timeout race), tide-credit the wrong hour's water (degenerate
short-route ETAs), or compare against the wrong datum (MSL vs LAT), and the
HazardReportPanel shows the same clean green face as a fully-validated
route. Fix the silent failures first.

## The list (16.25 pts priced; #5's CQ+perf twin counted once as a fix)

### Safety (4.0)

- [ ] **1.0 + 0.5 UX — Corrupt-cell → GEBCO degrade is silent** — propagate
      cell-failure + `source:'gebco'` counts into `buildRouteAdvisories` as a
      loud caution ("N% of route verified on 460 m ocean bathymetry only");
      retry failed blobs instead of session-pinning. (Retires finding #1.)
- [x] **1.0 — Validation-timeout race ships unvalidated route + stale
      report** — DONE: `ValidateRouteOptions.stillCurrent` gates every
      phase-5 `setLastReport` write (checked again after the hazard walk);
      `publishReport:false` bars the ECMWF braid from ever owning the
      singleton report; all 4 race sites flip a stale flag when their
      timeout wins; new `publishRouteNotValidated` posts a loud "Route NOT
      verified" caution on timeout AND on validator throw (was a
      prod-silenced log.info with the previous route's clean report still
      up). 3 tests lock the publish helper.
- [x] **0.5 — Short-route (<100 NM) ETAs pinned to departure time** — DONE:
      all three zero-ETA sites (seed pair, minimal route points, ECMWF braid
      nodes) now carry honest cumulative ETAs via the new pure
      `cumulativeLegs` (geodesy.ts) — the tide-curve window sized from the
      last node un-collapses too. CHIEF'S FIX-FIRST.
- [ ] **0.75 — Tide-gated legs validate silently clean** — flag hazards
      cleared ONLY by positive tide credit; surface a "tide-constrained leg"
      advisory with the window.
- [ ] **0.5 — GEBCO MSL-vs-LAT datum offset uncompensated** — subtract a
      conservative regional MSL→LAT delta (~1.0-1.3 m in Moreton Bay) before
      threshold comparison on GEBCO fallback points.
- [x] **0.25 — Degenerate short-route ETAs (red-team add)** — DONE with the
      above: `cumulativeLegs` tests lock monotonic ETAs, the 4-hour-leg
      scenario, NaN/zero-speed floors, and empty/single-point safety.

### Rendering (3.25)

- [ ] **0.5 — Unknown-attribute marks assert specifics** — null CATCAM
      renders a NORTH cardinal ("pass north" the data never said); unknown
      CATLAM gets the port-hand glyph. Fix: neutral "unknown mark" glyph.
- [ ] **0.25 — CATLAM popup wording inverted vs S-57** — swap the two
      `CATLAM_LABELS` strings (encPopup ~487-488), reword to "preferred
      channel to starboard/port", delete dead codes 5-8.
- [ ] **0.25 — ≥10 m sounding rounding (red-team add)** — verify display
      rounding vs charted value at the 10 m boundary.
- [ ] **2.25 — remaining confirmed rendering findings** — full detail in the
      audit transcript (`wf_d5a64621-927`); itemise when picked up.

### Performance (2.25)

- [ ] **0.75 — Post-worker-death glaze machinery fails open** — gate
      queueing on `geoWorkerBroken` liveness; skip prefilter/parking when
      dead; symmetric cleanup in the postMessage catch. (Also retires the
      0.25 CQ leak.)
- [ ] **0.5 — Duplicate-job race (twin of the CQ glazeKey finding)** — one
      fix, see code quality below.
- [ ] **1.0 — remaining confirmed perf findings** — itemise from transcript.

### Code quality (4.0)

- [ ] **1.0 — `glazeAssemblyBase` keyed by glazeKey, not job** — overlapping
      jobs truncate the parked majority and cache incomplete glaze as
      `upgraded:true` (persistent wrong keel-safety wash); error handler
      deletes other jobs' keys. Fix: key by jobId(+glazeKey), per-handler
      cleanup, worker-protocol round-trip test. (Counts the perf 0.5 twin.)
- [ ] **3.0 — remaining confirmed CQ findings** — itemise from transcript.

### UX (2.75)

- [ ] **0.5 — GEBCO-tier verification invisible in HazardReportPanel** —
      folded into the corrupt-cell fix above.
- [ ] **0.25 — No-coverage affordance (red-team add)**.
- [ ] **2.0 — remaining confirmed UX findings** — itemise from transcript.

## Protocol

Same as burn-down #1: burn to zero, score = 83.75 + banked (labelled "vs
the 2026-07-17 bar"), tsc + tests + explicit-path commits + build/sync per
item, ONE final open adversarial audit on completion. Full audit detail:
workflow `wf_d5a64621-927` journal.

## Ledger

| Date       | Item                                                         | Pts  | Commit      | Running (vs 83.75) |
| ---------- | ------------------------------------------------------------ | ---- | ----------- | ------------------ |
| 2026-07-17 | Short-route ETAs un-pinned (cumulativeLegs, 3 sites + tests) | 0.75 | see git log | 84.5               |
