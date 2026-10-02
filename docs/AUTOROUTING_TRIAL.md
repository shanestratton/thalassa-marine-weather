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
- **The leg review says why (review fix-up, 2026-10-03).** Until the chart
  layer draws the detailed chart over the overview (item (f)), the map still
  shows the overview's brown land under a green Cid Harbour line. Each leg
  over such ground now carries a note, "overview chart shows land here;
  detailed chart charts water" (`grid.overviewLandIgnored`, routeTracer). It
  is an 'info' note and never changes the grade. Ship decision 12 in the same
  push as (f); the note is the fallback, not the fix.
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
