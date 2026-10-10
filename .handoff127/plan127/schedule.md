# Build 127 schedule: the boat is the navigator

Written 2026-10-10 ~17:20 AEST from the plans in this folder (every plan read against b127 @ 719645bb7 =
master bd2d35b07 + 127-01 + master 98aa277a6), the agreed vision (127-VISION.md §5) and the critic's second
pass ("revise": its fixes are already in the plans; its open issues are settled below, each marked *critic*).
Revised ~17:45 for the critic's third pass:
- C-c decision 7a (the tracer waits for the boat registry);
- DESKMAP C1/C2 (the licensed-charts words only for an account whose Pi holds licensed charts);
- C-b decision 11 (AvNav o-charts pictures off on the phone).
Sizes and the ledger below follow.

Revised again ~22:30 for **127-ROUTE-W**: routing moves off the main thread (plan127/127-ROUTE-W.md, from the
measurement in scratchpad/routew127/measure.md). It joins lane 1 after PYD-4 and before PYD-2. PYD-2 now depends
on it.

State at 22:26 (observed, not planned):
- b127 = b2b865490, on the rewritten history, with 127-01, PYD-1 (a3c4b9c70) and DESKMAP (b2b865490) merged.
- In flight:
  - lane 1: PYD-4, branch pydplaces127, tests first;
  - lane 2: C-b, branch chartsb127;
  - lane 3: DESKMAP-b, branch deskwind127.
- Lane 1 ran PYD-4 ahead of PYD-2: PYD-4's only hard need is PYD-1 (127-PYD-4.md:3).

**Authority**
- Shane, 2026-10-10, verbatim: "ok can we make this a build on its own. without adding anything off the 127 list in
  the gap file?"; "oh, um add in the course up and north up etc. that is cool to see as well"; "can we include the
  wind layer on the desktop.?? as an option??"; "the desktop experience needs to be 2nd to none. the best of the
  best"; "we work within the rules, but we need to make it bang claude. better than what we were going to do".
- Shane, 2026-10-10 evening, verbatim, asked whether the app freezes during the one-minute autoroute: "yes for
  a short while it looked as though the app had frozen". Our question had said that a yes means routing moves
  into the background in 127, "so Plan Your Day never locks up the phone". → 127-ROUTE-W.
- o-charts (Roberto), 2026-10-10, verbatim: "Storing unencrypted data on any medium, and especially in the cloud,
  is strictly prohibited by the terms of the licenses signed with the chart providers."
- Shane's decisions of 2026-10-10: (1) PYD routing on for his account only; (2) the "Route round the land" tap,
  with route-on-open only if his three marina timings are ≤ 8 s; (3) the cut order PYD-7, then PYD-6, then the sw.js
  half of 127-H; never cut PYD routing, plot or leave window, C-a/b/c, DESKMAP + wind, 127-11; (4) Pi update 3
  approved for the dock after two root checks; (5) PENDING: keep saving autorouted routes as a line + grade words.
- Standing order, verbatim: "your recommendations for all work requiring an answer". Every call below is our
  recommendation on that order. Master pushes, edge deploys, the history rewrite and Pi installs still need his
  yes at the time, and he runs them himself (the classifier blocks them for me).

## The answer in one paragraph

Build 127 is **17 packages** (18 with 127-01, done), run as **20 builder runs on three lanes** (C-a, C-d and
127-11 are split in two). 127-ROUTE-W was added ~22:30 on Shane's "yes".
- **Pace.** At 126's measured pace (32 merges in ~17 h on three lanes, ~1.6 h per package per lane: S ≈ 1 h,
  M ≈ 1.5 h, the big Ms 2-2.5 h, Pi/L work 3-4 h), lanes 2 and 3 need **10-11.5 h each**. Lane 1 now needs
  **~11.5-14 h**, because ROUTE-W adds 3-3.5 h in front of PYD-2.
- **When.** Lane 2 merges everything by **Sunday ~05:00-08:00**. Lane 1 finishes about **Sunday ~09:00-11:15**,
  and so does lane 3, whose last item (11b) waits for PYD-3. Assembly takes ~4 h after that, so the target is
  **TestFlight 127 on Sunday 11 Oct, evening**.
  If review fixes run long it is **Monday 12 Oct midday**. **Monday evening is the cut line.**
- **Pi update 3.** Its Pi half ships on its own clock: staged Sunday, installed at the dock after 127 is on his
  phone.

- **What is in, in priority order:**
  - **Plan Your Day routes the stop she opens**, on her charts, for Shane's account. It shows different places with a
    reason for each, plots the routed line (never a straight one), opens every place, and gives the leave window.
  - **Routing never locks up the phone (127-ROUTE-W).** Auto, Plan Your Day, the planner and every other route run
    the router in a worker, and Stop really stops it. It also folds the tracer's navGrid worker in, for about
    −26 to −30 KB of JS.
  - **Charts stay on the boat:** the licence flag, no chart numbers on any disk, the S-63 and personal-shelf code
    deleted with a CI guard, the phone holding licensed cells in memory only, and the app half of Pi update 3.
  - **The desk map:** Light base + Relief seabed + OpenSeaMap seamarks, wind as an option, and chart orientation
    (North / Course / Track / Heading up).
  - Licence hygiene (127-H).
  - The two pop packages (PYD-6, PYD-7), which are the first to slide.
- **What can't be avoided:** the JS line.
  - At plan, 127 needs about +37 to +50 KB, with PYD-1 and DESKMAP measured: +1.4 KB against a plan of 0.6-1.0,
    and +8.0 KB against 3.6. That is +21 to +35 KB if Shane says yes to both "retire" questions.
  - ROUTE-W's −26 to −30 KB brings that to about **+7 to +24 KB**, or about −9 to +9 KB with both retires.
  - Measured at b2b865490, 3,272 B of headroom is left.
  - One deliberate move at assembly, with his OK (§ Bundle ledger). ROUTE-W makes it small.

## Rules for running it

1. **b127** = worktree `.claude/worktrees/b127`, HEAD 719645bb7 (127-01 merged at 1b71c2ade, master 98aa277a6
   merged). Every package branches from b127 and rebases on b127 before its finish stage. Worktrees go in
   `thalassa-marine-weather/.claude/worktrees/<name>`. Copy .env / .env.local / .env.production.local into each
   one. Use `refs/heads/b127` if the name is ambiguous.
