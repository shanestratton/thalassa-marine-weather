/**
 * Inshore Router Engine — public type contracts.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import type { FeatureCollection } from 'geojson';

/**
 * The subset of layers we actually consume. Other ENC layers in the
 * cell blob (COALNE, LIGHTS, BOYLAT, etc.) are ignored — they're
 * either redundant with LNDARE (COALNE) or display-only.
 */
export interface InshoreLayers {
    LNDARE?: FeatureCollection;
    DEPARE?: FeatureCollection;
    OBSTRN?: FeatureCollection;
    WRECKS?: FeatureCollection;
    UWTROC?: FeatureCollection;
    /**
     * Marked fairway polygons (S-57 FAIRWY) — the channel area itself.
     * Cells inside FAIRWY get the baseline routing cost (1.0×) so A*
     * stays inside the marked channel where one exists.
     */
    FAIRWY?: FeatureCollection;
    /**
     * Engineered deep water (S-57 DRGARE — dredged area). Treated the
     * same as FAIRWY for routing purposes: stay inside it when one
     * exists, even if a geometrically shorter path through generic
     * deep water exists outside it.
     */
    DRGARE?: FeatureCollection;
    /**
     * Lateral buoys (S-57 BOYLAT) — port + starboard channel markers.
     * Used by Pass 5 of buildNavGrid to mark cells within
     * MARKER_CHANNEL_RADIUS_M as preferred, so chains of paired
     * markers form an implicit channel corridor for A* to follow.
     * Useful when the chart has no FAIRWY/DRGARE polygons but does
     * have marker points (e.g. the SE QLD regional nav-markers file).
     */
    BOYLAT?: FeatureCollection;
    /**
     * Lateral beacons (S-57 BCNLAT) — fixed-marker analogue of BOYLAT.
     * Same channel-inference treatment.
     */
    BCNLAT?: FeatureCollection;
    /**
     * OSM coastline LineStrings (natural=coastline). Used to plug
     * LNDARE gaps where the chart's LNDARE tessellation misses the
     * actual land boundary (Newport peninsula 2026-05-19: chart
     * LNDARE was missing the canal-estate islands, so A* threaded
     * a straight diagonal across them from the canal exit to the
     * bay). Each LineString segment is Bresenham-rasterized as a
     * thin hardBlocked strip — enough to stop A* from crossing the
     * boundary even when the polygon LNDARE has the hole.
     */
    COASTLINE?: FeatureCollection;
    /**
     * OSM waterway=canal/fairway/dock LineStrings — the navigable
     * centreline of dredged channels (marina exit channels, port
     * approach cuts). The inverse of COASTLINE: each segment is
     * Bresenham-rasterized as a 1-cell NAVIGABLE corridor (protected
     * water) so canal estates connect to open water across chart
     * LNDARE that tessellates the channel banks as land at 50 m
     * resolution. Newport Marina 2026-05-20: the canal interior was
     * a 349-cell isolated component because the exit channel (a
     * waterway=canal LineString, not a closed polygon) was being
     * dropped — origin tap snapped 2 km out into Bramble Bay.
     */
    CANAL?: FeatureCollection;
    /**
     * OSM navigation-line LineStrings (seamark leading/transit lines) —
     * the charted dredged-channel centreline ships steer along. Unlike
     * CANAL (which just carves navigable water to connect islanded
     * pockets), NAVLINE is rasterised into a PREFERRED corridor (a few
     * cells wide) AND rescues shallow/blocked cells to navigable, so A*
     * is actively ATTRACTED onto the marked channel and rides it through
     * bars/approaches the coarse bathymetry reads as too shallow. Added
     * 2026-05-20 for the Brisbane River mouth bar (the dredged cut isn't
     * in chart FAIRWY and the lateral markers are too sparse to stitch,
     * but OSM has it as navigation_line).
     */
    NAVLINE?: FeatureCollection;
    /**
     * S-57 RECTRC (Recommended Track) LineStrings — the hydrographer's OFFICIAL
     * recommended route through a channel/approach, drawn on the chart (with
     * CATTRK + ORIENT bearing). Where present this is the AUTHORITATIVE channel
     * line: the channel router snaps the route onto it FIRST, ahead of the
     * derived buoy/leading-line follow. The "definitive set of routes out of
     * the marina" — it ships inside the ENC, we just plumb it through. Added
     * 2026-06-18 (Newport carries 43 RECTRC segments we were ignoring).
     */
    RECTRC?: FeatureCollection;
    /**
     * Notice-to-Mariners surveyed-depth override zones (services/ntmRouting.ts
     * — curated from a specific MSQ notice, injected ONLY when that notice is
     * current on the CKAN feed AND the skipper acknowledged it). Polygons with
     * `_class:'ntm-survey'` + `depthM` (surveyed least depth at LAT, > 0).
     * The NTM pass in buildNavGrid stamps them over chart DEPARE — a fresh
     * hydrographic survey outranks the ENC edition — recording the surveyed
     * depth in shallowDepthM and the requiredRise in ntmRiseM so caution
     * pricing grades by how much tide the crossing actually needs. Never
     * preferred, never a depth rescue above the survey.
     */
    NTMZONE?: FeatureCollection;
    /**
     * Notice-to-Mariners PROMULGATED BAR TRANSIT — the ordered REF-mark
     * alternative track from an acked, still-current bar-survey notice
     * (services/ntmRouting.ts pack.trackline). A single LineString the route
     * must RIDE across the bar when its origin (or destination) sits at that
     * bar. Deliberately its OWN layer, never NAVLINE: as a global leading
     * line it perturbed tier ordering 40 NM away (removed 2026-07-03). The
     * tier pipeline splices it as a FINAL, origin-scoped post-pass so it can
     * only ever reshape the bar-crossing leg. Geometry only — surveyed depth
     * stays NTMZONE's job, so a sub-floor cell on the transit still renders
     * CAUTION with tide-window chips.
     */
    NTMBAR?: FeatureCollection;
    /**
     * Marina finger pontoons / berth rows (OSM man_made=pier/pontoon,
     * floating=yes — LineStrings mostly, some closed polygons). Hard-blocked
     * by buildNavGrid's berth pass ONLY at fine resolution (cell < ~20 m),
     * overriding the marina-authoritative DEPARE, so the marina leg follows
     * the fairway lanes between berth rows instead of the geometric centre of
     * the basin (which drove over the pens). The coarse grid ignores them, so
     * a marina still reads as one navigable blob for the approach — no
     * disconnection. Added 2026-07-05 (Mooloolaba drove over the marina).
     */
    BERTH?: FeatureCollection;
}

