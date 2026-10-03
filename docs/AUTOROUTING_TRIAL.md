# Isolated autorouting trial

## Opt-in switch: Auto route (trial) — 2026-10-01, night

Phase 3's local gate (Pro, signed in, installed charts) opened Auto and Plan
Your Day to every signed-in tester with charts, because `isPro` is true for
every account while `PUBLIC_BETA_ACCESS.enabled`. A router built this week must
not reach them before Shane has proved it in the Whitsundays, so both are now
opt-in. Claude's call under Shane's delegation (2026-10-01: "any questions
please answer with whatever your recommendation is").

- **The switch.** Settings → Preferences → Routing → "Auto route (trial)",
  "Thalassa's own router. Not for navigation — review every route." Off by
  default; stored as `autorouteTrialEnabled` with the other Preferences
  switches (per account; it syncs with the account's settings). Read through
  `services/autorouteTrialSwitch.ts`.
- **Auto.** `getThalassaAutorouteStatus` is closed while it is off, so the
  routing choice keeps Auto disabled and says "Auto route (trial) is off. Turn
  it on in Settings → Preferences. Manual is ready." `calculateThalassaProposal`
  refuses in the same words before the engine runs, whoever asks.
- **Plan Your Day.** A Pro tap with the switch off opens nothing and says "Plan
  Your Day routes with Auto route (trial), which is off. Turn it on in Settings
  → Preferences." Switched off while the planner is open, it shuts. The runtime
  (`runDayPlanner`) refuses in those words before any status, reference or
  routing work.
- **Unchanged.** Pro, signed in and installed charts still apply on top; a free
  account is still offered the upgrade first. The manual planner's ⚡ Auto route
  and the passage planner do not read the switch. To widen Auto to every
  tester later, default the switch on (or drop it) — a decision for Shane.
- Tests: `tests/AutorouteTrialSwitch.test.tsx` (real settings store, closed by
  default for a beta Pro account, open when switched on, Plan Your Day the
  same), plus the switch cases in `tests/autoroutingThalassa.test.ts` and
  `tests/dayPlannerRuntime.test.ts`.

## Auto runs Thalassa's own router on the phone — 2026-10-01

SevenCs is out of the client. Shane, 2026-09-30: "sevenc's has never been
connected properly, it does not work, it can go at your leisure". Auto now asks
Thalassa's inshore router (`tryInshoreRoute`, the engine every Pro user already
runs through the manual ⚡ Auto route and the passage planner) through
`services/autoroutingThalassa.ts`, on the phone, from the installed charts.

- **Who gets Auto.** Pro route planning, a signed-in identity and a confirmed
  draft, as before. Whether Calculate is enabled is worked out on the phone:
  at least one installed navigation chart. No server status call; the old
  allowlist, switch, expiry and quota no longer decide anything. This widens
  Auto from Shane's account to every signed-in Pro account with charts; the
  `· Trial`, "Not for navigation. Unsaved proposal only." and
  review-required framing is unchanged.
- **Setup** is departure, destination, Calculate. The Canal / marina vs Open
  water choice and the canal exit pin went: the router routes from the berth
  with its own canal tier. Offline, the Newport estate routes from the phone's
  harbour water pack when its area is saved, and otherwise refuses and says
  the area's water isn't on this phone yet (owner decision 2; water pack
  since 2026-10-02).
- **Always 'safest'.** The tide changes whether and when, never which way.
  Draft + 0.5 m under the keel at LAT; no air draft set means every bridge and
  overhead line blocks (owner decision 5). The engine's 85 s watchdog is the
  only timeout.
- **Plain refusals, never a straight line.** Over 50 NM, or no installed chart
  at an end, is said before the engine runs. A corridor gap fetches the missing
  charts from the cloud once and retries once. Final refusals (no tide clears,
  overhead clearance) are shown whole.
- **The satellite land check** runs as in the passage planner. Land refuses;
  when the check cannot finish the route is shown with "checked against the
  installed charts only", what stopped it, and a Retry (field round 2, below).
- **The line** is drawn in the planner's own Phase 2a colours (one shared table,
  `inshoreRouteLineLayers`), with the tide chips. The independent chart review
  still grades every leg; it credits no tide, so water the line shows amber can
  read as danger there. A hand edit drops the router's colours and blocks save.
- **Saving** is unchanged: review, acknowledge, planned-only. Needs-tide and
  danger legs still deny save until the Phase 4 review rework. New evidence
  carries origin `thalassa-inshore`; the cloud constraint accepts it only after
  migration `20261001120000_saved_proposal_evidence_thalassa_origin.sql` is
  pushed. Until then saves stay on the device ("sync pending a server update").
  Older `sevencs-trial` rows still read.
