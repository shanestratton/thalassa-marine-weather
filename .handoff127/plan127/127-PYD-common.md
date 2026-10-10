# 127-PYD common: Plan Your Day v3 (read with every 127-PYD-n plan)

Not a package. The run order, the budget, the licence rules, Shane's decisions
and the questions that the eleven 127-PYD packages share. Revised 2026-10-10
~17:00 after the critic's "revise" (every issue re-verified in code; each fix
is marked "critic 2026-10-10" where it lands) and Shane's five decisions.

## Authority

Shane, 2026-10-10 ~15:20, verbatim:

> "also, plan your day?? why does it only ever show the same 3 destinations.  ???
> it needs another good clean up claude.  also, when you select somewhere,  and
> plot on the chart.  it goes direct.  straight over hills. rocks, other boats,
> land, sea, air,  you name it.  also i did a few checks on the autoroute and it is
> banging at the moment.  so can we incorporate the autorouting into the plan your
> day thingy.  once you have made it pop a little more"

"banging" = working really well. Then, on build 127: "ok can we make this a
build on its own. without adding anything off the 127 list in the gap file?";
"the desktop experience needs to be 2nd to none. the best of the best"; "we
work within the rules, but we need to make it bang claude. better than what we
were going to do". Standing order: "your recommendations for all work
requiring an answer". The agreed vision is scratchpad/plan127/127-VISION.md
(§5 lane 1 is Plan Your Day).

**Shane's decisions, 2026-10-10 (applied in every PYD plan):**
1. PYD routing is ON for Shane's account only in 127's TestFlight, OFF for
   testers; a one-line flip later (`PYD_ROUTING_FOR`, below).
2. Build the "Route round the land" TAP (`PYD_ROUTE_ON_OPEN = false`). Switch
   to route-on-open only if his marina timings (Coral Sea Marina → Cid
   Harbour, Whitehaven, Daydream) are all ≤ 8 s, so 127 SHOWS him the routing
   time on a TestFlight build (127-PYD-2 decision 4: "Routed in N s").
3. Cut order if short: PYD-7, then PYD-6, then the sw.js half of 127-H → 128.
   Never cut PYD routing, plot or the leave window (2, 3, 11), C-a/b/c,
   DESKMAP + wind, 127-11.
4. Pi update 3 (C-d) approved for the dock (not a PYD concern).
5. PENDING his answer (our recommendation): keep saving autorouted routes as a
   line + grade words only (C10 strips charted depths and positions); stop and
   purge if Roberto says no. PYD's only save path (127-PYD-3) follows it.

Build 127 integration branch b127 (worktree
/Users/shanestratton/Projects/thalassa-marine-weather/.claude/worktrees/b127),
**HEAD 719645bb7** = 1b71c2ade (master bd2d35b07 + 127-01) + master 98aa277a6
(CI only: `.github/workflows/ci.yml`, 26+/7-). Every app file:line in these
plans was re-read at 719645bb7.

Investigations behind these plans (scratchpad/pyd127/): destinations.md
(why the same 3), plotroute.md (why the straight line, router entry points),
look.md + look/mock-pyd127.png (the look).

## The three findings in one paragraph each

1. **Same 3.** `preRank` (services/dayPlanner/today.ts:1064-1118) sorts by
   shelter grade, then Parks-reviewed first, then score, then distance; shelter
   saturates at "bombproof 100" in almost any wind under ~18 kn, so the three
   nearest open reviewed stops win (Cid 13.0, Tongue 16.7, Maureen's 17.1 NM: 8
   of 9 day x stay combos on this weekend's real forecast; Cid in 109 of 120
   synthetic runs). Only `SWEEP_STOPS = 3` (:99) are route-checked, chosen
   blind, never backfilled; All places rows other than those three are plain
   text (components/dayPlanner/TodaySheet.tsx:661-671); the 40-nearest cap
   (places.ts:55) cuts Butterfly/Blue Pearl/Nelly/Cateran/Hamilton and spends 7
   slots on channels the atlas marks `likelyAnchorage: false`.
