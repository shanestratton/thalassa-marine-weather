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
- [x] **0.25 — Chart-edition staleness never reaches route advisories** — DONE
      (`83258181`): the validator computes the oldest covering edition age
      (cellsForBBox + chartAgeYears) and surfaces a new `chart-currency` note
      via pure `describeChartCurrency()` on both the clean and exhaustion exits.
      2 tests. **Safety dimension now fully burned.**

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

- [x] **0.5 — Cloud hydration multi-MB main-thread JSON.parse, 3-wide** — DONE
      (`d024fd40`): new `parseJsonOffThread` reuses the cell parse worker (raw
      value, no shape gate, so it handles the Pi `{cells:[…]}` wrapper);
      downloadCloudCell parses through it, shape gate / unwrap / patch run on the
      off-thread result. 3 tests.

### Code quality (1.5 of the seed)

- [ ] **0.75 — Residual god-modules** — DEFERRED (shared-tree risk): moving the
      five `mount*` families + `tagAndPush` is a large file-move on a tree other
      Claude sessions commit into live (MapHub changed under me repeatedly this
      cycle) — high conflict / sweep risk. Held for a quiet window or Shane's go.
- [x] **0.75 → 0.5 banked — glazeBuild branches untested (PARTIAL)** — DONE
      (`3c54d0ce`): 5 tests over `buildCellGlaze` cached / uncached / needQueue /
      upgraded-promotion paths (the frozen-queue-adjacent seam) via the real
      cache. REMAINING 0.25: the refreshEncVectorData/beforeIdFor scheduler
      ordering (map-coupled) — tracked as a residual.

### UX (0.5 of the seed)

- [x] **0.5 — "Depths verified on ocean bathymetry" headline on a
      caution-grade advisory** — DONE (`1516fea7`): the `gebco-share` collapsed
      headline reads "Depths not chart-verified". It is ONLY ever shown
      caution-grade (cells failed / ≥30% GEBCO), where "verified" was factually
      wrong; note-grade gebco-share never reaches the headline.

## Beyond the frozen seed — audit next-in-queue + missed findings (banked to reach ~92)

The frozen top-8 tops out at 90.90 (86.15 + the priced seed). Shane's call this
round: reach ~92, so these already-identified findings from the SAME cycle-3
audit (its per-dimension "missed findings" + the "next in queue" list) were
banked on top. All real, all cited distinct code paths.

- [x] **0.25 — glaze-cell worker reply not job-guarded** (`1516fea7`): requires
      a live job like its contours/done siblings — a post-death straggler cached
      a touched-only incomplete glaze as upgraded. + regression test.
- [x] **0.25 — tagAndPush 64-stride vs per-feature line clip** (`1516fea7`):
      yields every clipped DEPCNT/COALNE feature, matching the glazeBuild fold.
- [x] **0.25 — ENC_HAZARD_MAGENTA symbol/popup mismatch** (`1516fea7`):
      COLOURS.magenta now references the single-source #d837a9 (was #D53F8C).
- [x] **0.25 — attribution chip asserts provenance when ENC off** (`1516fea7`):
      gated like every other ENC chip.
- [x] **0.25 — visibility-writer docstrings describe retired model** (`1516fea7`):
      setEncRouteFocusMode / setEncChartDetail rewritten to the composer model.
- [x] **0.25 — coastline scan re-allocated turfLineString per point** (`83258181`):
      each line's turf feature built ONCE before the point loop.

## Ledger

| Date       | Item                                                                                        | Pts  | Commit     | Running (vs 86.15) |
| ---------- | ------------------------------------------------------------------------------------------- | ---- | ---------- | ------------------ |
| 2026-07-19 | ZOC-aware lateral clearance margin + free silent-catch advisory                             | 1.0  | `4645e4e2` | 87.15              |
| 2026-07-19 | White lights → yellow-white flare (+ flare-shape / z-filter drift)                          | 0.75 | `62b707e3` | 87.90              |
| 2026-07-19 | GEBCO positional-trust guard (reject reordered/mismatched depths)                           | 0.5  | `888f295a` | 88.40              |
| 2026-07-19 | Detail scrubber: isolated-danger marks join the safety floor                                | 0.5  | `781aa431` | 88.90              |
| 2026-07-19 | Backlog batch: glaze-guard + tagAndPush + magenta + gebco-headline + attrib-chip + vis-docs | 1.75 | `1516fea7` | 90.65              |
| 2026-07-19 | buildCellGlaze branch coverage (scheduler residual)                                         | 0.5  | `3c54d0ce` | 91.15              |
| 2026-07-19 | Cloud-cell download parses off-thread (parseJsonOffThread)                                  | 0.5  | `d024fd40` | 91.65              |
| 2026-07-19 | Chart-edition currency advisory + coastline-scan hoist                                      | 0.5  | `83258181` | 92.15              |

## Cycle-4 closing audit (protocol step 2): **91.20/100**

`wf_a1b5b444-4b5`, 11 agents, 0 errors, ~1.06M tokens. Arc: 79.6 → 83.75 →
84.25 → 86.15 → **91.20** — the biggest single-cycle open-score jump. Full
transcript + top-8: ENC_AUDIT_2026-07-19_closing.md.

The two numbers, kept honest: the vs-bar tally reached **92.15**, the fresh
open re-audit lands at **91.20**. Every cycle-4 fix that was re-verified held
(no refutations; chief: "every confirmed safety divergence is fail-safe…
nothing makes the layer over-confident for Shane's boat"). The ~0.95 gap is the
fresh audit surfacing NEW findings the frozen seed didn't cover — chiefly a
**pre-existing** safety #1 (1.5): a failed detailed-cell load can be masked by
overlapping coarse ENC coverage and present a clean validated face while the
fine grounding features were never consulted (chief's "fix first"). One
critique landed on cycle-4's own work: the lateral-graze advisory over-warns
(static 15 m, not draft-aware) — fail-safe, 0.25, top-8 #8. The new top-8 seeds
burn-down #5.