export interface RouteRequest {
    fromLat: number;
    fromLon: number;
    toLat: number;
    toLon: number;
    /** Vessel draft in meters. Required — drives DEPARE filtering. */
    draftM: number;
    /** Additional clearance above draft in meters. Default 1.0 m. */
    safetyM?: number;
    /** Grid cell size in meters. Default 50 m. */
    resolutionM?: number;
    /** Buffer around point obstructions in meters. Default 30 m. */
    obstructionBufferM?: number;
    /**
     * Minimum cells in the origin's connected component before the
     * snap accepts it. Default 25 (≈62,500 m² at 50 m resolution).
     * Lower for tight harbour entrances, raise to demand bigger water.
     */
    minComponentCells?: number;
    /**
     * Uncharted-space policy (field bug 2026-06-12, Newport→Mooloolaba:
     * with the corridor's layers empty the engine returned a dead-
     * straight 32.7 NM line over Bribie Island with ZERO caution flags —
     * UNKNOWN_OPEN's permissive default means uncharted islands don't
     * exist; see ROUTING_COLLAB reply 16).
     *
     *   'permissive' (default) — legacy behaviour: no-evidence space is
     *     freely navigable at 500× cost and the output mask stays clean.
     *     Correct for unit fixtures that lay only the features under
     *     test, and for fully-charted harbour corridors.
     *   'strict' — the LIVE orchestrator setting. Cells with NO water
     *     evidence (no DEPARE verdict, not FAIRWY/DRGARE-preferred, no
     *     OSM water) are flagged in `cautionMask` when crossed, and a
     *     route whose longest contiguous no-evidence run exceeds
     *     UNCHARTED_MAX_RUN_M is refused with code 'uncharted-corridor'
     *     — uncharted ≠ open, structurally, not as a cost knob.
     */
    unchartedPolicy?: 'permissive' | 'strict';
    /**
     * Route profile. 'safest' (default) treats all sub-margin water at the
     * full 40×/120× caution costs — tide never silently changes preference.
     * 'tideAssist' is the EXPLICIT "shortest" option: caution cells whose real
     * charted depth is wet at LAT and recoverable on a normal tide
     * (requiredRise ≤ 1.8 m) cost 10×, so a bank crossing like the southern
     * Bribie 2.0 m patch becomes routable — and ships with its tide window
     * (shallowRuns → "cross only with ≥ +0.9 m above LAT, clears HH:MM–HH:MM").
     * 'tideDirect' is the AUTO-ROUTE profile: the SAME recoverable mask as
     * tideAssist but the recoverable banks price at only 1.5× (vs 10×), so A*
     * commits to the near-direct crossing rather than a modest deep detour to a
     * marina channel — "follow the deepest water it can WITHIN the corridor;
     * where it can't, cross on the tide" (drying + land still hard-blocked, so
     * it never crosses those). Part of the grid cache key.
     */
    routeProfile?: 'safest' | 'tideAssist' | 'tideDirect';
}

