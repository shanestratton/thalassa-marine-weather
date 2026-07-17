# ENC Layer Burn-down #3 — frozen scope, from the 2026-07-17 closing audit

**Baseline: 84.25/100** (closing open adversarial audit `wf_f44069cf-1eb`,
11 agents, zero refuted verdicts; transcript in
ENC_AUDIT_2026-07-17_closing.md). Shane's call 2026-07-17 evening: option
2 — keep marching cycles. Same protocol: burn to zero, score = 84.25 +
banked ("vs the closing bar"), tsc + targeted tests + explicit-path
commits + build/sync per item, ONE open adversarial audit at the end.
Priced scope: **15.75 pts** (84.25 + 15.75 = 100).

Chief's fix-first (berth exemption) was fixed the same evening — first
ledger row below.

## Safety (2.5)

- [x] **0.75 — Berth exemption waives distant arms of the terminal's own
      (Multi)Polygon** — DONE same evening (`5455543a`): per-locality
      waiver (`BERTH_EXEMPT_RADIUS_M` 500 m), old pinning test re-pinned,
      distant-arm MultiPolygon regression added.
- [x] **0.5 — Regional MSL→LAT pessimism** — DONE: `gebcoDatumDeltaM`
      option; the validator scales it from the live tide curve's range
      (0.6 × range, floored at the Moreton 1.3 m — can only get MORE
      cautious); 2 tests incl. the floor-never-relaxes case.
- [x] **0.5 — Proximity report nearest-approach** — DONE: polygon/line
      hazards ranked by their closest VERTEX to the route (stride-capped),
      same treatment as COALNE — a training wall 0.1 NM abeam can no
      longer vanish because its bbox centre sat outside the buffer.
- [x] **0.25 — tideConstrained propagates from segment-crossing hits** —
      DONE: threaded through querySegmentHazards' return, counted per pass
      in the validator, buildRouteAdvisories takes the segment count.
- [x] **0.25 — explodeSoundings per-point depth only** — DONE: the
      feature-level fallback now applies ONLY to single-Point features;
      unmatched MultiPoint members are skipped as unknown.
- [x] **0.25 — UWTROC VALSOU enters the hazard model** — DONE: rocks
      carry depth/drying context into severity + the report; old test that
      pinned the drop re-pinned (incl. drying negative VALSOU).
- [ ] **0.5 — Depth-band palette abandons blue-shallow coding** — shallow
      water is the least saturated thing on the chart; revisit ramp
      (S-52/paper: shallow = blue). CAREFUL: Shane approved the white
      ramp (`1dc014f0`) — confirm with him before touching.
- [ ] **0.5 — Lights: near-all 'minor' (hidden < z10), ★ text glyph, fixed
      900 m sector arcs** — tier by LITCHR/category not just VALNMR; real
      light-flare glyph; scale sector arc radius (VALNMR when present).
