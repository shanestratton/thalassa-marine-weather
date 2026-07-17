# ENC open adversarial audit #4 — 2026-07-19 (wf_a1b5b444-4b5, 11 agents)

Open adversarial score: **91.20/100** (arc: 79.6 → 83.75 → 84.25 → 86.15 →
**91.20** — the biggest single-cycle jump). 11 agents, 0 errors, ~1.06M tokens,
~13 min. Fresh run (no resume). Audits the burn-down-#4 committed tree.

Raw per-agent transcript:
`.../subagents/workflows/wf_a1b5b444-4b5/journal.jsonl`

## Dimension scores (vs cycle-3)

| Dimension    | Max     | Score     | Δ vs cycle-3                                          |
| ------------ | ------- | --------- | ----------------------------------------------------- |
| Safety       | 30      | **27.90** | −0.35 (new #1 outweighs the 4 safety findings closed) |
| Rendering    | 20      | **18.15** | +0.90                                                 |
| Performance  | 15      | **13.40** | +0.90                                                 |
| Code Quality | 20      | **17.75** | +2.00                                                 |
| UX           | 15      | **14.00** | +1.60                                                 |
| **TOTAL**    | **100** | **91.20** | **+5.05**                                             |

## How burn-down #4's fixes held up

Every cycle-4 fix that was re-verified was **CONFIRMED sound** — no refutations,
and the chief's verdict is explicit: _"every confirmed safety divergence is
fail-safe… Nothing found makes the layer over-confident against a correct
baseline for Shane's boat."_ One critique landed on cycle-4 work:

- **Safety #8 (0.25, CONFIRMED)** — the new `segmentAreaGraze` lateral-graze
  advisory classifies via `classifyHazard`'s static 15 m `ENC_HAZARD_DEPTH_M`
  cutoff, not the vessel draft, so it over-warns a 2.4 m keel (the exact
  static-threshold tradeoff flagged in the design). Fail-safe (over-warns), but
  dilutes signal. Fix: re-eval graze DEPARE candidates against true draft via
  `encToHazardResult`, as the CROSSING path already does.

## Top 8 surviving findings (seed for burn-down #5)

| #   | Dim    | Finding                                                                                                                                                                   | Ded. | Fix direction                                                                                                                                                      |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | SAFETY | **Failed detailed-cell load raises NO advisory** when overlapping coarse ENC backstops it — clean ENC face over silently-degraded data (PRE-EXISTING; not in the #4 seed) | 1.5  | Consume `failedCellIds()` outside the `gebcoHits>0` gate; emit the failed-cell caution whenever a fine cell dropped, even if a coarse cell answers `covered:true`. |
| 2   | CODE   | Residual god-modules (EncHazardService 1725, EncVectorLayer 2186) + ~520-line `buildMergedVectorData` (the #4 deferral)                                                   | 1.0  | Carve ring-assembly / sounding-LOD / layer-accumulation out of the merge core into named units; review-surface only, no behaviour change.                          |
| 3   | PERF   | Glaze feature-budget can self-evict the in-progress merge's own cells, abandoning the hole-free upgrade                                                                   | 0.75 | Pin active-fold keys (or size the 120k eviction to `ensureGlazeCapacity`) so `putGlazeCell` can't drop the window it is still building.                            |
| 4   | RENDER | S-52 safety contour is a near-invisible slate hairline on the primary white display                                                                                       | 0.5  | Give the safety contour bold/amber prominence on chart mode too (Shane's mute → explicit opt-in).                                                                  |
| 5   | PERF   | Worker-upgrade re-push not gesture-deferred — re-serializes DEPARE_GLAZE mid-pan/zoom                                                                                     | 0.5  | Add the `map.isMoving()` guard to `refreshEncAsyncLayers`, matching the staggered path.                                                                            |
| 6   | UX     | Tap-the-water on uncharted GEBCO-fallback water is silent                                                                                                                 | 0.5  | On `!pick`, fall through to `GebcoDepthService` and surface the coarse depth, gesture-tied.                                                                        |
| 7   | CODE   | Clone HARD/SOFT-cap glaze-drop degradation has no test                                                                                                                    | 0.5  | FakeWorker test driving `payloadWeight` over `GLAZE_CLONE_HARD_CAP`; lock the weight math + caps.                                                                  |
| 8   | SAFETY | Lateral-graze advisory over-warns (15 m, ignores draft) — cycle-4's own graze fix                                                                                         | 0.25 | Re-eval graze DEPARE candidates against true draft via `encToHazardResult`.                                                                                        |

Next band (all 0.25): sounding-ink 5 m threshold not keyed to safety depth; TSS
single-arrow / no-ORIENT; beacon glyphs reuse buoy shapes; light-flare colour
gaps (blue/yellow/amber/orange → generic amber); worker-header protocol drift;
hazardIconSize cast laundering; dead kill-switch branches; aria-live re-announce
on expand; CATWRK 4/5 wreck glyphs registered-but-unrendered (0.15); night-dim
overlay no unmount cleanup (0.1).

## Chief's verdict

Trustworthy for the 2.4 m Tayana today — **91.2/100, 27.9/30 safety floor**,
every confirmed safety divergence fail-safe (router 4.1 m vs glaze 2.9 m
keel-safe; graze over-warns; the 2.5 m isochrone penalty within 0.1 m of the
real draft with true-draft re-validation downstream). The one trust-eroding
finding is **#1** — a failed detailed cell masked by coarse coverage presenting
a clean ENC-validated face while the fine grounding features were never
consulted. That is silent degradation, the one failure mode a certification
audit exists to catch. **Fix #1 first.** Everything else is prominence, jank,
jargon, or maintainability.