2. **At most 3 builders** (Codex shares the Mac).
   - One heavy command at a time across all lanes: vitest `--maxWorkers=1`, Playwright `--workers=1`, no parallel
     tsc, router suites at 4096 heap, memguard.
   - `df -h /System/Volumes/Data` before every build. **12 GiB free at 17:11 today; stop under 5 GB.**
   - Node: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. pi-cache runs on node@22, CI's version.
3. **Native compiles one at a time.** Only lane 2 touches Swift, and its two Swift packages run back to back in
   that lane:
   - C-d's app half: SecureStoragePlugin.swift;
   - C-c: EncryptedLargeStoragePlugin.swift (`prepareChartStore` + `purgeWebDiskCache`, the latter for C-b's
     decision 11) + Info.plist.

   C-b has no native change. No pbxproj change.
4. **Same files, same lane, in dependency order.** Where a file is shared across lanes only by separate hunks,
   the later merge rebases (see Cross-lane hunks). No package edits a Codex-owned file.
5. **Named files only**, never `git add -A`. Commit between phases. Fictional data only: new test data uses
   `OC-99-ZZ…` ids and the synthetic harbour kit, never a real cell (C-a's guard will fail anything else).
6. **JS: measure at every merge, never raise the line mid-build.** Log each package's measured delta (sum of
   dist/**/*.js before and after, as 127-01 did) in the ledger below. Once b127 crosses the line, check:bundle
   reports "over by N" at each merge. That is logged and expected, and it is not a reason to stop. The line moves
   once, at assembly (§ Bundle ledger).
7. **Builder prompts quote Shane's authorising words verbatim** (above). After any interrupt, check every agent's
   tail and restart with resumeFromRunId.
8. **No push notifications to Shane 22:00-07:00** (run `date` first). Merges into b127 are local and run overnight.
   Gates that need him wait for the morning.

## Step 0: ops, now (no builder slot)

- **Questions that block a lane soon.** Put them to Shane tonight, each with our recommendation (see Gates and
  asks): C-a Q2 (before Phase 0 finishes), C-a Q1 (before C-a Phase 1, ~23:00), C-c Q1 (before C-c, ~02:00), the
  JS move, and the "which account is yours" check for PYD-2.
- **AvNav header check for C-b's decision 11 (mine, read-only; no longer a blocker, critic pass 3).** C-b now
  switches the AvNav o-charts picture path off on the phone whatever the headers say: no-store can't be forced
  from our side, and pi-cache can't front Mapbox tiles. The check is evidence for the day it is switched back on.
  - Over ssh to calypso, run `curl -sI` on one o-charts tile from the provider on localhost.
  - A plain z/x/y path may not answer like an encrypted tile; record whatever it says.
  - Save no tile body. Record `Cache-Control`/`Expires`/`Last-Modified`.
  - Announce it before. If the classifier stops it, skip it: nothing waits on it.
- **The JS baseline is already measured:** 10,609,246 B, 12,829 B headroom (scratchpad/leave127/after-summary.txt).

## The Sunday history rewrite (C-a Phase 0's gate), and how the lanes live through it

- **Phase 0** runs first in lane 2, on a worktree from **master** 98aa277a6 (not b127). It `git rm`s the 7
  fixtures, gates their users (each gate counted in a ledger), and adds the guard in report-only form for the 24
  OC-id hits. **Shane pushes it** (a master push is a Vercel deploy; tests only, so no app change). Then he runs the
  audit's B1c `git filter-repo` from a mirror clone, adding C-a Q2's two `--path` lines if he says yes, and
  force-pushes. Before he starts: `gh run list` shows no CMEMS pipeline mid-run, and Codex is told.
- **When:** Phase 0 is ready by ~19:30 tonight. **Our recommendation: rewrite tonight before 22:00 if you can.**
  b127 then holds only 2-3 merges and the rebase is trivial. Otherwise first thing Sunday (~07:30), as the audit
  planned. Both work.