- [ ] **0.25 — Preferred-channel BEACONS drop junction banding** — extend
      the banded treatment (buoys done in #2) to BCNLAT 3/4.
- [ ] **0.25 — Wreck/obstruction taxonomy collapsed** — CATWRK 3/4/5 and
      OBSTRN WATLEV variants all wear one glyph; differentiate per INT1.
- [x] **0.25 — IALA-B prefix set** — DONE (+15 HOs: Taiwan, Central
      America, Caribbean chain, PR/USVI).
- [ ] **0.25 — Line seam de-dup clips against the finer cell's WHOLE
      DEPARE-extent rect** — presence-gate is per layer but the clip frame
      is the full extent; clip against the finer cell's SAME-LAYER data
      extent instead.
- [x] **0.25 — Caution colour table** — DONE: CAUTION_CLASS_COLOURS is
      the ONE vocabulary — the mount's match-expression and the popup
      accents both read it (six classes had drifted).
- [ ] **0.25 — Night dim ≠ S-52 palette (hue degradation)** — DEFER-WITH-
      REASON candidate again; if deferred twice it stays unbanked.
- [ ] **0.25 — Drying underline via U+0332 may not shape in Mapbox GL
      (PLAUSIBLE)** — verify on device; fallback = italic or prefix
      convention if the combining char doesn't render.
- [ ] **0.25 — TOPMAR/DAYMAR + BOYSHP/BCNSHP not rendered** — glyphs are
      fixed archetypes; extract + render shape variants (extractor batch).
- [ ] **0.25 — Case-defensiveness broken on render label/sort
      expressions** — lowercase (ogr2ogr) cells lose marks/lights in
      data-driven expressions; coalesce both cases in expressions (the
      readS57 sweep covered JS, not Mapbox expressions).

## Performance (1.75)

- [ ] **0.5 — Cold-path multi-MB JSON.parse indivisible** — parse on
      encGeometryWorker or chunk (EncCellStore ~195-208).
- [x] **0.25 — glazeCellCache feature budget** — DONE (120k-feature
      sum cap alongside the entry cap, oldest-first).
- [x] **0.25 — First-mount double-compute** — DONE with the table:
      ensureSource takes a LAZY builder, so POINTS/NAVAIDS build once (in
      the staggered refresh), not twice.
- [x] **0.25 — Merge memo 2 → 4 slots** — DONE (holds a z11↔z13
      excursion's bucketed keys; test re-pinned).
- [x] **0.25 — Clone budget** — DONE (payload weight = features +
      coverage verts; soft cap 60k logs, hard cap 200k drops the glaze
      half and keeps the instant grade).
- [x] **0.25 — getOrBuildIndex coarse-sliced** — DONE (macrotask
      between the four builds + RBush construction).
- [x] **1.0 — Worker protocol lifecycle tests** — DONE: 6 lifecycle tests
      over the REAL parking/cache modules with a fake Worker — round-trip
      reassembly (untouched stripped from the wire), overlapping jobs on
      one glaze key, eviction-abandon on 'done', error cleanup scoped to
      its own job, symmetric postMessage-failure release, coverage-lib
      subsetting.
- [x] **0.75 — Hand-mirrored ensureSource/uploads lists** — DONE:
      `ENC_SOURCE_TABLE` (id + builder + buffer, upload-priority order)
      drives BOTH the mount and the staggered refresh; completeness smoke
      test locks table ↔ ENC_VEC_SRC 1:1.
- [ ] **0.75 — Residual god modules** — extract tagAndPush, the glaze
      memo/queue block, and the slicer from the ~590-line merge fold;
      next slab from EncVectorLayer.
- [x] **0.5 — Comment/doc drift** — DONE: source counts 11/12/9/6 → 14,
      failed-load contract now states the 60 s cooldown (both sites),
      HazardReportPanel position comment corrected.
- [x] **0.5 — glaze-LRU invariant** — DONE: `ensureGlazeCapacity(n)`
      (grow-only, merge size + slack) declared by every glaze merge — the
      all-or-nothing upgrade can no longer self-defeat on a >32-cell
      window; 2 tests.
- [x] **0.5 — EncCellStore duplication** — DONE: loadCellGeoJSON is now
      COMPOSED from readCellRaw + parseAndCacheCellText (was a third
      hand-written parse/shape-gate/cache copy); readCellRaw reports
      notFound so the remote ladder still only runs on ENOENT.
- [x] **0.5 — Dead exports + duplicated localStorage keys** — DONE:
      MapHub imports ENC_NIGHT_DIM_KEY + SATELLITE_KEY from their one home
      (the raw-string writes were an untested cross-file equality); carve
      leftovers (6 dead imports) swept; PLUS the 15 FilterSpecification
      casts the earlier "casting" bank missed now route through mapFilter
      (honesty catch — the earlier claim covered ExpressionSpecification
      only).
- [ ] **0.5 — Visibility state machine composes via BCNLAT probe +
      last-writer-wins** — replace probe with explicit state; document
      precedence.
- [x] **0.25 — readS57 stragglers + expression casting** — DONE: last 4
      case-defensive pairs swept (extras.seabed/caution, InshoreRouter
      CATCAM, merge CATLAM); zero `as unknown as ExpressionSpecification`
      remain outside mapExpr's own doc.
- [x] **0.5 — Chart key sweep** — DONE: Deep-water route +
      Precautionary area keyed (the TSS-family additions).
- [x] **0.5 — Stacked cautions ALL fold in** — DONE: pickAreaTap
      collects every caution wash above the water; the popup renders one
      ⚠ row per restriction; regression test.
- [x] **0.5 — 'Plan ENC Route' demo row** — DONE: reads the real vessel
      draft (fallback 2.5 m); errors humanised (no engine internals).
- [x] **0.25 — Plan ENC Route clearable** — DONE: Clear All now also
      clears the test route (its route-focus mode stripped core safety
      layers for the session).
- [x] **0.5 — Night toggle surfaced** — DONE: floating ☾ on the map
      (one tap, same persisted state); the menu row stays.
- [x] **0.25 — Advisory decodes CATZOC** — DONE ('ZOC D' wording; test
      re-pinned).
- [x] **0.25 — Hazard panel a11y** — DONE: aria-live=polite on the
      region (list roles were already in place).
- [x] **0.25 — Dynamic Type hook** — DONE: popup tracks iOS text size
      via -apple-system-body with a 13px floor (device eyeball pending).
