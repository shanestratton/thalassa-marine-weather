# EncVectorLayer god-module carve — deferred handoff

`components/map/EncVectorLayer.ts` (~2300 lines) is the last standing ENC god-module
(the earlier `buildMergedVectorData` carve → `mergeFold.ts` retired the other one).
Every cycle-5..7 audit flagged it (2.0 → 0.75 → 1.0, code quality). It is **deferred**
deliberately: unlike the `mergeFold` carve, this is **not a clean byte-identical
statement move** — the target functions are entangled with the depth-style state
layer, so a naive extraction forces a circular import (ironic for a decoupling fix).
Do it in a dedicated isolated worktree with the `mergeFold` playbook (script move +
normalized-code diff + tsc + tests), NOT rushed onto other work.

## The target (from the audit)

Carve the 6 `mount*` builders (~980 lines, `353–1331`) into a per-layer module
(`encLayerMounts.ts`), keeping the orchestrator (`mountEncVectorLayer`) thin, and add
direct coverage for the imperative Mapbox glue:

- `mountLandCoastLayers` (353), `mountPointMarkLayers` (441), `mountSoundingLabelLayers`
  (592), `mountTrackAidLayers` (740, ~330 lines — the biggest), `mountDepthAreaLayers`
  (1073), `mountContourLayers` (1176).

## Dependency map (why it's not a clean move)

The mount region references these LOCAL EncVectorLayer symbols:

- **Mount-only → MOVE with the builders:** `scaminAware` (290), `scaminAwareMark` (295),
  `BRISBANE_VTS_AREA` (111).
- **Shared with `syncDepareBaseTreatment` → must be shared, not moved:**
  `DEPARE_FINE_RANK_FILTER` (1744; also used at 1770). Its siblings `DEPARE_RANK` (1727)
  and `DEPARE_COMPETENCE_FILTER` (1728) are used ONLY by sync, not the mounts.
- **The entanglement → the depth-style state layer:** the mounts call `applyTideOffsetPaint`
  (221) and `updateEncDepthStyle` (309), which both close over the module-scope
  `depthStyleState` WeakMap. Those helpers are used by ~10 other EncVectorLayer functions.

So `encLayerMounts` would need `applyTideOffsetPaint` + `updateEncDepthStyle` +
`DEPARE_FINE_RANK_FILTER` from EncVectorLayer, while EncVectorLayer needs the `mount*`
back → circular. Both cycles are call-time-only (safe in ES modules), but it's a smell.

## The clean sequence (recommended)

1. ✅ **DONE** — depth-style STATE layer extracted into `components/map/encDepthStyleState.ts`
   (332 lines out of EncVectorLayer; 2369 → 2105).
2. **Then** extract `encLayerMounts.ts` (the 6 builders + `scaminAware`/`scaminAwareMark`/
   `BRISBANE_VTS_AREA`), importing the state layer from step 1 — no cycle.
3. Add tests for the pure glue: `buildMergedPoints`, `buildMergedNavaids`, and an
   `ENC_SOURCE_TABLE`-covers-every-`ENC_VEC_SRC` completeness assertion.

Locked by: `tests/enc/*` (encDepthStyle, encVisibility, seamarkResolve, navaidIconId) +
`tests/seamarkLightIcons` + a build/`cap copy ios` sanity (mount path isn't unit-tested,
so the byte-identical diff IS the verification — same rigor as the mergeFold carve).

Prefix all tsc/build/commit with `NODE_OPTIONS="--max-old-space-size=8192"`.
