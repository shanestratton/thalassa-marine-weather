/**
 * Inshore Router Engine — public type contracts.
 * Carved out of inshoreRouterEngine.ts (module split, 2026-06-24).
 */
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

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
     *
     * LEADS ONLY: chart NAVLNE enters here only as a CATNAV 3 leading line.
     * Clearing lines (CATNAV 1) and transits (CATNAV 2) are removed by
     * navLineLeads (services/leadingLine.ts) at the merge, at routeInshore
     * entry and again in the grid, the land audit and the tracer. An OSM
     * line that redraws one of them is removed too (osmNavLineLeads at the
     * merge, navLineLeads on a mixed layer): the chart's category decides.
     *
     * ON-WATER SPANS ONLY past routeInshore entry (withNavLineLeadsOnly): a
     * lead is drawn on to its marks, usually ashore, and the land extension is
     * cut off there once (services/routing/leadLandClip navLinesOnWater, the
     * lead compiler's S-57 land rule), so the lead snaps, the approach, the
     * egress splice and the land audit never ride a lead over land. The grid
     * reads NAVLINE_GRID instead.
     */
    NAVLINE?: FeatureCollection;
    /**
     * Engine-internal: the leads as they were BEFORE the entry clip, for the
     * grid's Pass 5b only. The grid clips a lead against its OWN land verdict,
     * cell by cell, which also counts the OSM canal carve and OSM-vouched
     * water the S-57-only clip does not (the Newport entrance channel, Phase 1
     * review 2026-09-29) — and never stamps a corridor, a depth rescue or a
     * preference on a cell it holds as land. Absent: the grid reads NAVLINE.
     */
    NAVLINE_GRID?: FeatureCollection;
    /**
     * S-57 RECTRC (Recommended Track) LineStrings — the hydrographer's OFFICIAL
     * recommended route through a channel/approach, drawn on the chart (with
     * CATTRK + ORIENT bearing). Where present this is the AUTHORITATIVE channel
     * line: the channel router snaps the route onto it FIRST, ahead of the
     * derived buoy/leading-line follow. The "definitive set of routes out of
     * the marina" — it ships inside the ENC, we just plumb it through. Added
     * 2026-06-18 (Newport carries 43 RECTRC segments we were ignoring).
     *
     * Cut to its on-water spans at routeInshore entry, like NAVLINE: a track
     * the chart draws over land paint (the Moreton corridor's RECTRC 2655
     * lies wholly on it) is never snapped to.
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
     * S-57 SEAARE — named sea areas (OBJNAM: "Boat Passage", "Entrance
     * Channel"). Never read by the grid or the path cost: only to NAME the
     * water a route cannot get through (owner decision 11, 2026-10-01 —
     * services/engine/tideCeiling noTideClearsRefusal).
     */
    SEAARE?: FeatureCollection;
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
    /**
     * S-57 M_QUAL survey-quality zones (CATZOC), stamped with their cell's
     * fineness rank (`_scaleRank`) like the depth bands. Never read by the
     * grid or the path cost: the route's survey disclosure only (owner
     * decision 9, 2026-09-30; services/engine/shallowRuns collectSurveyRuns).
     */
    M_QUAL?: FeatureCollection;
}

/**
 * The highest tide the app knows at a place (owner decision 11, Shane
 * 2026-10-01: "ok avoid water no tide can clear"): one per 0.25° bucket of
 * the tide cache (TideHeightService tideCurveBucket), from the same 14-day
 * curve the route's tide chips read (tideWindowChips curveHighestM). The
 * router treats water that even this tide cannot clear for the boat as
 * impassable (services/engine/tideCeiling). A place with no ceiling proves
 * nothing: its water is routed as before.
 */
export interface TideCeiling {
    /** A spot in the bucket — where its curve was fetched. */
    lat: number;
    lon: number;
    /** The top of the loaded curve, m above LAT. */
    highestM: number;
    /** Whole days the curve spans: "the highest tide in the next N days". */
    days: number;
}

/** A cell merged for a route whose data carries NO M_QUAL layer at all —
 * "not extracted", unlike a cell whose zones simply leave a spot uncovered
 * ("ungraded"). Where one owns a spot, the route says its survey quality was
 * not checked (owner decision 9, 2026-09-30, read like decision 8). */
export interface SurveyUncheckedCell {
    id: string;
    bbox: readonly [number, number, number, number];
    /** Its fineness rank (services/enc/scaleShadow cellFinenessRank), or null. */
    rank: number | null;
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
    /** Cells merged for this route with no M_QUAL layer (SurveyUncheckedCell). */
    surveyUncheckedCells?: readonly SurveyUncheckedCell[];
    /**
     * The highest tide known per place (TideCeiling; owner decision 11,
     * 2026-10-01). Where the chart's deepest value for the water (DRVAL2)
     * plus that tide is still short of draft + safety, the water is
     * impassable for this request: the route goes the deep way round, or
     * none is drawn and the refusal names the spot. Absent or empty: nothing
     * is proved, and the route is as before. Part of the grid cache key.
     */
    tideCeilings?: readonly TideCeiling[];
    /**
     * INTERNAL (decision 11 fix-up, 2026-10-01): the charted bands a route
     * crossed through water no tide clears, with no local way round them.
     * routeInshore's own retry closes EVERY cell each one touches where it is
     * proved (TideBarrier) — a bar narrower than a grid cell included, which
     * the default grid leaves open — and routes again: the deep way round,
     * or no route. Part of the grid cache key.
     */
    tideBarriers?: readonly TideBarrier[];
}