2. **Straight line.** Plan Your Day never calls the router. "Plot on chart"
   (TodayStopDetail.tsx:145-152 → TodaySheet.tsx:272-276 → today.ts:1607
   `plotDayAction` → MapHub.tsx:839-881) loads [start, stop, start] as Manual
   pins and says "Straight lines to X: drag pins round the land" (:874). Times
   walk the same straight line stretched x1.15/1.3/1.4 (places.ts:65).
   **And a second straight line waits in the course frame (critic
   2026-10-10, HIGH):** with `traceDest` set, useTracerTraceLayer.ts:357-373
   draws the 'trace-dest-hint' dashed sky line from the last pin (or
   `traceOrigin`) straight to the destination. Dormant today (only the parked
   From/To boxes set a frame, MapHub.tsx:2738-2770), it would go live with
   127-PYD-3's "Plot by hand" frame; 3 suppresses it for Plan Your Day frames.
3. **No pop.** One flat slab (row/tile vs card 1.07:1 dark), three identical
   rows, red ✕ with the reason only in VoiceOver, thunder never in the headline,
   the same ✓/≈ glyphs meaning two things, nothing to act on.

## Packages, lanes and run order (vision §5)

| # | Package | Kind | Needs | Lane / status |
|---|---|---|---|---|
| 1 | Say why (P0 fixes) | copy + small CSS | - | Lane 1, first |
| 2 | Route the stop she opens | routing | - | Lane 1 |
| 4 | Different places, picked for a reason | engine | 1 | Lane 1 |
| 3 | Plot on chart = the routed line | routing | 2 | Lane 1 |
| 5 | Every place opens | engine + list | 2, 4 | Lane 1 |
| **11** | **Leave window (NEW)** | routing + tide | 2 | Lane 1, last |
| 6 | Day ribbon | visual 1 of 4 | 1, 4 | Lane 3, after DESKMAP: **CUT-LINE (2nd to slide)** |
| 7 | Best fit + two alternates | visual 2 of 4 | 4, 6 | Lane 3: **CUT-LINE (1st to slide)** |
| 8 | Stop page rebuilt | visual 3 of 4 | 2, 3, 7, 11 | **128** (vision §5) |
| 9 | Route pictures + shelter rose | visual 4 of 4 | 2, 7, 8 | **128** |
| 10 | Places worldwide | engine (global) | 4 | **128** |

