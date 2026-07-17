# ENC Layer Burn-down #5 — frozen scope, from the 2026-07-19 closing audit

**Baseline: 91.20/100** (closing open adversarial audit `wf_a1b5b444-4b5`,
11 agents, 0 refutations; transcript in ENC_AUDIT_2026-07-19_closing.md).
Arc: 79.6 → 83.75 → 84.25 → 86.15 → **91.20**. Same protocol: burn the frozen
top-8 to zero, score = 91.20 + banked ("vs the closing bar"), tsc + targeted
tests + explicit-path commits + build/sync, ONE open adversarial audit at the
end. Priced scope of the top-8: **4.5 pts** (91.20 + 4.5 = 95.7 ceiling).

Chief's fix-first (finding #1, the failed-cell always-emit advisory) shipped
first — first ledger row.

## Frozen top-8 (from the cycle-4 closing-audit seed)

### Safety (1.75)

- [x] **1.5 — Failed detailed-cell load raises NO advisory when coarse coverage
      backstops it** — DONE (`979d717c`): a dedicated `cell-load-failed`
      caution now fires whenever `failedCellIds` is non-empty, independent of
      the GEBCO share — the old failed-cell note lived only inside the
      `gebcoHits>0` block and was suppressed when an overlapping coarse cell
      answered `covered:true`, presenting a clean ENC face while the failed
      cell's fine grounding features were never consulted. FLIPPED the two tests
      that had locked the buggy "stay silent" spec (verify-semantics-not-wiring).
- [ ] **0.25 — Lateral-graze advisory over-warns (static 15 m, ignores draft)**
      — OPEN (cycle-4's own graze fix): re-eval graze DEPARE candidates against
      true draft via `encToHazardResult`, as the CROSSING path already does.

### Rendering (0.5)

- [ ] **0.5 — S-52 safety contour a near-invisible slate hairline on white** —
      OPEN: give it bold/amber prominence in chart mode too (Shane's mute → an
      explicit opt-in, not the default).

### Performance (1.0)

- [ ] **0.75 — Glaze feature-budget can self-evict the in-progress merge's own
      cells** — OPEN: pin active-fold keys (or size the 120k eviction to
      `ensureGlazeCapacity`) so `putGlazeCell` can't drop the window it's building.
- [ ] **0.5 — Worker-upgrade re-push not gesture-deferred** — OPEN: add the
      `map.isMoving()` guard to `refreshEncAsyncLayers`, matching the staggered
      path. (Overlaps a red-team missed finding: also skip setData when the
      collection reference is unchanged — contours-only upgrade re-pushes glaze.)

### Code quality (1.0)

- [ ] **1.0 — Residual god-modules** — carve ring-assembly / sounding-LOD /
      layer-accumulation out of the ~520-line `buildMergedVectorData` core into
      named units; review-surface only. (Deferred in #4 for shared-tree risk.)
- [ ] **0.5 — Clone HARD/SOFT-cap glaze-drop degradation untested** — FakeWorker
      test driving `payloadWeight` over `GLAZE_CLONE_HARD_CAP`; lock the caps.

### UX (0.5)

- [ ] **0.5 — Tap-the-water on uncharted GEBCO-fallback water is silent** — on
      `!pick`, fall through to `GebcoDepthService` and surface the coarse depth,
      gesture-tied.

## Ledger

| Date       | Item                                                 | Pts | Commit     | Running (vs 91.20) |
| ---------- | ---------------------------------------------------- | --- | ---------- | ------------------ |
| 2026-07-20 | Failed-cell always-emit advisory (chief's fix-first) | 1.5 | `979d717c` | 92.70              |
