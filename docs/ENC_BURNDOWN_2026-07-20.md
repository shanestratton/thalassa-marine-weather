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
- [x] **0.25 — Lateral-graze advisory over-warns (static 15 m, ignores draft)**
      — DONE (`f2a33fda`): segmentAreaGraze takes a positive-metres keel
      threshold; a depth area graze-flags only when minDepthM < that (land /
      OBSTRN unconditional). HazardQueryService supplies -hazardThresholdM
      (≈4.1 m for 2.4 m draft), mirroring the crossing path. Test locks it.

### Rendering (0.5)

- [ ] **0.5 — S-52 safety contour a near-invisible slate hairline on white** —
      HELD FOR SHANE'S CALL: the fix makes the contour bold/amber by DEFAULT on
      the white chart, which reverses Shane's deliberate mute. Needs his word on
      default-bold vs mute-with-opt-in before touching.

### Performance (1.0)

- [x] **0.75 — Glaze feature-budget can self-evict the in-progress merge's own
      cells** — DONE (`7e2949f1`): keys put since ensureGlazeCapacity are PINNED
      and skipped by the feature-budget eviction; the count cap stays
      unconditional; a prior merge unpins when the next starts. 2 tests.
- [x] **0.5 (+0.2 missed) — Worker-upgrade re-push not gesture-deferred** — DONE
      (`7e2949f1`): the upgrade subscription now defers to a single coalesced
      moveend apply while the camera moves; refreshEncAsyncLayers pushes ONLY the
      source whose features array changed (contours-only upgrade no longer
      re-uploads glaze). Stale "cheap no-op" docstring corrected.

### Code quality (1.0)

- [ ] **1.0 — Residual god-modules** — STILL DEFERRED (shared-tree risk): the
      large `buildMergedVectorData` carve on a tree other Claudes commit into
      live. Held for a quiet window or Shane's explicit go.
- [x] **0.5 — Clone HARD/SOFT-cap glaze-drop degradation untested** — DONE
      (`8a334139`): 2 FakeWorker cases — over-cap payload dispatches nothing +
      releases its in-flight claim; just-under ships its one glaze cell.

### UX (0.5)

- [ ] **0.5 — Tap-the-water on uncharted GEBCO-fallback water is silent** — on
      `!pick`, fall through to `GebcoDepthService` and surface the coarse depth,
      gesture-tied.

## Ledger

| Date       | Item                                                          | Pts  | Commit     | Running (vs 91.20) |
| ---------- | ------------------------------------------------------------- | ---- | ---------- | ------------------ |
| 2026-07-20 | Failed-cell always-emit advisory (chief's fix-first)          | 1.5  | `979d717c` | 92.70              |
| 2026-07-20 | Lateral-graze advisory made draft-aware (no over-warn)        | 0.25 | `f2a33fda` | 92.95              |
| 2026-07-20 | Glaze cache pins active merge + gesture-defer upgrade re-push | 1.45 | `7e2949f1` | 94.40              |
| 2026-07-20 | Clone HARD-cap glaze-drop degradation coverage                | 0.5  | `8a334139` | 94.90              |