/**
 * Diagnostics emitted alongside both success and failure responses.
 * Lets a caller see grid health (how navigable the route bbox is)
 * without parsing the full polyline. Specifically useful when a
 * route fails: tells the user "we built a 30k-cell grid, only 1200
 * were navigable, your origin snapped to (x,y) but couldn't reach
 * destination's component" — much better than a bare 'no-path'.
 */
export interface RouteDebug {
    gridSize: { width: number; height: number };
    cellsTotal: number;
    cellsNavigable: number;
    cellsBlocked: number;
    /** Cells reachable via 8-neighbor flood-fill from the origin's snapped cell. */
    cellsReachableFromOrigin?: number;
    /** Origin snap result in cell coordinates + surrounding lat/lon. */
    originSnap?: { x: number; y: number; snappedLat: number; snappedLon: number; snapDistanceM: number };
    /** Destination snap result. */
    destinationSnap?: { x: number; y: number; snappedLat: number; snappedLon: number; snapDistanceM: number };
    /** True when a shore destination is rendered at the nearest suitable water cell, not the land tap. */
    destinationWaterSnap?: boolean;
    /** True when the final snapped-water arrival leg was re-routed to avoid a hard-land chord. */
    destinationLandBridgeRepaired?: boolean;
    /** Metres of overland tail trimmed because the destination pin sits on
     *  charted dry land (suburb-centroid class) — the route ends at the
     *  water's edge instead of crawling up the bank. */
    destinationInlandTrimM?: number;
    /** True when the marina-centerline pipeline refined a clean-water route
     *  (mid-channel keel-safe straight legs) instead of plain A*+smoothPath. */
    marinaCenterline?: boolean;
    /** True when the two-tier fine marina pass was accepted over the 50 m
     *  main route (short routes that validated cleaner on a ~10 m grid). */
    twoTierFine?: boolean;
    /** Channel key when Fairlead spliced a buoyed-channel segment (the route
     *  follows the lateral marks there), else absent. */
    fairlead?: string;
    /** Present when the tier contract path (segmentRoute → per-span tier
     *  routers → glue) produced the final route instead of the monolith
     *  fairlead/leading splice. Value = the joined leg provenance (e.g.
     *  'tier2:fairlead(BC)+lead | tier3:passthrough'). Absent ⇒ the path
     *  refused and the route fell back to the proven splice chain. */
    threeTier?: string;
    /** Count of charted leading lines (navigation_line transits) the route was
     *  snapped onto — "line up the marks" vessel procedure. Absent if none. */
    leadingLine?: number;
    /** Count of charted leading lines the route APPROACHED via (route-via-
     *  transit: make the seaward mark, run the leads into the destination).
     *  Absent if the destination isn't served by leading lines. */
    leadingApproach?: number;
    /** Longest contiguous no-water-evidence run along the final polyline in
     *  metres (strict unchartedPolicy only). The refusal threshold is
     *  UNCHARTED_MAX_RUN_M — present on success AND on 'uncharted-corridor'
     *  failures so the caller can see how close/far the route was. */
    unchartedMaxRunM?: number;
    /** True when an 'uncharted-corridor' refusal came from the sub-second
     *  400 m coarse pre-check instead of the full fine-grid pass (reply 19
     *  fix 3 — strict refusals used to pay the whole 20-47 s build first). */
    coarsePrecheck?: boolean;
    /** Grid-relaxation params the ACCEPTED pass was built with (absent =
     *  strict, no zones). The Phase 12 shadow router must look up the
     *  SAME grid — the cache key includes both — or relax-zone routes
     *  (canal-estate berth starts) read as phantom 'no-entry' connector
     *  failures on the strict grid and poison the promotion dataset. */
    relaxedLndare?: boolean;
    relaxZones?: RelaxZone[];
    /** Phase 13: present ONLY on a PROMOTED Seaway Graph route. The engine
     *  never sets this — InshoreRouter attaches it when the graph route wins. */
    seaway?: { edgesUsed: string[]; gateCount: number; gateCompliance: number | null; detourRatio: number };
}