- **Plan My Day** routes each leg the same way. Catalogue trips with required
  checkpoints are excluded per stop ("needs checkpoints Auto cannot follow
  yet"); the rest of the plan still runs.

### Review fix-ups — 2026-10-01, later the same day

A safety and an integrity review of the swap found holes that the new surfaces
(Auto, Plan My Day) showed and could save. Fixed, each with a synthetic test:

- **Who gets Auto, corrected.** "Pro" is every account while the public beta is
  on (`PUBLIC_BETA_ACCESS.enabled` makes `isPro` true), so Auto reaches every
  signed-in account with installed charts. Plan Your Day had no Pro gate at all;
  it now has the same one (`DayPlannerEntry isPro`). To hold both to Shane's
  account until he says otherwise, a one-line `scope.userId` allowlist in
  `getThalassaAutorouteStatus` does it.
- **Never across charted land.** The engine refuses only a land run over 500 m,
  and its localized relax retry opens land up to 4 km from a far-snapped pin: a
  400 m land wall between two pins came back as a red line straight across it.
  Auto now refuses any charted land a route crosses away from a pin's own edge
  ("The only way Thalassa found crosses charted land near …"). In the engine,
  with tides loaded, a relaxed rescue and a decision-11 "way round" must be a
  way by water; otherwise the strict refusal stands, naming the water no tide
  clears (owner decision 11).
- **No route by water.** A route whose far end the engine does not explain (a
  pin on land, on a drying bank, in water no tide clears, an inland pin) ends
  more than 500 m from it: Auto says so and draws nothing. It used to show a
  saveable route that ended 11.6 km short, across a wall.
- **Red with no charted depth** (land, water no chart vouches for, a charted
  hazard's buffer) is never saved and never planned by Plan Your Day; inside a
  relax zone with tides loaded, Auto refuses it.
- **Satellite check unavailable** the route is shown with its caveat and is not
  saved until the check has run (Review's Retry since field round 2, below).
- **Notices to Mariners**: the route notes now say what the passage planner
  says — a current notice the routing follows, and standing notices within
  500 m of the line.
- **Reef-edge marks.** A solo lateral's inferred keep-out keeps its reach to the
  shore again; within a cable of the mark it opens only a charted dredged
  channel or fairway deep enough, and beyond a cable it leaves to the chart the
  water an S-57 depth area charts and that never dries. Water no S-57 band
  charts, drying and land stay closed to its full reach. Measured on the real
  cells: Newport → Rivergate 23.97 NM, the bay → Lytton Reach 13.62 NM and
  Newport → Tangalooma 23.35 NM, with and without a 2.5 m tide top, none on
  charted land.
- **The lead shadow** reads the lead graph only if the chart overlay has already
  compiled it; it never reads a chart or awaits inside a route.

### Field round 2 — 2026-10-02 (Shane's 18.3 NM route, Whitsundays)

- **"Satellite check not run (offline)" while online.** Measured: the check
  asked the `gebco-depth` edge for its ~85 samples point by point; the edge asks
  NOAA ERDDAP ten points at a time, and 86 points took 12.98 s at the edge
  (13.45 s end to end) against a 10 s deadline — every route over ~9 NM timed
  out, and the timeout was worded "offline". The check now asks the same edge's
  bbox mode for the route's box in ONE request (1.13 s upstream for that route,
  270 nodes) and reads each sample at its nearest whole-arc-minute node — what
  ERDDAP answers for a point (23 of 23 compared). Each attempt has 12 s and one
  retry after 1.5 s for a timeout, a dropped connection or a 5xx; a 401/403 or
  429 is not retried. The words say what happened ("couldn't be done just now:
  …"; "offline" only when the phone says it is). Save stays off (fail closed);
  **Retry satellite check** in Review re-runs the check alone, from the chart
  verdicts the proposal keeps — never the route or the chart review. The planner
  and the voyage form use the same words. The edge's point mode is unchanged.
- **Red with "no issue found".** On the Pi's own cells the red legs cut North
  Molle's south-west corner where the 50 m grid cells are caution because the
  charted 2–5 m shore band covers their centres; the line itself runs over the
  5–10 m and 10–15 m bands, and the engine's exact reading of it found nothing
  shallow, uncharted, disputed or near a hazard. The engine now says why each
  caution segment is caution (`cautionWhy`: shallow, uncharted, charts disagree,
  hazard keep-out, or the grid cell only). Grid-cell-only caution is not drawn
  red (and no longer reads as "no charted depth", which blocked Save with untrue
  words); every red stretch still drawn is named under its leg in Review ("Red
  on the map (40 m): charted 2.0 m — shallower than the 2.9 m this boat needs;
  no tide data here shows a tide that clears it ↗").
- **Route notes.** The Review list is headed with the summary's own words and
  count ("4 route notes · what this route must say"), numbered, and each note
  says where it applies (a pin's leg, or the whole route).
- **Review fix-ups (2026-10-03).** A segment is "the grid cell only" only when
  some cell the line touches is a shallow chart band's caution and nothing else
  made it caution: every cell the line touches is read (corners included), and
  a blocked cell — land or the shore's buffer, a mark's keep-out disc, a
  hazard's buffer, a berth or pontoon, a bridge too low, water no tide clears —
  keeps the red and names it ("touches the keep-out the router keeps round a
  navigation mark …"). A promoted Seaway route's red over a mark's disc in
  10–15 m water had been drawn green and saveable. Retry belongs to its own
  route: an answer that arrives after a new route, an edit or a clear is
  dropped; only a land finding removes the route — any other failure is shown
  beside Retry and Save stays off; Retry is offered only when the proposal kept
  the charts' verdicts (otherwise "Recalculate to run it again."). The words
  give the whole wait ("tried twice, 12 s each"), and a used-up allowance on
  the public key (no session) is "this connection's", not the account's.
- **Review fix-ups 2 (2026-10-03): the grid cell only, measured.** "The grid
  cell only" asked just that the line not enter the shallow band, and such a
  line runs 0–35 m from it by construction: a line 0.5 m off a steep-to reef
  drying 3 m, or along its very edge, went from red to green and saveable. Now
  the line must also keep its distance, measured exactly against the band's own
  edges — 30 m from a band that dries or never clears the keel (the engine's
  rock keep-out), 10 m from one whose deep end does (a 2–5 m band beside 5 m+
  water) — from every such band owning a caution cell within reach, not only
  the cells the line touches. Short of it the segment stays red, Save stays
  off, and Review says so: "passes 5 m from water charted to dry 3.0 m — the
  router keeps 30 m off it". Measured first on the real cells (AU421148, copied
  to scratch and deleted): the North Molle corner keeps 12.3 m+ from its
  2–5 m band, 31.6 m+ from its 0–2 m band and 43 m+ from the reef drying
  3.6 m, so it stays green; the 30 m is not the app's 60 m point-hazard buffer
  (an A\* tuning), which would have turned the corner red again. A Notice to
  Mariners survey's sub-floor cell is never "the grid cell only" (its depth is
  read on a 5 m walk), and a charted hazard AREA (foul ground, an obstruction
  area) now gets the same keep-out a charted rock gets in the route's hazard
  check, measured against its edges instead of a point test every 10 m. On the
  golden corridors two long bay chords that c0309771 drew green pass 3.7 m
  (Rivergate) and 6.2 m (Tangalooma) from a 2 m band and are red again, with
  that reason; no pinned golden value moved.

### Owner decision 12 — trust the detailed chart (2026-10-02, field round 2)

Shane, 2026-10-02: "Trust the detailed chart". His third route crossed Cid
Harbour (between Cid Island and Whitsunday Island). The map drew the harbour
as brown land with 16–35 m soundings inside it, and the leg was red, "Danger
reported · review required", with Save blocked. On the Pi's cells at
148.935° E, 20.255° S, the 1:3,500,000 overview AU130120 paints land, the
1:1,500,000 AU230140 charts 0–30 m, and the 1:90,000 AU421148 charts
10–15 m.

- **The rule.** Wherever a chart of usage band 3 or finer (1:350,000 or finer
  by compilation scale, or a band-3+ cell name) charts a depth area (DEPARE or
  DRGARE) that never dries (DRVAL1 ≥ 0), land paint from overview and general
  cells (bands 1–2) is no dispute. That spot is not decision-1 "charts
  disagree" water. The detailed chart's own depth decides the colour: deep,
  or shallow — red, or needs-tide amber where a tide clears it (decision 10).
  Such a spot keeps decision 1's protection, so neither the coastline strip
  nor the 1-cell land skin can seal a detailed chart's charted channel.
- **Drying bands keep their land (my call, fix-up 2026-10-03, reversing the
  first build).** The first build let a detailed DRYING band count too. Its
  land paint was then ignored, and the drying bank became routable caution
  that the lead land clip read as water. The production-shape Newport →
  Rivergate route rode NAVLNE 2387/2785 across the Brisbane River mouth's
  −2.2 m bank, under the overview's land: 30 m of drying ground crossed
  became 1,116 m. The lead compiler kept 8,121 m of leads over drying bands
  that HEAD clips. All of it was drawn red and Save stayed blocked, but the
  proposals got worse and no golden pinned drying metres. Decision 1 never
  lets a drying band beat land paint, and decision 12 does not either now.
  Cid Harbour (10–15 m) and the Airlie approach (1.8 m) never dry, so they
  are unaffected. Shane can reverse this call.
- **What stays.** Decision 1 between two detailed charts. A detailed chart's
  own land still wins over coarser water, such as an island the overview
  leaves out. Land also stands over a detailed band that dries or charts no
  depth. Land of unknown scale (an OSM breakwater) stays, and decision 1 is
  unchanged where only overview and general cells chart a spot.
- **One rule, everywhere.** `services/enc/scaleShadow.ts` holds it:
  `overviewLandYields`, `DETAILED_CHART_MIN_BAND = 3`, and
  `isDetailedChartRank` over the same fineness rank (`cellFinenessRank`:
  nativeScale / CSCL / usage band). These read it:
    - the grid (navGrid Pass 2 drops the land claim, so no caution,
      `wetConflict` or land skin comes from it), and with it the shallow-run
      sampler, the tide chips, the red reasons and the Auto review's leg
      checker, which all read that grid;
    - the lead land clip (`leadLandClip`: such a lead is on open water at the
      band's depth, not 'needs tide' for land paint);
    - the land audits and the D11 proof's land test (`chartWaterEvidence`
      `landPaintStanding` / `chartLandVerdict`, read by `safetyAudit`
      `hardLandAtPoint` and `auditUnvouchedHardLand`);
    - the satellite check's chart evidence (`backstopVerdict`). Its scale rule
      is the same line: `BACKSTOP_MIN_VOUCH_BAND = DETAILED_CHART_MIN_BAND`.
- **The map now agrees (item (f), 2026-10-03).** Decision 12 first shipped
  with a stop-gap leg note, "overview chart shows land here; detailed chart
  charts water", because the map still drew the overview's brown land over
  Cid Harbour. The chart layer now draws by scale (`scaleShadow`
  `encDrawTier`, one water / land / coastline group per scale tier, coarsest
  first), so the detailed chart's water covers the overview's land wherever
  decision 12 ignores it, and the note and its per-cell grid record are gone.
- **Measured on the real cells** (read-only copies from the Pi, in scratch,
  deleted after; `tests/repro/detailedChartOverviewLandRealCells.local.test.ts`,
  no tide data; "after" is the fix-up's final code):
    - Cid Harbour, straight legs from the northern entrance to an anchorage,
      the south-west arm and out west: before, every leg was a caution, "depth
      data conflicts here — treat as unproven". After, every leg reads clear,
      least 10, 15 and 8 m, with the note above.
    - Cid Harbour, routed in to the anchorage: before, 1.74 NM with a 1,843 m
      red "charts disagree" tail. After, 1.64 NM, nothing red, and the review
      is clear.
    - Cid Harbour, routed out from the anchorage: before, 4.67 NM round the
      north of Cid Island with 1,846 m red. After, 2.08 NM through the
      south-west arm, nothing red, and the review is clear.
    - Coral Sea Marina → Daydream Island: before, 8.07 NM, 3,689 m red, of
      which 3,340 m was "charts disagree" (the marina approach's charted 1.8 m
      under the overview's land). After, 8.00 NM, 16 points, no "charts
      disagree". The approach stays red for its own depth over 2,635 m
      ("charted 1.8 m — needs +1.1 m tide"; amber when a tide clears it,
      decision 10). The first build's line also ran 1,149 m over land the
      router had opened; with the protection kept, it does not. One finding
      is not fixed here: the new line's 5.9 km chord to Daydream clips the
      north-east corner of a charted obstruction area in AU421148 (foul ground
      that covers and uncovers, 208 × 285 m, near 20°14.0′ S, 148°46.2′ E). It
      is drawn red, "within the keep-out of a charted rock, wreck or
      obstruction", and Save stays blocked. Before D12, the overview's land
      paint over the water west of it kept the route farther north. The grid
      blocks a polygon hazard only at the centres of the cells it covers, with
      no keep-out (a point hazard gets `obstructionBufferM`). The router's grid
      blocked none of that segment's cells, and only the exact hazard check
      catches it. That belongs with item (a) (a chord must be at least as safe
      as what it replaces) and a grid keep-out for hazard areas.
    - Newport → Rivergate on the Pi's five Brisbane cells, through the app
      path with the golden capture's OSM overlay (the engine check that never
      finished in the first build): before, 23.96 NM, 44 points, 24.2 km red,
      8,575 m "charts disagree" (7,643 m of it under overview and general
      land) and a 706 m red run down to −2.2 m. After, 23.97 NM, 30 points,
      16.8 km red, 322 m "charts disagree", and no drying run. All 322 m is
      a detailed chart's land: AU428153's (1:90,000) coastline over
      AU5SCR01's (1:22,000) 0 m band in the Newport canal. The Rivergate reach
      rides the OSM overlay's river water (yellow), as it did before. Decision
      1 never applied there, because OSM-vouched water under land paint stays
      navigable. The first build's geometry count still stands: 204 spots of
      AU5BNE01-charted water lie under AU428153's land along that reach. That
      is a fact about the charts, though, not red on any route the router
      draws today.
- **Goldens** (each measured in its own process, re-pinned with "D12"
  reasons):
    - Corridor Rivergate: 23.24 → 23.23 NM, 38 → 34 points, caution 25 → 22,
      "charts disagree" 9,453 → 0 m, land 0 m. Drying ground crossed stays
      30 m and is pinned now. All 9,453 m was the overview and general cells'
      land over never-drying bands of OC-61-351824, 10ENB5 and 10RCS5, with
      no OSM water there. Where AU428153's own land lies over 10ENB5's water
      on this route, that water is OSM-vouched.
    - Corridor Tangalooma: 20.36 → 20.18 NM, 35 → 27 points, caution
      25 → 15. Its 1,906 m destination tail and all 4,302 m of "charts
      disagree" are gone, so the pin is plain deep water and the route ends
      28 m from it. Land 0 m, drying 0 m.
    - Production shape (chart leads + OSM overlay, strict): newport-shane
      24.72 → 24.73 NM, caution 37 → 26, points 52 → 44. Newport → Rivergate
      23.90 → 23.98 NM, caution 35 → 21, points 44 → 32. "Charts disagree"
      goes 15,102 → 0 m and 8,449 → 322 m, drying ground 0 → 0 m and
      30 → 0 m (now pinned ≤ 30 m with no tide data), and land stays 0 m.
    - Chart-only characterisation (no OSM overlay, decision 2's offline
      canal): the strict run used to refuse (hard-land-crossing, 922 m). It
      now returns an engine route, 23.96 NM, over 135 m of the canal's charted
      bank. That is under the engine's 500 m veto, but the route has 210 m of
      charted land away from the pin's edge, and every caller (Auto, the
      passage planner, the day planner, the voyage form) refuses that. Decision
      2 still holds in the app, and Auto still says the harbour water isn't on
      the phone. The pin itself is still no charted pin: AU428153's band-4
      land keeps the canal decision-1 water (pinned directly in
      `chartedEndpointTail`). Permissive: 24.62 → 23.96 NM. Tangalooma
      strict refuses as before (1,250 m). Tangalooma permissive goes
      23.95 → 23.86 NM and ends 28 m off its now deep-water pin.
    - Lead compiler (Moreton, ranked): the same 110 spans and 18,210 m
      clipped. The 'land-paint' review drops from 71 edges to 18, and ten deep
      spans (5–14 m) go from 'needs tide' to 'needs review' (survey ungraded,
      decision 4). None is clear.
    - Seaway corpus: directNM 23.24 → 23.23, 20.36 → 20.18 and 17.85 → 22.75.
      Every shadow outcome is unchanged. The first build had turned the marks
      row into a degenerate 'graph' row (entry = exit node, 1 of 5 gates),
      which was not a success.
    - `threeTierNewport` (chart-only newport-shane): kinks near gates 2 → 4.
      The route used to leave the canal due east over 2.2 km of charted land.
      It now runs north through the entrance channel, and the tier-2 grid
      search steps 71 m sideways and back at marks 3, 4, 5 and 7. That is a
      50 m-grid artefact for item (a), and the production shape has 1 such
      kink.
    - `noTideFixtureOffsets`: at five nudged alignments the Newport canal
      entrance is cut off from the bay. It was before as well: HEAD's "routes"
      there crossed 857–875 m of unvouched charted land, which the file never
      checked, and the strict policy refuses such a route (measured at
      Tangalooma k = 7 and 10 and Rivergate k = 10). With the tide ceilings those
      alignments now refuse with 'no-tide-clears' (the bridge runs across the
      canal mouth's drying flats). Tangalooma k = 7 routes with no land at
      all. Routed alignments now pin land too.
- **Left for the next stages.** Item (a): the Airlie reef-corner chord, a
  grid keep-out for hazard areas, and the tier-2 stepping at the Newport
  gates. Item (f): the scale-ordered chart display, which should ship in the
  same push as this. Also left: the Newport canal entrance that some grid
  alignments cut off (this predates decision 12). And when a relaxed rescue
  crosses charted land away from a pin, the engine still prefers it with no
  tide data (`relaxedRescueFault` runs only with tide ceilings). The callers
  refuse that route, but the engine's own refusal would say so sooner.

### Field round 2, part 3 (stage A) — hazard areas and shallow pins (2026-10-03)

- **A charted hazard area gets a keep-out in the grid.** A point hazard
  (OBSTRN, WRECKS, UWTROC) closed every cell its `obstructionBufferM` disc
  touches; an area hazard closed only the cells whose centre lies inside it.
  Pass 6's land skin is skipped beside deep water, so in open water nothing
  kept a chord off foul ground. A charted (S-57) area now closes every cell
  whose square comes within the buffer of one of its rings, holes included.
  That is measured exactly, the same rule as `hazardBufferSegments`
  (`navGrid` Pass 3). Router furniture with no S-57 identity keeps its own
  footprint, as the final audit reads it: mark discs, clearance bars, and OSM
  reefs and aeroways. MultiPoint hazards now block too, as the audit already
  read them. `tests/engine/hazardAreaKeepOut.test.ts`. After review (fix-up,
  same day):
    - An area the chart sounds deep enough for the keel (VALSOU ≥ draft +
      UKC) gets no ring, only its own cells, because the audit exempts it.
      Its 60 m ring had closed seven cells of the Brisbane River's dredged
      fairway round 21 × 46 m of foul ground charted 5.4 m (CATOBS 7), and a
      leg 40 m from it read "crosses a charted hazard" while the line said
      clear.
    - The ring follows the cell size. Whole squares while a cell is no wider
      than twice the keep-out (the app's 50 m grid at 60 m, the 10 m marina
      pass, the tracer). Cell centres within the buffer up to four times it
      (a big route's coarsened grid). None beyond that: the 400 m strict
      pre-check closed 500–700 m passages between two foul areas and refused
      the route at once as 'uncharted-corridor'.
    - A line that keeps every charted hazard's buffer (the exact audit) but
      clips the corner of a keep-out cell is the grid's alone (GRID_ONLY, or
      NEAR_SHALLOW beside a shallow band), not "a charted hazard". On the Pi's
      cells a 981 m chord to Shute Harbour clipped a cell 113.7 m from the
      nearest hazard, in 15 m water, and Auto refused to save it. Cells that
      router furniture closes (an OSM reef) stay a hazard: the audit never
      reads them (`NavGrid.furnitureHazardBlocked`).
    - Pi cells (read-only copies, deleted after), Coral Sea Marina → Daydream
      through the app path: before, 8.00 NM, 8,563 m red, with the 5.9 km
      chord through the NE corner of the foul area (0.0 m from it, "within
      the keep-out of a charted rock, wreck or obstruction"). After, 8.17 NM,
      2,635 m red, which is only the marina approach's own charted 1.8 m, and
      no hazard red. Cid Harbour in and out and Shane's 18.3 NM field route
      are unchanged.
    - Corridor goldens: identical, though they carry 30–62 charted
      obstruction areas each.
    - Cost: a line round a small area in open water can come out longer.
      The synthetic corner case goes from 3.30 to 3.46–3.50 NM, because the
      grid's octilinear path is not pulled straight round the keep-out. That
      is item (a)'s any-angle string pulling.
- **A shallow start or end pin goes direct, amber.** Shane, 2026-10-03: "A
  start pin in very shallow water sends the route out to deep water and
  back, instead of going direct with an amber warning. - fix that." A pin in
  charted water shallower than draft + UKC that a tide can clear (decision 7)
  had a tail that walked the grid cell by cell to the cheapest deep-enough
  water. Where the route did not come back past the pin, that deep water
  could lie behind it: two pins in one shallow bay went out and back
  (7.5 km for a 1.1 km hop, synthetic). Elsewhere the tail was the grid's
  8-connected staircase. Now (`services/engine/directTail.ts`) the tail is
  one straight line from the pin to the point on the route that makes the
  route shortest, or straight to the other pin when both are shallow. The
  line:
    - is never longer than the charted way it replaces plus two cells (plus
      the other pin's tail, shallow to shallow). It can't become a long
      shortcut across shallows the router chose to go round.
    - passes the grid (every cell is the pin's charted water or deep
      enough), the chart itself (`tailFault`: no land, drying band, water no
      chart covers or no tide clears, or low structure) and every charted
      hazard's keep-out.
    - leaves the pin's shallow water once, so it is never a shortcut
      through other shallows.
    - never skips a gate anchor, a canal leg or an offshore leg.
    - is amber, "needs tide", from the pin to where it first reaches deep
      water; the rest is ordinary route. Where no straight line passes, the
      charted way stays and the route notes say why ("…a straight line would
      cross charted land"; `RouteResult.pinTail`, `debug.directTailRefused`).
      Auto's leg review names the pin's water on the first and last legs:
      "starts in 1.2 m charted water — needs +1.7 m tide" (`validateTraceLeg`
      `pinStart` / `pinEnd`). Without tide data a tail stays red, as decision
      10 says. `tests/engine/shallowPinDirect.test.ts`.
    - Newport fixture (chart cells + OSM), the north-exit pin: departing for
      Newport marina, 2.04 → 2.03 NM; for Pinkenba, 21.91 → 21.83 NM. The
      tail is one straight segment instead of a 6–8 vertex staircase. The
      no-out-and-back cut stays, and runs first.
    - Corridor goldens: identical. Newport-shane and the marks corridor's
      decision-1 destination tails keep their charted way ("water outside
      its charted shallows"). Those pins chart deep water under coarse land
      paint, so no route note.
    - After review (fix-up, same day): the line is never shallower than the
      way it replaces. Its shallowest charted depth (the finest survey, on
      the tail check's 5 m walk) must be no less than the shallowest the
      route charts between the pin and the line's end. Candidates are still
      tried shortest first. The charted tail takes the deeper way out, and a
      line ranked by length alone cut across the flats: a pin in a 2 m
      gutter through 0 m flats went 1,460 m over the flats, needing +2.9 m of
      tide where the gutter needs +0.9 m, while the route still said "2.0 m,
      +0.9 m, direct". It now keeps the gutter and says why ("…a straight
      line would cross shallower water than its charted way (0.0 m charted,
      against 2.0 m)").
    - `pinTail.needsM` is the tail's own: worked from the shallowest water
      along it, with `leastM` when that lies off the pin and is shallower.
    - Shallow to shallow across a deep strip the line reads on one sample
      only: the whole line is the pins' water (caution, with the destination
      tail). The rest of it used to be marked deep: 1.2 km of charted 1.2 m.
    - The route note now reaches the voyage form and a saved plan
      (`inshoreRouteToGeoJSON` keeps `pinTail`; `savedInshoreRouteCaveats`
      rebuilds it). Alone, the notice is titled "Shallow pin".

### Field round 2, part 3 (stage B) — any-angle string pulling (2026-10-03)

Round 2's item (a): on Shane's 18.3 NM route, legs 4→5 ran due east
(~200 m) and 5→6 south-east (~140 m) where the straight 4→6 (~317 m) crosses
15–20 m water — a 50 m, 8-connected grid artefact.

- **Why nothing pulled it straight.** Measured on the Pi's cells (read-only
  copies, deleted after): the route Auto shipped there was the promoted
  Seaway Graph route, not the engine's (whose own route was one straight
  17.33 NM line). A Seaway connector leg is the A\* cell chain itself: the
  route was 498 points, each a cell centre 50 m east or 70.7 m south-east,
  and no smoother ever saw it. On the engine's own path the smoothers are
  cost-gated (`smoothPath`: a chord may cost no more than the cells it
  replaces, so the centring term keeps a stagger) or collinear-only (the
  scaffold collapse's 2.5 m, the grid Douglas-Peucker's quarter cell), so
  the tier-2 grid search's 71 m sideways step at Newport's entrance marks
  survived all three.
- **The rule** (`services/engine/stringPull.ts`). A run of segments becomes
  the straight chord between two of its vertices when the chord is at least
  as safe as the run, by the finished route's own exact checks. Equal or
  better is enough.
    - Every state that colours a whole segment — a caution cell, a charted
      hazard's buffer, charted-shallow or uncharted water, decision-1 water,
      an amber survey, too near a shallow band, a low structure, a closed
      cell, hard land, water no tide clears — the chord may carry only if
      every segment it replaces carries it. No red, amber or dashed stretch
      spreads onto water that was green.
    - Every exposure is no longer on the chord than on the run, and none is
      new: those states and their reasons (a wing, relaxed land, an NtM
      survey cell, no-evidence water), water off the preferred fairway, and
      cells beside land.
    - Its shallowest charted depth is no shallower than the run's, at any
      depth: a chord never trades the A\*'s deeper water for a shorter line
      over shallower ground. Band by band, it keeps from every shallow band
      at least that band's clearance (the GRID_ONLY rule, 30 m from a band
      that dries, charts no depth or never clears the keel, 10 m from one
      whose deep end does), or the closest the run came to that same band
      where the run was nearer. It reads the bands two cell diagonals out,
      where GRID_ONLY reads half of one: a 60 m drying reef whose only cell
      centre lay 66 m off a chord passing 19 m from its edge went
      unmeasured. Its survey error is no larger, and it comes no nearer a
      channel's bank than the run did (the grid's centring field), so a
      chord never cuts a bend toward the bank.
    - No charted mark lies between the run and the chord: it passes every
      mark on the side the run does, whichever way the marks pair. It passes
      each mark no closer than the run did, or than 25 m where the run was
      further. On the chart-only Newport capture a chord passed port beacon
      2 at 1 m where the stair kept 24 m.
    - Where it is not clean, it stays within a cell's diagonal of the
      vertices it replaces. A 3.2 km chord across Newport's charted-shallow
      entrance, off its marks, totalled less exposure than the stair up the
      marks; the same amount elsewhere is not the same water.
    - Kept: the route's ends, gate anchors, vertices on a charted lead
      (NAVLNE CATNAV 3 or RECTRC), seams between kinds, the canal
      centre-line and a marked channel's follower (the engine), and a graph
      edge and every leg end (the Seaway route). The charted tails come
      after, as before.
- **Gates threaded at their centres** (`threadGateCentres`). A lateral gate
  (a port and a starboard mark, each the other's nearest) that the route
  crosses more than 10% of its width (or 5 m) off its centre is threaded
  through the centre, by the same rule: the new path at least as safe, no
  mark between, no other mark passed closer, each gate's nearer mark further
  off. A line from one centre that crosses the next gate off centre takes
  that centre too, since centring 5/6 alone brought the line closer to mark
  4 of the next gate.
- **Measured.**
    - Shane's field route on the Pi's cells: 498 → 6 points, 18.22 → 18.00
      NM, every segment green, 0 m of land. The stair at legs 4→5→6 is gone.
    - Newport-shane (chart-only capture): kinks near the marks 4 → 2 (the
      bound is restored). The entrance passes mark 5 at 27.1 m (was 12.2 m),
      mark 4 at 23.7 m (was 6.0 m), and no entrance mark closer than 23 m.
      The two kinks left are the channel's own: the turn north between
      mark 7 and the unnumbered starboard sector-light beacon, and the bend
      at the 5/6 centre.
    - Corridor goldens, red never longer: Rivergate 23.23 → 23.22 NM;
      Tangalooma 20.18 → 20.16 NM, caution 15 → 13; newport-shane red
      11,517 → 11,487 m; the marks corridor 8,875 → 8,861 m; Moreton tier-2
      17.92 → 17.88 NM. Pi cells: Shute out → jetty 40 → 20 points, Airlie →
      Shute 30 → 22, red unchanged; the others identical.
    - Stage A's synthetic corner case round a foul area (straight line 3.26
      NM): 3.50 → 3.40 NM at a 30 m buffer, 3.46 → 3.35 NM at 60 m.
    - Cost: about 0.2 s on an 18 NM route on the Mac. `hardLandAtPoint` now
      answers from each ring's edge index and a bucket grid, with identical
      answers: tested every 10 m beside a mainland coast, it had cost a
      route a second.
- `tests/engine/anyAngleStringPull.test.ts`. It fails first on ea300aa8:
  the synthetic Seaway connector was 27 points with its corner 226 m off
  its chord, and is now 2.
- **Review fix-up (stage B, 2026-10-03).**
    - _Shallow bands weighed one by one._ The review found the clearance
      compared as one number, the worst shortfall over all bands. A chord
      shares the run's first vertex, so it inherits that vertex's shortfall.
      A stair 3 m off a 2–5 m flat (10 m asked, 7 m short on every segment)
      licensed a chord 24 m from a reef drying 1 m (30 m asked), which the
      stair kept 58 m off. Neither line touched a caution cell, so both drew
      green. `nearShallowBand` now returns every band inside its clearance
      (`within`). The chord must keep from each band at least that band's
      clearance, or the closest the run came to the same band. A synthetic
      test pins the case; it failed first (chord 25.6 m off the reef). The
      corridor goldens and Shane's field route on the Pi's cells (18.00 NM,
      6 points, every segment green) are unchanged.
    - _Two maxima stay single numbers, on purpose._ The survey error margin
      and the centring field are still compared as maxima over the line, so
      a chord sharing a vertex inherits its value. The survey margin only
      caps the number a leg note discloses. Whether a survey's error eats
      the keel's margin is read piece by piece as survey-margin metres,
      which a chord may not gain. The centring field is the grid's
      mid-channel preference, not a clearance. A chord is kept off a bank by
      the per-band clearance, by cells beside land (no longer than the
      run's), by hard land, and by the one-diagonal corridor for any chord
      that is not clean.
    - _A drawn chord's red is read exactly._ A chord the pull or the gate
      threading draws was coloured by the 25 m sampler alone, so one
      clipping a caution cell for less than a step drew green. The engine
      now adds the exact cell walk the pull weighed it by. The Seaway route
      does the same for its pulled chords, by the sampler's own rule (a
      closed cell or a caution cell). No golden's caution count moved:
      measured with the exact read and without it, identical.
    - _A Seaway connector is not a lead follower._ The engine keeps every
      vertex within 3 m of a charted lead, because there the route rides the
      lead. A Seaway connector's cell chain only crosses near a lead, cell
      centre by cell centre. Pinning those cells would keep the stair, so
      only its leg ends and graph edges are kept (DECIDED 2026-10-03). The
      review's probe of five goldens: the pulls removed 865 vertices within
      150 m of a lead, but no chord ran further from the lead than its run
      at its furthest (85 → 52 m, 357 → 204 m, 77 → 13 m, 479 → 480 m). The
      mean distance rose on three stretches (42 → 57 m, 20 → 38 m,
      30 → 35 m). Off-preferred water is an exposure a chord may not
      lengthen, which keeps it in the lead's preferred corridor.
    - _The Seaway pull's reader is built once per comparison_, on the first
      round that composes a route. It was rebuilt every re-solve round. A
      round only grows the blocked set, which the reader reads at each call.
      Each round still pulls its own cell chain. Pulling only a round that
      can be returned would change which violations the re-solve blocks, so
      it is left for a later pass.
    - _Bundle._ Stage A and stage B together took the JS 3,222 B past the
      10.2 MiB budget. Stage B was trimmed by 2.6 KB first: shared
      local-plane helpers through `segmentDistanceM` (the same arithmetic),
      one mark walker, and plain constants for the exposure tables. That
      left it 643 B over (10,696,118 B), so the budget moved to 10.25 MiB,
      with its reason dated in `scripts/check-bundle-size.js`.

### The real-chart check — a shallow band's clearance everywhere, cardinals, the canal's reason (2026-10-03)

The saved test routes (the three Brisbane goldens and Shane's three
Whitsunday field routes) were run through the app path on the Pi's own cells,
copied read-only to scratch and deleted after. Four findings are fixed here;
the fifth (B, the Hamilton reach's lateral chain) follows, below.

- **A — a segment inside a shallow band's clearance was drawn green.** The
  clearance rule (`nearShallowBand`: 30 m from a band that dries, charts no
  depth or never clears the keel, 10 m from one whose deep end does) only ran
  on a caution segment the grid's cells alone made caution. A segment whose
  50 m cells read clean was never measured, on an engine route or a promoted
  Seaway route: the Cid Harbour route passed 4.3 m from South Molle's reef
  drying 3.6 m, Coral Sea Marina → Daydream 24.6 m from Daydream's, and
  others 1.1–8.8 m from 2 m bands, all green.
    - _Every segment is measured_ (`collectShallowRuns`, so the engine route
      and the promoted route alike), and only the STRETCH inside the
      clearance is drawn, exactly (`leadLandClip segmentAreaNearIntervals`:
      the line's chord through each ring edge's capsule). It is a
      `chartedShallowSpans` entry with `near` (the band, how close, the
      clearance asked): red, or needs-tide amber where a tide clears the
      band itself (decision 10, the band's DRVAL1 the depth to lift). A
      cells-only caution segment near a band is GRID_ONLY now, with its close
      stretch drawn: the Rivergate golden's 11.3 km bay chord, red end to end
      for one caution cell 3.7 m from a 2 m band (F1), has no red left on it.
    - _Never amber_ over decision-1 water or water no band charts, beside a
      band whose own water the charts dispute, nor for a band that charts no
      depth (it reads 0 m, the grid's own reading of a missing depth). Not
      measured on a segment red whatever the tide, on the canal, or on a
      charted pin's tail (the pin's own water). On a caution segment a tide
      lifts, only a band that DRIES counts (DECIDED: the line is already in
      water that needs a tide, beside more of it; a 0–2 m band's 0 m end
      would have turned 527 m of Newport's marked exit, 6.6 m off it in its
      2 m channel, from amber to red at a 2.5 m tide). Where the line enters a
      band, its approach inside the clearance is drawn with the crossing.
    - _A `near` stretch blocks Save and Plan My Day_, red or amber: the
      water under the line is deep, so the leg review sees no tide
      dependency. The route notes say "passes 5 m from water charted to dry
      3.0 m — the router keeps 30 m off it".
    - _The grid prices a ring round each shallow band_
      (`applyShallowClearanceRing`, once per cached grid, on the engine's
      grid the Seaway shadow reads too). A navigable cell whose centre lies
      within √(clearance² + half a diagonal²) of a band — 46 m for 30 m, 37 m
      for 10 m on the 50 m grid, so no step between two cells off the ring
      passes inside the clearance — costs 3× (a band that dries or never
      clears the keel) or 1.5× (a 2–5 m band). A cost, never a block, folded
      into `centreFactor` like the shore skin, so A\*, the smoother and the
      string pull's "no nearer a bank" read it; the Seaway connectors'
      search reads `shallowRing`. Not where the marks own the line
      (preferred water, a paired mark's disc) nor in a relax corridor.
      DECIDED: a multiplier, not the 40× caution price — a fully ringed reach
      would cost like crossing caution and a deep cell beside a reef would
      price above a shallow one. By cell centres alone (the first cut), a
      diagonal step passed 24.7 m off Daydream's reef between two cells 30 m+
      from it.
- **C — a cardinal's side read from one offset.** The leg review judged the
  wrong side of a cardinal by the closest point's offset along the safe
  direction alone, so a leg ending 338 m SOUTH of an east cardinal, 24 m west
  of its meridian, was "the wrong side" (Rivergate leg 23, newport-shane leg
  27), and "give it 90 m" fired 390 m off. Wrong side is now the hazard
  quadrant only (within ±45° of the danger's direction); the shave note reads
  the distance.
- **D — the canal's red named no reason.** `CAUTION_WHY.CANAL` on a canal
  segment that carries no other reason (28 m at the start of Rivergate and
  Tangalooma, 42 m on newport-shane).
- **Measured** on the Pi's cells (before → after, no tide data):
    - Cid Harbour (route 3): 4.3 → 49.7 m from the nearest drying band, 14.53
      → 14.50 NM, 10 → 7 points, all green. Route 2 (Armit → Molles): 18.00
      NM, all green, 52.5 → 58.4 m. Coral Sea Marina → Daydream: 24.5 →
      35.1 m from the nearest drying band, 8.17 NM; 19 m drawn red at the
      marina exit, 4.7 m off a 2 m band.
    - Brisbane: Rivergate 23.97 → 23.98 NM, red 7,272 → 7,310 m; Tangalooma
      23.34 → 23.33 NM, red 6,883 → 6,909 m; newport-shane 24.59 NM, red
      9,080 → 9,170 m (each 237–301 m inside a clearance: the Newport exit
      14.7–24.4 m off a drying bank, and 1–90 m of the bay or the river 1.1–
      27 m off a band). At a 2.5 m tide red +120–137 m. The cardinal notes are
      gone; every red has a reason.
    - Corridor goldens: Rivergate red 19,819 → 8,598 m drawn (23.22 → 23.21
      NM), Tangalooma 14,119 → 6,712 m (20.16 → 19.97 NM: A\* takes another
      line across the bay), newport-shane and the marks corridor +10 m.
    - Cost: the ring takes 0.14–0.33 s per grid on the Mac (the owners of
      the shallow cells beside each candidate, read once each).
- `tests/engine/clearanceStretch.test.ts`, the cardinal cases in
  `tests/routeTracer.test.ts`, the CANAL check in
  `tests/inshoreRouter.seawayPromotion.test.ts` and the near-span case in
  `tests/dayPlannerEngine.test.ts` fail first on 7f48fe15.

#### Its fix-up review (2026-10-03)

- **The marks own the line: no clearance stretch in channel water.** The ring
  skips preferred water, a paired mark's disc and a relax corridor
  (`shallowRingExempt`), so the router cannot be steered off a bank there —
  yet the clearance pass drew such a channel red and refused Save and Plan My
  Day: a 50 m dredged channel between banks drying 1.5 m, 1 km of it red,
  where 7f48fe15 drew it as channel and let it past. A clearance stretch is
  now cut at every cell edge the line crosses and not drawn where the cell is
  exempt. DECIDED: no stretch at all there, not a caveat — the chart's
  channel and its marks are the authority, and a gate on channel water would
  be a new hard gate without Shane. Not on a cells-only caution segment
  7f230264 already reddened for its clearance: that red and its refusal stand.
  The river-only Newport → Rivergate route (2.45 NM) is back to 1,604 m red
  with no clearance stretch (the first cut: 1,682 m, 5 stretches, Save
  refused).
- **A band that holds no cell centre is measured and ringed.** Bands were found
  only through the 50 m cells whose centres they own, so a 34 m patch drying
  2 m between four centres, or a 30 m strip (drying, or 0–2 m) between two
  rows of them, 10 m off a line was drawn green and saved, and never priced.
  The clearance pass now also takes every shallow band within its clearance
  whose own survey owns the water at its nearest edge (leadLandClip's
  `areaEdgeNearest`: 0.1 m inside it) or under the line, with no Notice to
  Mariners survey stamped there; and the ring is seeded from every cell a
  shallow band's edge passes through, where its survey owns the water just
  inside that edge (at once for a band no finer survey overlaps). On the
  goldens this found 114 m of the needs-tide Newport exit 6–20 m off a bank
  drying 2 m (red whatever the tide; that route's Save and Plan My Day were
  already refused for the tide it needs). No golden route moved.
- **Cardinals: the danger's whole half close in.** The quadrant rule alone
  turned a pass 30 m SSW of an east cardinal from danger into a caution Save
  does not stop for. Under 90 m the danger's half is the wrong side; beyond,
  the hazard quadrant (a centimetre's grace on either line). The 338 m
  Rivergate case stays clear.
- **The saved plan says it.** A voyage-form plan kept no clearance stretch
  (routeGeoJSON carried none) and was saved without a word. The route's
  caveats now say "This route passes 4 m from water charted to dry 3.6 m —
  closer than the 30 m the router keeps off it", and `routeGeoJSON` carries
  `nearShallow` so a saved plan says it again.
- **The grid cache counts the ring** (w × h bytes reserved at admission).
- **Measured on the Pi's cells** (copied read-only, sha256-checked, deleted
  after; before = the real-chart check's build): every route's line is the
  same. The Newport exit's stretches beside the drying bank (120 + 92 m on
  Rivergate, 120 + 60 + 31 m on Tangalooma and newport-shane) lie where the
  marks own the line and are gone, with the river channel's 90 m on
  newport-shane and Tangalooma's 16 m. At a 2.5 m tide Rivergate draws
  120 m less red (120 m more needs-tide amber), Tangalooma 137 m less (120 m
  more amber, 17 m more channel), newport-shane 120 m less (30 m more amber,
  90 m more channel). Left: Rivergate's 1 m (8.8 m off a 2 m band, open
  water) and its 37 m on a cells-only caution segment 7f230264 already
  reddened; Tangalooma's 10 m (1.1 m off a 2 m band); Coral Sea Marina's
  19 m (4.7 m off a 2 m band). The Whitsunday routes are
  unchanged (Cid Harbour 49.7 m, Armit → Molles 58.4 m and Daydream 35.1 m
  from the nearest drying band). No new cardinal note; Auto's warnings gain
  the caveat line.
- **Cost** on the Mac: the ring 0.08–0.65 s per route on the Pi's cells
  (the build: 0.04–0.47 s) — owners first, then the edge seeds, their
  ownership asked 0.1 m inside the seeding edge against the finer bands
  only (through areaEdgeNearest and every band over the spot, one
  Whitsunday grid's 12,000 asks took 0.36 s). Route times unchanged within
  noise (1.3–7.4 s).

#### Finding B — the Hamilton reach's lateral chain (2026-10-03)

With the SE-QLD marker file loaded (the normal online case) the Brisbane
River's Hamilton reach bend left the 9.1 m dredged channel and crossed ~250 m
of 2 m water 87 m NW of the chart's green beacon at ***REMOVED***
(Rivergate leg 26 red SHALLOW|WING 424 m; newport-shane leg 30, 2,418 m).
Without the file it stayed in the channel.

- **Why.** The last tier-2 leg runs from the bay to the destination. With the
  file, a two-gate regional chain at the river mouth (-27.400) snapped onto
  it (`tier2:chain×1`), and a chain claims the WHOLE leg: no RECTRC snap,
  fairlead, gate-follower or RECTRC ride runs after it. The bend, 2 km on,
  kept the raw A\* slice. Without the file there are no pairs at all (the
  fetch failing drops the chart's pairs too) and the RECTRC shaped the leg
  (`tier2:rectrc×1`). The bend's green is the chart's alone; it pairs with
  the chart's red 6F 210 m off into a one-gate cluster 2.1 km from the
  nearest regional chain end, so no chain carried it.
- **The fix (`routeTier4` 3a/3c).** Where a chain shaped a leg and a RECTRC
  is charted, the leg is also built riding the RECTRC where the chain did not
  reach (the chain's own vertices fixed; each RECTRC kept only where its
  stretch carries no more water no tide clears, red or WING), and without the
  chains at all. The RECTRC's 2-point pieces are joined where they meet
  (≤ 10 m, ≤ 60°), so a ride follows the river round successive bends. The
  candidates are weighed by `tier2RedLoad`, sampled every 5 m: the least
  water no tide clears wins first, then the least red, then the least WING.
  Red is grid CAUTION or blocked cells, charted depth below draft + safety
  (cut at the band edges, which a 50 m cell misses) and, under the strict
  uncharted policy production runs, uncharted water — what the engine draws
  red, plus the keep-outs it will not pass. Red and WING within one grid
  cell's diagonal (at least 25 m) are a tie, and a tie keeps the chain's
  leg.
- **Lone gates, merged.** An accepted pair no chain carries (no chain end
  within 800 m, not in the synthesised chain) is a lone gate
  (`channelChainsFromMidpoints`). A chain-snapped leg that passes one within
  its half-width + 150 m, outside its middle half, threads its midpoint —
  only where the leg then crosses the line between its two marks, no turn
  over 90° at the midpoint and none past the de-spike limit (120°) at its
  neighbours, off land, and only where that carries no more water no tide
  clears, red or WING. Merged into the chain's line, never replacing it. A
  pair of one regional and one chart mark is never a lone gate.
- DECIDED: red first, then WING — WING cells are CAUTION, so a leg with
  less WING but more red has more water out of the channel overall.
- DECIDED: not on the canal egress span — that chain is the engine's
  explicit contract (the Gluer's double-back allowance rides on it).
- DECIDED: the 'chain+rectrc' leg wins only when it beats the chain alone;
  a tie keeps the chain's leg exactly (no golden moved on a tie).
- DECIDED: a chain that "claims" a leg without moving a vertex (its gates
  already on the A\* slice) shaped nothing, so only the RECTRC-only leg is
  weighed against it.
- **Review fix-up (2026-10-03).**
    - DECIDED: water no tide clears (`grid.noTideClears`) is weighed before
      red, so no leg wins by crossing more of it: the engine clips or refuses
      a route there, where a chain over 2 m water passes at high tide. A
      hazard's keep-out (an obstruction's buffer, a mark's avoidance disc)
      stays red, not first: the RECTRC is snapped with land as its only veto,
      as a charted track is never vetoed by the hazard it guides past. Tried
      the other way on the real cells, weighing every non-land blocked cell
      first put the bend back over 2 m water (Rivergate 463 m SHALLOW|WING):
      on the reach below the bend (-27.4105,153.1484) the RECTRC crosses a
      mark's avoidance disc and an obstruction's buffer, 110 m of blocked
      cells, so its ride was refused.
    - DECIDED: uncharted water counts as red under the strict policy (the
      engine's `isUnvouchedIdx`, passed through `applyThreeTier`). Before,
      a RECTRC leg over any amount of it beat a chain with 5 m of CAUTION.
    - DECIDED: the 3c tie is one grid cell's diagonal (a line on any heading
      crosses at most that much of one cell), at least 25 m, so one cell's
      defect on the chain's line can't swap the whole leg, and the
      gate-centring on every gate, for a RECTRC offset to the deep side. The
      splice checks (a RECTRC stretch, a lone gate) keep 1 m: they must add
      nothing.
    - DECIDED: a lone gate is threaded only where the leg crosses its
      port↔starboard line (a and b on opposite sides of it, from the
      midpoint's new `_axisDeg`): reaching a side channel's entrance gate and
      back is not passing through it. A threshold on the leg's heading
      (|cos| ≤ 0.5, 60° or more) would have dropped the Hamilton bend's own
      gate: the line between its marks meets the reach above it at 49°.
    - DECIDED: a pair of one regional and one chart mark (`_mixedSource`) is
      never a lone gate: where the two disagree on a buoy's colour, its two
      copies 25–600 m apart pair into a phantom gate on one physical buoy. No
      such phantom exists in the SE-QLD file plus the Brisbane cells; the
      Hamilton bend's gate is both chart marks.
- **Measured on the Pi's cells** (copied read-only, sha256-checked, deleted
  after; SE-QLD marker file loaded; before = 61e36ccb):
    - Rivergate 23.98 → 24.02 NM, 18 → 16 caution segments, red 7,272 →
      6,848 m: the bend's 424 m SHALLOW|WING is gone. The leg leaves the
      green to starboard (80 m) and the red 6F to port (78 m) — through the
      gate — where it left the green to port 87 m off. The leg is
      `tier2:chain×1+rectrc×3`: the chain at the river mouth, the RECTRC from
      there (red 511 → 184 m by `tier2RedLoad`; the RECTRC alone 990 m, as it
      chords past the east cardinal's disc at the mouth).
    - newport-shane 24.59 → 24.69 NM, 20 → 18 caution segments, red 9,080 →
      6,662 m: the 2,418 m SHALLOW from the bend is gone, and the red beacon
      at ***REMOVED*** is passed 74 m off, not 5 m.
    - At a 2.5 m tide the same (amber 3,756 → 3,295 m on Rivergate, 5,759 →
      3,341 m on newport-shane). Unchanged: Tangalooma (with the marker
      file), Rivergate and newport-shane without it (no pairs at all, so no
      chain), and the three Whitsunday routes (their legs are never
      chain-snapped). Route times unchanged within noise.
    - After the review fix-up, re-run on the same cells: Rivergate and
      newport-shane (tide unknown and 2.5 m) and Tangalooma, routes,
      colours and Auto's review byte-identical to the measurements above.
    - The corridor goldens are unchanged, but that tests nothing here: their
      fixtures carry no `channel_midpoint` features, so tier-2 has no chain
      and no lone gate there. Finding B is tested by the synthetic file
      below; the only committed suite that feeds regional chains through
      `routeInshore` is `tests/repro/newportPinkenba.repro.test.ts`
      (variants D and G).
- **Not fixed here:** when the marker file's fetch fails (offline),
  `fetchRegionalMarkers` throws before the chart's own laterals are paired,
  so an offline route has no chart gates either — the harness's "no marker
  file" run had no channel chains at all. The chart's pairs should survive
  a failed fetch (pair with `url = null`).
- `tests/tier4/tier2ChainVsRectrc.test.ts` reproduces the bend on synthetic
  geometry (a RECTRC through a dredged bend, a chain that stops short of it)
  and fails on 61e36ccb; its fix-up cases (water no tide clears, a
  keep-out on the RECTRC, uncharted water, one cell on the chain's line, a
  lone gate in a sharp corner or beside the leg, the phantom gate) fail on
  the change before the fix-up, except the keep-out guard.

#### Round-3 fix-up — near stretches, channel edges, tier-2 red (2026-10-03, night)

A review of 61e36ccb and 3e3a3603 (Shane, 2026-10-03: "keep going claude").
Each item is tested first (it fails on 3e3a3603's code):
`tests/engine/nearStretchVerdict.test.ts` (items 1, 2, 3 and 6),
`tests/tier4/tier2ChainVsRectrc.test.ts` (item 4),
`tests/RouteMemoryCeilings.test.ts` (item 5) and
`tests/dayPlannerEngine.test.ts` (item 1 for Plan My Day).

1. **Only a RED near stretch refuses Save and Plan My Day.** 61e36ccb refused
   a route for ANY near stretch, even one beside a 1 m band a tide clears
   (amber under decision 10). `nearSpanBlocks` (engine/types) is the one rule:
   a near stretch refuses when no tide lifts it (a hazard's buffer, water the
   charts dispute or do not chart, a band with no depth) or when the tide
   ceiling the route was planned with proves no tide clears the band (its
   DRVAL1 + the curve's own top < draft + UKC, at both ends and the middle of
   the stretch; collectShallowRuns drops `tideLiftable`). An amber one — a
   tide may clear the band, or no tide was loaded for the place — is saved
   and planned with its note, like other needs-tide water. (Changed the same
   night by the fix-up review below: no tide loaded is red, and Plan My Day
   refuses an amber one as a tide it cannot verify.)
    - DECIDED: "no tide clears it" is read from the route's own tide ceilings
      (owner decision 11's, already loaded before routing), not from the
      chips' curves: Save and Plan My Day see no map. The curve's own top
      (`topM`), not the 0.1 m quantised-up value decision 11's proof uses —
      the lower top refuses more.
    - DECIDED: with no tide loaded for the place, a stretch a tide could lift
      is not refused, as the brief says ("tide unknown and it isn't
      liftable"). The map still draws it red with "no tide data", and the
      route notes say how near it passes. That includes a band that dries
      (a reef drying 3 m beside the line, needing +5.9 m): if Shane wants
      Save to wait for the tide there, it is one line in `nearSpanBlocks`.
      SUPERSEDED by the fix-up review below (`tideUnknown`).
2. **A near stretch in water the marks own is a CHANNEL EDGE.** The ring
   still skips preferred channel water, a mark pair's gate or disc and a relax
   corridor (A\* cannot steer off a bank there), but the stretch is now
   measured and named instead of hidden: `ChartedShallowSpan.channelEdge`,
   drawn amber (`'edge'`, the needs-tide amber with no chip) over the
   channel's yellow, said in the route notes ("In the marked channel this
   route runs close to the edge of the channel's charted shallows: 27 m from
   water charted 0.0 m, inside the 30 m the router keeps off it elsewhere.
   Keep to the middle of the channel.", notice title "Close to the channel
   edge"), never a tide window and never a refusal. Inside a charted
   hazard's buffer (or with no hazard mask to prove otherwise) it is an
   ordinary red near stretch.
    - DECIDED: amber in the needs-tide ink, not a new colour; the keys say
      "Needs tide — the chip says when; no chip: close to a channel’s edge"
      and "Amber · a tide clears it, or a channel edge is close". Survey
      dots and the unverified dashes keep their own patterns.
    - DECIDED: a channel edge is not counted in `cautionNearShallow` and is
      never a red stretch's reason (routeRedReasons skips it).
3. **A band that holds no cell centre is found by its own extent.**
   `nearShallowBand` (GRID_ONLY's rule and the string pull's chord test)
   found a band only through the 50 m cells whose centres it owns, so the
   any-angle string pull chorded 5.5 m past a 10 × 40 m strip drying 1 m
   that the stair it replaced kept 62 m off. It now also measures every
   shallow band whose box meets the line's reach, where its own survey owns
   the water at its nearest edge; the string pull asks it wherever a shallow
   band's box is near, not only a shallow cell. The ring already seeded
   bands from their edges (61e36ccb's fix-up) and is unchanged.
   `areaEdgeNearest` now finds the inside of a band at a corner (0.1 m off
   the point in whichever of eight directions lies in it): a chord's nearest
   point on a thin strip is usually its corner, where a step off one edge's
   normal missed the band on both sides.
4. **Tier-2 red is weighed (3e3a3603's `tier2RedLoad`).** A metre over a
   charted hazard's keep-out (an obstruction's, wreck's or rock's buffer —
   not a mark's avoidance disc, not OSM furniture) weighs
   `TIER2_HAZARD_RED_WEIGHT` = 2 against a metre of charted-shallow water a
   tide may clear; water no tide clears is still weighed first. Under the
   strict policy (production) any water no chart gives a depth for is red,
   wherever the leg runs: no S-57 band under it (cut at the band edges), or,
   where the layers hold no bands, a no-evidence grid cell or a sample off
   the grid. Before, a lateral chain's own discs vouched for that water
   (isUnvouchedCell: a mark's preferred cell is vouched), so a chain over
   water no chart charts tied a charted lead (0 m of red each) and kept the
   leg.
    - DECIDED: weighted, not first. 3e3a3603's fix-up measured every
      keep-out first putting the Hamilton reach bend back over 2 m water
      (the RECTRC there crosses a mark's disc and an obstruction's buffer,
      110 m; its ride carried 184 m of red against the chain's 511 m). At
      2× the ride is at most 294 m and still wins.
5. **The grid cache counts the ring as the grid holds it.** Admission
   reserves w × h for the ring (61e36ccb); after the engine attaches it,
   `recountNavGridCacheEntry` sets the entry to the grid's real bytes (an
   empty ring where no shallow band exists — w × h less) and trims the other
   entries to the 48 MB budget.
6. **A saved voyage-form plan keeps the near stretches.** `routeGeoJSON`
   carries `nearShallowSpans` (each stretch: segment and fraction, depth,
   clearance, red or amber, channel edge) beside the `nearShallow` summary,
   which now counts `red` and the `channel` edges apart. A plan shown again
   (`savedInshoreRouteCaveats`: the planner, the departure sweep, a followed
   route) says what the route said, from the stretches, falling back to the
   summary an older save kept.
    - DECIDED: the departure sweep does not gate departures on a near
      stretch. It gates the water under the line (shallowRuns) and reports
      "UKC at the worst spot" from it; a band beside the line is not under
      the keel. The sweep shows the near stretches' note with the plan's
      other caveats.

- **Goldens** (each in its own process, against 3e3a3603): every corridor
  route is byte-identical, and so is its red. Rivergate (2.40 and 2.44 m):
  7 channel edges, 139 m drawn amber out of the channel's yellow; its 4
  open-water near stretches (125 m) no longer refuse Save or Plan My Day
  with no tide loaded (they do again after the fix-up review below).
  Tangalooma: 2 channel edges, 10 m. newport-shane and the marks corridor:
  their one near stretch no longer refuses (it does again, below). No pin
  moved; the Rivergate golden now pins the channel edges.
- **Measured on the Pi's cells** (copied read-only, sha256-checked, deleted
  after; the six saved test routes, tide unknown and at a 2.5 / 3 m top,
  with and without the SE-QLD marker file; before = 3e3a3603): every
  route's line is byte-identical, and so are Auto's distance, its leg
  review, the land, drying and no-tide audits and the red. Drawn:
  Tangalooma's last leg now shows 16 m amber 'edge' (27.4 m from a 0–2 m
  band, in its channel — the review's case); nothing else changes colour.
  Named: the Newport exit's stretches beside the bank drying 2 m (14.7–24.4
  m off, 120 + 60 + 31 m, on its red needs-tide segments) are channel edges
  again on Rivergate, Tangalooma and newport-shane with the marker file, so
  their route notes gain "In the marked channel this route runs close to the
  edge of the channel's charted shallows: 15 m from water charted to dry
  2.0 m …". Without the marker file (no pairs, no channel there) they stay
  open-water near stretches, and at a 2.5 m top they are red (−2.0 m + 2.5 m
  < 2.9 m) — the stretch 21.9–28.4 m off at the river mouth is now measured
  at the band's corners too (27 + 21 + 8 m more, on segments already red).
  Rivergate's 1 m beside a 2 m band (8.8 m off, open water) and
  Tangalooma's 10 m (1.1 m off) are amber and no longer refuse Save. Route
  times unchanged within noise (the string pull 4–467 ms, the ring
  0.08–0.64 s).

#### Round-3 fix-up review — no tide is red, Plan My Day and the tide, channel edges, deep wrecks (2026-10-03, late night)

A review of the fix-up above (Shane, 2026-10-03: "keep going claude, i am
off to bed"). Each change is tested first (it fails on the fix-up's code):
`tests/engine/nearStretchVerdict.test.ts`, `tests/tier4/tier2ChainVsRectrc.test.ts`
and `tests/dayPlannerEngine.test.ts`.

1. **No tide loaded for the place is red again (high).** A near stretch a
   tide could lift kept `tideLiftable` when the route had no tide ceiling
   for its place (a failed tide fetch, a partial load, no station), so a
   line 1 m or 4 m from a reef drying 3 m was saveable and planned amber
   while the map drew it solid red "no tide data". Owner decision 10 says no
   tide data can't prove it, and 3e3a3603 refused it. `collectShallowRuns`
   now marks such a stretch `tideUnknown` (no ceiling at either end or the
   middle), and `nearSpanBlocks` refuses it. The map is unchanged: it still
   lifts the stretch under a live tide and draws it red without one.
    - DECIDED: every band, not only drying ones. The map draws them all red
      without a tide, and every other stretch drawn red is refused.
    - DECIDED: a new field rather than dropping `tideLiftable`, so the map
      can still draw the stretch amber when a live tide arrives after the
      route was planned. Save then still refuses until the route is planned
      again with the tide loaded: the safe way round.
2. **Plan My Day refuses an amber near stretch as a tide it cannot verify
   (medium).** It refuses every other tide dependency it cannot check (the
   route's needs-tide words, the leg review's `needsTide`), but the near
   note has no tide words, so a stretch beside a 0–2 m band that a 2.5 m tide
   covers was planned for any departure, low water included.
   `assessDayPlanRoute` now refuses any near stretch that is not a channel
   edge: red ones with "passes too close …", amber ones with "The route
   depends on a tide or tidal clearance that this planner cannot verify."
   Save is unchanged: it keeps an amber one with its note.
    - DECIDED: refuse outright, as on-line needs-tide water is refused,
      rather than check the departure against the band's DRVAL1 like the
      tide chips do. Reason: one rule for every tide dependency, and no new
      tide reader in the planner. Checking the window is the better product
      and is left for later.
3. **A channel edge within 5 m of the bank is an ordinary near stretch
   (low).** `CHANNEL_EDGE_FLOOR_M` (engine/shallowRuns). A probe put a line
   1 m off a bank drying 3 m inside a dredged channel, under a 0.5 m tide
   ceiling, and it was an amber channel edge, saveable and planned. Now it
   is red (no tide clears the bank) and refused. With Serene Summer's 4.9 m
   beam, a line 5 m off puts her side 2.5 m from the bank. The goldens' and
   the real cells' channel edges are all 14.7 m or more, so none of them
   changes.
    - DECIDED: 5 m, fixed. Reason: the router does not carry the beam, and
      5 m covers half of Serene Summer's beam plus a margin.
    - Not done: relax-only cells (a far-snapped pin's relax circle) are
      still called "In the marked channel". Making them ordinary near
      stretches could refuse common marina routes, and it needs its own
      words. Left for a later round.
4. **A wreck charted deep enough is not a doubled hazard in tier-2 (low).**
   `navGrid` buffers every charted point hazard whatever its VALSOU, but the
   final audit skips one sounded deep enough (VALSOU >= draft + UKC), so the
   engine never draws its keep-out red. `tier2RedLoad` weighed those metres
   twice. The grid now marks the cells only such hazards closed
   (`deepHazardOnly`, allocated only where one exists; any other hazard's
   claim on a cell clears it, in either order), and `tier2RedLoad` weighs
   them once.
5. **The route notes count a stretch once, and a marginal channel edge does
   not title them (low).** The engine cuts a stretch wherever the band
   beside it changes and at every vertex. `nearShallowSummary` now joins a
   piece that starts where the last piece of its kind ended, so Rivergate's
   7 channel-edge pieces are 2 places ("and on 1 more stretch", not "on 6
   more"), and its 4 open-water pieces are 2. A channel edge titles the
   notice ("Close to the channel edge") only when it falls 5 m or more short
   (`CHANNEL_EDGE_HEADLINE_SHORT_M`) or nothing else is said. A marginal one
   is still named in the notes, under the survey title when there is one.
   Measured on the goldens: Rivergate says "(and on 1 more stretch)" for
   both its open-water and its channel-edge note (2 red stretches); the
   Tangalooma golden (28.2 m against 30 m, 1.6 m short) has no other note,
   so it keeps the title "Close to the channel edge".
    - Not done: naming the drying band before a closer 0 m band. That is a
      judgement call between "nearest" and "worst", so it stays as it was.

- **Goldens** (each in its own process, TZ=UTC, against the fix-up's
  measurements): every corridor polyline is byte-identical, and so is every
  drawn metre (danger, tide, green, channel, edge, with and without a 2.5 m
  tide). With no tide loaded, Rivergate's 4 open-water near stretches (2.40
  and 2.44 m drafts) and newport-shane's and the marks corridor's one each
  refuse again, as at 3e3a3603. Tangalooma and moreton-tier2 are unchanged.
- **Suites and size:** the router suites (154 files, in batches of 4, one
  worker) pass in local time and in UTC: 2,341 passed, 0 failed, 3 expected
  failures, 5 skipped. A vite build of this tree measures 10,722,336 B of JS
  (10.23 of the 10.25 MiB budget, 25.6 KB left), 4.8 KB more than the last
  build at 3e3a3603 for the round-3 fix-up and this review together.

#### G2 — route times, a cardinal's wrong side, the chart's own pairs offline, red over the stretch (2026-10-04, night)

Shane, 2026-10-03: "keep going claude, i am off to bed". On top of 85dc7e07.
Each change is tested first (it fails on 85dc7e07's code):
`tests/engine/lazyClearanceRing.test.ts` (item 1), `tests/engine/cardinalWrongSide.test.ts`
and the new block in `tests/tier4/tier2ChainVsRectrc.test.ts` (items 2 and 3), the new
cases in `tests/routeTracer.test.ts` (item 4) and `tests/engine/redNamesItsReason.test.ts`
(item 5).

1. **Route times back to 7f48fe15's.** Route times on the Pi's cells had risen 18–37%
   since 61e36ccb; the clearance ring alone cost 0.08–0.67 s per route, priced for every
   cell of the cached grid on the main thread before A\* ran.
    - _The ring is priced lazily_ (`attachShallowClearanceRing`): attaching finds the
      seeds and marks every cell a band could be near `RING_PENDING`; a cell is priced the
      first time A\*, a connector, `cellCostAt`, the string pull or the confined-water
      reshaper reads it (`aStar shallowRingClass`), with the same class and the same
      factor folded into `centreFactor` as pricing the whole grid (the test reads every
      cell both ways). `applyShallowClearanceRing` still prices it all at once.
    - Measured: the searches read nearly every cell a band could be near (Rivergate
      9,580 of its 9,837 pending cells, Armit → Molles 61,187 of 62,694), so laziness
      alone saved nothing. DECIDED: not corridor-limited either — a cell outside a
      corridor would price as open water beside a reef, and A\* reads cells far off the
      straight line. The time was in pricing each cell and in the Seaway connector's step
      loop (1.2–2.4 s per route, 0.6–1.4 M pops):
        - `bboxBuckets` puts boxes too big for its 0.01° buckets (an overview cell's
          bands: 910 in the Brisbane cells, every one read for every spot asked) in
          buckets 16 times wider; the same answer, in the items' order (tested against
          filtering the list);
        - the point-in-ring test and the segment-to-area distance walk their edge bands
          without a closure per edge;
        - one bucket index per band list (`depthBandsIn`), not one each for the ring, the
          clearance stretches and the string pull;
        - the connector's heuristic no longer allocates per target per push (term for
          term the same arithmetic), and it reads the ring and the cost ladder once per
          search, not through a call per neighbour.
    - Every route line, mask and stretch is byte-identical to 85dc7e07's on the twelve
      real-chart runs (line and colour hashes) before the routing changes below.
    - Measured on the Pi's cells, the median of 3 runs, each in its own process, the
      three trees interleaved on the same cells (ms, 7f48fe15 → 85dc7e07 → this; tide
      unknown, then at a 2.5 or 3 m top; with the marker file): Rivergate 4,660 → 5,298 →
      4,706 and 5,169 → 5,670 → 5,030; Tangalooma 5,211 → 6,457 → 5,291 and 5,658 → 6,660 →
      5,594; newport-shane 4,310 → 4,858 → 4,219 and 4,625 → 5,300 → 4,636; Armit → Molles
      3,772 → 4,650 → 3,718 and 3,712 → 4,635 → 3,503; Cid Harbour 2,724 → 3,400 → 2,708 and
      2,837 → 3,554 → 2,802; Coral Sea Marina → Daydream 1,011 → 1,248 → 979 and 960 →
      1,189 → 893. Every route is within 1.5% of 7f48fe15's (the target was 5%); all twelve
      together −1.3% (85dc7e07: +18.5%). Measured in vitest, where an imported binding read
      in a hot loop is a getter call — part of what 61e36ccb added, and what these reads
      remove; the bundled app pays less for it.
    - The lazy state (the bands, the seeds, the owners read so far) lives with the cached
      grid and goes when the cache drops it; the grid's bytes count the ring (w × h), not
      that state. (Superseded by the review fix-up below: the engine prices the ring in
      full.)
2. **A cardinal's wrong side is red, and the router keeps to its safe side.** With no
   SE-QLD marker file, Newport → Rivergate passed 12 m (newport-shane 5 m) on the WEST
   side of the river mouth's east cardinal (-27.39651, 153.15337), drawn as channel. The
   chart's track (RECTRC) passes 60 m east of it; the tier-2 snap onto it, which has land
   as its only veto, joined the route to the track's next piece across the mark's west
   side.
    - _Red, named_ (`tier3/cardinalClamp cardinalWrongSideMetres`, `CAUTION_WHY.CARDINAL`):
      a segment with any of its line on a cardinal's wrong side inside its keep-out (the
      disc's radius) is caution on the engine's route and on a promoted Seaway route,
      red over a marked channel's yellow, not the tide's to lift, "passes a cardinal mark
      on its danger side — keep to the side it's named for". Save and Plan My Day say
      "…passes a cardinal mark on its danger side." where that is the only reason.
      DECIDED: the leg review's rule, at every point of the line — the danger's whole
      half within 90 m, beyond that only its hazard quadrant, and not where the line rides
      a charted lead (within 40 m, within 30° of its heading). The whole half-disc would
      have reddened the track itself 350 m south of this mark, where it bends into the
      river in the south quadrant. (The review fix-up below: within 400 m, not the disc's
      radius, and the leg review reads every point too.)
    - _The snaps keep the safe side_ (`snapKeepingCardinalSide`): the whole-route RECTRC
      snap, the seam snap and the tier-2 snap and ride take each track only where it adds
      no metre on a cardinal's wrong side; with no cardinal near they are the same snaps.
      A leg whose track piece was refused so is snapped onto the pieces joined where they
      meet (finding B's join), which follows the track past the mark's east side.
3. **The chart's own pairs survive a marker file that does not load.**
   `fetchRegionalMarkers` threw before the chart's laterals were paired (the "not fixed
   here" of finding B), so offline every chart lateral was a solo keep-out disc and no
   gate was checked. Now it pairs them and says so (`markerFileFailed`); the leg review
   still says "channel marks unchecked — mark data did not load" and checks the chart's
   own pairs. DECIDED: fixed here — it is the root of item 5's route and item 4's advice
   offline.
4. **No crossing advice inside a gate.** Offline, the Newport exit's legs through each
   gate's midpoint (27 m from each mark) were told "bank side of port mark 8 — cross to
   the channel side": the channel itself is charted 0–2 m, so `lateralPassRead` read the
   boat's side as shoal. A leg that passes between a solo lateral and an opposite-hand
   one within 300 m threads their gate and is told nothing; shoal on both sides of a mark
   reads 'unknown' ("verify your side"), not 'shoalside'. (The review fix-up below: a
   confirmed bank-side pass there still warns.)
5. **Red over the shallow stretch only (`CAUTION_WHY.STRETCH`), and deeper water into
   Murrarie.** Offline, newport-shane's last leg was red for 1,565 m over 488 m charted
   2 m. A caution segment red for its charted depth alone (SHALLOW, every caution cell a
   shallow band's), only part of which the finest survey charts below draft + safety, is
   drawn over those stretches (its `chartedShallowSpans`, with their runs, tide chips and
   words) and its own colour elsewhere. It keeps its own depth facts (`tideDepthM`), so
   its clearance is measured as before. DECIDED: only a band that dries counts beside it,
   as on any caution segment a tide lifts — read as a clean segment, the Rivergate golden
   gained 3 near stretches (approaches to the bank it crosses) that would have refused
   Save for a needs-tide crossing the review already refuses. (Withdrawn by the review
   fix-up below: it drew a line 5 m off a 0–2 m bank green.)
    - The route: with the chart's pairs (item 3) the last leg follows the river's track
      round the bend into Murrarie (-27.43087,153.11964 → -27.44131,153.11096 →
      -27.44366,153.10604), as with the marker file. And a tier-2 leg no chain shaped (the
      charted track's pieces, the raw A\* slice or the lateral follower) is weighed against
      the ride on the track's pieces joined where they meet by finding B's `tier2RedLoad`;
      a tie keeps the leg. DECIDED: the gate follower keeps its line (it threads the pairs'
      midpoints).

- **Goldens** (each in its own process): every polyline is byte-identical to 85dc7e07's.
  Drawn: Rivergate (2.40 and 2.44 m) red 8,486 → 8,404 m, channel edge 139 → 164 m
  (re-pinned: a STRETCH segment's deep part shows the edge the whole red hid), 9.7 m of
  survey-margin dashes on another's deep part (re-pinned from 0); Tangalooma red 6,702 →
  6,643 m;
  newport-shane 11,533 → 11,528 m; the marks corridor 8,895 → 8,893 m; moreton-tier2
  unchanged. Near stretches and Save refusals unchanged.
- **Measured on the Pi's cells** (copied read-only, sha256-checked, deleted after; the six
  saved test routes, tide unknown and at a 2.5 / 3 m top; before = 85dc7e07):
    - With the SE-QLD marker file: every route line is unchanged, and so is every leg
      review. Red: Rivergate 6,849 → 6,840 m, newport-shane 6,662 → 6,636 m, Tangalooma
      6,893 → 6,892 m (STRETCH segments' deep parts, now their own colour or survey dashes).
    - Without it: Rivergate 23.97 NM both, 56 m off the cardinal's EAST side (was 12 m
      west of it), red 6,849 → 6,840 m (as with the file; at a 2.5 m top 3,674 → 3,554 m),
      and 1,008 m of survey-margin dashes now shown where it rides the charted track at the
      mouth; newport-shane 24.64 → 24.68 NM, 56 m off the cardinal's east side (was 5 m
      west), red 8,227 → 6,636 m and charted below the keel's need 7,120 → 6,632 m (the
      488 m of 2 m into Murrarie gone — as with the file); Tangalooma 23.37 → 23.34 NM.
      Gone from the leg reviews: "wrong side of the east cardinal" (Rivergate,
      newport-shane) and every "bank side of … mark — cross to the channel side" (16 on
      Rivergate and Tangalooma, 17 on newport-shane); grades danger 18 / 18 / 22 → 18 / 18 /
      20, caution 10 / 10 / 15 → 9 / 8 / 14. The Whitsunday routes are unchanged.
- **Suites and size:** the router suites (225 files, in batches of 4, one worker) pass in
  local time and in UTC: 3,206 passed, 0 failed, 3 expected failures, 5 skipped. A vite
  build measures 10,727,079 B of JS (10.23 of the 10.25 MiB budget, 20.8 KB left), 4.7 KB
  more than the round-3 review's build.

#### G2 review fix-up (2026-10-04, night)

Reviewed the same night. Each fix is tested first (it fails on the G2 build):
`tests/engine/stretchClearance.test.ts` (item 1), the new block in
`tests/engine/cardinalWrongSide.test.ts` and the new cases in `tests/routeTracer.test.ts`
(items 2 and 3), and the new pin in `tests/RouteMemoryCeilings.test.ts` (item 4).

1. **A STRETCH segment's approach to a bank is red again.** G2 measured a STRETCH
   segment's clearance as it measures a needs-tide segment's, where only a band that dries
   counts. But the rest of a STRETCH segment is drawn in its own colour. The review's probe:
   a line runs 0–5 m north of a 0–2 m band for 920 m, then 1 m into the band for its last
   17%. It was green over those 920 m, though the router itself keeps 30 m clear of that
   band. At 85dc7e07 that water was red, and so it was on a clean segment and on a
   GRID_ONLY one.
    - The fix: the rest of a STRETCH segment is now measured as a clean segment is. Every
      shallow band counts, and the part inside a band's clearance is a near stretch.
    - Owner decision 10 then sets its colour. It is amber where a tide the route knows
      clears the band. It is red, and Save and Plan My Day refuse it, where no tide was
      loaded or no tide can clear it. So the approaches refuse a needs-tide crossing only
      where a clean segment's approaches would.
    - G2's DECIDED (only drying bands count beside a STRETCH segment) is withdrawn. The 3
      near stretches it avoided on the Rivergate golden are approaches to a bank. They are
      red with no tide loaded, as their whole segments were at 85dc7e07.
    - Goldens, each in its own process; every polyline is unchanged:
        - Rivergate (2.40 and 2.44 m): open-water near stretches 4 → 7 (re-pinned); near
          stretches 346 → 390 m; red 8,404 → 8,451 m (85dc7e07: 8,486 m); channel edge
          164 → 161 m. Survey-margin dashes are back to 0 m (were 9.7 m; re-pinned to 0),
          because those metres lie inside a bank's clearance.
        - Tangalooma: near stretches 2 → 5 (3 of them refuse Save with no tide); red
          6,643 → 6,691 m (85dc7e07: 6,702 m).
        - newport-shane: red 11,528 → 11,533 m. The marks corridor: 8,893 → 8,895 m. Both
          equal 85dc7e07's. moreton-tier2 is unchanged.
    - `redNamesItsReason`: the North Molle STRETCH case is re-pinned. Its approaches inside
      the 10 m kept off the 2–5 m band (267 m each side, because the line is that oblique)
      are now red with the crossing, named for the band's edge.
2. **The router's cardinal red and the leg review read one rule.** G2's mask counted every
   point within the disc's radius (400–1000 m, sized to reach the route). The leg review
   looked only at a leg's closest point within 400 m. Two cases showed the gap:
    - A leg 600 m west of an east cardinal with a 900 m disc was red and refused, but its
      review said clear.
    - A leg whose closest point lay 100 m north of an east cardinal, just east of its
      meridian, ran on 290 m west into the mark's hazard quadrant. The review graded it
      clear: a false green.

    Now both read `cardinalWrongSideAt` (tier3/cardinalClamp), at every point of the line.
    The rule: within 400 m of the mark (`CARDINAL_REACH_M`, the review's band), the danger's
    whole half within 90 m, and beyond 90 m only its hazard quadrant. The review samples
    every 5 m inside the band, and its closest point.
    - DECIDED: the review reads every point, rather than the mask reading the closest point
      only. The closest point alone misses a leg that runs on into a hazard quadrant.
    - Two tracer tests had legs that ran into the hazard quadrant: a leg 50 m south that
      started 300 m west, and a tangent 200 m off at 200° that reached 350 m west. They are
      re-shaped to stay on the safe half, and the old legs are pinned as the wrong side.

3. **A confirmed bank-side pass beside an opposite-hand solo lateral still warns.** The
   gate skip (G2 item 4) ran before the side read, so it also dropped a confirmed
   'shoalside' read. Solo laterals are the marks the pairing declined to pair, such as two
   channels either side of a bank. The skip now applies only where the side is 'unknown'.
4. **The engine prices the ring in full.** Under lazy pricing, the pricing state stayed
   with the cached grid and the cache's 48 MB budget did not count it. Measured on the
   goldens, dropping that state freed 21.6 MB (Rivergate), 23.3 MB (Tangalooma) and
   73.8 MB (newport-shane's two grids).
    - The engine now calls `applyShallowClearanceRing`. It gives the same classes and drops
      the pricing state.
    - Cost, median of 3, each in its own process (ms, lazy → full): Rivergate 1,104 →
      1,149; Tangalooma 1,241 → 1,332; newport-shane 2,005 → 1,970. That is +2.3% in all.
    - DECIDED: the memory outweighs ~90 ms on the worst golden, because the phone has a hard
      2 GB WebContent cap. This was not re-measured on the Pi's cells, where G2 measured the
      searches reading 97% or more of the pending cells anyway.

- **Not re-run on the Pi's cells:** the G2 real-chart numbers above predate this fix-up.
    - Item 1 adds red only on STRETCH segments' approaches to a band.
    - Items 2 and 3 change the leg review only in two cases: where a leg runs into a
      cardinal's hazard quadrant beyond its closest point, and where a leg passes a solo
      lateral's confirmed bank side between it and an opposite-hand one.
- **Suites and size:** the router suites pass in local time and in UTC: 226 files, in
  batches of 4 on one worker; 3,219 passed, 0 failed, 3 expected failures, 5 skipped. A vite
  build measures 10,727,744 B of JS (10.23 of the 10.25 MiB budget, 20.2 KB left), 665 B
  more than G2's.

### Left for Shane (server side, not done here)

The edge function, its `_shared` modules and its secrets are still deployed and
in the repo; nothing in the client calls them. When ready:

1. `supabase migration list` first, then `supabase db push`. db push applies
   EVERY pending migration, this one included —
   `20261001120000_saved_proposal_evidence_thalassa_origin.sql`, which widens the
   evidence origin check — so check the list for anything else still pending
   (20260908150000 was owed on 2026-09-08) before you push.
2. `supabase functions delete autorouting-trial`
3. `supabase secrets unset SEVENCS_CLIENT_ID SEVENCS_CLIENT_SECRET SEVENCS_TRIAL_USER_IDS SEVENCS_TRIAL_EXPIRES_AT SEVENCS_TRIAL_ENABLED`
4. Then a code commit removing `supabase/functions/autorouting-trial/`,
   `supabase/functions/_shared/autorouting-trial.ts`,
   `autorouting-provider-check.ts` (keep its types for the legacy evidence
   reader, or inline them), `autorouting-vessel.ts` (still used by the client's
   vessel snapshot — move it first), the `[functions.autorouting-trial]` entry in
   `supabase/config.toml`, its line in `tests/SupabaseEdgeJwtPolicyContract.test.ts`
   and `tests/AutoroutingTrialEdge.test.ts`.

The sections below are the history of the SevenCs trial.

## Standalone `/plan` entry verification — 2026-09-13

The current web source already uses the shared Planning home: **Slide to Start
Plotting → Manual routing / Auto routing**. It needs no duplicate Auto card.
The standalone session wall now renders immediately while authentication is
being checked, even with a provisional user, and requires a confirmed session
before revealing the planner. Signed-out users have no dismiss action. Native
non-builder gate behaviour is unchanged. Auto still requires the server's existing
account allowlist, trial switch, expiry and quota; exposing the choice does not
grant an account access or activate a route.

The phone visual check also caught an existing sign-in layout fault: the
viewport-pinned privacy footer covered the Google button. Privacy copy now
follows the buttons in normal flow, with a gap and bounded, scrollable content
on short screens. All three provider actions and their authentication handlers
are unchanged.

Validation: **242 tests across ten focused suites** passed, including five new
real-`/plan` entry cases with the actual slider, routing dialog and handoff logic
(provider/chart workspace mocked). TypeScript, web build, scoped ESLint,
Prettier and whitespace checks passed. Local web-release/asset checks and bundle
budgets passed. **Two compiled browser cases**, desktop Chromium and phone
WebKit, confirmed the sign-in wall blocks the planner, cannot be dismissed,
makes no trial request, and keeps the privacy text clear of hit-testable email,
Apple and Google buttons. Both final screenshots were inspected.

Local web entry: `main-ClIJfMFo.js`; SHA-256:
`dc9996e3c0c07fb0eae7d1b07bb11b627cdeb146c061cb6fad88030833117854`.
This was a web build only, not a new native sync/archive/TestFlight release.

The live Vercel deployment was inspected read-only: `dpl_EuUUgRNt4o6sVKfcVfCRQ3oVJWJq`,
created **10 September 2026 at 07:12 AEST**, serves `main-DWyPOmnU.js` and an older
planner without the routing choice. `/plan` shares the production deployment
and aliases with the wider public website. No deployment, promotion, commit,
push, provider request or access-policy change was performed during this entry
verification. Publishing the current web candidate requires a shared-site
release, not a `/plan`-only switch.

## Automatic chart-matched Newport exit — 2026-09-13

For **Canal / marina** departures inside the reviewed Newport tidal-canal area,
the trial now chooses the exit without a third pin. It reads the device's
registered navigation chart and requires its edition, issue date and all eight
real lateral-marker identities/categories/positions to match the reviewed
profile. Missing, reference-only, removed, changed or unreadable charts cannot
enable the automatic exit. Standard licensed-chart read-through is bounded by
a 15-second verification deadline; failures leave **Choose Canal exit** available.

The proposal is constrained through the exact centres of all four reviewed
marker pairs, in explicitly reviewed inner-to-outer order. Each centre remains
a pinned vertex after local solving/simplification. SevenCs starts at the final
pair and must initially progress outward; no route or straight-line substitute
is accepted on a failed local path, marker constraint or provider join. Existing
wall, pontoon, bridge, grid, tile, worker and chart-review limits remain intact.

The automatic card shows the exit coordinates and allows **Choose manually**;
manual override can be switched back to automatic. Changing departure discards
the old exit even during partial coordinate entry, aborts pending work and
re-resolves the area. Manual overrides survive destination-only edits. A
resolved automatic exit cannot leave a hidden Canal Exit tap target selected.
Source evidence and review expiry are rechecked before calculation and before
displaying its result; delayed work cannot revive an old selection.

This is **Newport-only coverage**, not an inference that any farthest, nearest
or lowest-numbered buoy is an exit. The reviewed polygon excludes Newport
Lake/lock, the bridge-separated southern canals, Scarborough and open bay.
Same-area destinations and unknown regions retain manual/local planning.
The broader daily obstacle refresh is unchanged and cannot renew this reviewed
marker profile. Its initial review expires **20 September 2026 at 07:12 AEST**.
An expired profile returns to manual until reviewed again.

The [source review](NEWPORT_AUTOMATIC_EXIT_REVIEW_2026-09-13.md) records the live
licensed chart, official MSQ map, notices, exact pairs and conservative polygon
derivation. “Chart-matched” is not a physical inspection, tidal/depth/traffic
clearance or permission to navigate an unsaved proposal. No worldwide automatic
coverage or control of a vessel/lock is implied.

Validation for this revision: **245 focused tests** and **34 Chromium/WebKit
browser cases** passed. Six automatic-exit visual cases were additionally
captured and inspected across daylight, dark and night phone/split-pane layouts.
Scoped lint, formatting and `git diff --check` passed. The earlier interrupted
browser run was not counted as successful; the complete rerun passed all cases.

Fresh complete z16 water and the controlled overlay plus fixed bridges produced
local paths for both previous Newport departure pins: **14 and 10 waypoints**,
with all four exact pair centres retained. Independent polygon/line checks at
15,304 samples (at most 0.5 m apart) found no outside-water samples, obstacle
interior samples or mapped wall/pier/bridge/boundary intersections. Desktop
solve times were 366 and 316 ms; no SevenCs request or route activation was
performed by these diagnostics. This is mapped geometry, not physical clearance.

`npm run ship` completed TypeScript, production build, Capacitor sync and
artifact secret checks. All **424** generated web files match their iOS copies
byte-for-byte. Entry: `main-SRl1dMn0.js`; SHA-256:
`f5f941da845b4c0b62c490c8baa11f2b2fbff59bd3217afe42ae15b530927cbb`.
Local preview only: no native archive, TestFlight upload, commit, push or backend
deployment was performed for this automatic-exit change.

Planning home has no separate autorouting card. Completing **Slide to Start
Plotting** opens a centered **Manual routing / Auto routing** choice, scoped to
the owning pane on iPad. Closing it stays on Planning home; sliding again starts
fresh. Manual immediately opens the existing plotting chart, even when offline
or while the trial entitlement check is pending. Auto is enabled only after
the server grants trial access. Its chart opens lazily, after the choice.

Trip legs, Saved routes and From a past voyage keep their existing direct-open
flows. The slider has no retained selected leg, so Auto does not secretly
consume a route intent or copy a previously opened route. It opens a separate,
disposable workspace with blank endpoints and read-only location/vessel
snapshots. Its endpoints, vessel-input snapshot, request and proposal never enter the normal
planner, saved-route library, passage handoff, active log, public page or Pi.
Close discards the draft. Editing an input invalidates the previous result.
Account changes and cancellation fence late replies. There is deliberately no
Save, Follow, Publish or Cast off action in this first evaluation slice.
The Auto trial currently calculates **leaving now**, not the scheduled departure
on Planning home. Removing the repeated departure message does not change that API behaviour.

## Local preview after build 117 — 2026-09-12

The trial now displays the existing viewport-bounded ENC renderer over its own
map, with chart depth fills, land, contours and marks below the proposal. It
uses the same licensed chart inventory as manual plotting; charts still require
available coverage and successful loading. Reference-only, missing coverage and
loading states remain explicit. The isolated map uses full chart treatment
without changing the OBS/manual imagery preference.

Draft and speed are no longer editable here. The mode chooser snapshots Vessel
preferences (including the existing feet-to-metres conversion) when Auto opens.
Invalid or missing preferences disable Calculate and direct the user to Vessel;
no substitute vessel values are invented. Clear resets endpoints/proposal only.
The duplicate draft/speed and leaving-now paragraphs are removed. The trial
warning and provider warnings remain.

This is a local build + Capacitor sync only, not a new TestFlight release.

Initial ENC-preview validation: 150 focused unit tests and 10 Chromium/WebKit phone/split-pane
checks passed, alongside the 28 legacy marina/canal checks below. Browser
checks use a synthetic reference ENC cell, not live licensed chart coverage.
They also caught and now cover cancelling delayed ENC uploads when a map is
closed; upload generations and geometry deduplication are scoped per map so
one pane cannot cancel another. Scoped lint and `git diff --check` passed.
`npm run ship` completed TypeScript, production build, Capacitor sync and
artifact secret checks. Web and iOS both contain `main-C8pVZjEM.js`, SHA-256
`2c7165a9b61813d2ef7db51b0be9a40d7b9c3f25198c4e2e991d7569191b7b3f`.

### Waypoint and chart-check preview

Every returned coordinate is a numbered, selectable waypoint. No bends are
simplified and the original provider payload stays unchanged. Each exact leg
receives the same `gradeLegs` / `validateTraceLeg` checks used by manual plotting:
depth against draft plus the existing 0.5 m LAT margin, land, obstructions,
berths, cardinal marks, lateral gates/solo laterals and nearby leads. Colours
and a paged waypoint list expose each result; issue buttons focus its mark or
location. Green means no issue found by these checks, never navigation approval.
Sub-keel legs remain flagged: no tide credit or departure window is established.

This caller deliberately uses a stricter **charted-depth-only** input policy.
It excludes the old engine's fabricated OSM water/marina depths and excludes
canal, NAVLINE, FAIRWY and DRGARE rescue hints from depth-grid generation. The
original lead/mark layers remain available to the checker. A lead line is not
itself a sounding. Manual routing's default input policy has not changed.
Missing chart/marker/obstacle data stays incomplete, not green. The strict
context has a different in-flight key so it cannot coalesce with a legacy grid.

Review is cold and in-memory, with 64-leg batches and at most one held grid;
long legs use the existing bounded subdivision. Stop, Clear, Close and identity
changes discard/cancel work. A changed chart fingerprint invalidates old
colours and offers Recheck rather than auto-rebuilding continuously during
hydration. Dateline, polar and degenerate segments decline explicitly.
No saved-route writes, approval envelope, handoff, publication or Pi commands.

**Lead following:** the supplied evaluation OpenAPI schema has no documented
follow-leads toggle. Our request already enables its route/restriction checkers.
It supports ordered must-go areas/points, but these have not been introduced
by this change. An off-lead warning is not an automatic correction; the manual
checker only assesses relevant nearby leads, not universal lead adherence.
No provider settings or deployed functions changed, and the screenshot alone
does not identify why that particular SevenCs proposal deviated.

Validation for this revision: 275 focused tests plus 40 manual-routing
regressions passed. All 10 selected Chromium/WebKit phone and split-pane
visual cases passed, including actual rendered waypoint labels, incomplete
reference-chart results, keyboard layout and Close cleanup. A fixture font
failure exposed a dependency on downloaded glyphs; the trial now uses locally
rendered text so waypoint numbers need no font-server request. Scoped lint,
formatting, TypeScript, production build, Capacitor sync and artifact secret
checks passed. All 422 generated web files match their iOS copies byte-for-byte.
Entry: `main-D5Xo7YKG.js`; SHA-256:
`28c20f7191791ac9e04b6fc363d902695cc2e3aa3f3ee91fe3831808d60504df`.
This remains a local preview: no archive, upload, commit or deployment.

### Canal departure connector — local preview, 2026-09-12 evening

The optional **Canal / marina departure** control adds an explicit **Canal exit**
pin. The skipper selects the handover beyond the canal walls; this revision does
not guess marina exits, impose a remembered Newport gate, or change ordinary
SevenCs/manual routing. It handles the departure side only, not a destination
marina. Any changed pin, toggle, Clear, Close or account change discards the
combined proposal and cancels outstanding work.

Thalassa builds the local section first using the existing `routeMarina`
centreline solver. It runs in a disposable module worker over a 3 m grid,
bounded to 750,000 cells / 48 map tiles, with a 20-second compute deadline.
No worker means an explicit refusal, not synchronous UI-thread routing.
Water polygons come from the existing z16 vector-water decoder; missing tiles
refuse the request. Pontoons, breakwaters, reefs, airport geometry and known
fixed bridge spans are blocked. Bridge clearance is not established by this
connector, so known bridge spans are not automatically traversed. The legacy
OSM edge's HTTP-200/all-empty failure response is rejected too.

Unknown space is blocked. There is no canal carving, satellite colour
classification, fallback straight line, artificial depth, erosion relaxation,
or jump to a different basin. Endpoint joins and every generated straight leg
are checked on the local water/obstacle grid. The solver's numerical uniform
cost is only a water mask, never a sounding. This is **map geometry, not a
surveyed passage or a guarantee that all real-world obstructions are mapped**.
The usual ENC depth/marker review still runs; local canal legs remain caution
or danger, never automatically green.

Only after a connected local path is found does the authenticated SevenCs
request start, from the exact chosen Canal exit and with the same vessel draft
and speed. The provider's first point must be within 2 m; even that tiny join
is checked, not silently snapped. Provider segments crossing the local crop
are checked too, to reject shortcuts/backtracking across mapped banks. The
complete proposal labels the handover waypoint. Original provider RTZ/GeoJSON
remain untouched and apply only to the SevenCs continuation. No route save,
approval, activation, publication, server deployment or TestFlight upload.

Validation: 207 focused tests across nine files passed, including a recorded
Newport canal bend with OSM pontoons, independent polygon-boundary checks,
disconnected basins, thin walls, bridge spans, missing tiles/obstacles, provider
seams, auth races, cancellation and legacy marina-solver regressions. This is
not a live sea trial or proof of the whole Newport departure. Ten phone/split
day/dark/night Chromium/WebKit layout cases and two real module-worker browser
cases passed. `npm run ship` passed TypeScript, production build, Capacitor sync
and artifact secret checks. All 424 web files match the iOS copies. Entry:
`main-Cf8kHAIc.js`, SHA-256
`aa79586ac12fb9209716899fa133e6353ea4becdc4f6a1b968094e8b8bdbf226`.
Worker: `canalDepartureWorker-Bm92wyH2.js`. The local preview returns HTTP 200
at `http://127.0.0.1:4173/`. No CI run, commit, push or release was made.

### Explicit departure choice — local preview, 2026-09-13

The canal control was too easy to miss: the previous unchecked default sent
the departure straight to SevenCs. Auto now starts with **no departure mode
selected**. Two large **Canal / marina** and **Open water** buttons stay in the
fixed header above the chart, outside the lower scroll area. Calculate requires
an explicit choice even if both endpoints have already been set.

Canal / marina requires a separate Canal exit and guides taps through departure,
exit, then destination. The fields use that order too. Selecting canal mode with
no departure keeps the first tap on Departure, rather than silently assigning
it to Canal exit. A prompt beside Calculate names the missing position, including
the reported case with an exit and destination but a blank departure.
Only Open water can call SevenCs directly. Switching
modes cancels pending work, clears the proposal/exit but preserves departure and
destination; tapping the selected mode again preserves pins. Clear or reopening
requires a fresh choice. The lower panel can shrink when the keyboard opens so
the fixed choices, chart and editor stay inside the phone or owning iPad pane.

This corrects discoverability and the silent default, not the canal geometry.
No solver clearances or wall checks were relaxed, and a real Newport departure
still needs testing with the canal option explicitly selected. Local build/sync
does not update an already-installed TestFlight app; Run the synced Xcode app
or reload the local browser preview to test these changes.

Validation: 79 focused tests and 12 Chromium/WebKit phone/split-pane cases pass,
including day/dark/night, keyboard visibility, explicit mode selection, missing
departure, mode-change cancellation and refusal without a direct fallback.
Scoped lint and `git diff --check` pass. `npm run ship` completed TypeScript,
production build, Capacitor sync and artifact secret checks. All 424 web files
match their iOS copies byte-for-byte. Entry: `main-CGjLswov.js`; SHA-256
`862e601fb2adde0829f6b3e042e247cd834de5983b9c5717db8ffff5b6bb8ccf`.
The local `/plan` preview returns HTTP 200 with this bundle. No CI, archive,
TestFlight upload, server deployment, commit or push was performed.

### Canal size-limit correction — 2026-09-13

The 06:09 screenshot supplied departure `-27.21448333, 153.0878` and Canal exit
`-27.17196667, 153.0942` (converted from the displayed rounded minutes). Their
separation is 4,775 m / 2.58 NM. The old fixed 4 km guard rejected this before
loading water or obstacles, even though its crop needs only 659,610 cells and
33 z16 map tiles, within the existing 750,000-cell / 48-tile limits.

Removed the redundant maximum endpoint-distance cutoff. The minimum 20 m
separation, coordinate validation, 3 m resolution, crop padding, grid/tile/input
budgets, worker deadline, shoreline/obstacle masks, endpoint and provider-seam
checks all remain unchanged. Large areas still refuse instead of coarsening the
grid, carving water or falling back to a direct route. Acceptance of the crop
does not establish a connected real-world canal or clearance.

Validation: reproduced the screenshot's failure before the fix, then passed
113 focused tests (including grid/tile refusal, thin walls, provider joins,
legacy marina/parity and UI regressions). Four Chromium/WebKit worker cases
passed: a U-bend and a synthetic all-water crop at the screenshot's exact size.
These verify bounded computation, not live Newport water/obstacle coverage.
TypeScript, scoped lint, production build, Capacitor sync and artifact secret
checks passed. All 424 web/iOS files match; `/plan` serves the new bundle.
Entry: `main-COaijP8D.js`, SHA-256
`a58f4e8c819a489f98ac3c709a4758c94a329ff251e57e76f6b12f40a0934fe6`.
No CI, upload, server change, commit or push. Existing Xcode project edits
were preserved.

### Earlier marina/canal reuse investigation (before connector integration)

- `services/marinaCenterline.ts`: pure grid centreline routing, shore clearance,
  connected-water checks and line-of-sight simplification. The Newport binary
  fixture tests exercise berth-to-gate, reverse and cross-estate geometry.
- `services/tier3/fineCanalGrid.ts`: fine-resolution marina/canal segments and
  safeguards against clipping bends; consumes an existing navigation grid and
  corridor, not just two GPS coordinates.
- `services/tier3/canalLineFollower.ts`: follows connected canal centrelines,
  with limited endpoint snapping rather than arbitrary long connectors.
- `services/InshoreRouter.ts` and `services/OsmRouteOverlayService.ts`: collect
  canal/fairway, breakwater and berth/pontoon geometry for the old engine.
- `services/curatedFairways.ts`: a manually curated Mooloolaba lane. It is not
  a general marina-exit database. `services/bathymetricRouter.ts` is a retired
  adapter returning null, not the implementation to wire into SevenCs.

The 28 focused centreline/parity/canal/fine-grid tests passed in this checkout.
They establish regression behaviour on fixtures, not present-day navigability.
The old import path includes assumed marina depths (for example, 5 m for an OSM
marina polygon), so it must not be adopted as verified depth coverage.

A possible next slice is a separately reviewed local departure/arrival connector
to a suitable SevenCs offshore endpoint, preserving source provenance and
checking every connector and join. It must decline without sufficient water,
obstacle and depth evidence. No connector, route snapping or marina-wall fix has
been added by this preview; the provider geometry remains unchanged.

## Provider boundary

The authenticated `autorouting-trial` Supabase function is the only SevenCs
caller. It uses the supplied evaluation server and verified OAuth client
credentials flow. Credentials are server secrets, not Vite variables. Access
requires a verified Supabase session, an exact server-provisioned user UUID,
an enabled switch and an unexpired trial. Status is limited to 120/hour per
user; calculations to 12/hour. No paid weather-optimisation service is enabled.

Server configuration:

- `SEVENCS_CLIENT_ID`, `SEVENCS_CLIENT_SECRET`
- `SEVENCS_TRIAL_USER_IDS` — immutable Auth UUID allowlist, provisioned privately
- `SEVENCS_TRIAL_EXPIRES_AT` — required UTC timestamp; currently stops at
  2026-11-10 00:00 UTC, conservatively inside the complimentary 60-day window
- `SEVENCS_TRIAL_ENABLED` — exactly `true` to permit access

Only Shane's verified account is provisioned. No other account, public-beta
flag, mutable email or client-supplied identity grants access. Disabling the
switch or letting the expiry pass stops new provider calls; there is no renewal
or purchasing code. Deploy only `autorouting-trial`, never all functions.

The adapter uses the provider's documented `POST /api/route` JSON request and
response, checked against the evaluation server's OpenAPI document on
2026-09-12 AEST. URLs are fixed; redirects and caller-supplied endpoints are
not accepted. Provider work and response streams have a 35-second deadline
and bounded sizes. Failed POSTs are not automatically retried.

## What the proposal does — and does not — mean

The request supplies a yacht type, selected draft, cruising speed and a fixed
0.5 m clearance in each water-area category. **No predicted tide is credited.**
Beam, air draft and other yacht dimensions are not supplied or checked in this
first trial; returned warnings explicitly say so. Provider
checker/expander dependencies remain enabled. Paid weather optimisation and
voyage optimisation remain disabled.

The returned line is a **trial proposal, not navigation approval**. ENC display
does not change or validate the provider route; the background outside available
ENC coverage is not a nautical chart. A provider success flag or a leg marked safe
does not become a Thalassa verified-route badge. Proper chart/licence coverage,
restrictions, vessel dimensions and local conditions still require review.

Every returned geometry is checked for valid coordinates. Track parts must
already join exactly; the adapter never invents a joining leg, reorders,
smooths, snaps or simplifies them. More than 10,000 track points, broken
geometry or a provider endpoint more than 250 m from the requested point is
rejected. Accepted endpoint offsets over 5 m are disclosed as warnings.
Unsafe/danger features and user warnings are surfaced. The original RTZ and
GeoJSON are retained verbatim in memory (4 MiB combined limit), then discarded
with the workspace; they are not written to logs, local storage or route tables.

## Provider verification record

A live, non-navigational test between two offshore Sunshine Coast points
returned provider request `327000`: success, approximately 14.96 NM in three
seconds. The app adapter accepted all seven returned track coordinates and
retained both RTZ and GeoJSON byte-for-byte. This proves that particular API
exchange, **not** Lady Musgrave entrance suitability or complete Australian
chart coverage.

The private `autorouting-trial` function is deployed (version 1). Live probes
returned 204 for preflight, 405 for GET and 401 for an unauthenticated
calculation. The deployment did not change database tables or other functions.
The verified account allowlist, trial expiry, kill switch and client credentials
are provisioned as server secrets. No signed-in production calculation was
performed by impersonating the user: the authenticated provider exchange above,
deployed unauthenticated rejection and injected-auth contract tests are separate
pieces of evidence, not a claimed end-to-end device test.

## Initial workspace validation (before shared slider entry)

Chromium and WebKit passed all 18 layout/interaction cases with no retries or
skips: 390 px and 430 px phones plus a 1024 px split screen, each in daylight,
dark and night modes. These tests use a real Mapbox renderer with a local
basemap/provider fixture. They check every proposal vertex remains visible,
keyboard-safe inputs, visible Close/zoom controls, independent companion-pane
interaction, and draft disposal on close. They do not verify live chart tiles
or provider chart coverage. The final workspace unit suite passed 24 tests.

The bundle also narrows the existing lazy Sentry import to its six used exports.
Error reporting, its privacy filters and its React initialization remain in
place; replay stays disabled. This removes unused SDK exports from the install
payload without increasing the bundle-size budget.

The final full Vitest run passed 1,136 files / 10,477 tests, with the existing
four skipped files, five skipped tests and three expected failures unchanged.
No tests were quarantined or weakened. An initial combined run caught an
incorrect ResizeObserver test stub; its scoped replacement passed both the
24-test focused suite and the fresh full run. Full lint passed (59 existing
warnings), changed-file formatting passed, and the new Edge function passed
Deno type checking and formatting. Source beta contracts passed 126 checks.

`VITE_APP_BUILD=115 npm run ship:beta` completed successfully from source
commit `26691b711a315dc6c0fbaa1629cf937547bb8a57`, explicitly pinned in the
bundle's commit metadata. This includes the full TypeScript/production build,
web-release and route-registry checks, bundle budget, Capacitor sync, artifact
secret scans and all 140 final release contracts.

- Main entry: `assets/main-D2REQGv4.js` (18,465 bytes).
- Main SHA-256: `c0cf3fbf04d6939236b7a01496ec0cffb7b4ad1827b63b57cd29a6a6090610f3`.
- JavaScript payload: 9,662,734 bytes (276 files), below the unchanged 9.9 MiB
  cap and 714,575 bytes smaller than the recorded build 114 payload.
- Sentry vendor chunk: 78,837 bytes, previously 448,220 bytes.
- All 419 generated web files matched their embedded iOS copies byte-for-byte.

The compiled artifact then passed all 12 Chromium/mobile-Safari smoke,
planning-home/departure and Glass split-navigation regressions (25.4 seconds,
zero retries or skips). The preview server was stopped by the test runner.
Build 114's archive/upload are not part of this change. Build 115 is prepared
locally only until a separate TestFlight release is requested.

## Shared slider entry revision

The obsolete card is removed. The mode choice checks trial access only when
opened, never blocks Manual on that check, and closes once on an account
change even when the workspace also observes the identity change. Close,
Escape and backdrop dismissal discard the complete flow; reopening starts a
new check and draft. The lazy-loading fallback is also dismissible and pane
contained. No provider contract, saved-route data or server configuration
changed in this revision.

The combined focused suite passed 220 tests across 11 files: trial service and
Edge contracts, workspace and mode choice, planner handoffs, slider, focus trap,
pane portals, trip identity and JWT policy. Chromium and WebKit passed all 24
source browser cases with no retries or skips, covering the real slider gesture,
Manual isolation, Auto access gating, Close/Escape/reopening, and the retained
chart/keyboard checks in phone and split-screen day/dark/night layouts.

The replacement local build 115 passed `npm run ship:beta` from source commit
`e340c48cb74531ae8f75e5a4b16a8abce1568d36`, explicitly pinned through
`GITHUB_SHA`. The compiled diagnostics identify commit `e340c48cb745` and build
`115`. TypeScript, production build, release/bundle/route checks, Capacitor sync,
artifact secret scans and all 140 final release contracts passed.

- Main entry: `assets/main-1T3HmAbd.js` (18,465 bytes).
- Main SHA-256: `64d1d7532b89f56a3206734c5521344329d9d8a63d75ac63d25f08a565a88980`.
- JavaScript payload: 9,665,997 bytes (276 files), within the unchanged 9.9 MiB cap.
- All 419 generated web files match their embedded iOS copies byte-for-byte.

The compiled artifact passed all 14 selected Chromium/mobile-Safari smoke,
planner and Glass split-navigation checks in 28.9 seconds, with no retries or
skips. The new regression completes the real slider gesture, opens the choice,
then selects Manual and verifies the existing tracer opens armed without an
Auto calculation. Source-fixture checks separately cover authorized Auto.
Build 115 remains local: no archive or TestFlight upload was requested for this
entry-point revision. Build 114 is unchanged.