/**
 * A charted depth band a route crossed through water no tide clears
 * (RouteRequest.tideBarriers; decision 11 fix-up, 2026-10-01): its polygon,
 * the deepest it admits (DRVAL2) and its survey rank. The retry's grid
 * closes every cell the band touches where that depth plus the place's
 * highest tide is still short of draft + safety, unless a finer survey owns
 * the cell.
 */
export interface TideBarrier {
    geometry: Polygon | MultiPolygon;
    deepestM: number;
    /** Survey fineness (`_scaleRank`), or null when unranked. */
    rank: number | null;
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
    /** Metres of tail trimmed off charted land when the destination pin is
     *  WATER the route could not reach (2026-10-01): a gap to the pin, never
     *  "the destination is inland". */
    destinationLandTailTrimM?: number;
    /** Owner decision 7 (round 2, 2026-09-30): the pin sat in charted caution
     *  water (NavGrid.chartedShallow) and the route runs all the way to it —
     *  the stretch past the last deep-enough water is a 'needs tide' tail. */
    originChartedPin?: boolean;
    destinationChartedPin?: boolean;
    /** Why a charted-end attempt (decision 7) was re-run with today's
     *  endpoints (fix-up, 2026-09-30): its tail crossed hard land, a drying
     *  band or a structure bar at the vector check, the pin's deep water lay
     *  in a component the route did not use, or the finished geometry reached
     *  the pin through other water. Absent when no re-run happened. */
    chartedEndRejected?: string;
    /** Metres a pin's charted tail saved by joining the route where the path
     *  already passed nearer the pin than the tail's deep end (no
     *  out-and-back, 2026-10-01). Absent when no tail was cut. */
    outAndBackCutM?: { origin?: number; destination?: number };
    /** A charted pin's tail run DIRECT (Shane, 2026-10-03; engine/directTail):
     *  metres of route the straight line replaced, and its own length. */
    directTail?: { origin?: { fromM: number; toM: number }; destination?: { fromM: number; toM: number } };
    /** A shorter straight tail existed but none passed the checks: why (the
     *  line to the tail's own junction), and the charted way was kept. */
    directTailRefused?: { origin?: string; destination?: string };
    /** Owner decision 11 (2026-10-01): grid cells proved impassable because
     *  no tide the app knows clears them for this boat (TideCeiling). */
    noTideClearsCells?: number;
    /**
     * Decision 11 fix-up (2026-10-01): the route crossed water no tide clears
     * with no local way round it (services/engine/tideCeiling
     * classifyNoTideRuns), so this attempt was refused. Where it is (the
     * longest run's middle, [lon, lat]), its metres, the spots its bands are
     * read at (every run's start, middle and end — routeInshore closes those
     * bands and routes again) and whether the attempt reached both pins
     * (within 500 m, or at the edge of a pin off the water): only a route
     * that reached them proves the crossing is the only way through. Present
     * only on such a refusal.
     */
    noTideCrossing?: {
        mid: [number, number];
        lengthM: number;
        spots: [number, number][];
        reachedPins: boolean;
    };
    /** Decision 11 fix-up (2026-10-01): stretches over water no tide clears
     *  the 50 m geometry drew where a local fine way avoids it (a creek
     *  narrower than a cell), replaced by that way; their metres. */
    noTideSplicedM?: number[];
    /** Metres cut off an end whose pin is off the water (pinOffWater, round 3
     *  2026-09-30): the route stops at the edge of the drying bank or land
     *  instead of running on across it to the pin. */
    pinEdgeTrimM?: { origin?: number; destination?: number };
    /** Segments the final hazard audit flagged caution: within the
     *  obstruction buffer of a charted hazard of unknown or too-shallow depth
     *  (round-3 review, 2026-09-30; safetyAudit hazardBufferSegments). */
    hazardBufferSegs?: number;
    /** Vertices the scaffold collapse dropped from the four-tier route:
     *  near-collinear points (within 2.5 m) inside runs of one state (round
     *  4, 2026-09-30; engine/geometry collapseStateRuns). */
    scaffoldCollapsed?: number;
    /** Vertices the any-angle string pull removed from the four-tier route:
     *  grid stair-steps a chord replaced where it is at least as safe as the
     *  segments it replaces (field round 2 item a, 2026-10-03;
     *  engine/stringPull). */
    stringPulled?: number;
    /** Lateral gates the route crossed close by a mark and now threads
     *  through the centre (engine/stringPull threadGateCentres). */
    gatesThreaded?: number;
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
    /** Longest continuous final-route run (metres) inside exact charted
     * LNDARE without overlapping DEPARE/DRGARE/FAIRWY water evidence. */
    hardLandMaxRunM?: number;
    /** Total final-route distance (metres) across the same unvouched land. */
    hardLandTotalM?: number;
    /** The part of hardLandTotalM away from a pin's own edge (2026-10-01):
     *  land the route crosses, not the ground a pin off the water — on land,
     *  on a drying bank, trimmed back to the water's edge — sits on
     *  (safetyAudit hardLandAwayFromPinEdges). A localized-relaxed rescue of a
     *  no-tide refusal may cross none; Auto refuses a route that crosses any. */
    hardLandAwayM?: number;
    /** The middle of the longest such run, [lon, lat]. */
    hardLandAwayAt?: [number, number];
    /** Ends of the longest unvouched hard-land run, as [lon, lat]. */
    hardLandRun?: { start: [number, number]; end: [number, number] };
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
 * Display/annotation only: tide changes feasibility AND timing, never geometry
 * — with one exception, owner decision 11 (2026-10-01): water NO tide the app
 * knows clears for this boat is impassable (RouteRequest.tideCeilings).
 */
/** A stretch of the route between two exact points: segment + fraction. */
export interface ChartedShallowSpan {
    startSeg: number;
    startT: number;
    endSeg: number;
    endT: number;
    /** The shallowest charted depth under it (m below LAT). */
    minDepthM: number;
    /**
     * Its charted depth alone makes it red, so a tide may draw it amber
     * (owner decision 10; round-4 review, 2026-09-30): not in a charted
     * hazard's buffer, not over decision-1 water, and the router sent a
     * hazard mask. Absent: red whatever the tide (fail-safe — older and cloud
     * results too).
     */
    tideLiftable?: boolean;
    /**
     * A stretch red (or amber, decision 10) for passing too close to a
     * shallow band, not for the water under it (the real-chart check,
     * 2026-10-03): the band, how close the stretch comes, and the clearance
     * the router keeps (shallowRuns nearShallowBand: 30 m from a band that
     * dries, charts no depth or never clears the keel, 10 m from one whose
     * deep end does). Its minDepthM is that band's DRVAL1 (0 m where it
     * charts none, the grid's own reading of a missing depth), so a tide that
     * clears the band itself draws it amber. Absent: charted-shallow water
     * under the line.
     *
     * Its `tideLiftable` is dropped where the tide ceiling the route was
     * planned with proves no tide clears the band (its DRVAL1 + the curve's
     * own top < draft + UKC; round-3 fix-up, 2026-10-03): red, and Save and
     * Plan My Day refuse it. Where no tide was loaded for the place it keeps
     * `tideLiftable` (the map may still lift it under a live tide) but is
     * `tideUnknown`, and is red for Save and Plan My Day too (nearSpanBlocks;
     * owner decision 10, "no tide data = can't prove it"). A near stretch a
     * tide the route knows may lift is amber 'needs tide': Save keeps it with
     * its note, and Plan My Day refuses it as a tide it cannot verify.
     */
    near?: CautionNearShallow;
    /**
     * A tide-liftable `near` stretch where the tide ceilings the route was
     * planned with (RouteRequest.tideCeilings, owner decision 11) hold none
     * for the place at its ends or middle — no tide loaded, a partial load, or
     * no station: nothing proves a tide clears the band beside it, so it is
     * red for Save and Plan My Day (nearSpanBlocks; owner decision 10). Round-3
     * fix-up review, 2026-10-03: without it a line 1 m from a reef drying 3 m,
     * drawn red 'no tide data', was saveable and planned amber.
     */
    tideUnknown?: boolean;
    /**
     * A `near` stretch in water the marks own (shallowRuns shallowRingExempt:
     * a dredged channel, fairway, lead corridor, mark pair's gate or disc —
     * where the clearance ring does not steer the router; round-3 fix-up,
     * 2026-10-03): drawn amber ('edge') and named "runs close to the edge of
     * the channel's charted shallows", never a tide window, never a refusal.
     * A stretch there inside a charted hazard's buffer (or with no hazard
     * mask to prove otherwise) is an ordinary red near stretch instead, and
     * one within shallowRuns CHANNEL_EDGE_FLOOR_M (5 m) of the band an
     * ordinary near stretch (fix-up review, 2026-10-03).
     */
    channelEdge?: boolean;
}

/**
 * Whether a near stretch (ChartedShallowSpan.near) is RED for Save and Plan
 * My Day (round-3 fix-up, 2026-10-03): no tide lifts it — a hazard's buffer,
 * water the charts dispute or do not chart, a band with no depth, or a band
 * the route's tide ceiling proves no tide clears — or no tide was loaded for
 * the place to prove one does (tideUnknown; owner decision 10, fix-up
 * review). Amber near stretches (a tide the route knows may clear the band)
 * and channel edges are not: Save keeps them with their note.
 */
export function nearSpanBlocks(span: ChartedShallowSpan | null | undefined): boolean {
    return !!span?.near && span.channelEdge !== true && (span.tideLiftable !== true || span.tideUnknown === true);
}

export interface ShallowRunInfo {
    /** First segment index of the run (segment i = polyline[i] → polyline[i+1]). */
    startSeg: number;
    /** Last segment index of the run (inclusive). */
    endSeg: number;
    /**
     * Where the run starts in startSeg / ends in endSeg, as a fraction of the
     * segment — present only when the run does not cover that segment whole:
     * a stretch of charted-shallow water on a segment the grid did not flag
     * caution (the renderer backstop, round-3 review, 2026-09-30; see
     * RouteResult.chartedShallowSpans). Absent: the whole segment.
     */
    startT?: number;
    endT?: number;
    lengthM: number;
    /**
     * Set when this run is an ENDPOINT TAIL (owner decision 7, round 2,
     * 2026-09-30): the pin sits in charted-shallow water, and the run is the
     * stretch between it and the last water deep enough for the keel — amber
     * 'needs tide', saveable. Emitted whatever its length (other runs only
     * from 200 m).
     */
    endpointTail?: 'origin' | 'destination';
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
     * The deepest the chart admits at that spot: the owning bands' deepest
     * DRVAL2 (decision 11 fix-up, 2026-10-01). Where it plus the highest tide
     * reaches what the keel needs, the water is not proved unclearable even
     * when its shallow end needs more than any tide — a 0–2 m band at a
     * 2.5 m top — and the chip says "its 0 m end", not "no tide clears it".
     * Absent where a band there bounds no depth, or the depth is an NtM
     * survey's.
     */
    deepestM?: number;
    /**
     * True when the run's minimum depth came from an NtM surveyed-override
     * zone (grid ntmRiseM stamped) rather than the chart DEPARE — the chip
     * can then say "surveyed" instead of "charted".
     */
    ntmSurveyed?: boolean;
    /**
     * An endpoint tail through decision-1 water (fix-up, 2026-09-30): caution
     * only because a COARSER chart paints land over a finer survey that
     * charts it deep enough (finestDepthM, the shallowest finest-survey depth
     * along the tail). minDepthM stays null — there is no tide to wait for —
     * so the chip names the land paint instead of a window.
     */
    coarserLandPaint?: boolean;
    finestDepthM?: number;
    /**
     * Some of the run is decision-1 water — a finer never-drying band under a
     * coarser chart's land paint — whatever its depth (round 4, 2026-09-30).
     * That water stays red whatever the tide (owner decision 10), so a run
     * whose tide window is all over it gets a 'charts disagree' chip, not a
     * window over a red line (tideWindowChips tideRunChips).
     */
    chartsDisagree?: boolean;
    /** Some of the run lies in a charted hazard's buffer (round-4 review,
     * 2026-09-30): that red is not the tide's to lift, and its chip says so. */
    nearHazard?: boolean;
    /** Some of the run has no chart depth at all (round-4 review, 2026-09-30):
     * red whatever the tide, and its chip says so. */
    partUncharted?: boolean;
}

/**
 * Why a stretch of the route is disclosed for its SURVEY quality (owner
 * decision 9, 2026-09-30, "Yes, amber on the route"; decisions 3 and 4 read
 * on the route as on the leads — leadReview surveyVerdict):
 *   • 'survey-poor' — CATZOC D or U: no stated accuracy (amber);
 *   • 'survey-margin' — the charted depth less the grade's vertical error is
 *     below draft + UKC (amber);
 *   • 'survey-ungraded' — the finest survey there carries no CATZOC (amber);
 *   • 'survey-unchecked' — the finest survey there is a cell whose data has
 *     no M_QUAL layer at all: not checked, said as a caveat (decision 8's
 *     way), never amber.
 */
export type SurveyRunReason = 'survey-poor' | 'survey-margin' | 'survey-ungraded' | 'survey-unchecked';

/** One survey stretch of the finished route. Disclosure only: it never moves
 * the route or its cost, and never refuses it. */
export interface SurveyRunInfo {
    reason: SurveyRunReason;
    /** Where it starts: segment index and the fraction along that segment. */
    startSeg: number;
    startT: number;
    /** Where it ends: segment index and the fraction along that segment. */
    endSeg: number;
    endT: number;
    lengthM: number;
    /** The worst CATZOC of the finest survey owning it (null: none). */
    catzoc: number | null;
    /** 'survey-margin': the largest vertical error along it (m). */
    errorM?: number;
    /** The shallowest finest-survey charted depth along it (m), when charted. */
    minDepthM?: number;
    /** Stretch midpoint (by along-track length) — where its chip anchors. */
    midLat: number;
    midLon: number;
    /** 'survey-unchecked': the cells with no M_QUAL layer. */
    cellIds?: string[];
}

/**
 * Why a caution segment is caution, read exactly along its line
 * (RouteResult.cautionWhy; round 2, 2026-10-02). Bits — a segment can have
 * several:
 *   • SHALLOW — the finest survey (or a current NtM survey) charts water under
 *     the line shallower than draft + safety;
 *   • UNCHARTED — part of the line has no chart depth under it;
 *   • DISAGREE — decision-1 water: a finer band under a coarser chart's land
 *     (never an overview or general cell's land over a detailed chart's
 *     depth: owner decision 12 ignores that land);
 *   • HAZARD — inside a charted rock's, wreck's or obstruction's buffer
 *     (the hazard mask, or a hazard's blocked cell the line touches);
 *   • WING — it crosses a pair-wing's cell: outside a lateral mark;
 *   • LAND — it crosses land or a blocked cell the router opened (a relax
 *     zone round a pin, or a carve between two bodies of water);
 *   • MARK — it touches the keep-out disc the router infers round a lone
 *     navigation mark (navGrid markDiscBlocked);
 *   • STRUCTURE — it touches a berth or pontoon, or a bridge too low for the
 *     boat (berthBlocked / clearanceBarred);
 *   • BLOCKED — it touches any other cell the grid keeps closed: land or
 *     the shore's buffer (the land audit owns land it crosses), water no
 *     tide clears, …;
 *   • GRID_ONLY — none of those, at least one cell the line touches is a
 *     shallow chart band's CAUTION, every caution cell it touches is a
 *     shallow chart band's alone, AND the line keeps its clearance from every
 *     such band within reach (shallowRuns nearShallowBand: 30 m from one that
 *     dries or never clears the keel, 10 m from one whose deep end does): the
 *     50 m cell holds shallower water than the line does and the line is
 *     measured clear of it. Not drawn red. Every cell the line touches counts
 *     (forEachCellOnSegment), corners included; a blocked (NaN) one always
 *     rules it out — navGrid writes land, a mark's disc, a hazard's buffer, a
 *     berth and a bridge bar as blocked, never as CAUTION (fix-up review,
 *     2026-10-03) — and so does a Notice to Mariners survey's sub-floor
 *     stamp (its depth is read on a 5 m walk, not exactly; round-2 review
 *     fix-up 2, 2026-10-03);
 *   • NEAR_SHALLOW — GRID_ONLY in every other way, but the line comes closer
 *     to a shallow band than that clearance (RouteResult.cautionNearShallow
 *     says how close, to what): red, "passes 5 m from water charted to dry
 *     3.0 m" (round-2 review fix-up 2, 2026-10-03 — a line metres off a
 *     steep-to drying reef had been drawn green and saved). Since the
 *     real-chart check (2026-10-03) the router no longer reddens a whole
 *     segment for it: EVERY segment is measured, and only the stretch inside
 *     the clearance is drawn, as a ChartedShallowSpan with `near` (red, or
 *     amber where a tide clears the band itself; such a segment reads
 *     GRID_ONLY or not caution at all). The bit is kept for saved results;
 *   • CANAL — not caution: red by the canal's own convention (canalMask, the
 *     marina basin's narrow water), named so no red carries no reason (the
 *     real-chart check, 2026-10-03). Set only where no other reason is;
 *   • CARDINAL — some of the line lies on a cardinal mark's wrong side
 *     (tier3/cardinalClamp cardinalWrongSideAt, the leg review's own rule:
 *     within 400 m, the danger's whole half within 90 m, its hazard quadrant
 *     beyond; not where the line rides a charted lead): red, beating a marked channel's yellow, and not
 *     the tide's to lift (G2, 2026-10-04);
 *   • STRETCH — SHALLOW alone, every caution cell a shallow band's, and the
 *     finest survey charts only PART of the line shallower than draft +
 *     safety: the segment is drawn red (or amber) over those stretches alone
 *     (its chartedShallowSpans), its own colour elsewhere (G2, 2026-10-04:
 *     newport-shane's last leg was red for 1,565 m over 488 m of 2 m);
 *   • UNEXPLAINED — none of those, and no exact reading, no shallow band's
 *     cell, or no band to measure the clearance from, to prove it is the
 *     cells' alone: red, said as the grid's.
 */
export const CAUTION_WHY = {
    SHALLOW: 1,
    UNCHARTED: 2,
    DISAGREE: 4,
    HAZARD: 8,
    GRID_ONLY: 16,
    UNEXPLAINED: 32,
    WING: 64,
    LAND: 128,
    MARK: 256,
    STRUCTURE: 512,
    BLOCKED: 1024,
    NEAR_SHALLOW: 2048,
    CANAL: 4096,
    CARDINAL: 8192,
    STRETCH: 16384,
} as const;

/**
 * How close a NEAR_SHALLOW segment's line comes to the shallow band it is red
 * for (RouteResult.cautionNearShallow; round-2 review fix-up 2, 2026-10-03).
 */
export interface CautionNearShallow {
    /** Metres from the line to the band (0: on its edge). */
    clearanceM: number;
    /** The band's shallowest charted depth (DRVAL1; negative dries; null: none charted). */
    depthM: number | null;
    /** The clearance that band asks for (m): the rock keep-out where it dries
     *  or never clears the keel, 10 m where its deep end does. */
    requiredM: number;
}

/** The reasons that draw a stretch amber (all but 'survey-unchecked') — in
 *  dashes since owner decision 10 (2026-09-30): solid amber is needs-tide. */
export const AMBER_SURVEY_REASONS: ReadonlySet<SurveyRunReason> = new Set([
    'survey-poor',
    'survey-margin',
    'survey-ungraded',
]);

/**
 * Why a pin is not water a route can reach it through (RouteResult.pinOffWater):
 * on charted land, on a drying bank, or — owner decision 11 (2026-10-01) — in
 * water no tide the app knows clears for this boat. The route stops at the
 * edge of the water it can use.
 */
export type PinOffWater = 'land' | 'drying' | 'no-tide';

/**
 * A pin in charted water shallower than the keel needs, with its 'needs tide'
 * tail (owner decision 7; RouteResult.pinTail): the charted depth AT the pin
 * (the finest survey's), the tide its tail needs (draft + UKC − the tail's
 * shallowest charted depth, 0.1 m), that shallowest depth when it lies off the
 * pin and is shallower (fix-up review, 2026-10-03), and whether the tail runs
 * DIRECT — one straight line to the route (Shane, 2026-10-03) — or, where no
 * straight line passes, the charted way, and why.
 */
export interface PinTail {
    depthM: number;
    needsM: number;
    leastM?: number;
    direct: boolean;
    why?: string;
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
     * Contiguous caution runs on the final polyline — ≥200 m, or an endpoint
     * tail of any length — with the real charted min depth where the chart
     * vouches one: the input to the tide-window annotation. Since the round-3
     * review (2026-09-30) a run also takes in any stretch the finest S-57
     * survey charts shallower than draft + safety on a segment the grid did
     * NOT flag caution (chartedShallowSpans), so that water always gets its
     * chip. Absent on cloud/legacy results.
     */
    shallowRuns?: ShallowRunInfo[];
    /**
     * The renderer's BACKSTOP (round-3 review, 2026-09-30): exact stretches of
     * segments the grid did NOT flag caution where the finest S-57 survey (or
     * a current NtM survey) charts water shallower than draft + safety — cut
     * at the depth bands' own edges. A 50 m cell, an off-grid splice (a lead
     * or RECTRC snap, a canal egress, a tap-to-water bridge) or a coarser
     * source's claim over the cell can leave such water uncautioned; the
     * planner draws it red ('danger') whatever else the segment is. Absent on
     * cloud/legacy results.
     */
    chartedShallowSpans?: ChartedShallowSpan[];
    /**
     * Per-segment flag, length `polyline.length - 1`: the segment is caution
     * over decision-1 water (owner decision 1: a finer never-drying band under
     * a coarser chart's land paint — shallow water, never deep; since owner
     * decision 12, 2026-10-02, never overview or general land over a detailed
     * chart's depth area, which is ignored, not disputed). The renderer
     * lets it beat a marked channel's yellow, as charted-shallow water does
     * (round-3 review, 2026-09-30). Absent on cloud/legacy results.
     */
    landPaintConflictMask?: boolean[];
    /**
     * Per segment, why a caution segment is caution, read EXACTLY along its
     * line (CAUTION_WHY bits; 0 on a segment that is not caution). Round 2,
     * 2026-10-02: the field route's North Molle corner drew red where only the
     * 50 m cells touched a 2 m shore band — the line itself charted 5 m+ — and
     * nothing said why. GRID_ONLY is not drawn red; every other reason is, and
     * the route review names it. Absent on cloud/legacy results.
     */
    cautionWhy?: number[];
    /** Per segment: the shallowest charted depth under a caution segment's
     *  line where it is below draft + safety (the SHALLOW reason), else null. */
    cautionDepthM?: (number | null)[];
    /** Per segment: the shallow band the line passes too close to, and how
     *  close (round-2 review fix-up 2, 2026-10-03), else null — since the
     *  real-chart check (2026-10-03) on any segment with a `near` stretch in
     *  chartedShallowSpans (the worst band on it). */
    cautionNearShallow?: (CautionNearShallow | null)[];
    /** Metres of overland tail trimmed off an inland destination pin —
     *  present only when the trim fired (route ends at the water's edge). */
    destinationInlandTrimM?: number;
    /**
     * Per-segment flag, length `polyline.length - 1`: the segment is caution
     * AND the chart (its finest survey, or a current NtM survey) charts water
     * shallower than draft + safety on it — charted-shallow water, as opposed
     * to uncharted or conflict caution (fix-up, 2026-09-30). The renderer lets
     * it beat a marked channel's yellow: marks say where the channel is, not
     * how deep it is. Absent on cloud/legacy results.
     */
    chartedShallowMask?: boolean[];
    /**
     * Per segment: the charted depth (m below LAT) a tide must lift for the
     * route to clear draft + UKC there — the shallowest charted depth under a
     * caution segment red for its depth ALONE (owner decision 10, Shane
     * 2026-09-30: "Amber if a tide clears it"). The planner draws that
     * segment amber when some tide gives draft + UKC over it, red when none
     * does. Null where a tide cannot change the red: not charted-shallow, a
     * charted hazard's buffer, a sample no chart covers, decision-1 water.
     * Absent on cloud/legacy results (all red, as before).
     */
    tideDepthM?: (number | null)[];
    /**
     * Draft + UKC (m) the router judged tideDepthM and the charted-shallow
     * water against (round-4 review, 2026-09-30): the planner colours the tide
     * against the same sum, not a second copy of the UKC that could drift.
     */
    tideNeedM?: number;
    /**
     * A pin that is NOT water a route can reach it through (owner decision 7,
     * round 2, 2026-09-30): on charted land, or on a drying bank (DRVAL1 < 0).
     * No charted 'needs tide' tail: the route stops at the EDGE — the last
     * water the chart paints neither drying nor land, nearest the pin (round
     * 3, 2026-09-30; it used to run on across the drying bank to the cell the
     * pin snapped to, red with its drying depth). debug.pinEdgeTrimM says how
     * much was cut. The planner's route notice says which. Absent when both
     * pins are water.
     */
    pinOffWater?: { origin?: PinOffWater; destination?: PinOffWater };
    /** A pin in charted-shallow water and its tail (PinTail); absent when neither pin is. */
    pinTail?: { origin?: PinTail; destination?: PinTail };
    /**
     * The route's survey-quality stretches (owner decision 9, 2026-09-30;
     * SurveyRunInfo): amber for CATZOC D/U, a grade whose error eats the keel
     * margin, or no grade; 'survey-unchecked' where the chart data carries no
     * M_QUAL. Disclosure only. Absent on cloud/legacy results.
     */
    surveyRuns?: SurveyRunInfo[];
    /** Cells with no M_QUAL layer that own some of the route: its survey
     * quality was not checked there (said as a caveat, never amber). */
    surveyUncheckedCells?: string[];
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
        /** The final emitted geometry would sustain a run across exact charted
         * land with no overlapping water evidence. */
        | 'hard-land-crossing'
        /** INTERNAL (decision 7, round 2): an attempt that ran a route to a pin
         * in charted-shallow water reached it through other water. The engine
         * re-runs it with today's endpoints; routeInshore never returns it. */
        | 'charted-end-rejected'
        /** A fixed bridge with insufficient clearance for this vessel's air
         *  draft severs the only channel — the honest verdict is "no
         *  mast-safe route", never a cross-country workaround. */
        | 'air-draft-blocked'
        /** Owner decision 11 (2026-10-01): the only way through crosses water
         *  no tide the app knows clears for this boat. The error names the
         *  spot, its charted depth, the highest tide and what the boat needs. */
        | 'no-tide-clears';
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
     * Per-cell HAZARD flag (1 = blocked by an OBSTRN / WRECKS / UWTROC buffer
     * or area — charted, or a mark-inference disc, which markDiscBlocked
     * tells apart). Exported (round-3 review, 2026-09-30) so the endpoint
     * carve and the component-bridge carve refuse to tunnel a charted hazard's
     * buffer, as they refuse clearanceBarred: a 60 m origin bubble re-opened
     * a wreck's buffer and the route passed 35 m from it. Optional for
     * cached-grid back-compat.
     */
    obstnBlocked?: Uint8Array;
    /**
     * Per-cell flag (1 = closed by a hazard with NO S-57 identity: an OSM
     * reef, an aeroway — router furniture other than a mark's disc or a
     * clearance bar). The final audit (hazardBufferSegments) reads charted
     * hazards only, so where it finds a line clear of them a charted
     * hazard's keep-out cell the line touches is the grid's alone — never one
     * of these (fix-up review, 2026-10-03; shallowRuns cautionCells). Only
     * allocated when such a feature exists.
     */
    furnitureHazardBlocked?: Uint8Array;
    /**
     * Per-cell flag (1 = closed ONLY by charted hazards sounded deep enough
     * for this keel, VALSOU >= draft + UKC — buffered like any point hazard,
     * but exempt from the final audit, so never drawn red for the hazard).
     * tier4Router tier2RedLoad weighs these as ordinary red, not a hazard's
     * double (fix-up review, 2026-10-03). Only allocated when such a hazard
     * exists.
     */
    deepHazardOnly?: Uint8Array;
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
     * A lead's or a mark pair's preference (Pass 5b / 5) is not evidence:
     * see leadOnlyPreferred.
     */
    unvouched?: Uint8Array;
    /**
     * Per-cell flag: 1 = the cell is preferred ONLY because a lead's corridor
     * (Pass 5b) or a paired lateral mark's gate disc (Pass 5, round 2) stamped
     * it. A lead or a pair of marks says where to steer, not how deep it is:
     * such a cell over uncharted water is still unvouched (never green under
     * the strict policy), so readers that treat `preferred` as evidence must
     * except these. Absent when no lead or mark pair preferred a cell (Phase
     * 2a review, 2026-09-30).
     */
    leadOnlyPreferred?: Uint8Array;
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
     * Per-cell CHARTED CAUTION WATER flag (owner decision 7, round 2,
     * 2026-09-30): 1 = a CAUTION cell that is honest chart water shallower
     * than the keel needs — an S-57 band that never dries (charted DRVAL1 ≥
     * 0) owns it at its finest survey with no land paint over it, or it is
     * decision-1 water (a finer never-drying band beats a coarser chart's
     * land paint) whose finest band is itself deep enough for the keel (owner
     * decision 2 keeps a shallow canal band under land paint out: fix-up,
     * 2026-09-30), or a current Notice-to-Mariners survey charts it. Never land, relaxed land, a drying
     * band, a hazard / berth buffer, a structure bar or uncharted water. The
     * ONLY caution a route endpoint may sit in: the engine runs the route to a
     * pin there, the stretch past the last deep-enough water flagged 'needs
     * tide'. Readers pair it with `cells[idx] < 0` (a later carve clears it
     * implicitly). Absent when no cell qualifies.
     */
    chartedShallow?: Uint8Array;
    /**
     * Per-cell flag (owner decision 11, 2026-10-01): 1 = water no tide the
     * app knows clears for this boat — the charted bands' deepest value
     * (DRVAL2) plus the place's highest tide (RouteRequest.tideCeilings) is
     * still short of draft + safety at its centre, and no band a tide clears
     * touches it (fix-up, 2026-10-01: a creek narrower than a cell stays
     * open) — or a crossed band's retry closed it (RouteRequest.tideBarriers).
     * Blocked in `cells` (NaN) like land; the endpoint carve and the
     * component-bridge carve never tunnel it. Absent when the grid was built
     * without ceilings or nothing was proved.
     */
    noTideClears?: Uint8Array;
    /**
     * Per-cell wet-chart-land-conflict flag (1 = a coarse LNDARE painted over
     * a finer cell's wet DEPARE band and the wet claim won — the cell is
     * honest CAUTION, protected from the land buffer; never set where owner
     * decision 12 ignores overview land over a detailed chart's depth area,
     * navGrid Pass 2). Routable mid-route;
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
     * The shallow-band clearance ring (the real-chart check, 2026-10-03;
     * engine/shallowRuns applyShallowClearanceRing): per cell, 2 where a step
     * from the cell's centre could pass within SHALLOW_CLIFF_CLEARANCE_M of a
     * band that dries, charts no depth or never clears the keel, 1 within
     * SHALLOW_BAND_CLEARANCE_M of one whose deep end does (the centre within
     * √(clearance² + half a diagonal²) of it), else 0. A COST,
     * never a block: its factor (aStar shallowRingFactor) is folded into
     * centreFactor, and the Seaway connectors' search reads it here. Empty
     * (length 0) once applied to a grid with no shallow band; absent until
     * applied. May be priced lazily since G2 (2026-10-04): a cell's byte
     * carries aStar RING_PENDING until shallowRingResolve prices it (aStar
     * shallowRingClass reads it), RING_SEED on a band edge's seed cell. The
     * engine's cached grids are priced in full (plain classes; G2 review).
     */
    shallowRing?: Uint8Array;
    /** Prices a pending ring cell (engine/shallowRuns
     *  attachShallowClearanceRing): its class, its factor folded into
     *  centreFactor. Absent once the ring is fully priced. */
    shallowRingResolve?: (idx: number) => number;
    /**
     * Per-cell "a paired channel mark governs this cell" flag (1 = inside a
     * mark-governed disc). Set alongside centreFactor at grid build. Used to keep
     * the centred-water de-stagger (deStaggerCentred) OUT of marked channels —
     * those are already smoothed against their gate discipline and must stay
     * byte-identical. Optional for cached/test back-compat (absent ⇒ all-zero).
     */
    markGoverned?: Uint8Array;
    /**
     * Per-cell flag: 1 = a pair-wing's outboard CAUTION (Pass 5c — passing
     * outside a lateral mark). Read by the route's caution reasons (round 2,
     * 2026-10-02) so a wing's red is never taken for a shallow band's: a wing
     * cell over deep water is caution for the marks, not the depth. Absent:
     * no wing stamped.
     */
    wingCaution?: Uint8Array;
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