/**
 * One contiguous charted-shallow (caution) run on the final polyline — the
 * substrate for the Phase 7 tide-window annotation ("clears 09:40–15:10").
 * Display/annotation only: tide changes feasibility AND timing, never geometry.
 */
export interface ShallowRunInfo {
    /** First segment index of the run (segment i = polyline[i] → polyline[i+1]). */
    startSeg: number;
    /** Last segment index of the run (inclusive). */
    endSeg: number;
    lengthM: number;
    /**
     * Shallowest REAL charted DRVAL1 (m below LAT) sampled along the run — the
     * depth the CAUTION sentinel in grid.cells erases. NULL when nothing charted
     * vouches a depth there (uncharted / conflict caution): callers must NOT
     * fabricate a tide window from a null.
     */
    minDepthM: number | null;
    /** Run midpoint (by along-track length) — where the window chip anchors. */
    midLat: number;
    midLon: number;
    /** Where the minimum depth was sampled — the exact spot to check on the chart. */
    minAtLat?: number;
    minAtLon?: number;
    /**
     * True when the run's minimum depth came from an NtM surveyed-override
     * zone (grid ntmRiseM stamped) rather than the chart DEPARE — the chip
     * can then say "surveyed" instead of "charted".
     */
    ntmSurveyed?: boolean;
}

export interface RouteResult {
    polyline: [number, number][]; // [lon, lat], lon-first per GeoJSON convention
    /**
     * Per-segment caution flag, length `polyline.length - 1`.
     * `cautionMask[i] === true` means the segment polyline[i]→polyline[i+1]
     * crosses one or more CAUTION cells — water that reads too shallow
     * for this vessel in our coarse bathymetry but is not land/hazard.
     * The renderer draws these segments red so the skipper verifies
     * depth locally. Absent on cloud results that predate this field.
     */
    cautionMask?: boolean[];
    /**
     * Per-segment canal flag, length `polyline.length - 1`. `canalMask[i] === true`
     * means the segment rides a charted OSM canal centre-line (the dead-centre canal
     * route from snapRouteToCanalLines). The renderer draws these the SAME red as
     * caution — a canal is careful, slow, narrow water — but it is kept SEPARATE
     * from cautionMask because the canal is KNOWN charted water, not water-to-verify,
     * so it must not inflate the safety/scorecard caution metric. Empty/absent when
     * the route touches no canal.
     */
    canalMask?: boolean[];
    /**
     * Per-segment tier-2 flag, length `polyline.length - 1`. `channelMask[i] === true`
     * means the segment rides the MARKED-CHANNEL / lead-out leg (lateral marks /
     * recommended track from a canal-mouth out to bay water). The renderer draws
     * these YELLOW — pilotage water — distinct from RED canal/caution, GREEN
     * inshore bay, and DARK BLUE offshore. Empty/absent when the route touches no
     * marked channel.
     */
    channelMask?: boolean[];
    /**
     * Deprecated compatibility alias for channelMask. It used to mean "marked
     * channel" before the four-tier contract assigned tier 4 to offshore.
     */
    tier4Mask?: boolean[];
    /**
     * Per-segment offshore flag, length `polyline.length - 1`. true = the segment is
     * the OFFSHORE leg (engine TierId 4 — off the ENC grid, GEBCO-only). The renderer
     * draws these DARK BLUE. Empty/absent on a fully-inshore route.
     */
    offshoreMask?: boolean[];
    distanceNM: number;
    gridSize: { width: number; height: number };
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    /**
     * Contiguous charted-shallow caution runs ≥200 m on the final polyline,
     * with the real charted min depth where the chart vouches one — the input
     * to the tide-window annotation. Absent on cloud/legacy results.
     */
    shallowRuns?: ShallowRunInfo[];
    /** Metres of overland tail trimmed off an inland destination pin —
     *  present only when the trim fired (route ends at the water's edge). */
    destinationInlandTrimM?: number;
    debug?: RouteDebug;
    /**
     * Per-phase timing in ms. Useful for finding the bottleneck during
     * speed optimisation. Keys: buildNavGrid, labelComponents,
     * componentSnap, aStar, smoothPath.
     */
    phaseTimings?: Record<string, number>;
}

