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
- [x] **1.0 — Spatial tide honesty** — DONE (`8fc0fad1`): routes >40 NM
      with a live curve carry a named-station single-curve advisory, appended
      in both exit branches.

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

- [x] **1.2 — End-to-end merge-fold tests** — DONE (`eab82ed0`): the REAL
      fold driven through getMergedVectorData over a coarse+fine library —
      shadow-drop, presence-gated line de-dup, provenance, cautions, SEAARE
      labels, sounding explode+ladder. Task #27 closed.
- [x] **1.6 — Seam tests + dedupe** — DONE in two tranches: 1.2
      (`eab82ed0`) partition tests (ENC/GEBCO split, soundingOnly demotion,
      outage degradation, LAT/MSL clamp) + resolveCandidateIndexes dedupe with
      a deterministic cellId sort; 0.4 — EncVectorLayer click/popup logic
      extracted pure (`pickAreaTap` area-tap precedence incl. caution-over-
      water fold-in, `needsTideWindow` DEPARE tide-window fetch gate) and
      wired back into the handler, 14 tests.

### Rendering

- [x] **0.75 — INT1 glyph set** — DONE (`938f52c1`): +/\* rocks by WATLEV,
      filled-vs-outline wreck hull by CATWRK (unknown reads dangerous),
      foul-ground obstruction circle; icon-allow-overlap.
- [x] **0.75 — TSS directionality** — DONE (`8fc0fad1`): map-aligned ⇧
      rotated to ORIENT on each lane + "Lane direction: 057°" popup row.
- [x] **0.5 — Night palette v1** — DONE (`f39bfb33`): chartplotter-style
      red-tinted uniform dim (scotopic-safe #1a0505 @ 0.45, topmost layer),
      ☾ toggle in chart modes, persisted. A full S-52 colour-table swap
      remains future work — this is the honest v1.
- [x] **0.5 — Missing charted-area classes** — DONE (`0e6f9870` + Pi
      re-extraction #2 → cloud manifest v7): CTNARE/TSEZNE/ACHARE/MARCUL
      end-to-end (Newport now serves CTNARE:13, ACHARE:7) + FAIRWY finally
      rendered (dashed marine-blue boundary). CBLSUB/PIPSOL lines remain in
      the extractor's deferred batch (line geometries, next visual pass).

### UX

- [x] **1.75 — UX cluster** — DONE (`e58c8f8d`): severity-tiered crossings
      (entry-prohibited/-restricted = caution), caution-aware panel headlines,
      RESTRN raw-code fallback in advisory + popup, aria-expanded on both
      collapsible panels. (Accent unification + micro-type were already
      delivered in `8c005171` / the earlier 10 px legibility pass.)

### Device-gated

- [ ] **1.75 — Ship the martinez true-coverage glaze on-device** — CODE
      SHIPPED 2026-07-17 (see below), banks only after the on-device verify.
      The post-mortem's re-enable precondition is met: per-pair vertex cap
      (`GLAZE_MARTINEZ_VERTEX_CAP` 12k) with over-cap pairs degrading to the
      strip-rect clip, shallow-band-only coverage payload, `[glaze]` stats
      warn line for cap tuning. REMAINING (the gate): Shane's iPhone session —
      shallow-wash visuals, the de-dup gate on live partial-coverage cells,
      memory stability while panning the Newport/Bribie seam at z10+.

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
| 2026-07-16 | Spatial tide single-station advisory                           | 1.0  | `8fc0fad1` | 90.65             |
| 2026-07-16 | TSS lane directionality (ORIENT arrows + popup)                | 0.75 | `8fc0fad1` | 91.4              |
| 2026-07-16 | INT1 hazard glyphs (CATWRK/WATLEV differentiated)              | 0.75 | `938f52c1` | 92.15             |
| 2026-07-16 | Merge-fold e2e tests (task #27 closed)                         | 1.2  | `eab82ed0` | 93.35             |
| 2026-07-16 | Partition seam tests + candidate-resolution dedupe             | 1.2  | `eab82ed0` | 94.55             |
| 2026-07-16 | Batch-2 area classes live (Pi #2 → v7) + FAIRWY rendered       | 0.5  | `0e6f9870` | 95.05             |
| 2026-07-16 | Night dim v1 (red-tinted, persisted toggle)                    | 0.5  | `f39bfb33` | 95.55             |
| 2026-07-17 | EncVectorLayer logic tests (pickAreaTap / needsTideWindow)     | 0.4  | `b8d4e1b8` | 95.95             |

**95.95 vs the 2026-07-16 bar. Every non-device item is burned.** What
remains to cross 96: the device-gated martinez glaze session (1.75, needs
Shane's iPhone) or curated VTS geometry (0.4, deferred with reason). Then
the protocol's final open adversarial audit.
