# Bounded planned-course traffic-lane guidance

The planner now accepts original `InshoreLayers.TSSLPT` / `ExclusionSources.TSSLPT` polygons and MultiPolygons, retaining only their complete geometry and original `ORIENT` direction. No lane polygon writes navigable water, positive depth, preferred flags, chart permission or right of way. Hard `TSEZNE` separation-zone avoidance remains closed.

The [IHO S-57 object catalogue](https://docs.iho.int/iho_pubs/standard/S-57Ed3.1/31ApAch1.pdf) defines lane parts as uniform-flow areas. The [IHO UOC, clause 10.2.1.1](https://legacy.iho.int/iho_pubs/standard/S-57Ed3.1/S-57%20Appendix%20B.1%20Annex%20A%20UOC%20Edition%204.1.0_Jan18_EN.pdf) identifies `ORIENT` as traffic-flow direction; it can intentionally be absent at junctions to avoid implying lane priority. The [IMO COLREG overview](https://www.imo.org/en/about/conventions/pages/colreg.aspx) describes following traffic flow and crossing as nearly perpendicular as practicable. This implementation guides planned route courses. Wind/current can make the vessel's actual heading different; it does not assess or certify COLREG compliance.

## Private fields and source rules

`buildTrafficLaneField` validates and copies bounded original area geometry. Missing, invalid or conflicting orientation stays unknown; neither polygon shape/order nor its reciprocal supplies a direction. Complete source geometry is limited to 2,000 features / 50,000 vertices through the existing topology validator. Malformed geometry and unsupported dateline spans refuse rather than silently dropping lane coverage. Private names and chart attributes are not copied.

`ExclusionField.trafficLanes` is compiled again from original layers at engine entry, so a request's forged compiled field cannot bypass the source. `applyExclusionField` adds fresh route-private `tssLane` and `tssDirection` arrays after the cached chart grid is read. States are 0 absent, 1 known and 2 unknown/conflicting. The arrays consume five bytes per grid cell and never enter the cached chart grid; existing generic grid byte accounting covers them. Source, raster and final geometry operations have explicit ceilings. Cancellation/budget refusal cannot partly adopt fields on a cached grid.

## One directional price and final guard

Known lane steps favor charted flow or a crossing near perpendicular to it. Coarse search has eight courses; its internal flow/crossing windows are 30°/25°. These are planner discretization choices, not legal or vessel-heading tolerances. Opposing and other oblique known-lane courses are unavailable. An unknown/conflicting cell adds only a caution factor and an explicit unknown disclosure.

All directional factors are at least one, preserving the existing 0.9 own-track lower-bound heuristic. A\*, chain pricing, the actual course of a smoothing chord and grid-based de-stagger/fair/marina simplification use the same rule. A raster staircase cannot disguise an oblique final chord.

The shared final `auditFinishedRouteExclusions` now also checks the exact finished line against original lane areas after cloud, shadow, lead/tail and other postprocessing. It partitions segments at polygon edges; a narrow lane between coarse cell centers cannot disappear. Each occupied interval applies the original orientation, with overlapping contradictions explicitly unknown. Holes remain outside a lane; ambiguous boundary-only contact is unknown. Known opposing/oblique final geometry refuses with the existing `route-exclusion` code. Missing/unbounded geometry proof refuses with `exclusion-unavailable`. A sub-cell lane may therefore require route review rather than produce an automatically repaired path.

## Main-service contract

- Original source layer: `TSSLPT?: FeatureCollection` alongside `RESARE`/`TSEZNE`. No precompiled or reinterpreted lane geometry is authoritative.
- Final shared disclosure helper: `finishedTrafficLaneGuidance(layers, polyline, check?)` returns `charted-flow`, `orientation-unknown`, or `undefined` when no lane is touched. It throws if a positive disclosure cannot be checked.
- Engine and job success field: `trafficLaneGuidance?: 'charted-flow' | 'orientation-unknown'`. Final job audit attaches it only from current original source geometry and retires an inherited stale field. UI wording must remain number-free, explain unknown orientation, and distinguish planned course from actual heading under wind/current.
- `InshoreRouteResult.routeAreaCaveats?: string[]` is a type seam only. The main service supplies those words from the actual current manual/MPA lease after its fences. This packet creates no RouteJob caveat input.

Root owns original cohort collection and planner/tracer/Auto/saved-route warning propagation. No licensed source is persisted; this packet changes no boat/watch state or deployment. Whole-app TypeScript, production budget, full composed worker/browser and native/physical acceptance remain root release gates. Pi source is regenerated from the committed engine, with no installation.

## Focused freeze evidence

At source `2e9d125d0`, the final focused run passes 86 cases in 10 suites: traffic lanes, shared exclusions, track priors, worker purity/clone and existing fairing, subgrid, simplification and centring regressions. Earlier broader coverage passes 103 cases plus two existing expected failures; the refined lane/exclusion/purity group passes 64 cases. Scoped ESLint reports no findings; all nine source/test/document files pass Prettier; `git diff --check` is clean. The generated Pi router mirror passes `--check` for all 42 modules, copied from committed source `2e9d125d0`.

Six existing `routeJob.parity` goldens fail both on this packet and on the clean pre-TSS merge `6f66144929fd520e6812d2293da34ae9ae6982e6`, with identical received hashes below. None of these fixtures supplies TSSLPT. Their assertions and goldens are unchanged; the two provider warning counts are respectively 10 instead of 9 and 8 instead of 7 on both revisions. Two NOAA cases remain skipped because the licensed sample cell is absent. This packet does not claim that broader suite passes.

| Existing golden               | Identical received SHA256 on parent and TSS packet                 |
| ----------------------------- | ------------------------------------------------------------------ |
| archipelago 5 NM              | `e3feb987ebf0d8077ca1f1df695f4eaf2a1d2dc8c8c65d5b2824e906eeb871d6` |
| archipelago 12 NM             | `0ea82130b74807843db86434340d51ebf33f8f54537245922fb75cee4a22ebae` |
| archipelago 20 NM             | `0e7aa2dafa68a7e4e745a05f67d99f53ea86312a9e8c63149752307101dbc2df` |
| Atlantic promoted             | `bddd3912282b220ec5bff84590902796e431384cf7d76150ddfdcfd6d3345f03` |
| provider archipelago verified | `13b73702ebc7c2f0bbbb97ed0b200a095e04e1f510eb17ad17ce9d2569747eed` |
| provider Atlantic unavailable | `017d5c4a2c5d11b4f1d4fb6579103eac86bb3be85877bba06a1f01741ecc61c3` |

Local receipts are `work/validation139-tss-freeze.log`, `work/validation139-tss-final.log`, `work/validation139-tss-refined.log` and `work/validation139-tss-parent-parity-baseline.log`. No whole-app compiler, production build, provider request, deployment, boat/watch action or Pi installation was performed for this packet.