- **Never cut (decision 3):** 1, 2, 3, 4, 5, 11. The autorouted plot (2 + 3)
  and the leave window (11) depend on nothing visual: if 6 and 7 slide, 127
  still ships varied, explained picks; every place opens; every opened stop
  routed strictly on her charts (Shane's account); Plot on chart = the routed
  line or two marks; never a straight line; the leave window.
- **Merge order, lane 1:** 1 → 2 → 4 → 3 → 5 → 11. Later merges rebase. 2 and
  4 both edit today.ts `planDay` (2: routed legs; 4: selection) and
  TodaySheet.tsx (2: route state; 4: rows); the functions differ.
- **Lane 3:** DESKMAP → DESKMAP-b (wind) → 6 → 7. 6 starts only after lane 1
  has merged 1 AND 4 (6 re-baselines screen 1, whose rows 4 changes); 7 after 6.

### Feasibility (critic 2026-10-10: the visual chain is serial on one spec)

- Measured pace (vision §5): build 126 merged 29 packages in ~20 h on three
  lanes, ~2 h of lane time per package. Lane 1 holds six packages, two of them
  M (2, 4): expect ~14-18 h of lane time, serial, because 1, 2, 4, 5 and 11
  all edit today.ts + TodaySheet.tsx + TodayStopDetail.tsx.
- **The serial file is the 1,423-line browser-tests/day-planner-layout.spec.ts.**
  Every PYD package adds Playwright cases; 6 and 7 re-baseline screen 1
  (`.today-cell`-keyed). Run in parallel they conflict on every merge.
  **Fix, decided here:** the stop-page and routing cases of 2, 3 and 11 go in
  a NEW spec, `browser-tests/day-planner-route.spec.ts` (same fixture, same
  `AS_DRAWN` sizes copied from day-planner-layout.spec.ts:63-72, same
  helpers), added to `playwright.day-planner.config.ts` `testMatch` (today
  `['day-planner-layout.spec.ts']`, :9) so CI's "Plan Your Day fit" job
  (.github/workflows/ci.yml:270) runs it. day-planner-layout.spec.ts keeps
  screen 1 and All places (1, 4, 5, 6, 7). Lane 3's 6 and 7 then conflict
  only with 1, 4 and 5, which merge first.
- **Decide the cut when lane 1 merges 4** (6's start gate), from measured
  progress, not at the end (the vision's cut line: "if Monday evening arrives
  first"). Cutting 6 and 7 does not speed lane 1 (its packages are serial on
  their own files); it protects lane 3's must-haves (DESKMAP + wind) and the
  ship date. So: if DESKMAP + wind are not merged when 4 merges, 7 slides at
  once; if 6 is not merged by Monday midday, 6 slides too. Lane 1 never waits
  for lane 3, and nothing in lane 1 depends on 6 or 7.
- **8 GB Mac:** at most 3 builders, one heavy command at a time (vitest
  `--maxWorkers=1`, Playwright `--workers=1`, no parallel tsc, `df` before a
  build). Copy .env / .env.local / .env.production.local into each worktree.
  Commit named files only, never `git add -A`.
- **Node:** Homebrew node@24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`);
  `/usr/local/bin/node` 24.12 is the fallback. pi-cache runs on node@22.

## The two switches (decisions 1 and 2), one place

New `services/dayPlanner/pydRouting.ts` (127-PYD-2 owns it):

```ts
/** Decision 1 (Shane 2026-10-10): Shane's account only in 127's TestFlight.
 *  The one-line flip after his smoke: 'owner' -> 'everyone'. */
export const PYD_ROUTING_FOR: 'owner' | 'everyone' = 'owner';
/** Decision 2: the "Route round the land" tap. true only if his three marina
 *  timings are all <= 8 s ("Routed in N s" on the stop page). */
export const PYD_ROUTE_ON_OPEN = false;
```

- "Shane's account" = the signed-in session's email equals
  `PLATFORM_OWNER_EMAIL` (services/chat/constants.ts:15, the constant
  ChatService already uses to find the platform owner, services/ChatService.ts:422),
  AND the session user id equals the current identity scope's userId
  (services/authIdentityScope.ts:10-17). Read once per sheet open through the
  sheet's injected `sources` (`sources.ownerAccount(): Promise<boolean>`,
  default: `supabase.auth.getSession()` from services/supabase, the stored
  session, no request unless the token needs refreshing), so the fixture
  can say owner or tester. Imported read-only; no chat file is edited.
- It is a rollout flag, not a security boundary: routing runs on the phone
  either way. With 'everyone', the provider's own gates still apply (signed
  in, Auto route (trial) switch on, charts at both ends,
  autoroutingThalassa.ts:255-279).
- **Testers in 127 (not the owner):** no route row, no "Route round the land"
  button, no leave window. "Plot on chart" becomes "Plot by hand" (two marks,
  no line; 127-PYD-3). Nothing mentions routing to them.
- **Owner timing readout:** owner only, whatever `PYD_ROUTING_FOR` says, so a
  later flip never shows testers the stopwatch.

## JS budget (read before estimating)

- The tripwire `javascript: 10.13 MiB` = 10,622,075 B
  (scripts/check-bundle-size.js:76) sums **every** dist/**/*.js, lazy chunks
  included. Lazy loading protects first load (`mainRaw` 800 KiB, `mainGzip`
  250 KiB) and nothing else; it does not buy tripwire room.
- Measured on b127 after 127-01: **10,609,246 B, headroom 12,829 B**
  (scratchpad/leave127/after-summary.txt). 98aa277a6 changed CI only.
- Plan Your Day is already lazy (DayPlannerEntry.tsx:11 `lazyRetry(() =>
  import('./TodaySheet'))`); the Auto workspace is already lazy
  (RoutingModeDialog.tsx:21). Every new import from PYD into router, Auto,
  tide or sweep code is a dynamic `import()`; code already in dist
  (calculateThalassaProposal, sweepDepartures, annotateRoute,
  computeTidalWindows, fetchTideCurve, inshoreRoutePieces) costs only a chunk
  wrapper.
- **PYD estimates, revised:** 1: 0.8, 2: 5.0-6.0 (owner flag + timing line in,
  the disclosure copies out), 4: 5, 3: 2.5-3.2 (frame kind + main-chart
  handoff in), 5: 1.5, **11: 1.0-1.5**; 6: 3, 7: 1.5 (cut-line); 8: 2, 9: 3.5,
  10: 3.5 (128). **127 must-list (1-5 + 11): ~16-18 KB; with 6 + 7: ~20-22 KB**
  (the vision's "PYD 1-7 + 11 ≈ 21 KB").
- **Trims inside PYD, done first and measured** (~-2 to -3 KB in 127): the
  straight-pin path and its toast (3); the old read-only `reviewProposal`
  mode folded into the day-plan mode instead of adding a second mode (3); the
  three tiles and the facts-line string assembly the ribbon replaces (6, if it
  ships). 8's prose trims move to 128 with 8.
- **Not ours to trim:** the parked ⚡ `useAutoRouteLeg` (MapHub.tsx:1858, ~20 KB
  source) is kept compiled on purpose (mapHubHelpers.ts:111-112 "Wiring stays
  compiled and tested").
- **Rule:** each package records its measured delta (sum of dist/**/*.js
  before/after, as 127-01 did). The 127 programme moves the tripwire ONCE,
  deliberately (vision §5 "JS"), after C9's deletions and the trims above are
  measured, with the reason in the check-bundle-size.js comment ("Build 127:
  Plan Your Day v3 (127-PYD-1..7, 11), charts stay on the boat (127-C-b,
  C-c and C-d's app half), the desk map + wind and orientation modes, ~N KB
  measured; C9, 127-H's barb deletion and the PYD trims came first"). Never
  to make a build pass silently.
- **Programme total (critic pass 2, 2026-10-10, summed from every 127 plan's
  own estimate; updated for critic pass 3):** the must-list (PYD 1-5 + 11 ≈
  15-20, C-b +2.3-3.9, C-a −1.5-2.0, C-c +5.6-8.1, C-d app half +2.5-3.2,
  DESKMAP +3.6, DESKMAP-b +2.1, 127-11 +6-7, 127-H −1.5-2.5) is **≈ +32 to
  +45 KB**, +35 to +49 KB with PYD-6/7, against 12.8 KB of headroom: the line
  moves by ≈ 19-36 KB, more than the vision's "+25 to +35 KB" (which did not
  count C-b/C-c/C-d). Shane's two "retire" answers (C-a Q1 S-63 card ≈ −5-7;
  C-c Q1 ENC Library ≈ −8-10) bring the must-list to ≈ +16-30 KB. Pass 3 added
  ~1.4 KB: C-c's tracer wait (7a), the `boatCharts` flag, DESKMAP's slot-0
  fix, and C-b's AvNav switch. schedule.md's ledger is the live copy. Inside the ~140 KB that
  check-bundle-size.js:75-76's comment already plans for builds 126-128.

## Licence rules (127 "charts stay on the boat"; o-charts ruling 2026-10-10)

Roberto: "Storing unencrypted data on any medium, and especially in the cloud,
is strictly prohibited by the terms of the licenses signed with the chart
providers." 127 design (vision §4, §6): protected cells decrypted on the Pi in
RAM (C1), phone memory-only (C3), proposal evidence memory-only (C8), no chart
numbers or positions on any disk (C10), provenance flag (C7).

1. **Route on the phone, from cells in memory.** PYD routes through Auto's
   provider `calculateThalassaProposal` (services/autoroutingThalassa.ts:249),
   whose engine reads cells only through EncCellStore / listCells. With C3
   those are memory-backed, so the same call works aboard (Pi on the LAN) and
   at sea. Away from the Pi, protected cells are absent and the provider's
   coverage gate (:274-279) says so; NOAA/open cells still route.
2. **Not the Pi's /api/enc/route.** It reads the plaintext store that C1
   deletes (pi-cache/src/routes/enc.ts:1468-1630), merges 9 layers, has no
   tides, air draft, marks or OSM water, runs permissive, and C-d switches it
   to 503. Never call it from PYD.
3. **PYD writes nothing chart-derived.** Routes, disclosures, pin depth
   verdicts, leave windows and thumbnails live in memory for the sheet's life:
   never localStorage, Preferences, IndexedDB, Filesystem, the account or logs.
   **PYD's one log line** is the owner timing line (127-PYD-2): durations in
   ms only, no positions, no names, no depths. The engine wrapper already logs
   the two PINS at warn level (InshoreRouter.ts:857-859 "ENTRY origin=…
   dest=…"), as it does for Auto: her positions, not chart geometry; left alone.
4. **Showing** a routed line and its colouring is fine (in memory).
   **Saving / following** goes through one of two existing paths, never a new
   store (127-PYD-3):
   - "Use on the main chart": the routed line handed to the Manual plotter
     as an unsaved draft (her line; useTraceDraft keeps pins in
     sessionStorage, the class the constitution allows, vision §4.1 rule 3);
     the Route report grades it; Sail follows it (MapHub.tsx:1670-1695
     `sailTrace`); the plotter's own Save writes the line + verification
     words. No `proposal_evidence`.
   - Auto's planned-only Save card, inside the day-plan chart, only once C-b
     (C8 memory-only evidence + C10) is in b127.
   Both write a line of positions worked out on o-charts cells: decision 5
   (pending), our recommendation keep, stop and purge if Roberto says no.
5. **Pictures never draw chart geometry.** Thumbnails (9, 128) draw
   OpenStreetMap coastline (ODbL, credited) plus the route polyline only.
6. **No engine file is edited by any PYD package.** services/inshoreRouterEngine.ts
   and its import graph are mirrored to the Pi by
   pi-cache/scripts/sync-router-engine.mjs; touching them would make a PYD
   package a Pi deploy (app-before-Pi). services/autoroutingThalassa.ts,
   types/autorouting.ts, services/routing/DepartureSweepInshore.ts and
   services/routing/inshoreTideSpots.ts are not in that graph (127-PYD-2
   changes only the first two, and only to carry `departureMs`).
7. **Tide (11).** WorldTides is the app's tide source (TideHeightService.ts:
   220-223, fetchWorldTides via pi-cache → Supabase proxy → direct). Its terms
   (vision §4.3): results may be cached for and redisplayed to that end user
   only, and "Do not use WorldTides as the only source for navigation". So the
   leave window is shown to her only, says "check the official tide table",
   is never on a shared surface, and never stored.

## Routing rules (from Shane's router decisions)

- Strict only: the app routes `unchartedPolicy: 'strict'`
  (services/InshoreRouter.ts:2038). Auto's provider adds the hard-land refusal
  (:376-380), the 500 m pin-gap refusal (:410-423) and the satellite land
  check (:432-440). Measure in strict.
- Charted leads (NAVLNE CATNAV 3, RECTRC) are followed by the engine; nothing
  in PYD overrides them.
- Shallow = amber "needs tide"; dry = red, named (in Auto's own warnings,
  inshoreRouteCaveats `dryRuns`, autoroutingThalassa.ts:443-466); route ends
  run amber to the pin; never refuse a whole route for dry or shallow
  stretches (Shane 2026-10-08). Structures as the engine already does them: a
  cell with no structure data = route + warning (`structuresUnknownCells`); a
  charted bridge or cable the mast cannot clear, or any structure when no air
  draft is set (owner decision 5, autoroutingThalassa.ts:281-283), refuses.
  PYD changes none of it.
- **Never a straight line drawn as a route, and never a straight line drawn
  at all from Plan Your Day.** No route = the reason in plain words and, for
  plotting by hand, the two end marks only, with the course frame's
  'trace-dest-hint' suppressed for a Plan Your Day frame (127-PYD-3 decision
  6; critic 2026-10-10, HIGH).
- **What the routed proposal really carries** (critic 2026-10-10;
  types/autorouting.ts:39-90, autoroutingThalassa.ts:496-537): `coordinates`,
  `warnings` (sentences: never parsed for numbers), `createdAt`,
  `vesselProfile`, and `engine` (`ThalassaRouteDisclosure`): `stateMask`,
  the masks, `cautionWhy`, `cautionDepthM`, `tideDepthM`, `tideNeedM`,
  `shallowRuns` (`ShallowRunInfo`: `startSeg`, `endSeg`, `lengthM`,
  `minDepthM`, `midLat/Lon`, `minAtLat/Lon`, `endpointTail`, `dryTail`,
  `partUncharted`, `nearHazard`, `chartsDisagree`, …), `chartedShallowSpans`,
  `surveyRuns`, `structuresUnknownCells`, `pinOffWater`, `tideCheck`,
  `destinationInlandTrimM`, `cellsUsed`, `distanceNM`, `elapsedMs`,
  `backstop`, `backstopReason`, `hardLandAwayM`, `tideCeilingsLoaded`. **There
  is no `dryRuns` and no `pinTail` field;** PYD uses only the fields above
  (a pin tail is `shallowRuns[].endpointTail`; a pin's dry tail is
  `shallowRuns[].dryTail`; named dry stretches stay in Auto's sentences).

## Global rules

- Worldwide-first: every package has a non-Queensland test (the fixture's
  noumea and tromso modes; synthetic Brittany/Solent-like sets in 10).
- Coverage said honestly: "No chart for X on this phone", "depth not checked",
  "Shelter not known", "tide not known", "No anchorages or named bays mapped
  near here (OpenStreetMap)". Never blank, never silently wrong, and never a
  sentence that is only true for a boat with a Pi (critic 2026-10-10: a NOAA
  user has no Pi).
- No Queensland words in global UI: "Parks" becomes "Local notes" (1); the
  reviewer is named in the note itself ("Queensland Parks say…").
- Times on the PLACE's clock (already true; keep it).

## Layout rules

- Menu pages/sheets fit one screen at 375x667 and up at normal text (the
  126-17b inner-scroll for worst-case stop lists stays the only scroll on
  screen 1); 320x568 and large text may scroll inside the card.
- **The room the sheet really gets** (day-planner-layout.spec.ts:44-52,
  measured with the app's root and insets): **483 px** at 320x568, **572 px**
  at 375x667, **685 px** at 390x844, **754 px** at 430x932. Every new block is
  budgeted against these, not against the viewport.
- Modals centred, clear of the tab bar (TodayModal and OverlayPortal already).
- Real chrome in Playwright: `AS_DRAWN` sizes with `&root=app`
  (day-planner-layout.spec.ts:63-72), the fixture's real tab bar
  (e2e/fixtures/day-planner.tsx:221-232), Chromium + WebKit, SF and
  `fonts=wide`, the 1024x768 split pane, landscape, large text.

## Questions only Shane can answer (each with our recommendation)

1. **Decision 5, still pending:** may routes worked out on o-charts cells keep
   being saved (a line + grade words; C10 strips charted depths and
   positions)? It bites 127-PYD-3's "Use on the main chart" → Save.
   **Recommendation: yes, keep it; stop and purge if Roberto says no** (one
   sentence in the follow-up after his reply, ~Tue 13 Oct).
2. **Which account is "yours".** The flag keys on the email the chat already
   treats as the platform owner (shane.stratton@gmail.com). **Recommendation:
   keep that; if your TestFlight sign-in is Apple's hide-my-email, tell us and
   we key it to your user id instead.** The device smoke's first step shows
   whether it took (the "Route round the land" button is there or not).

Answered and applied: the Auto route (trial) default (decision 1), route on
open vs tap (decision 2), the cut order (decision 3).