export interface RouteFailure {
    error: string;
    /** Optional sub-reason for UI categorization. */
    code?:
        | 'origin-on-land'
        | 'destination-on-land'
        | 'destination-disconnected'
        | 'no-path'
        | 'origin-out-of-bounds'
        | 'destination-out-of-bounds'
        | 'empty-grid'
        | 'uncharted-corridor'
        /** A fixed bridge with insufficient clearance for this vessel's air
         *  draft severs the only channel — the honest verdict is "no
         *  mast-safe route", never a cross-country workaround. */
        | 'air-draft-blocked';
    debug?: RouteDebug;
}

// ── Geometry helpers ────────────────────────────────────────────────

// Exported for services/seaway/connector.ts (Phase 11) — the connector
// runs on the SAME grid + cost function as the engine, by construction.
export interface NavGrid {
    width: number;
    height: number;
    /** Geographic origin: bbox SW corner. */
    minLon: number;
    minLat: number;
    /** Cell sizes in degrees. */
    dLon: number;
    dLat: number;
    /** Float32Array length = width*height. NaN = blocked, ≥0 = depth. */
    cells: Float32Array;
    /**
     * Per-cell channel preference flag (1 = inside FAIRWY or DRGARE,
     * 0 = outside). When set, A* uses the baseline 1.0× cost regardless
     * of depth — this is how the router "stays in the marked channel"
     * when one exists, even if a geometrically shorter path through
     * generic deep water is available.
     */
    preferred: Uint8Array;
    /**
     * Per-cell LAND flag (1 = blocked by LNDARE / coastline / the LNDARE
     * coastal buffer — actual terra firma). A point-hazard buffer (WRECKS /
     * OBSTRN / UWTROC) blocks `cells` but does NOT set this. The leading-line
     * splice validators use it so a charted lead is never vetoed by the very
     * hazard it exists to guide past (the Tangalooma WRECKS veto), while
     * still never crossing land. Optional for cached-grid back-compat.
     */
    landBlocked?: Uint8Array;
    /**
     * Per-cell MARINA-BERTH flag (1 = the cell was blocked by the Pass 2c
     * berth carve — an OSM man_made=pier/pontoon footprint). Distinct from
     * landBlocked so the fine-canal gate can tell "this span runs through a
     * marina's finger pontoons" apart from ordinary land: a berth-dense span
     * is FORCED onto the fine grid + marina-centreline solver so it rides the
     * fairway between the pens instead of the coarse A* slice that cuts over
     * them (wharf-start, 2026-07-07). Only allocated when berths are present.
     */
    berthBlocked?: Uint8Array;
    /**
     * Per-cell MARK-INFERENCE flag (1 = the cell was blocked by an IALA
     * avoidance disc synthesised from a solo lateral/cardinal mark —
     * `_class` iala-oriented-hazard / direct-hazard /
     * lateral-marker-as-hazard — NOT by a charted obstruction). A*
     * treats it as blocked like any hazard (the robot stays
     * conservative); the TRACER downgrades it to an honest caution —
     * calling an inference "a charted hazard" over charted 5-6 m water
     * cried wolf (Skirmish Point, 2026-07-14). Optional for cached-grid
     * back-compat.
     */
    markDiscBlocked?: Uint8Array;
    /**
     * Per-cell NO-WATER-EVIDENCE flag (1 = at the end of the grid build the
     * cell was still UNKNOWN_OPEN with no DEPARE verdict, no FAIRWY/DRGARE
     * preference, no OSM water and no protection — nothing in any source
     * vouches there is water here). Evidence-based, NOT coverage-bbox-based:
     * the Sunshine Coast ribbon cells' bboxes cover Bribie Island while
     * containing zero LNDARE (reply 16 cause #3), so bbox containment proves
     * nothing. Under unchartedPolicy 'strict' these cells flag caution when
     * crossed and long runs refuse the route. A post-build rescue (endpoint
     * carve, bridges) clears the flag implicitly: readers must pair it with
     * `cells[idx] === UNKNOWN_OPEN`. Optional for cached-grid back-compat.
     */
    unvouched?: Uint8Array;
    /**
     * Per-cell REAL charted depth (shallowest DRVAL1, m below LAT) for cells a
     * shallow-for-draft DEPARE claimed in Pass 1 — the depth the CAUTION
     * sentinel in `cells` erases. NaN where no shallow DEPARE touched the cell.
     * Routing never reads it; it exists so the tide-window annotation can
     * compute requiredRiseM = draft + tideSafety − depth per run
     * (display-only, masterplan Phase 7). Optional for cached-grid back-compat.
     */
    shallowDepthM?: Float32Array;
    /**
     * Per-cell low-clearance flag (1 = under a fixed structure — a bridge —
     * this vessel's air draft cannot make). Impassable ABSOLUTELY: rescue,
     * relax, and carve passes must never re-open these cells; the component
     * bridge carve and endpoint carve refuse to tunnel them. Optional for
     * cached-grid back-compat.
     */
    clearanceBarred?: Uint8Array;
    /**
     * Per-cell tide-assist flag (1 = caution cell whose REAL charted depth is
     * wet at LAT and recoverable on a normal tide: requiredRise ≤ 1.8 m).
     * Populated ONLY when the request asked for routeProfile 'tideAssist' —
     * the profile is part of the grid cache key. aStar/cellCostAt price these
     * at 10× instead of 40× so the explicit "shortest" profile can take a
     * bank crossing that ships with its tide window. Never set on drying
     * cells. Optional for cached-grid back-compat.
     */
    tideAssist?: Uint8Array;
    /**
     * Cost multiplier applied to the {@link tideAssist} recoverable cells.
     * 10 for the 'tideAssist' profile (the tide-window "shortest"); 1.5 for
     * the auto-route 'tideDirect' profile, which prices the recoverable banks
     * low enough that A* prefers a near-direct crossing over a modest deep
     * detour. Absent ⇒ cellCostMultiplier defaults to 10 (tideAssist parity).
     * Baked into the grid at build time and part of the profile cache key.
     */
    assistCostMul?: number;
    /**
     * Per-cell wet-chart-land-conflict flag (1 = a coarse LNDARE painted over
     * a finer cell's wet DEPARE band and the wet claim won — the cell is
     * honest CAUTION, protected from the land buffer). Routable mid-route;
     * endpoint snapping PREFERS honest water over these so a geocoded
     * land pin never departs from a phantom conflict creek. Optional for
     * cached-grid back-compat.
     */
    wetConflict?: Uint8Array;
    /**
     * Per-cell localized-relax flag (1 = LNDARE softened to CAUTION inside an
     * endpoint relax zone). Exposed so the relax-retry acceptance can detect
     * a route CIRCUMVENTING a low-clearance bridge overland (relax-carved
     * cells near a clearanceBarred cell) and refuse instead. Present only on
     * grids built with relax zones.
     */
    relaxMask?: Uint8Array;
    /**
     * Per-cell NtM-surveyed requiredRise (m above LAT needed for this vessel's
     * floor), for CAUTION cells whose depth was overridden by an acknowledged,
     * current Notice-to-Mariners survey zone (NTM pass). NaN everywhere else.
     * aStar/cellCostAt grade these cells' caution price by rise — a freshly
     * surveyed 2.5 m corridor beats a surveyed 1.4 m shoal — while ordinary
     * chart caution keeps the flat 40×. Zone cells at or above the floor carry
     * no entry (they price as normal water). Optional for cached-grid
     * back-compat.
     */
    ntmRiseM?: Float32Array;
    /**
     * Per-cell "INJECTED canal/marina channel water" flag: 1 = the cell was
     * claimed by the nearshore Mapbox vector-water fill we INJECTED for routing
     * (a DEPARE feature tagged `_source === 'mapbox-water'` over the endpoint
     * corridor crops). This is STRICTLY NARROWER than osmWaterCells: it excludes
     * generic chart OSM rivers/harbours/lakes, the thin Pass-1b OSM canal carve
     * (which already routes fine and is baked into the route-fixture baselines),
     * and — by construction — the open bay (the injection only ever covers the
     * ~4 km crops around origin + destination). The tier
     * router uses it to (a) classify these vertices tier-1 (a canal, not "deep
     * open water") and (b) force the fine centreline pass over them even though
     * the wide injected fill defeats the coarse narrowness probe. Optional for
     * cached-grid + test back-compat (omitted ⇒ treated as all-zero).
     */
    injectedCanal?: Uint8Array;
    /**
     * Per-cell coarse-A* centring multiplier (≥ 1): the step cost into a cell is
     * scaled by this so the search bows to mid-channel in confined water. Derived
     * from the navigable mask via {@link computeCentreFactor} (clearance-to-shore,
     * clamped to one channel half-width — see {@link CENTRE_BIAS}). Computed once
     * at grid build and read by BOTH aStar and cellCostAt (the smoother/gate
     * pricing) so the search and every refinement step price edges identically —
     * no post-A* pass can re-straighten a centred leg onto the bank. Optional for
     * cached-grid + test back-compat: when absent, aStar computes-and-attaches it
     * lazily and cellCostAt treats it as 1 (the prior wall-hugging behaviour).
     */
    centreFactor?: Float32Array;
    /**
     * Per-cell "a paired channel mark governs this cell" flag (1 = inside a
     * mark-governed disc). Set alongside centreFactor at grid build. Used to keep
     * the centred-water de-stagger (deStaggerCentred) OUT of marked channels —
     * those are already smoothed against their gate discipline and must stay
     * byte-identical. Optional for cached/test back-compat (absent ⇒ all-zero).
     */
    markGoverned?: Uint8Array;
    /**
     * Per-cell "two-sided-confined channel" flag (1 = water bounded on opposing
     * sides within a probe reach — a canal/river reach, not open water or a
     * one-sided coast). Set alongside centreFactor at grid build. The de-stagger
     * acts ONLY on confined water, so it cleans a canal's wobble but leaves an
     * open approach (e.g. a bar run) untouched. Optional (absent ⇒ all-zero).
     */
    confined?: Uint8Array;
}

/**
 * A circular zone (tap centre + radius) within which LNDARE/coastline
 * cells are relaxed to CAUTION (traversable at 500× cost, flagged red)
 * instead of hard-blocked. Used by the far-snap retry to thread the
 * charted-land barrier islanding an endpoint (Newport's canal estate)
 * WITHOUT relaxing the whole grid — global relaxation let A* shortcut
 * straight across the mainland (verified land-crossing 2026-05-20).
 * Confining relaxation to a bounded zone around the problem endpoint
 * keeps every mid-route mainland cell hard-blocked, so the only red
 * cells are the genuine barrier the user must pilot through.
 */
export interface RelaxZone {
    lat: number;
    lon: number;
    radiusM: number;
}

export interface FairingMidpoint {
    lat: number;
    lon: number;
    halfWidthM: number;
}