- **How the lanes survive it without stopping:**
  - I rebase b127 onto the rewritten master between merges: `git rebase --onto origin/master <old master tip>
    refs/heads/b127`, with `--rebase-merges` if any merge carries a resolution.
  - Each in-flight package rebases onto the new b127 at its own finish step, using its recorded old base.
  - **C-a Phase 1 does not merge until b127 is rebased** (C-a's gate). If the rewrite slips to Sunday, C-a P1, and
    C-c stacked on C-a P1's branch, finish overnight and merge in order right after the rebase.
- **gc last.** `git reflog expire --expire=now --all && git gc --prune=now` runs once, with all builders between
  runs, and only after:
  - Codex has rebased its branches (its two worktrees share this object store);
  - the stale worktrees are re-pointed or removed: b126, ops125 and encshelfpush (after a merged check), and
    thalassa-ux-audit's wt-base and wt-head (detached at old commits).

  Until then the old blobs stay reachable on this Mac.
- **Shane's B1d-B1f after the rewrite** (any time Sunday):
  - GitHub Support purge request;
  - delete Actions artifacts and caches;
  - Pi clone `fetch --depth 1` + `reset --hard`;
  - wx portal-build re-clone.

## The lanes

Hours are lane time at 126's pace and include both reviews and the finish fixes. "Clock" assumes a ~18:00 Sat start.

### Lane 1: Route the day (Plan Your Day routing) (≈ 11.5-14 h; revised ~22:30 for ROUTE-W)

| # | id | size | est h | JS KB (plan) | needs | clock done | gates (Shane's) |
|---|---|---|---|---|---|---|---|
| 1 | 127-PYD-1 say why | S | 1 | +0.6-1.0 (**+1,388 B measured**) | – | **merged a3c4b9c70** | none |
| 2 | 127-PYD-4 different places, picked for a reason | M (big) | 2-2.5 | +4.5-6.0 | 1 | in flight (pydplaces127, from ~22:10) → ~00:15-00:45 | device smoke Sat/Sun/Mon × 2 h/4 h/overnight |
| 3 | **127-ROUTE-W routing off the main thread** | M-L | 3-3.5 (1 h spike first) | **−26 to −30 net** (+5-9 new, −35.0 navGrid worker fold) | – (rebases on C-b if C-b merged first) | ~03:15-04:15 | none to merge; device smoke folded into PYD-2's |
| 4 | 127-PYD-2 route the stop she opens | M (big) | 2-2.5 | +5.0-6.0 | 1, **ROUTE-W** | ~05:15-06:45 | marina timings Cid/Whitehaven/Daydream (≤ 8 s each → flip `PYD_ROUTE_ON_OPEN`); account check |
| 5 | 127-PYD-3 Plot on chart = the routed line | M | 1.5-2 | +2.5-3.2 (incl. the straight-pin trim) | 2, **C-b merged** (Save card, v5 stubs) | ~06:45-08:45 | device smoke; decision 5 |
| 6 | 127-PYD-5 every place opens | S-M | 1-1.5 | +1.0-2.0 | 2, 4 | ~07:45-10:15 | none |
| 7 | 127-PYD-11 leave window | S | 1 | +1.0-1.5 | 2 | ~08:45-11:15 | device smoke vs the official tide table |

- **Why this order:**
  - **ROUTE-W before PYD-2** (Shane's "yes for a short while it looked as though the app had frozen"). PYD-2's
    route runs through ROUTE-W's worker, and its close-the-page-cancels rule needs ROUTE-W's real Stop.
    ROUTE-W touches no Plan Your Day file.
  - **ROUTE-W's spike gates it.** Phase 0 is ~1 h: the `router-engine` chunk must load as a module worker in
    WebKit, and the chunk split must cost ≤ +5 KB (critic: +3 KB was below the plan's own +1.1 to +3.2
    estimate for it; the −35 KB fold pays).
    - If it fails, ROUTE-W ships its ~0.6 KB fallback half in ~1 h, and PYD-2 starts ~2 h earlier with its
      *(fallback)* words.
    - The worker then moves to 128, and Shane hears in the morning.
  - Otherwise it is PYD-common's merge order. 1, 2, 4, 5 and 11 all edit today.ts, TodaySheet.tsx and
    TodayStopDetail.tsx, so the lane is serial on its own files. PYD-4 went ahead of PYD-2 (observed), and PYD-2
    rebases on its hunks.
  - Cutting PYD-6/7 would not speed it up. Lane 1 never waits for lane 3, and nothing here depends on 6 or 7.
  - PYD-3 lands after C-b (lane 2, ~21:30). Its "Use on the main chart" hands hundreds of legs to the plotter's
    verdict cache, so it must never ship without C-b's v5 stubs. The timing makes that order natural.
- **Stop-page fit (critic, low):** the longest routed stop at 375x667 (572 px) is the Playwright test's to judge.
  If it fails, PYD-11's fold order applies (risk 4).

### Lane 2: Charts stay on the boat (compliance) (≈ 8.5-11 h, then the Pi half 3-4 h on its own clock)

| # | id | size | est h | JS KB (plan) | needs | clock done | gates (Shane's) |
|---|---|---|---|---|---|---|---|
| 1 | 127-C-a **Phase 0** (on master) | S | 1-1.5 | 0 (tests) | C-a Q2 answer | ~19:00-19:30 | **Shane pushes master, then the rewrite** (above) |
| 2 | 127-C-b licence flag, memory-only evidence, C10, AvNav o-charts pictures off | M | 1.5-2 | +2.3-3.9 (net of −1.2-1.8 sw.js) | – (the AvNav header check no longer blocks) | ~20:30-21:30 | release-day cloud check (read-only, his approval); notes-scrub SQL if notes > 0 (he runs it); decision 5 |
| 3 | 127-C-a **Phase 1** (C9, C5, guard; P1 ports) | M-L | 2.5-3 | −1.5-2.0 (Q1 yes: −6.5 to −9) | C-b; **b127 rebased after the rewrite** before it merges | ~23:00-00:30 (merge may wait for the rewrite) | C-a Q1 |
| 4 | 127-C-d **app half** (enrol, token header, `PiHttpError`, PiCacheTab row) | S | 1-1.5 | +2.5-3.2 | – | ~00:00-02:00 | must be on his phone before the Pi install |
| 5 | 127-C-c phone holds licensed cells in memory only, + 7a tracer wait, `boatCharts` flag, WebKit cache purge | M (big) | 2.5-3 | +5.6-8.1 (Q1 retire: −2 to −3 net) | C-b, C-a P1 (stack on its branch if the rewrite is Sunday), C-d app (imports `PiHttpError`, words) | ~02:00-05:00 | ~20-min dock smoke (memory vs the 2 GB WebContent cap; force-quit with a route in the tracer); old iCloud backups; C-c Q1; Roberto Q1 → `BOAT_CELLS_ON_PHONE` |
| 6 | 127-C-d **Pi half** (vault, stage, Mac dry run) | M-L | 3-4 | 0 app bytes | C-a P1 + C-b merged; measurement M0-M5 on calypso | Sunday daytime | measurement OK (C-d Q2); rootchecks PASS; dock install; phone smoke; purge.sh same visit (C-d Q1) |

- **Why this order:**
  - Phase 0 is first because CI on master must be green before the rewrite, and the rewrite gates C-a P1.
  - C-b is first in b127 because PYD-3's Save card and C-c both build on its classifier
    (services/enc/chartLicence.ts) and its v5 stubs.
  - C-a P1 is before C-c: C-c rebases on C-a's deletions in EncCellStore, EncHazardService and EncImportService.
  - **C-d's app half moves ahead of C-c.** C-c imports `PiHttpError` and `piChartAccessWords` from it, and both
    edit PiPairingService.ts and the boat-network fixture. The two Swift compiles stay back to back.
- **C-c decision 7a is written first, test-first (critic HIGH, passes 2 and 3).** Pass 3 found two more facts,
  both read in b127:
  - a pass graded before registration also **overwrites** the aboard bank (one payload per account, rewritten
    after every cluster);
  - registration rode the auto-sync, which **never runs while the tracer is open** (autoSyncFromPi.ts:95-98).

  So the gate can't simply wait. The design:
  - `ensureBoatRegistry()` is called by the tracer itself, is metadata only, and is never deferred by plotting;
  - 'pending': no hydrate, no grade, no persist, and the line "Opening Serene Summer's charts from the Pi…";
  - the hydrate is keyed by fingerprint, not one-shot, and re-runs on the transition to 'loaded';
  - 'away' verdicts are provisional: never persisted, never releasable;
  - the background check waits the same way.

  Test 13 (failing first) pins: zero legs graded while pending; zero regrades after registration and after a
  jetsam reload; the bank byte-identical after an ashore launch; one effect re-run per transition.
- **C-d's Pi half takes the first lane that frees up after C-a P1 has merged** (critic: it sat in no lane):
  lane 2 after C-c, or lane 1 after PYD-11. It writes pi-cache files that C-a and C-b also touch, so it always
  rebases on them.
  - The measurement runs Sunday daytime: read-only, announced, no watch armed, alongside.
  - It is not a TestFlight blocker.
  - Its in-package cut order (prewarm → 128; installs-paused; enrol-only device list) applies if short.

### Lane 3: The desk and the pop (≈ 10-11.5 h of work; 11b, last, waits for PYD-3)

| # | id | size | est h | JS KB (plan) | needs | clock done | gates (Shane's) |
|---|---|---|---|---|---|---|---|
| 1 | 127-DESKMAP Light base + Relief + OpenSeaMap, honest off the boat (3 commits) | M | 2-2.5 | +3.6 | – | ~20:00-20:30 | live with the release master push; OpenSeaMap courtesy note (his) |
| 2 | 127-DESKMAP-b wind on the desk | S | 1-1.5 | +2.1 (stopgap skipped, see below) | DESKMAP | ~21:00-22:00 | Open-Meteo dashboard watch, week 1 |
| 3 | 127-11a "the chart can turn" (audit fixes, keyboard lock) | M− | 1.5 | ~half of +6.0-7.0 | DESKMAP, DESKMAP-b | ~22:30-23:30 | none |
| 4 | 127-H licence hygiene (H1 sw.js + H2 Open-Meteo paid) | S | 1-1.5 | −1.5 to −2.5 | C-b merged (sw.js) | ~23:30-01:00 | **3 edge deploys before the TestFlight build and master push**; Calypso smoke |
| 5 | 127-PYD-6 day ribbon (**cut-line 2**) | M | 1.5 | +1.7-2.7 | PYD-1 + PYD-4 merged | ~01:00-02:30 | none |
| 6 | 127-PYD-7 best fit + two alternates (**cut-line 1**) | M | 1.5 | +1.0-2.0 | PYD-6 | ~02:30-04:00 | none |
| 7 | 127-11b "the modes" (controller, arrow, chooser, rose) | M− | 1.5 | the rest of +6.0-7.0 | 11a, **PYD-3 merged** (~06:45-08:45 since ROUTE-W) | ~08:15-10:15 | device smokes; 127-11 Q1/Q2 |

- **Why this lane, and this order (a change from the vision, on the same-file rule and the critic's lane-2
  overload):**
  - **127-11 moves here from lane 2.** It shares six files with DESKMAP/DESKMAP-b (MapHub.tsx, useMapInit.ts,
    MapboxVelocityOverlay.tsx, CloseInWindLayer.ts, logMap.ts, chat/PinMapViewer.tsx) and none with C-a..d, apart
    from C-b's one MapHub call.
  - **127-H moves here too** (critic recommendation).
  - Lane 2 drops from ~8-9.5 planner-days to its compliance chain.
- **127-11 is split in two runs.** Its plan already ships 11a alone.
  - 11a defers its one AutoroutingTrialWorkspace.tsx line to 11b, so 11a never waits for PYD-3.
  - 11b starts only after PYD-3 has merged. **Since ROUTE-W, PYD-3 lands ~06:45-08:45, so 11b moves to the end
    of lane 3, after PYD-7** (DESKMAP-b, 11a, 127-H, PYD-6, PYD-7, then 11b). Lane 3 never idles waiting for it.
  - 11b's one AutoroutingTrialWorkspace.tsx line rebases on ROUTE-W's status/footer hunks and PYD-3's day-plan
    mode.
- **DESKMAP-b skips its rotation stopgap** (decision 10: "only if 11a is absent"). 11a follows it in the same
  lane and is never cut, so the stopgap is never needed. If 11a ever slipped, the stopgap is a 0.2 KB follow-up.
- **PYD-6 waits for PYD-1 and PYD-4** (it re-baselines screen 1). PYD-7 waits for PYD-6.
  - Both are cut-line items, so they sit behind the never-cut DESKMAP, DESKMAP-b, 127-11 and 127-H.
  - PYD-6 takes the gap before 11b's PYD-3 gate.
- **DESKMAP build brief, decided here (critic, medium + low):**
  1. **Superseded by the plan itself (critic pass 3, DESKMAP C1/C2).** "Licensed charts stay on {vessel}" shows
     only with the account flag `settings.boatCharts.licensed`, which C-c's registration writes from the paired
     Pi's index. The earlier signal, "a saved verification fingerprint naming a protected id", would have
     misfired for the four accounts that pulled licensed cells from the old cloud shelves.
     - Everyone else gets "No chart for this area", or a blank line over a NOAA cell.
     - On web Obs: "No chart for this area. Open charts (NOAA) show here in US waters."
     - Never "licensed" or a boat name without the flag.
  2. A strip line "Seabed: model depth, not a chart" shows whenever the GEBCO tint is visible on Light. That is
     the vision wording Shane agreed, and it is cheap.

### First three, now

- **127-PYD-1** (lane 1)
- **127-C-a Phase 0** (lane 2, on master)
- **127-DESKMAP** (lane 3)

## Day plan, checkpoints and the cut

- **Sat 18:00 → Sun ~07:00 (lane 1 to ~11:00):**
  - Lane 1: PYD-1 ✓, PYD-4, **ROUTE-W**, PYD-2, PYD-3, PYD-5, PYD-11.
  - Lane 2: Phase 0 (handed to Shane ~19:30), C-b, C-a P1, C-d app, C-c, then the C-d Pi half.
  - Lane 3: DESKMAP ✓, DESKMAP-b, 11a, 127-H, PYD-6, PYD-7, 11b (11b last: it waits for PYD-3).
- **Cut decision at PYD-4's merge (~Sun 00:00), from measured progress** (PYD-common):
  - If DESKMAP + wind are not merged by then, PYD-7 slides at once.
  - If PYD-6 is not merged by **Monday midday**, it slides too.
  - Then 127-H's H1 (sw.js) slides. **H1-floor ships instead:** Mapbox leaves the service worker's cache list (one
    line), so 127 stays compliant and only the speed-up moves.
  - Inside packages, if short: C-a's P2 ports → 128 (still counted in the ledger), and C-d's own cut order.
  - **Never cut:** PYD-1..5 + 11, C-a/b/c, DESKMAP + wind, 127-11 (ask Shane before touching it), C-d's never-cut
    list.
- **Checkpoint Sun ~07:30 (Shane up):** every TestFlight package should be merged or in its finish stage, except
  lane 1's tail (PYD-3, PYD-5, PYD-11) and lane 3's 11b, which since ROUTE-W are due ~09:00-11:15. Tell him
  ROUTE-W's spike result then.
  - **Behind by more than ~3 h of lane time:** slide PYD-7, then PYD-6, then H1, and tell him.
  - **Ahead:** the C-d Pi half gets a second slot for its measurement and dry run. Nothing from 128 comes in
    (Shane: "without adding anything off the 127 list").
- **Sunday morning:**
  - the rewrite, if not done last night;
  - the rebase and gc;
  - the held C-a P1 → C-c merges;
  - the C-d measurement (with his OK);
  - his three edge deploys.
- **Assembly (Sun from ~11:00-11:30, ~4 h; was ~09:00-10:00 before ROUTE-W):**
  1. Merge order check: the never-cut set is in, and C-b precedes PYD-3 and C-c.
  2. **No migration and no DB push in 127** (critic, low).
  3. Version bump to 127.
  4. **The one JS move** (§ Bundle ledger) and the Lighthouse ratchet.
  5. CI-identical verify on b127:
     - vitest single worker;
     - e2e and keyboard (testMatch complete);
     - the day-planner config, with the new day-planner-route.spec.ts;
     - build, check:bundle, Lighthouse;
     - deno check/fmt/test for the three edge functions;
     - pi-cache build/test on node@22;
     - the router mirror `--check`;
     - C-a's guard with its ledger count.
  6. `npm run check:ios-injector`, `plutil -lint` Info.plist,
     `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx cap sync ios`, `df`, then the archive.
  7. C-b's read-only cloud check. If notes > 0, Shane runs the staged scrub (SELECT first).
  8. **Shane deploys** proxy-openmeteo, proxy-bosun-fallback and check-weather-alerts (127-H), before the master
     push.
  9. **Shane runs `git push origin master`.** Check prod first, because Codex pushes master too. This is the
     Vercel deploy that puts the desk map, the wind, the CSP and sw.js live. Wait for CI green.
  10. I upload with `xcodebuild -exportArchive`.

## Cross-lane hunks (additive; the later merge rebases, and the expected order is given)

- **MapHub.tsx** has six packages in three lanes, the biggest conflict surface. The hunks are named in each plan:
  1. DESKMAP: desk state, menu, strip (slot 0 from the `boatCharts` flag), sketch banner;
  2. C-b: one `regradeStubLegs` call on report open;
  3. DESKMAP-b: desk wind state and row;
  4. PYD-3: the 'plot-day' branch ~:839-881, `setCourseFrame` ~:2738-2770 and one prop on the tracer-layer call;
  5. 11b: mounting the control;
  6. **C-c (7a):** the `setTracerChartsWait` state and the loading/no-chart banner lines at :4424-4432. These
     are the same lines as DESKMAP's sketch banner: DESKMAP first, C-c rebases.
- **useTracerTraceLayer.ts:** DESKMAP (sketch legs; new layers join `TRACE_LAYER_IDS` for `promoteTraceLayers`)
  first, then PYD-3 (`destHintFeatures`, :357-373).
- **services/routeTracer.ts:** DESKMAP's sketch type first, then C-b's verdict v5 stubs.
- **services/autoroutingThalassa.ts** and its test:
  - **ROUTE-W first** (lane 1): the :73-75 comment, :289-297 (`signal`, `onStage`, the stage words) and
    :432-435 (`chartVerdicts`);
  - then PYD-2 (`departureMs` at :285 and the request/route types);
  - C-c (`ensureBoatCells` at :274 and :308-331, the status words at :82-83 and :107-109) rebases. If C-c
    merges before ROUTE-W, ROUTE-W rebases instead.
  - **C-c, merging second, adds the top-level `chartsMs` and the middle figure** in "Routed in 6.4 s · charts 1.2 s
    · router 4.1 s".
  - Tests are extended by both, never replaced.
- **ChartDepthControls.tsx:226-229:** one owner, `boatChartsLine`. DESKMAP's 'web' and 'web-open' sentences
  land first; C-c, merging second, folds them into the helper. The component keeps no second string.
- **types/settings.ts:** DESKMAP adds `boatCharts?: { licensed: boolean } | null` (type and reader); C-c adds the
  writer (registration and `forgetPairing`). Until C-c merges, every desk shows the open wording.
- **public/sw.js:** C-b deletes the LAN tile branch first; 127-H's H1 rebases beside it.
- **AutoroutingTrialWorkspace.tsx:** ROUTE-W (status line, panel line, Stop in the footer) first; PYD-3
  rewrites the day-plan mode; 11b's one line follows last.
- **127-ROUTE-W's other shared files:**
  - services/InshoreRouter.ts: ROUTE-W only. C-b's plan cites inshoreRouteToGeoJSON (:2491-2569) but does not
    list the file.
  - components/map/usePassagePlanner.ts: ROUTE-W :572-574; 127-11's fits are at :864 and :1690.
  - hooks/useVoyageForm.ts: ROUTE-W :794; C-b's caveats are at :832-850. Adjacent, so the later merge rebases.
  - vite.config.ts: ROUTE-W's `manualChunks` rule; 127-H only reads `releaseMinifyPublicScripts`.
  - utils/createLogger.ts, services/engine/navGridWorkerHost.ts and tests/WorkerSentryNoop.test.ts: ROUTE-W
    only. routeTracer.ts is not touched: C-b's verdict stubs and C-c's 7a are unaffected.
  - The router mirror: ROUTE-W edits no engine module's code. **But utils/createLogger.ts is in the mirror's
    closure, and its source is in the digest** (sync-router-engine.mjs:38, :173; critic). The logger sink
    therefore needs the sync re-run, which changes only pi-cache/src/routerEngine/syncedFrom.ts; the Pi keeps its
    logger shim and needs no redeploy. CI's `--check` (ci.yml:99) fails without it. Lane 2's mirror changes
    (C-b → C-a P1 → C-d Pi) also rewrite syncedFrom.ts: whichever merges second re-runs the sync after
    rebasing, then `--check`.
  - services/native/memoryGauge.ts: ROUTE-W's one line (an iOS memory warning trims the route workers' grid
    caches, ROUTE-W decision 12). It replaces C-c's optional line.
- **Day planner files:**
  - Files: TodaySheet.tsx, today.ts, DayPlanner.css and browser-tests/day-planner-layout.spec.ts.
  - PYD-6 and PYD-7 start after PYD-1 and PYD-4.
  - PYD-3, PYD-5 and PYD-11 still merge around them in separate hunks.
  - The routing cases of PYD-2, 3 and 11 live in the new day-planner-route.spec.ts, so screen 1 stays the only
    shared spec.
- **Lane-2 internal, serialized by order:**
  - EncImportService, EncHazardService, EncCellStore and cloudCellSync: C-b → C-a P1 → C-c.
  - useTracerGrading.ts, traceVerification.ts and traceBackgroundCheck.ts: C-b → C-c (7a rebases on the v5
    stubs).
  - AvNavService.ts: C-b only (decision 11). The matching WebKit purge is C-c's Swift.
  - PiPairingService.ts and e2e/fixtures/boat-network-layout.tsx: C-d app → C-c.
  - pi-cache routes/enc.ts, encWatcher.ts, server.ts, encChartStore.ts, oChartsInstaller.ts, the router mirror and
    tools/senc-extractor: C-b → C-a P1 → C-d Pi. C-d re-runs the mirror `--check` at staging.
- **Lane-3 internal, serialized by order:** useMapInit.ts, useWeatherLayers.ts, creditsStrip.ts,
  MapboxVelocityOverlay.tsx, CloseInWindLayer.ts, logMap.ts and chat/PinMapViewer.tsx go DESKMAP → DESKMAP-b →
  11a/11b.
- **hooks/useAppBootstrap.ts:** C-a P1 (the launch clean-up key) against Codex's e2ee branch, which also edits it.
  Separate effects; Codex rebases after the rewrite anyway.
- **Tests carrying OC- ids:**
  - Files: autoroutingThalassa, AutoroutingTrialWorkspace, autoroutingProposalSave, inshoreRouteNoticeDryRuns and
    inshoreRouter.chartLeads.
  - Phase 0 may rewrite their ids to `OC-99-ZZ…`.
  - PYD-2, PYD-3, C-b and C-c extend them with fictional ids only.
- **One-line config hunks:** playwright.keyboard.config.ts testMatch (DESKMAP, DESKMAP-b, 127-11, ROUTE-W's
  route-worker.spec.ts) and
  playwright.day-planner.config.ts (PYD-2). .github/workflows/ci.yml is C-d Pi's only; rebase on 98aa277a6's shards.

## Gates and asks, in time order

### Tonight (each with our recommendation)

1. **C-a Q2:** delete the retired Newport canal-exit chain, and add its two paths to the rewrite? **Yes.** Needed
   before Phase 0 finishes (~19:30).
2. **The rewrite:** tonight before 22:00 if you can (the cheapest rebase), otherwise Sunday ~07:30. You push
   Phase 0, check `gh run list`, tell Codex, run filter-repo, then force-push.
3. **C-a Q1:** retire the S-63 Licensing card? **Yes** (−5 to −7 KB). Needed before ~23:00.
4. **C-c Q1:** retire the ENC Library? **Yes** (−8 to −10 KB). Needed before ~02:00. Without an answer it stays
   NOAA-only and refuses the rest in plain words.
5. **The one JS move** (§ Bundle ledger). Needed at assembly; asked now so assembly never waits.
6. **PYD-2: is your TestFlight sign-in your usual Gmail account, or Apple's hide-my-email?** If hidden, we key the
   owner flag to your user id.
7. **Decision 5:** keep saving autorouted routes as a line + grade words; stop and purge if Roberto says no.
   **Yes.** C-b builds the switch either way, so this blocks nothing.

### Sunday

- The rewrite (if not done last night), then B1d-B1f (GitHub Support, Actions artifacts and caches, Pi clone,
  wx re-clone).
- **C-d Q2: may I run the read-only measurement on calypso?** **Yes, I run it.** It is announced, needs no sudo,
  writes nothing to disk, runs only with no watch armed, alongside, and not Wed 19:00-20:00.
- **127-11 Q1:** may the chart keep her on screen in the turning modes? **Yes.**
- **127-11 Q2:** is the August heading war fixed? If not, turn off the puck's PGNs 127250/127257. Until then
  Heading up says "Her compass is jumping between two headings".
- **C-c Q2:** judge "route on open" on the first open after a fresh launch. **Yes.**
- **C-d Q3:** add the "catalogue only" tell-line to the Roberto follow-up? **Yes, as a statement.**
- **Release steps (his hands):**
  - the 3 edge deploys;
  - the OK on C-b's cloud check, and the scrub if needed;
  - the master push.

  No DB push.

### At the dock, after 127 is on his phone (she's alongside until ~25 Oct)

1. **Pi update 3, ideally before the PYD timing run, or time twice** (C-d README):
   - the measurement;
   - `rootchecks.sh` PASS with sudo (zram-only swap, core dumps off);
   - the install: never during an anchor watch, never under way, not Wed ~19:30;
   - a five-minute phone smoke (enrol, open a chart);
   - `purge.sh` in the same visit. It refuses until the phone has received a vault cell.
2. **Device smokes:**
   - 127-01: no Leave on own boat; the crew follower still has it.
   - PYD-2: three timings, then send the numbers. ≤ 8 s each → one-line flip of `PYD_ROUTE_ON_OPEN`.
   - ROUTE-W (with PYD-2's timings): while "Routing round the land · N s" shows, the chart pans and the sheet
     scrolls; Stop gives "Stopped. Nothing changed." at once; a Mac-connected EXIT line ends in `worker`.
   - PYD-3, PYD-4, PYD-11.
   - C-b: force-quit → legs coloured at once; PDF without charted depths.
   - C-c: ~20 min, memory against the 2 GB cap, plus 7a: force-quit with a checked route in the tracer, then
     reopen aboard. The legs colour at once with no `tracer:ctx-start` crumb.
   - 127-11: Heading up at the marina, Track up in the dinghy, underway with wind, Course up on the desktop.
   - The desk map and wind on the PC.
   - 127-H: Calypso geocode by voice.
3. **If iCloud Backup is on:** delete the older device backups holding Documents/enc-cells.
4. **After his smoke:** the one-line flip `PYD_ROUTING_FOR = 'everyone'` waits for his word (a 127.x or 128).

### Roberto (~Tue 13 Oct)

- Q1 "no" → `BOAT_CELLS_ON_PHONE = false`, then rebuild. A "no" on routes → C-b's switch is off and the purge
  runs. **127 ships either way.**

## Bundle ledger

- **Line:** 10,622,075 B (10.13 MiB). Lazy chunks count.
  - **b127 after 127-01:** 10,609,246 B, 12,829 B headroom.
  - **b127 at b2b865490** (after PYD-1 and DESKMAP; measured by pydplaces127's base build, 22:10):
    **10,618,803 B, 3,272 B headroom.**
- **Plan estimates (each plan's own):**

| package | lane | est KB | note |
|---|---|---|---|
| 127-01 (done) | – | **+8 B measured** | |
| PYD-1 / 2 / 4 / 3 / 5 / 11 | 1 | **+1.39 measured** / +5.0-6.0 / +4.5-6.0 / +2.5-3.2 / +1.0-2.0 / +1.0-1.5 | router, tide and sweep code are dynamic imports (chunk wrappers only) |
| **127-ROUTE-W** | 1 | **−26 to −30 net** | +5 to +9 new code; −35,001 B navGrid worker chunk folded into the one engine chunk; −74 B worker-sentry-noop. Spike-measured first. Without the fold +5 to +9; fallback half ~+0.6 |
| C-a Phase 0 / Phase 1 | 2 | 0 / **−1.5 to −2.0** | Q1 yes: −6.5 to −9 |
| C-b | 2 | +2.3-3.9 | after its −1.2-1.8 sw.js LAN-branch trim; +0.15 AvNav switch (critic pass 3) |
| C-d app half | 2 | +2.5-3.2 | ~0.55 KB in the main entry |
| C-c | 2 | +5.6-8.1 | +1.1 for critic pass 3 (7a ~0.9, flag writer 0.1, purge 0.1). Q1 retire: **−2 to −3 net**. If EncCellStore sits in the entry chunk, import the vault dynamically |
| C-d Pi half | 2 | 0 | Pi only |
| DESKMAP / DESKMAP-b | 3 | **+7.99 measured** (plan +3.6) / +2.1 | +0.2 for the slot-0 flag and open wording; stopgap skipped |
| 127-11 (11a + 11b) | 3 | +6.0-7.0 | byte-only cuts: keep-on-screen −0.5, planner Course up −0.3 |
| 127-H | 3 | **−1.5 to −2.5** | H2d deletes the parked public wind barbs |
| PYD-6 / PYD-7 (cut-line) | 3 | +1.7-2.7 / +1.0-2.0 | |

- **Totals (revised ~22:30: PYD-1 and DESKMAP measured, ROUTE-W added):**
  - **Must-list before ROUTE-W: +37 to +50 KB.** The plans' +32 to +45 had DESKMAP at 3.6 and PYD-1 at
    0.6-1.0.
  - **With ROUTE-W: +7 to +24 KB.** With PYD-6/7: +10 to +28 KB.
  - **With both retires (C-a Q1, C-c Q1) and ROUTE-W: about −9 to +9 KB.**
  - Against the 12.8 KB 127 started with, the line may not have to move at all with both retires. Without
    them, it moves by up to ~11 KB at plan.
  - **If ROUTE-W's spike fails** (fallback half only): back to +37 to +50 KB, or +21 to +35 KB with both
    retires, as before.
  - **Honesty:** 126 measured +172 KB against +92 KB planned (some of that was the five packages added
    mid-build). DESKMAP ran 2.2× its plan. Plan for ~1.5× on new code. That gives about +52 to +67 KB, or
    about +34 to +55 KB with the retires. ROUTE-W at 1.5× on its new code (−21 to −28 KB) brings those to
    about **+24 to +46 KB**, or **+6 to +34 KB** with the retires.
- **Trims land first and are measured, in the order they merge:**
  1. C-b's sw.js branch (C-b in flight, ~23:00);
  2. C9 and, with Q1, the S-63 card (C-a P1, ~00:00);
  3. 127-H's barb deletion (~01:00);
  4. **ROUTE-W's navGrid worker fold (−35.0 KB, ~03:15-04:15), the biggest;**
  5. with Q1, the ENC Library (C-c, ~04:30);
  6. PYD-3's straight-pin path (~06:45-08:45).

  At b2b865490, b127 is 3,272 B under the line. It crosses at the next feature merge (C-b or PYD-4,
  ~23:00-00:45). ROUTE-W's fold may bring it back under for a while. From the first crossing, the ledger logs
  "over by N" (or "under by N") at each merge.
- **The ask (one move, at assembly):** set `javascript` to the measured b127 total rounded up to the next
  0.01 MiB, and **never above 10.17 MiB (10,664,018 B, +41,943 B) without asking you again.**
  - With both retires that covers 127 even at 126's overrun: 10.14-10.15 MiB at plan, ~10.17 at 1.5×. The very
    top of that 1.5× range is now ~0.2 KB over 10.17; PYD-7 slides first if it comes to that.
  - Without the retires it covers the plan (10.15-10.16) but not a 1.5× overrun. We would then slide PYD-7, PYD-6
    and 127-11's two byte-only cuts first, and come back to you.
  - **With ROUTE-W's fold (revised ~22:30):**
    - without the retires: ≤ 10.15 MiB at plan, and still ≤ 10.17 MiB at 1.5×;
    - with both retires: likely no move at plan, ≤ 10.16 MiB at 1.5×.

    The two bullets above apply only if ROUTE-W ships its fallback half.
  - The check-bundle-size.js comment gets the reason: "Build 127: Plan Your Day v3 (127-PYD-1..7, 11), charts stay
    on the boat (127-C-b, C-c and C-d's app half), the desk map + wind and orientation modes, ~N KB measured; C9,
    127-H's barb deletion and the PYD trims came first".
  - It stays far below the ~300 KB an accidental dependency adds, so the tripwire still trips. 128 then needs its
    own deliberate move.
- **Lighthouse and first load:**
  - Main-entry additions are small: C-d's header injection and allowlist (~0.55 KB), the vault only if
    EncCellStore is in the entry chunk, and ROUTE-W's logger-sink registration (~0.1 KB).
  - ROUTE-W moves ~287 KB of engine from ApplicationShell into its sibling `router-engine` chunk (the same
    bytes). Its gate: no entry other than index reaches that chunk, and `mainRaw`/`mainGzip` move by ≤ 0.5 KB.
  - Check `mainRaw` 800 KiB / `mainGzip` 250 KiB and ratchet Lighthouse at assembly.

| merged | package | est KB | measured B | headroom left B |
|---|---|---|---|---|
| 1b71c2ade | 127-01 | 0 | +8 | 12,829 |
| a3c4b9c70 | 127-PYD-1 | +0.6-1.0 | +1,388 (its branch vs 719645bb7) | – |
| b2b865490 | 127-DESKMAP | +3.6 | +7,993 (its branch vs 10,609,246) | – |
| b2b865490 | **b127 total** (on the rewritten history) | | 10,618,803 B (+9,557 vs 10,609,246; +176 B beyond the two branch deltas, not traced) | **3,272** |

## What slips to 128 (by plan or by cut)

- **By plan:**
  - PYD-8 (stop page rebuilt), PYD-9 (route pictures + shelter rose) and PYD-10 (places worldwide);
  - the old 127 list, in its own order (official warnings, boat-went-quiet, the StormGlass chain, UKC/datum, the
    gap-register items);
  - the phone planner moving to Light (DESKMAP's one question: try the desk first);
  - 127-11's "not in this build" list;
  - 127-H's found-on-the-way items, including the personal-ports Mapbox geocode purge, which needs a migration;
  - ROUTE-W's "not in this build" list: the satellite-water classifier in the worker (two remaining pauses,
    est. 0.3-1.2 s on the phone), the independent network waits run side by side (6.7 → ~3.6 s on the synthetic
    route), and worker-held cells.
- **By cut, if needed:** PYD-7, PYD-6, 127-H's H1 (H1-floor ships), C-a's P2 ports, and C-d's prewarm.
  ROUTE-W's worker moves to 128 only if its own spike fails (its fallback half ships instead).
- **Later:**
  - Desktop "ask the boat to route" → 129 (needs Roberto).
  - The Pi brain and the morning watch → 128-129.

## Risks

1. **The JS line.** See the ledger. 126 overran ~1.7×. Measure at every merge, and keep the retire answers early.
   ROUTE-W's −35 KB fold is the biggest single lever, and it is spike-gated: until it is measured, plan as if it
   isn't there.
1a. **127-ROUTE-W (added ~22:30).**
   - **The spike.** The engine chunk must start as a module worker in WebKit and on the phone. A separate
     worker build is not a fallback, because it duplicates 74-287 KB. If the spike fails, the fallback half
     ships and PYD-2 keeps its "the screen may pause" words.
   - **Memory.** The worker shares the 2 GB WebContent cap. Its clone of the corridor is extra memory: about 4×
     the corridor's JSON at peak (40-80 MB for 10-20 MB), because the main side's features are EncCellStore's
     cached objects and stay anyway. One route runs at a time, and iOS's memory warning trims the workers too
     (ROUTE-W decision 12, corrected by the critic). C-c's dock smoke measures it.
   - **Device proof.** No shipped worker has yet loaded a sibling chunk by a static import over capacitor://.
     Run the assembled build once in the iOS Simulator before TestFlight, and read the EXIT line's `worker`.
   - **Shared hunks.** autoroutingThalassa.ts with PYD-2 and C-c; AutoroutingTrialWorkspace.tsx with PYD-3 and
     11b.
   - **The clock.** Lane 1 is now the long pole (to ~11:15 Sunday), and 11b waits for PYD-3.
2. **The history rewrite mid-build.** In-flight branches rebase with `--onto` and their recorded base. C-a P1 and
   C-c hold their merges until b127 is rebased. Run gc only after Codex and the stale worktrees (b126, ops125,
   encshelfpush, ux-audit's two) are dealt with. Tonight is cheaper than Sunday.
3. **C-c's tracer wait (decision 7a, critic HIGH)** is a new state on the tracer's hottest effect, plus one wait in
   the background check.
   - Without it, every relaunch aboard (and every jetsam reload) grades without the licensed cells, overwrites
     the bank and cold-regrades the passage: the 2026-08-04 amplifier.
   - With a naive wait, a route open in the tracer would deadlock against the auto-sync's plotting deferral until
     the cap.
   - Test 13 pins zero regrades, the bank surviving an ashore launch, and one effect re-run per transition.
4. **Phone memory under C3.** Cells in WebContent RAM against the 2 GB jetsam cap, measured in the dock smoke. The
   2026-09 jetsam history says get the .ips first if anything crashes to The Glass.
5. **Native.** Two Swift edits plus the Info.plist key removal in one archive, compiled one at a time.
6. **MapHub.tsx** (five packages, three lanes). The hunks are named; the later merge rebases.
7. **AvNav o-charts tiles (store 9)**, verified by reading code (critic pass 3):
   - mapbox-gl fetches them through WebKit's persistent HTTP cache, and nothing on our side can force no-store;
   - pi-cache can't front Mapbox tiles (pinned TLS);
   - the WAN host and 100.64/10 paths exist in AvNavService.

   The path is latent: its only control has been parked since 18 July. **C-b switches it off on the phone in
   127** (`AVNAV_OCHARTS_ON_PHONE = false`, LAN-only when it returns), and C-c purges WebKit's disk cache once.
   C-d adds nothing for AvNav.
8. **Shane's hands:**
   - Phase 0 push, the rewrite and B1d-f;
   - 3 edge deploys and the release master push;
   - the JS OK;
   - seven answers;
   - Pi update 3 (root checks, install, purge);
   - the smokes.

   If the edge deploys lag the app, Calypso can't geocode place names until they land; nothing else breaks.
9. **Roberto (~Tue)** can flip C3 or the route saving. Both are one-line switches, and 127 ships either way.
10. **The 8 GB Mac and disk.** 12 GiB free now, and the archive needs several GB. `df` before every build; stop
    under 5 GB. Three builders plus Codex, single-worker everything. Check agent tails after any interrupt.
11. **Desk wind on the paid Open-Meteo plan, and OpenSeaMap's free server.**
    - Open-Meteo: watch the call count in week 1.
    - OpenSeaMap: Shane sends a courtesy note. If their server says no, our own seamark layer is the plan, later.
