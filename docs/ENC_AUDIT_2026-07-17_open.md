# ENC open adversarial audit — 2026-07-17 (wf_d5a64621-927, 11 agents)

Raw workflow result (chief synthesis + all red-teamed dimension verdicts):

```json
{
    "summary": "Certification honesty check: open adversarial audit of the ENC vector-chart layer",
    "agentCount": 11,
    "logs": [],
    "result": {
        "chief": "# FINAL OPEN ADVERSARIAL SCORE — ENC Vector Chart Layer\n\n## Dimension scores\n\n| Dimension | Max | Deductions (verdicts + red-team adds) | Score |\n|---|---|---|---|\n| Safety | 30 | 3.5 confirmed + 0.5 missed (degenerate short-route ETAs) = **4.0** | **26.00** |\n| Rendering | 20 | 2.75 confirmed (incl. one 0.5→0.25 adjustment) + 0.5 missed (CATLAM popup inversion, ≥10 m sounding rounding) = **3.25** | **16.75** |\n| Performance | 15 | 2.25 confirmed, no missed findings = **2.25** | **12.75** |\n| Code quality | 20 | 4.0 confirmed, no missed findings = **4.00** | **16.00** |\n| UX | 15 | 2.5 confirmed + 0.25 missed (no-coverage affordance) = **2.75** | **12.25** |\n\n## **TOTAL: 83.75 / 100**\n\nNo REFUTED verdicts to drop. All red-team missed findings were folded in at stated value — none duplicate an existing deduction (the perf 0.5 duplicate-job race and code-quality 1.0 glazeKey finding describe the same defect through two legitimate rubric lenses — perf cost vs. design defect — and both dimension teams priced them independently; both stand, but the burn-down below treats them as **one** fix).\n\n## Top 8 surviving findings (severity-ranked burn-down seed)\n\n| # | Finding | Deduction | Fix direction |\n|---|---|---|---|\n| 1 | **Corrupt/unbuildable ENC cell silently degrades to GEBCO** — session-pinned failure, `log.warn` only, route validates \"clean\" over charted UWTROC; twinned with the UX finding that GEBCO-tier verification is invisible in HazardReportPanel | 1.0 safety + 0.5 UX | One fix retires both: propagate cell-failure and `source:'gebco'` counts into `buildRouteAdvisories` as a loud caution (\"N% of route verified on 460 m ocean bathymetry only\"); retry failed blobs instead of session-pinning |\n| 2 | **Validation timeout race ships unvalidated route + stale hazard report** — 4 race sites; un-cancelled validator later overwrites the live report with one computed for a discarded polyline | 1.0 safety | Add a cancellation token/genRef guard to `setLastReport` (mirror the existing `computeGenRef` route-swap guard) and emit a \"route NOT validated\" advisory whenever the timeout wins |\n| 3 | **Short-route (<100 NM) ETAs all pinned to departure time** — every Moreton Bay passage credits departure-tide height to crossings reached hours later; a bank that dries near LW validates clean | 0.5 safety | One line: seed the arrival node `timeHours = distanceNM / cruisingKt` in `usePassagePlanner.ts:1314-1324` (or suppress positive tide credit when ETAs are degenerate) |\n| 4 | **Tide-gated legs validate silently clean** — a leg passable only at predicted HW is indistinguishable from an unconditionally clear leg | 0.75 safety | In `HazardQueryService.encToHazardResult`, flag any hazard cleared *only* by positive tide credit and surface a \"tide-constrained leg\" advisory with the window |\n| 5 | **`glazeAssemblyBase` keyed by glazeKey, not job** — overlapping jobs truncate the parked feature majority and cache the incomplete glaze as `upgraded:true` (persistent wrong keel-safety wash), plus the error handler deletes other jobs' keys | 1.0 CQ + 0.5 perf | Key the parking map by jobId (or jobId+glazeKey); each handler deletes only its own entries; add a worker-protocol test locking round-trip reassembly |\n| 6 | **Post-worker-death glaze machinery fails open** — gate is a compile const, not liveness; parked clones accumulate unboundedly in exactly the memory-stressed mode the worker exists to survive | 0.75 perf | Gate queueing on worker liveness (`geoWorkerBroken`); clear/skip prefilter+parking when dead; symmetric cleanup in the `postMessage` catch (also retires the 0.25 CQ leak) |\n| 7 | **GEBCO MSL-vs-LAT datum offset uncompensated** — anti-conservative ~1.0–1.3 m in Moreton Bay on exactly the uncharted fallback points | 0.5 safety | Subtract a conservative regional MSL→LAT delta (or a fixed 1.3 m pessimistic offset) from GEBCO depths before threshold comparison |\n| 8 | **Unknown-attribute marks default to specific assertions** — lost CATCAM paints a NORTH cardinal (\"pass north\" the data never said; a south cardinal inverts the safe side); unknown CATLAM buoy gets the port-hand glyph; and the popup's CATLAM 3/4 wording is inverted vs. S-57 | 0.5 + 0.25 rendering | Neutral \"unknown mark\" glyph for null CATCAM/CATLAM; swap the two `CATLAM_LABELS` strings in `encPopup.ts:487-488` and reword to \"preferred channel to starboard/port\"; delete dead codes 5-8 |\n\n## Chief auditor's honest paragraph\n\n**Is this layer trustworthy for a 2.4 m-draft vessel today? Conditionally — and the conditions are exactly the ones a skipper can't see.** The rendering, performance and code-quality findings are real but honest: they degrade fidelity or efficiency in mostly conservative directions and the skipper can compensate. The safety cluster is different in kind: findings 1, 2, 3 and 7 are all *silent* — a route can be drawn over a charted rock (corrupt cell → GEBCO), shipped unvalidated (timeout race), tide-credited with the wrong hour's water (degenerate ETAs), and depth-checked against the wrong datum (MSL vs LAT), and in every case the HazardReportPanel presents the identical clean green face it shows for a fully ENC-validated route. The system's failure mode is confident silence, which is the one failure mode a navigation aid must not have. **Fix #3 first**: it is a one-line change, it is wrong even when everything else works perfectly and the skipper departs exactly on time, and it fires on essentially every passage Shane actually sails (<100 NM, Moreton Bay, tide-critical banks) — then spend the burn-down on #1/#2, which convert the remaining silent degrades into loud, honest advisories.",
        "dimensions": [
            {
                "dimension": "SAFETY — grounding-hazard correctness end-to-end (ENC parse → spatial query → severity → GEBCO fallback → tide → route advisories)",
                "verdicts": [
                    {
                        "title": "Corrupt/unbuildable ENC cell silently degrades routing to GEBCO with no skipper-visible warning",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 1,
                        "reason": "Verified end-to-end: EncHazardService.ts:153-157 marks a missing/corrupt blob failed for the whole session with log.warn only (doc at :487 confirms session-long); utils/concurrency.ts:27-31 swallows index-build throws to undefined (geometryBBox at EncSpatialIndex.ts:221-228 throws on empty/GeometryCollection geometry and propagates uncaught through the constructor at :315); the uncovered points fall to GEBCO as source:'gebco' (HazardQueryService.ts:348-354), and buildRouteAdvisories (landAvoidance.ts:515-550) only warns on source:'none', CATZOC>=4, and draft>5 — a route over a charted UWTROC validates clean against the ~460 m raster with zero warning. Deduction proportionate for a silent safety-of-life degrade."
                    },
                    {
                        "title": "Validation timeout race silently ships an unvalidated route and can leave a mismatched hazard report",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 1,
                        "reason": "All race sites verified: isochroneEnhancer.ts:419-427 (15 s), usePassagePlanner.ts:1329-1337 (30 s short-route), :1767-1770 (15 s deferred), :2082-2086 (ECMWF braid). Timeout resolves null, the drawn line ships with only a prod-silenced log.info, and no 'route not validated' advisory fires. The un-cancelled validator always reaches phase 5 and calls setLastReport (landAvoidance.ts:972-1001) with a report computed for the DETOURED polyline that was discarded, landing in the singleton (EncHazardReportService.ts:466-482) HazardReportPanel renders. computeGenRef (usePassagePlanner.ts:1771) guards the route swap but not the report write, and no caller outside landAvoidance ever calls setLastReport(null) — a superseded plan's validator can also overwrite the new plan's report."
                    },
                    {
                        "title": "Tide-gated clearances validate silently clean — no 'tide-constrained leg' advisory",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.75,
                        "reason": "encToHazardResult clears 'shallow' hazards using the per-ETA tide credit (HazardQueryService.ts:172-174); buildRouteAdvisories (landAvoidance.ts:515-550) has no tide-dependency advisory of any kind — the only tide note is the spatial single-station one for routes >40 NM (landAvoidance.ts:686-695). A leg that only clears at predicted high water is presented identically to an unconditionally clear leg."
                    },
                    {
                        "title": "GEBCO MSL-vs-LAT baseline offset uncompensated on fallback points",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "The datum guard only suppresses positive tide credit (Math.min(0, ...) at HazardQueryService.ts:346, comment :336-345 acknowledges the mismatch); the raw MSL-referenced GEBCO depth (GebcoDepthService.ts:13-16) is compared unadjusted against the chart-datum-semantics draft threshold (HazardQueryService.ts:111-132). In Moreton Bay (LAT ≈ MSL − ~1.0-1.3 m) this is anti-conservative on exactly the uncharted points, consuming most of the 1.75 m built-in margin; 0.5 is proportionate given the bounded magnitude."
                    },
                    {
                        "title": "No advisory for quality-unknown (M_QUAL-absent) ENC coverage or GEBCO-verified inshore gaps",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "buildRouteAdvisories skips non-numeric catzoc (landAvoidance.ts:540: `if (typeof r.catzoc !== 'number') continue;`), so a cell with no M_QUAL reads better than a charted CATZOC C/D zone; a coverage-gap point inside a charted cell's bbox returns covered:false (EncSpatialIndex.ts:596-598, 668-670) and becomes source:'gebco' (HazardQueryService.ts:323-354) with no provenance note distinguishing 460 m-raster verification from ENC validation."
                    }
                ],
                "missedFindings": [
                    {
                        "title": "Short-route (<100 NM) validation pins every sample ETA to departure time — departure-tide credit applied to crossings reached hours later",
                        "detail": "The short-route bypass (straightLineNM < 100, usePassagePlanner.ts:779 — essentially every Moreton Bay passage) feeds validateRouteSegments seedNodes with timeHours: 0 on BOTH endpoints (usePassagePlanner.ts:1314-1324). landAvoidance interpolates sample ETAs between the endpoints' timeHours (landAvoidance.ts:765-778), so every sample on the entire route gets timeMs = departureTimeMs, and the live tide curve (wired whenever the user sets a departure time, landAvoidance.ts:661-702) credits the DEPARTURE-time tide height to every shallow re-evaluation along the route (HazardQueryService.ts:172-174, 421-424). Departing Newport at HW +2.0 m, a 2.5 m bank crossed 6 h later near LW evaluates at effectiveDepth −4.5 m vs the 2.4 m keel's −4.1 m threshold and validates clean, when the true arrival-time depth is a hard hazard. Unlike finding 3 (departure slip), this is wrong even when the skipper departs exactly on time. The long-route isochrone paths pass real per-node timeHours and are unaffected. Fix is one line of honest ETA seeding (distance/cruisingKt for the arrival node) or suppressing positive tide credit when all ETAs are degenerate.",
                        "evidence": "components/map/usePassagePlanner.ts:1314-1324 (both seedNodes timeHours: 0), :779 (isShortRoute = <100 NM); services/isochrone/landAvoidance.ts:765-778 (aTimeMs = bTimeMs = departureTimeMs → every sample timeMs = departure), :661-672 (tide curve + tideAt wired from departureTimeMs); services/HazardQueryService.ts:172-174 (positive tide credit clears shallow hazards)",
                        "deduction": 0.5
                    }
                ],
                "adjustedScore": 26
            },
            {
                "dimension": "RENDERING (S-52/INT1 chart-rendering fidelity, max 20)",
                "verdicts": [
                    {
                        "title": "TSS separation zone (TSEZNE) visually identical to the traffic lane (TSSLPT)",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Verified: EncVectorLayer.ts:440-443 assigns the identical '#d97706' to both TSSLPT and TSEZNE in the shared colourExpr; both share the same 0.1 fill wash (:463-466) and the same [3,2]-dash outline (:502-506). The only differentiator is the ORIENT arrow layer, filtered to _caution=='TSSLPT' only (:547-551). The in-code comment ':443 // TSS separation zone — amber family (keep OUT)' shows the keep-out semantics were known yet given zero visual distinction from the keep-in lane. S-52 tints the separation zone distinctly precisely so it reads opposite to the lanes. Deduction proportionate."
                    },
                    {
                        "title": "Unknown-attribute marks default to a SPECIFIC hand/quadrant glyph instead of a neutral one",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Verified: services/enc/types.ts:240 returns 'sm-buoy-lateral' for an unknown-CATLAM lateral BUOY, and seamarkIcons.ts:260 registers that id as lateralBuoySvg(COLOURS.red,'can') — the region-A port-hand glyph — while lateralMarkColour (types.ts:192) answers neutral YELLOW for the same null, an internal contradiction. Note the beacon arm is actually neutral (types.ts:240 'sm-beacon-yellow' for beacons), so the defect is buoy-only, but the cardinal fallback is fully confirmed and worse: types.ts:249 returns 'sm-cardinal-north' for unknown CATCAM, painting BY bands + double-up-cones (seamarkIcons.ts:61,68) — an explicit 'pass north' the data never asserted; a south cardinal with lost CATCAM inverts the safe side. 0.5 is proportionate for a potential safety inversion."
                    },
                    {
                        "title": "Preferred-channel laterals (CATLAM 3/4) render as plain port/starboard marks — banding lost",
                        "verdict": "ADJUSTED",
                        "adjustedDeduction": 0.25,
                        "reason": "The code facts are confirmed: types.ts:224-226 folds 3 into isPortHand and 4 into isStbdHand, and no red-green-red/green-red-green banded glyph exists anywhere in getSeamarkIconDefs (seamarkIcons.ts:255-317). But the deduction is disproportionate at 0.5: per S-57, CATLAM 3 (preferred channel to starboard) IS rendered region-A red-can-family and CATLAM 4 green-cone-family — the app draws the CORRECT hand, so the direction of error is safe (the skipper following the plain lateral stays in the main channel). What is lost is the bifurcation banding — an information/fidelity loss in the same class as the 0.25 topmark and glyph-conflation findings, not the wrong-assertion class of the 0.5 cardinal fallback. Adjusted to 0.25. (The auditor's mitigating claim that 'the popup decodes CATLAM correctly' is itself wrong — see missed finding below.)"
                    },
                    {
                        "title": "Isolated-danger topmark drawn as two side-by-side spheres instead of two vertical spheres",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: seamarkIcons.ts:108-109 place both spheres at cy=6 with cx=21 and cx=27 — horizontally adjacent. IALA/INT1 Q130.4 stacks the two black spheres vertically; the vertical pair is the distinguishing redundancy channel. BRB band order below (black:110/red:111/black:112) is correct, so the mark stays identifiable by colour. 0.25 proportionate for a topmark-channel-only fidelity loss."
                    },
                    {
                        "title": "Rock WATLEV / obstruction CATOBS glyph conflations vs INT1 K-section",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: EncVectorLayer.ts:649-657 maps WATLEV '4' and '5' both to 'sm-hazard-rock-awash' (the asterisk, seamarkIcons.ts:234-238) — INT1 K11 (covers/uncovers) and K12 (awash at datum) are distinct symbols and the code comment at :647-648 even names both cases before conflating them. All OBSTRN take one 'sm-hazard-obstruction' dashed circle (EncVectorLayer.ts:600-609, seamarkIcons.ts:250-253) with no CATOBS/VALSOU differentiation. Direction of error conservative; 0.25 proportionate."
                    },
                    {
                        "title": "Night mode is a uniform scrim, not an S-52 night palette",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: setEncNightDim (EncVectorLayer.ts:1566-1603) adds one world polygon with fill-color '#1a0505' at 0.45 opacity, no beforeId, and no per-layer re-palette anywhere. S-52 DUSK/NIGHT tables preserve danger-symbology contrast while dropping luminance; a uniform scrim dims the safety contour, magenta hazards and 9-12 px sounding digits by the same factor as the paper. Acknowledged in-code as v1 (:1554-1560); 0.25 for the semantic gap is fair."
                    },
                    {
                        "title": "Drying soundings drop the INT1 underline — khaki ink is the only 'dries' channel",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: buildSoundingTextField (encDepthStyle.ts:261-272) emits abs-magnitude digits — a drying 0.2 m renders identically in glyph terms to a 0.2 m sounding — and the sole differentiator is the '#6b5e23' khaki at encDepthStyle.ts:286-287, with the decision documented at EncVectorLayer.ts:738-744 and :758-766. INT1 underlines drying figures; colour-alone is the channel that fails in glare and for colour-deficient eyes on keel-critical numbers. The khaki drying BAND fill (DEPARE_BAND_COLORS.drying) gives area-level context, which softens but does not remove the gap. 0.25 fair."
                    },
                    {
                        "title": "Contour labels round non-integer VALDCO at chart datum — a wrong depth number",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: buildDepcntLabelField (encDepthStyle.ts:301-304) applies ['to-string', ['round', v]] unconditionally — including the tideOffset=0 datum path used at mount (EncVectorLayer.ts:1395) and whenever applyTideOffsetPaint runs with a null offset (EncVectorLayer.ts:230, h=0). A charted 2.5 m contour labels '3' (Mapbox 'round' is round-half-away, so 0.5→1, 2.5→3) adjacent to soundings that keep tenths. Exposure low on integer-VALDCO AU cells but the number printed is one the hydrographer never charted, in the deeper direction. 0.25 proportionate."
                    },
                    {
                        "title": "TSS family incomplete at the extractor registry: TSELNE/TSSBND/PRCARE/DWRTPT never reach the renderer",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: ROUTING_CLASSES (tools/senc-extractor/src/s57Classes.ts:71-147) contains TSSLPT (:134) and TSEZNE (:137) but no TSELNE, TSSBND, PRCARE, DWRTPT or DWRTCL; the documented deferred list (:140-146) names topmarks/harbour structures/named areas/cable-pipeline lines and omits the TSS line/precautionary classes entirely, so this is an unbudgeted gap, not a tracked deferral. CAUTION_AREA_CLASSES (services/enc/types.ts:652-662) mirrors the same subset. A scheme charted with TSELNE separator lines renders as bare amber lanes; PRCARE (INT1 magenta '!' mandated) renders as nothing. 0.25 fair for a completeness gap."
                    }
                ],
                "missedFindings": [
                    {
                        "title": "Popup CATLAM 3/4 decode reads INVERTED against S-57 — the auditor's cited mitigation is itself wrong",
                        "detail": "The auditor credited the tap popup with correctly decoding preferred-channel marks ('the information survives behind a tap'). It does not: S-57 attribute CATLAM defines 3 = 'preferred channel to STARBOARD lateral mark' and 4 = 'preferred channel to PORT lateral mark', but encPopup.ts labels 3 as 'Preferred channel — port' and 4 as 'Preferred channel — starboard'. A skipper at a bifurcation who taps the mark and reads 'Preferred channel — port' on a CATLAM-3 buoy naturally reads 'the preferred channel lies to port' — the opposite of the charted meaning (the wording matches the mark's HAND, not the channel direction, with nothing to disambiguate). The render mapping in types.ts:222-238 (3→port glyph, 4→starboard glyph) is correct under the standard, which confirms the popup wording is backwards, not the renderer. The LEAVE_SIDE passing rule (encPopup.ts:502-505) also covers only codes 1/2, so no passing guidance exists for exactly the marks where the channel divides; and CATLAM_LABELS carries dead entries for codes 5-8 that do not exist in the S-57 CATLAM enumeration.",
                        "evidence": "components/map/encPopup.ts:487-488 ('3': 'Preferred channel — port', '4': 'Preferred channel — starboard') vs S-57 CATLAM (3 = preferred channel to starboard, 4 = preferred channel to port); corroborated by the render mapping services/enc/types.ts:224-226 and the mirrored comment types.ts:183-184; encPopup.ts:489-492 (nonexistent codes 5-8), :502-505 (LEAVE_SIDE covers 1/2 only)",
                        "deduction": 0.25
                    },
                    {
                        "title": "Soundings ≥10 m round to NEAREST whole metre and drop decimetres — depth numbers print deeper than charted",
                        "detail": "buildSoundingTextField's deep branch renders ['to-string', ['round', v]] for |v| ≥ 10: a charted 12.6 m sounding displays '13' — 0.4 m deeper than surveyed. Chart/ECDIS sounding presentation (S-52 presentation library, INT1 metric convention) carries decimetre subscripts up to ~31 m and truncates (shoal-bias, never rounding a sounding deeper); the app's own sub-10 m branch honours the subscript convention, so the 10 m cutoff plus nearest-rounding is a divergence, not a system-wide simplification. The merge additionally pre-rounds _d to the nearest decimetre (Math.round(d*10)/10, encHazardParse.ts:242) — nearest-biased again, though only ±5 cm. Materiality is low for a 2.4 m draft in ≥10 m water, but it is the same 'printed a depth number the hydrographer never charted, in the deep direction' class the auditor deducted 0.25 for on contour labels (finding 8), applied to a far more numerous feature (every 10-31 m sounding on the chart), so it deducts consistently.",
                        "evidence": "components/map/encDepthStyle.ts:266-271 (['<', ['abs', v], 10] branch keeps subscript tenths; else ['to-string', ['round', v]]); services/enc/encHazardParse.ts:242 (_d: Math.round(d * 10) / 10); comment at EncVectorLayer.ts:717-718 ('deeper rounds whole') documents the choice without the shoal-bias",
                        "deduction": 0.25
                    }
                ],
                "adjustedScore": 16.75
            },
            {
                "dimension": "PERFORMANCE (mobile WebGL / iOS WKWebView + Mapbox GL) — ENC vector-chart stack",
                "verdicts": [
                    {
                        "title": "Post-worker-death glaze queue keeps growing: glazeAssemblyBase parks feature arrays that are never cleared once the worker is gone",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.75,
                        "reason": "Verified line-by-line: gate is the compile const GLAZE_WORKER_ENABLED=true (EncHazardService.ts:1028, used :1683), never worker liveness; after onerror (:693-701) sets geoWorkerBroken and clears ONCE, every later merge with an un-upgraded cached glaze re-runs the full prefilter (:1719-1733, {...feat} clones of every DEPARE/DRGARE feature) and parks the untouched majority at :1736; dispatchGeometryWork returns at :1245-1246 on null worker without cleanup, and the postMessage catch (:1268-1271) deletes only pendingGeometryJobs. The only glazeAssemblyBase deletes (:699/:719/:751) are unreachable post-death. Parked clones pin blob geometry past the 48 MB blob budget (EncCellStore.ts:92-94). One entry per distinct glazeKey (cell x shadow-set) accumulates over a coastal pan, plus wasted per-merge prefilter CPU — fail-open in the exact memory-stressed mode the worker machinery exists to survive. Deduction proportionate as the top finding."
                    },
                    {
                        "title": "Duplicate-job race on the same glazeKey drops the parked untouched majority and caches an incomplete glaze as upgraded",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Mechanically verified: needQueue=!cached.upgraded (:1649) re-queues an in-flight key on any re-merge (250 ms debounced window escape vs multi-second worker jobs under the 500k budget, encGeometryWorker.ts:48 — realistic overlap); :1736 overwrites the parked base; the first 'glaze-cell' answer consumes+deletes it (:718-719); the second reassembles with `?? []` and putGlazeCell stores the touched-only subset with upgraded:true (:720), reused until the 32-entry LRU evicts (glazeCellCache.ts:24). Perf cost (duplicate multi-second martinez job + payload clone) is real; the vanishing keel-safety white wash is the correctness face of the same defect. Adjacent unflagged variant folded in at no extra charge: the job-error handler (:751) deletes ALL job.glazeKeys — mergeGlazeKeys spans every glaze cell of the merge (:1250, :1755), including keys parked by a DIFFERENT pending job — truncating via the same `?? []` path."
                    },
                    {
                        "title": "Spatial-index LRU cap (24) is below the acknowledged ~30-cell route candidate set — sequential-scan thrash rebuilds every index on every query batch",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "encIndexCache.ts:17-22 sets INDEX_CACHE_MAX=24 while its own comment sizes Brisbane→Cairns at ≈30; strict LRU (:36-44) under fixed-order cyclic access (resolveCandidateIndexes, EncHazardService.ts:239-249) gives 0% hit rate once N>cap, and rebuilds (buildHazardsForCell + 4 RBush trees, :141-172) run un-sliced on the main thread. One overstatement corrected but not deduction-changing: point-query batches chunk at GEBCO_BATCH_SIZE=400 (landAvoidance.ts:386,796-798) so their bboxes are route SECTIONS, not the full route — but querySegmentHazards (landAvoidance.ts:878 → EncHazardService.ts:336) and querySegmentCautions (:733 → :376) pass the whole route in one call each, and MAX_VALIDATION_PASSES repeats the cycle, so the full-set thrash fires multiple times per validation regardless."
                    },
                    {
                        "title": "Superseded merges are never aborted — fast panning stacks concurrent full merges whose outputs are evicted almost immediately",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "buildMergedVectorData has no cancellation token; single-flight is per-cacheKey only (EncHazardService.ts:885-895); the hook's cancelled flag gates only the apply, not the compute (useEncVectorLayer.ts:283, :322); mergedDataCache.ts:21 holds 2 slots so a stacked older merge's output is evicted within 1-2 further merges. Mitigations the auditor already priced in are real (250 ms debounce useEncVectorLayer.ts:266-269, gesture-parked slices EncHazardService.ts:1317-1319, zoom-bucket paramsFresh check :253-255). 0.25 proportionate."
                    },
                    {
                        "title": "First mount uploads all 14 GeoJSON sources in one synchronous tick — the stagger only protects the refresh path",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "mountEncVectorLayer's ensureSource loop pushes all 14 collections in one task (EncVectorLayer.ts:1471-1484) followed synchronously by every layer-group mount (:1507-1527, ~30 addLayer), while refreshEncVectorData earned a one-source-per-frame stagger with watchdog for exactly this hitch (:1605-1693). The idle deferral (useEncVectorLayer.ts:367-370, timeout 50 ms) moves the task off first paint but does not slice it. Partially softened at the z7-8 boot case because buildGlaze is false below GLAZE_MIN_ZOOM=9.5 (glaze collection arrives empty), but DEPARE/LNDARE/SOUNDG over the 47-cell window are still the documented heavy uploads. 0.25 fair."
                    }
                ],
                "missedFindings": [],
                "adjustedScore": 12.75
            },
            {
                "dimension": "CODE QUALITY (ENC vector-chart layer)",
                "verdicts": [
                    {
                        "title": "glazeAssemblyBase is keyed by glazeKey, not job — overlapping jobs silently drop the parked feature majority",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 1,
                        "reason": "Every cited line verified: parking map keyed by glazeKey alone (EncHazardService.ts:648, set at :1736), job 1's 'glaze-cell' answer deletes the entry (:719) and job 2's reassembles with `?? []` (:718) then caches the truncated set as upgraded:true (:720) so it is never re-queued; cached-not-upgraded cells re-queue on every merge (:1649). The trigger is concrete: useEncVectorLayer.ts:243-254 re-merges on every Math.round(zoom) bucket crossing, which varies the merge cacheKey (s{bucket}, :881) while glazeKey (:1640) is zoom-free — two in-flight jobs share a glazeKey whenever a bucket crossing (or a pan to a different cell-set window) lands inside the worker's multi-second latency. The error handler deleting ALL job glazeKeys (:751) is a second entry into the same truncation. Persistent wrong cache (LRU of 32) on a navigation display layer; 1 point is proportionate."
                    },
                    {
                        "title": "Worker protocol: zero test coverage and hand-mirrored inline message types",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.75,
                        "reason": "Grep of tests/ for glazeAssemblyBase|encGeometryWorker|postMessage: zero hits; mergeFold.e2e.test.ts:149 states the e2e path runs 'no derived contours, no glaze, no worker'. The out-protocol exists only as a comment (encGeometryWorker.ts:25-31); the service mirrors it as an inline structural cast with stringly `type` (EncHazardService.ts:702-710) and the postMessage payload at :1267 is an untyped object literal. The pure clip layer beneath is genuinely well-locked (clipCoverageBounded/clipDepareCoverage tests), so 0.75 rather than more is right — the untested part is exactly the protocol/lifecycle layer where finding 1 lives."
                    },
                    {
                        "title": "postMessage-failure path leaks glazeAssemblyBase entries — error cleanup is asymmetric",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "The catch at EncHazardService.ts:1268-1271 deletes only the pendingGeometryJobs entry; the glazeAssemblyBase arrays parked at :1736 for that job's keys survive, unlike the onerror path (:698-699 clears the map) and the job-error message (:750-751 deletes the job's keys). The leak is bounded (overwritten on the next successful queue of the same cell, cleared on worker death) so 0.25 is proportionate."
                    },
                    {
                        "title": "Residual god-module: EncHazardService ~2000 lines with a ~575-line merge closure; EncVectorLayer 2307 lines",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.75,
                        "reason": "wc: EncHazardService.ts 1993 lines, EncVectorLayer.ts 2307 (largest component file). buildMergedVectorData spans 1290-1864 with the tagAndPush closure at 1457 capturing shadow/dedup/glaze/coverage/queue/sea-area/cull loop state; the module self-describes as a god-module at :126, :606, and concedes the merge core 'resists isolation' at :1153/:1181. The decomposition campaign is real (glazeCellCache, derivedContourCache, mergedDataCache, encIndexCache, parse/labels/density/lightSectors all extracted + tested), but the residual is exactly where the finding-1 defect bred. 0.75 stands."
                    },
                    {
                        "title": "Duplicated case-defensive S-57 property reads hand-repeated at ~40 display sites",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "readNumber/readString exist precisely for this trap (encHazardParse.ts:43-66) yet encPopup.ts has 34 hand-rolled `?? props.x` dual reads and zero imports of the helpers; types.ts has 8 (encNavaidIconId :223/:243, buildLightCharacterLabel :355-376); the merge decoration hand-rolls it too (EncHazardService.ts:1523 CATLAM, :1568 VALNMR, :1570 COLOUR). Convention-by-discipline where a constructive guarantee exists one import away. 0.5 fair."
                    },
                    {
                        "title": "Stale header comment in glazeCellCache — documents the abandoned key scheme",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "glazeCellCache.ts:2-3 documents keys as `v{ver}:{cellId}:{sortedShadowIds}` and :5-6 claims immutability 'per registry version'; the actual key (EncHazardService.ts:1640-1643) is `{id}@{edition}@{sizeBytes}:{shadowIds}` with the comment at :1633-1639 explaining exactly why v{ver} was dropped. A maintainer reading the cache module's own doc reasons about invalidation backwards. Real, small, 0.25."
                    },
                    {
                        "title": "Dead production export: coverageStripRects superseded by coverageMaskStrips but still shipped",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Exported at clipDepareOverlap.ts:329 with only tests/enc/clipDepareCoverage.test.ts as callers (repo-wide grep). Its empty/over-budget fallback returns [extent] (:339-347, 'Legacy semantics preserved') while the successor coverageMaskStrips deliberately returns [] on empty and degrades grid resolution on over-budget (:429-437) specifically to avoid the whole-rectangle blackout — a contradictory contract one wrong import away. 0.25 fair."
                    },
                    {
                        "title": "~30 `as unknown as` casts on load-bearing Mapbox filters/expressions",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Counted 19 in EncVectorLayer.ts + 8 in encDepthStyle.ts = 27 (auditor's ~30 is accurate enough); e.g. :275/:280 SCAMIN filter pair, :551/:733. Mitigation correctly credited: tests/enc/exprEval.ts + encDepthStyle.test.ts semantically evaluate the style-module expressions, but the mount-site filters sit outside that harness. 0.25 with the mitigation acknowledged is right."
                    }
                ],
                "missedFindings": [],
                "adjustedScore": 16
            },
            {
                "dimension": "UX (ENC vector-chart layer)",
                "verdicts": [
                    {
                        "title": "GEBCO-only route verification is invisible to the skipper",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Verified in code. landAvoidance.ts:890-902 computes encHits/gebcoHits and uses them ONLY in the log string (line 901); buildRouteAdvisories (landAvoidance.ts:515-549) branches on vesselDraftM>5, source==='none', and CATZOC>=4 — never source==='gebco'. HazardQueryService.ts:330-357 confirms GEBCO answers uncovered points (and even soundingOnly-cleared points fall through to GEBCO, widening the silent tier). A route verified wholly on ~450 m ocean bathymetry renders in HazardReportPanel identically to ENC-verified. Given the codebase's own route+warn doctrine (comments at landAvoidance.ts:502-513 call the warn 'only defensible if the warn is LOUD'), this is the one uncommunicated degraded tier. 0.5 proportionate."
                    },
                    {
                        "title": "Night dim covers the map canvas only — DOM UI still glares, and later-added layers escape the dim",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Both halves verified. EncVectorLayer.ts:1555-1561 comment states 'DOM UI is unaffected'; addLayer at 1592-1602 has no beforeId ('topmost by design'). setEncNightDim is invoked from exactly one effect keyed [nightDim, mapReady] (MapHub.tsx:2683-2692) — nothing re-hoists it, so any layer added afterwards (e.g. trace-line-glow/core/arrows added with no beforeId, MapHub.tsx:806-846) draws ABOVE the dim at full day brightness. DOM glare confirmed: teal hydration chip (MapHub.tsx:5885-5889), bg-slate-900/95 chart key (5895), full-brightness popup (encPopup.ts background rgba(15,23,42,0.92)). The feature's own rationale is scotopic preservation; one bright element defeats it. 0.5 proportionate."
                    },
                    {
                        "title": "Chart key legend omits several classes that render: marine farms, special-purpose (yellow) marks, fairway boundaries, recommended tracks",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "Legend gaps fully verified: the swatch list (MapHub.tsx:5961-5985) has 7 mark entries + 5 caution washes; no MARCUL (renders with own accent, encPopup.ts:617, labels at 154/163), no special-purpose yellow (specialMarkSvg seamarkIcons.ts:119-126, mapped at 383, rich popup encPopup.ts:555-597), no FAIRWY_LINE, no RECTRC. RECTRC/RECTRC_LABEL and FAIRWY_LINE excluded from CLICKABLE_LAYER_IDS (encLayerIds.ts:203-204, 225). Two mitigations noted but insufficient to downgrade: the RECTRC exclusion is a documented deliberate tradeoff (encLayerIds.ts:196-198, lead line must not swallow tracer pin drops), and RECTRC_LABEL renders OBJNAM/'LEAD' along the line (EncVectorLayer.ts:952-975) so a named lead may show its bearing — but a legend entry costs nothing and the gap contradicts the key's stated post-audit purpose (buoyage vocabulary, MapHub comment at 5950-5953, and the key's own 'tap any to read' hint at 5959 is false for these classes). 0.5 stands."
                    },
                    {
                        "title": "Sub-legibility typography on safety-critical surfaces",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.5,
                        "reason": "All cited sizes verified: text-[8px] depth-band labels (MapHub.tsx:5922), text-[9px] key-toggle button (5873) and 'tap any to read' (5959), text-[10px]/[11px] hazard rows incl. mono coordinates and CATZOC provenance (HazardReportPanel.tsx:226-246, 151), text-[10px] throughout EncAttributionChip (194, 213-244, several at /50-/60 opacity compounding the contrast problem), 12px popup body (encPopup.ts). No large-text mode or scaling hook exists. The repo's own precedent (32px close-button fix citing the 2026-07-12 fat-finger audit, encPopup.ts:684-686) treats deck ergonomics as in-scope, and reading sizes never got the same pass. 0.5 proportionate for the stated arm's-length-in-chop envelope."
                    },
                    {
                        "title": "Advisory headline derived by substring-matching advisory prose; first-caution-wins hides co-present cautions when collapsed",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: HazardReportPanel.tsx:107-118 classifies via cautionText.includes('NO depth data'/'NOT been validated'/'pass limit'/'draft'/'Route crosses'), and line 104 takes advisories.find(severity==='caution') — first caution only. buildRouteAdvisories pushes the >5m-draft caution (landAvoidance.ts:519-527) BEFORE the no-data caution (529-537), so draft+unverified-water shows only 'Draft exceeds depth model' collapsed. No test file references HazardReportPanel (grep across tests/ returns nothing), so the coupling is unlocked on the consumer side; a producer-side test (tests/isochrone-submodules.test.ts:351) incidentally locks the 'NO depth data' substring but not the others, and changing prose+test together still silently degrades the panel. Minor mitigations (expanded view lists all advisories; the shown headline is still a red caution) match the auditor's modest 0.25."
                    },
                    {
                        "title": "Popup a11y gaps: close target still under the platform floor, async tide-window swap unannounced",
                        "verdict": "CONFIRMED",
                        "adjustedDeduction": 0.25,
                        "reason": "Verified: close button is 32x32 with a comment explicitly acknowledging Apple's 44pt floor while stopping short of it (encPopup.ts:684-696). Popup root is injected HTML with no role='dialog'/aria-modal (encPopup.ts:652-658). fillDepareTideWindow swaps span.textContent ('checking tides…' → window or 'tide data unavailable right now') with no aria-live region (EncVectorLayer.ts:2063-2083), so the keel-window answer is never announced. Correctly weighted low (0.25) since screen-reader use is secondary at the helm, but these are the basics."
                    }
                ],
                "missedFindings": [
                    {
                        "title": "Uncharted water while browsing has no affordance — ENC-coverage absence is indistinguishable from chart-off",
                        "detail": "The attribution chip returns null when zero ENC cells intersect the viewport (EncAttributionChip.tsx:144 'if (cellsInView.length === 0) return null'), so panning from charted into genuinely uncharted water silently removes the trust chip — there is no 'end of chart coverage' signal, the standard chartplotter affordance. The codebase itself recognises the failure mode for the download case: the hydration chip exists precisely because 'dark water that's a DOWNLOAD in flight must never read as no chart here' (MapHub.tsx:5881-5882) — but genuine no-coverage got no counterpart. The chart key's only uncharted mention ('Bare imagery = not enough water, or uncharted', MapHub.tsx:5934-5938) renders only in the satelliteVisible branch; on the default HYBRID base, uncharted water simply looks like base map, ambiguous with ENC toggled off. This is the browsing-side twin of the auditor's confirmed GEBCO route-verification gap: both are 'absence of ENC data reads as normal'.",
                        "evidence": "components/map/EncAttributionChip.tsx:144, components/map/MapHub.tsx:5881-5889 (hydration-chip rationale), components/map/MapHub.tsx:5931-5941 (uncharted note satellite-branch only)",
                        "deduction": 0.25
                    }
                ],
                "adjustedScore": 12.25
            }
        ]
    },
    "workflowProgress": [
        {
            "type": "workflow_phase",
            "index": 1,
            "title": "Audit"
        },
        {
            "type": "workflow_phase",
            "index": 2,
            "title": "RedTeam"
        },
        {
            "type": "workflow_phase",
            "index": 3,
            "title": "Synthesize"
        },
        {
            "type": "workflow_agent",
            "index": 1,
            "label": "audit:safety",
            "phaseIndex": 1,
            "phaseTitle": "Audit",
            "agentId": "a55dc47a3a45aa7a7",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784237909830,
            "queuedAt": 1784237909802,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "SAFETY — grounding-hazard correctness end-to-end (ENC parse…",
            "promptPreview": "You are a marine-navigation-software safety auditor. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/EncV…",
            "lastProgressAt": 1784238472951,
            "tokens": 196614,
            "toolCalls": 32,
            "durationMs": 563120,
            "resultPreview": "{\"dimension\":\"SAFETY — grounding-hazard correctness end-to-end (ENC parse → spatial query → severity → GEBCO fallback → tide → route advisories)\",\"findings\":[{\"title\":\"Corrupt/unbuildable ENC cell silently degrades routing to GEBCO with no skipper-visible warning\",\"detail\":\"getOrBuildIndex marks a cell failed for the whole session on a missing/corrupt blob (log.warn only), and resolveCandidateInde…"
        },
        {
            "type": "workflow_agent",
            "index": 2,
            "label": "audit:rendering",
            "phaseIndex": 1,
            "phaseTitle": "Audit",
            "agentId": "af6c86904d158272f",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784237909833,
            "queuedAt": 1784237909802,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "RENDERING (S-52/INT1 chart-rendering fidelity, max 20)",
            "promptPreview": "You are an S-52/INT1 chart-rendering auditor who knows what real ENCs look like on commercial chartplotters. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaar…",
            "lastProgressAt": 1784238350768,
            "tokens": 166617,
            "toolCalls": 21,
            "durationMs": 440935,
            "resultPreview": "{\"dimension\":\"RENDERING (S-52/INT1 chart-rendering fidelity, max 20)\",\"findings\":[{\"title\":\"TSS separation zone (TSEZNE) visually identical to the traffic lane (TSSLPT)\",\"detail\":\"The per-class caution colour expression assigns the same amber (#d97706), the same 0.1 fill wash and the same dashed outline to both TSSLPT (the lane you should be IN) and TSEZNE (the zone you must keep OUT of). The only…"
        },
        {
            "type": "workflow_agent",
            "index": 3,
            "label": "audit:performance",
            "phaseIndex": 1,
            "phaseTitle": "Audit",
            "agentId": "adc58869a515f85d2",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784237909833,
            "queuedAt": 1784237909802,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "PERFORMANCE (mobile WebGL / iOS WKWebView + Mapbox GL) — EN…",
            "promptPreview": "You are a mobile-WebGL performance auditor (iOS WKWebView + Mapbox GL). \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- …",
            "lastProgressAt": 1784238298106,
            "tokens": 196109,
            "toolCalls": 26,
            "durationMs": 388273,
            "resultPreview": "{\"dimension\":\"PERFORMANCE (mobile WebGL / iOS WKWebView + Mapbox GL) — ENC vector-chart stack\",\"findings\":[{\"title\":\"Post-worker-death glaze queue keeps growing: glazeAssemblyBase parks feature arrays that are never cleared once the worker is gone\",\"detail\":\"The queue-side gate for building the glaze upgrade payload is the compile-time const GLAZE_WORKER_ENABLED, not worker liveness. After the geo…"
        },
        {
            "type": "workflow_agent",
            "index": 4,
            "label": "audit:codequality",
            "phaseIndex": 1,
            "phaseTitle": "Audit",
            "agentId": "aea6ce88338574728",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784237909833,
            "queuedAt": 1784237909802,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "CODE QUALITY (ENC vector-chart layer)",
            "promptPreview": "You are a staff-level TypeScript code-quality auditor. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/En…",
            "lastProgressAt": 1784238255458,
            "tokens": 183208,
            "toolCalls": 29,
            "durationMs": 345625,
            "resultPreview": "{\"dimension\":\"CODE QUALITY (ENC vector-chart layer)\",\"findings\":[{\"title\":\"glazeAssemblyBase is keyed by glazeKey, not job — overlapping jobs silently drop the parked feature majority\",\"detail\":\"The round-2 prefilter parks each glaze cell's untouched features in a module-scope Map keyed by glazeKey alone. A cached-but-not-upgraded glaze cell re-queues on every merge (needQueue = !cached.upgraded),…"
        },
        {
            "type": "workflow_agent",
            "index": 5,
            "label": "audit:ux",
            "phaseIndex": 1,
            "phaseTitle": "Audit",
            "agentId": "ac590616be123083b",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784237909833,
            "queuedAt": 1784237909802,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "UX (ENC vector-chart layer)",
            "promptPreview": "You are a marine-UX auditor who sails and knows what a helmsman needs at arm's length in chop. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the c…",
            "lastProgressAt": 1784238193546,
            "tokens": 114256,
            "toolCalls": 25,
            "durationMs": 283713,
            "resultPreview": "{\"dimension\":\"UX (ENC vector-chart layer)\",\"findings\":[{\"title\":\"GEBCO-only route verification is invisible to the skipper\",\"detail\":\"The advisory system loudly covers 'none' (no data) and low-confidence CATZOC, but a route validated entirely or partly against GEBCO raster bathymetry reads identically to ENC-verified in the HazardReportPanel — the enc=X gebco=Y split goes only to the console log. …"
        },
        {
            "type": "workflow_agent",
            "index": 6,
            "label": "redteam:ux",
            "phaseIndex": 2,
            "phaseTitle": "RedTeam",
            "agentId": "aed2a4ea58074f63c",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238193568,
            "queuedAt": 1784238193550,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "UX (ENC vector-chart layer)",
            "promptPreview": "You are a red-team verifier for a marine-software audit. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/…",
            "lastProgressAt": 1784238526150,
            "tokens": 77758,
            "toolCalls": 35,
            "durationMs": 332581,
            "resultPreview": "{\"dimension\":\"UX (ENC vector-chart layer)\",\"verdicts\":[{\"title\":\"GEBCO-only route verification is invisible to the skipper\",\"verdict\":\"CONFIRMED\",\"adjustedDeduction\":0.5,\"reason\":\"Verified in code. landAvoidance.ts:890-902 computes encHits/gebcoHits and uses them ONLY in the log string (line 901); buildRouteAdvisories (landAvoidance.ts:515-549) branches on vesselDraftM>5, source==='none', and CATZ…"
        },
        {
            "type": "workflow_agent",
            "index": 7,
            "label": "redteam:codequality",
            "phaseIndex": 2,
            "phaseTitle": "RedTeam",
            "agentId": "aa9075bd2d2ff51a6",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238255465,
            "queuedAt": 1784238255464,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "CODE QUALITY (ENC vector-chart layer)",
            "promptPreview": "You are a red-team verifier for a marine-software audit. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/…",
            "lastProgressAt": 1784238635066,
            "tokens": 89452,
            "toolCalls": 31,
            "durationMs": 379600,
            "resultPreview": "{\"dimension\":\"CODE QUALITY (ENC vector-chart layer)\",\"verdicts\":[{\"title\":\"glazeAssemblyBase is keyed by glazeKey, not job — overlapping jobs silently drop the parked feature majority\",\"verdict\":\"CONFIRMED\",\"adjustedDeduction\":1,\"reason\":\"Every cited line verified: parking map keyed by glazeKey alone (EncHazardService.ts:648, set at :1736), job 1's 'glaze-cell' answer deletes the entry (:719) and …"
        },
        {
            "type": "workflow_agent",
            "index": 8,
            "label": "redteam:performance",
            "phaseIndex": 2,
            "phaseTitle": "RedTeam",
            "agentId": "acb8dad4b6154bdd6",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238298108,
            "queuedAt": 1784238298107,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "PERFORMANCE (mobile WebGL / iOS WKWebView + Mapbox GL) — EN…",
            "promptPreview": "You are a red-team verifier for a marine-software audit. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/…",
            "lastProgressAt": 1784238770780,
            "tokens": 116249,
            "toolCalls": 31,
            "durationMs": 472671,
            "resultPreview": "{\"dimension\":\"PERFORMANCE (mobile WebGL / iOS WKWebView + Mapbox GL) — ENC vector-chart stack\",\"verdicts\":[{\"title\":\"Post-worker-death glaze queue keeps growing: glazeAssemblyBase parks feature arrays that are never cleared once the worker is gone\",\"verdict\":\"CONFIRMED\",\"adjustedDeduction\":0.75,\"reason\":\"Verified line-by-line: gate is the compile const GLAZE_WORKER_ENABLED=true (EncHazardService.t…"
        },
        {
            "type": "workflow_agent",
            "index": 9,
            "label": "redteam:rendering",
            "phaseIndex": 2,
            "phaseTitle": "RedTeam",
            "agentId": "a72e3bc70de23e764",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238350772,
            "queuedAt": 1784238350771,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "RENDERING (S-52/INT1 chart-rendering fidelity, max 20)",
            "promptPreview": "You are a red-team verifier for a marine-software audit. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/…",
            "lastProgressAt": 1784238741213,
            "tokens": 137816,
            "toolCalls": 22,
            "durationMs": 390441,
            "resultPreview": "{\"dimension\":\"RENDERING (S-52/INT1 chart-rendering fidelity, max 20)\",\"verdicts\":[{\"title\":\"TSS separation zone (TSEZNE) visually identical to the traffic lane (TSSLPT)\",\"verdict\":\"CONFIRMED\",\"adjustedDeduction\":0.5,\"reason\":\"Verified: EncVectorLayer.ts:440-443 assigns the identical '#d97706' to both TSSLPT and TSEZNE in the shared colourExpr; both share the same 0.1 fill wash (:463-466) and the s…"
        },
        {
            "type": "workflow_agent",
            "index": 10,
            "label": "redteam:safety",
            "phaseIndex": 2,
            "phaseTitle": "RedTeam",
            "agentId": "aa24e6dbd09efcb53",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238472966,
            "queuedAt": 1784238472963,
            "attempt": 1,
            "lastToolName": "StructuredOutput",
            "lastToolSummary": "SAFETY — grounding-hazard correctness end-to-end (ENC parse…",
            "promptPreview": "You are a red-team verifier for a marine-software audit. \nSCOPE — the ENC vector-chart layer of the Thalassa marine-weather app (repo /Users/shanestratton/Projects/thalassa-marine-weather):\n- services/enc/* (EncHazardService, EncSpatialIndex, encHazardParse, hazardSeverity, clipDepareOverlap, encGeometryWorker, scaleShadow, soundingDensity, seaareLabels, the cache modules, types)\n- components/map/…",
            "lastProgressAt": 1784238807278,
            "tokens": 123986,
            "toolCalls": 23,
            "durationMs": 334312,
            "resultPreview": "{\"dimension\":\"SAFETY — grounding-hazard correctness end-to-end (ENC parse → spatial query → severity → GEBCO fallback → tide → route advisories)\",\"verdicts\":[{\"title\":\"Corrupt/unbuildable ENC cell silently degrades routing to GEBCO with no skipper-visible warning\",\"verdict\":\"CONFIRMED\",\"adjustedDeduction\":1,\"reason\":\"Verified end-to-end: EncHazardService.ts:153-157 marks a missing/corrupt blob fai…"
        },
        {
            "type": "workflow_agent",
            "index": 11,
            "label": "chief-synthesis",
            "phaseIndex": 3,
            "phaseTitle": "Synthesize",
            "agentId": "a57e8b250f634d18a",
            "model": "claude-fable-5",
            "state": "done",
            "startedAt": 1784238807286,
            "queuedAt": 1784238807284,
            "attempt": 1,
            "promptPreview": "You are the chief auditor closing a certification audit of a marine ENC chart layer (rubric: safety 30 / rendering 20 / performance 15 / code quality 20 / UX 15 = 100).\nHere are the five red-teamed dimension results (post-verification verdicts + any missed findings the red team added):\n[\n  {\n    \"dimension\": \"SAFETY — grounding-hazard correctness end-to-end (ENC parse → spatial query → severity → …",
            "lastProgressAt": 1784238867742,
            "tokens": 44256,
            "toolCalls": 0,
            "durationMs": 60456,
            "resultPreview": "# FINAL OPEN ADVERSARIAL SCORE — ENC Vector Chart Layer\n\n## Dimension scores\n\n| Dimension | Max | Deductions (verdicts + red-team adds) | Score |\n|---|---|---|---|\n| Safety | 30 | 3.5 confirmed + 0.5 missed (degenerate short-route ETAs) = **4.0** | **26.00** |\n| Rendering | 20 | 2.75 confirmed (incl. one 0.5→0.25 adjustment) + 0.5 missed (CATLAM popup inversion, ≥10 m sounding rounding) = **3.25**…"
        }
    ],
    "totalTokens": 1446321,
    "totalToolCalls": 275
}
```
