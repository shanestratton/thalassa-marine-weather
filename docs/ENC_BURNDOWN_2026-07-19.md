# ENC Layer Burn-down #4 — frozen scope, from the 2026-07-18 closing audit

**Baseline: 86.15/100** (closing open adversarial audit `wf_2d67d3fc-d85`,
11 agents, zero refuted verdicts, one UX verdict adjusted DOWN; transcript
in ENC_AUDIT_2026-07-18_closing.md). Arc so far: 79.6 → 83.75 → 84.25 →
**86.15**, safety **28.25/30**. Same protocol as cycles 1–3: burn the frozen
top-8 to zero, score = 86.15 + banked ("vs the closing bar"), tsc + targeted
tests + explicit-path commits + build/sync per item, ONE open adversarial
audit at the end. Priced scope of the frozen seed: **4.75 pts** (the top-8 +
the free silent-catch missed finding).

Handover Fable 5 → Opus 4.8 mid-cycle (docs/HANDOVER_2026-07-18_fable-to-opus.md).
Chief's fix-first (finding #1, the ZOC-aware lateral clearance margin) + the
free silent-catch advisory shipped in the same commit — first ledger row.

## Frozen top-8 (from the cycle-3 closing-audit seed) + the free missed finding

### Safety (1.5 of the seed)

- [x] **0.75 — Zero lateral clearance around AREA hazards** — DONE
      (`4645e4e2`): `EncSpatialIndex.segmentAreaGraze` finds the closest
      NON-crossing AREA hazard (land / shoal DEPARE-DRGARE / polygon OBSTRN)
      within a ZOC-scaled positional-error margin (IHO CATZOC: A1 ±5, A2 ±20,
      B ±50; C/D/U capped at 100). Folds on its OWN channel (not
      mergeHazardResults) through querySegmentHazards → HazardQueryService →
      `describeAreaGraze` on the clean pass; land grazes are a caution,
      shoal/obstruction a note. PLUS the CATZOC advisory gate lowered ≥4 → ≥3
      so ZOC-B (±50 m) now warrants "verify depths visually". 8 geometry
      regression tests + describeAreaGraze + ZOC-B gate tests.
- [x] **0.25 — Silent segment-vs-polygon catch (the free one-liner, a
      missed finding)** — DONE (`4645e4e2`, same commit): the thin-islet
      crossing check's catch now raises a `segment-check-failed` caution on
      the clean pass instead of a dev-log-only warn — a clean report can no
      longer hide an unrun sub-231 m crossing test.
- [x] **0.5 — GEBCO response trusted positionally** — DONE:
      `alignDepthsToRequest` trusts a depth ONLY where the edge's echoed
      lat/lon still matches the requested point at cache-key precision (the
      edge echoes coords verbatim). Any misalignment — reorder, short/long
      array, corruption — drops THAT point to the loud no-data path; the
      result stays aligned to the request (order, length, coords) so caching
      keys stay consistent. 6 tests incl. the reversed-response shoal-swap
      (a shoal sample can never inherit a neighbour's deep value).
- [ ] **0.25 — Chart-edition staleness never reaches route advisories**
      (from cycle-3 safety verdict #3; not in the top-8 but same seed) —
      OPEN: plumb `EncCell.issued` age into a currency advisory kind.

### Rendering (1.25 of the seed)

- [x] **0.75 — White lights render near-white on the white chart** — DONE:
      `sm-light-white` now builds via `lightSvg(LIGHT_WHITE_FLARE '#f0e030')`
      instead of `lightSvg(COLOURS.white)` — the icon's colour IS the S-52
      warm yellow-white hue LIGHT_COLOUR_HEX['1'] bakes into `_lightColor`
      (the match key), so it holds contrast over the day chart. Secondary
      drift fixed in the same change: the "carry the S-52 flare shape" comment
      corrected to the actual radiant star-burst, and the "render from z11"
      comment aligned to the z10 filter. Locked by tests/seamarkLightIcons.ts.
- [x] **0.5 — Detail scrubber hides isolated-danger marks at d≥3** — DONE
      (`781aa431`): BOYISD/BCNISD removed from the d≥3 cut and added to the
      SAFETY FLOOR (never cut), matching the OBSTRN/WRECKS/UWTROC rule — they
      point AT a charted hazard, so they outrank the laterals (d=6) they used
      to die three notches before. 2 tests (never-hidden at any level; the
      special-purpose minors they were grouped with still cut at d≥3).

### Performance (0.5 of the seed)

- [ ] **0.5 — Cloud hydration multi-MB main-thread JSON.parse, 3-wide** —
      OPEN: route cloudCellSync downloadCloudCell through encParseWorker (or
      gate/patch without a full parse), matching the load path.

### Code quality (1.5 of the seed)

- [ ] **0.75 — Residual god-modules** — OPEN: move the five `mount*`
      families + `tagAndPush` into their own modules; lock with the e2e.
- [ ] **0.75 — glazeBuild branches + staggered-refresh scheduler untested**
      — OPEN: unit-test buildCellGlaze cached/uncached/needQueue paths and
      refreshEncVectorData/beforeIdFor ordering (incl. the frozen-queue bug).

### UX (0.5 of the seed)

- [ ] **0.5 — "Depths verified on ocean bathymetry" headline on a
      caution-grade advisory** — OPEN: severity-conditional headline in
      HazardReportPanel ("Depths from LOW-RES ocean bathymetry — not
      chart-verified") when cells failed.

## Ledger

| Date       | Item                                                               | Pts  | Commit     | Running (vs 86.15) |
| ---------- | ------------------------------------------------------------------ | ---- | ---------- | ------------------ |
| 2026-07-19 | ZOC-aware lateral clearance margin + free silent-catch advisory    | 1.0  | `4645e4e2` | 87.15              |
| 2026-07-19 | White lights → yellow-white flare (+ flare-shape / z-filter drift) | 0.75 | `62b707e3` | 87.90              |
| 2026-07-19 | GEBCO positional-trust guard (reject reordered/mismatched depths)  | 0.5  | `888f295a` | 88.40              |
| 2026-07-19 | Detail scrubber: isolated-danger marks join the safety floor       | 0.5  | `781aa431` | 88.90              |
