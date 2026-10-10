# 127-ROUTE-W Routing off the main thread: the phone keeps working while it routes


> **ORCHESTRATOR CALLS (2026-10-10 ~23:10, on the critic's four open items; standing order "your recommendations for all work requiring an answer"):**
> 1. **SPLIT.** Build **127-ROUTE-W1** now, in lane 1 before PYD-2: the spike, routeJob, the host, `chartVerdicts`, signal + dedupe (incl. the stopped-run fix), the stage words, the memory trim, the parity/clone/host/join/purity tests and the production spec. **127-ROUTE-W2** later (after PYD-2, lane 3 if free): Auto's Stop + counter + panel line, the navGrid fold (its −35 KB is only needed at assembly) and the dev long-task spec.
> 2. **DEVICE PROOF:** one iOS Simulator run of the assembled build at 127 assembly (df first); read the EXIT line's `worker`. If the worker fails on WKWebView the host falls back and we say so.
> 3. **SPIKE CHOICE:** try the preload-helper move into `engine-leaf` first (keeps the Pi mirror digest untouched and avoids a lane-2 conflict); use the logger sink only if the helper move fails, then re-run the mirror sync (syncedFrom.ts only, no Pi redeploy).
> 4. **MEMORY:** the 127-C-c dock smoke measures peak memory with a ~30 NM corridor. If tight, post only the corridor's features in 127; the worker holding its own cells waits for 128.
> 5. **ALSO (new small package 127-ROUTE-P, lane 3 after DESKMAP-b if time, else 128):** run the router prep's independent network waits in parallel (cells, OSM overlay, satellite tiles, Notices to Mariners zones/packs, tides; ETOPO after the engine as today). Measured on the synthetic 20 NM route: 6.7 s of serial waiting → ~3.6 s. Most of Shane's ~1 minute is waiting, so this is the bigger felt win alongside the worker.

Lane 1 of 127, after 127-PYD-4 and before 127-PYD-2 (PYD-2 routes through this). Size M-L: 3-3.5 h of lane
time, including a 1 h spike that gates the rest (critic 2026-10-10 ~23:00: more likely 5-6 h, see Size). No
engine module's code changes, and there is no DB, deploy or Pi step. One mirror STAMP does change:
utils/createLogger.ts is in the Pi mirror's closure and its source is in the mirror digest
(pi-cache/scripts/sync-router-engine.mjs:38, :173), so decision 4's sink makes CI's `--check` (ci.yml:99) fail
until the sync is re-run. Only pi-cache/src/routerEngine/syncedFrom.ts changes (the Pi gets the logger shim either
way, :151), so the Pi needs no redeploy. Written 2026-10-10 ~22:30 from the measurement in
scratchpad/routew127/measure.md, with every app file:line re-read at b127 HEAD b2b865490.

## Authority (verbatim)

- Our question to Shane, 2026-10-10 evening: "One quick question if you're still there: during that one-minute
  autoroute, does the app freeze? If you're already off, I'll take it as yes and move the routing into the
  background in 127, so Plan Your Day never locks up the phone."
- Shane's answer: "yes for a short while it looked as though the app had frozen".
- Earlier the same evening, as the workflow recorded them: Auto takes "no more like a minute :)", and he called
  it "unbelievably cool. fucken unreal".
- Shane, on 127: "ok can we make this a build on its own. without adding anything off the 127 list in the gap
  file?" This package is not from the gap file. It is the follow-through on his answer above, and it is what
  127-PYD-2 needs to route without locking up the phone.
- JS: Shane approved ONE move of the line at 127 assembly, to at most 10.17 MiB (+41,943 B). This package is
  designed to bring the total down, not up (see JS estimate).
- o-charts (Roberto), 2026-10-10: "Storing unencrypted data on any medium, and especially in the cloud, is
  strictly prohibited by the terms of the licenses signed with the chart providers." A worker holding cells in
  memory is fine; nothing it holds is ever written anywhere (Licence below).
- Standing order: "your recommendations for all work requiring an answer". Every call below is our
  recommendation on that order.

## What the skipper sees

**Auto** (anyone with Auto route (trial) on), Coral Sea Marina → Cid Harbour:

1. She taps **Calculate trial route**. The status reads "Following deep water…", as it does today, while the
   charts, OpenStreetMap water, satellite water and notices load. The chart already pans during this part,
   apart from two short pauses while the satellite water is read (each est. 0.15-0.6 s on the phone; 128
   moves them, Not in this build).
2. When the router itself starts, the status reads **"Routing round the land · 3 s"**. The seconds tick, so she
   can see the phone hasn't frozen. The panel line under it reads **"The chart stays live while it works. Stop
   ends it."** The chart pans and zooms, the panel scrolls, and the buttons answer. Today this is the stretch
   where nothing moves.
3. While it is busy, the second footer button reads **Stop**, not Clear. Stop ends the route straight away and
   keeps her pins: "Stopped. Nothing changed." Closing Auto (✕) also ends it. Today neither can interrupt the
   router: the A* runs to the end and its result is thrown away.
4. If another route is already running (for example the passage planner asking for the same leg), she sees
   "Waiting for the route before this one…". If both asked for the same leg, they share one run, and her Stop
   only drops her own request.
5. After the router comes "Checking the route · 9 s" while the satellite land check and the notices run.
   Then the line draws and Review opens, exactly as today, with the same line, colours, notes and words.
6. The 85 s watchdog now really stops the router, with today's words: "Routing took longer than this phone
   allows (85 s). Try a shorter passage. Nothing changed."
7. On a phone where a worker can't start (an old WebKit, or a failed spawn), routing runs the old way. The
   status then says so: "Routing round the land (the screen may pause) · 3 s".

VoiceOver hears the stage changes, not the ticking seconds (the counter is `aria-hidden`).

**Plan Your Day** (127-PYD-2, Shane's account): the stop page's route row goes through the same stages
("Finding the way round the land…", then "Routing round the land · 6 s"). The sheet scrolls, and the ✕ closes
the page and ends its route at any moment. Under PYD-2's rule, one route runs and one waits.

**Passage planner, voyage form, ⚡ Auto route and the From/To boxes:** their words don't change. Their spinners
keep turning and the chart keeps panning while they route, because they all go through the same one seam.

Nothing about the route itself changes. It is the same line, the same colours and the same refusals, and the
parity tests below prove it.

## Today (b127 b2b865490)

**The freeze is one long task, and it starts at one call site.**
- `routeInshore(merged, routeOpts)` has exactly one call site in the app: services/InshoreRouter.ts:2157. Every
  app caller reaches it through `tryInshoreRoute` (:830):
  - Auto's provider (services/autoroutingThalassa.ts:297);
  - the passage planner (components/map/usePassagePlanner.ts:521);
  - the voyage form (hooks/useVoyageForm.ts:756);
  - ⚡ (components/map/useAutoRouteLeg.ts:132, :147);
  - MapHub's From/To (components/map/MapHub.tsx:2850).
- From :2157 to the return at :2409-2485, the main thread runs without one yield:
  - the engine;
  - the lead-graph shadow (:2227-2290);
  - the Seaway shadow and its promotion, which can REPLACE the route (:2293-2395, `SEAWAY_ROUTER_ENABLED = true`
    at :186);
  - the mask audit (:2386);
  - the result assembly, which builds the chart-water probe (:2480 → `routeChartWater` :646-668).

  The next yield is the provider's ETOPO request (autoroutingThalassa.ts:432-435).
- The code already knows: "It cannot interrupt the synchronous engine compute (no JS timer fires mid-A*; a
  Worker thread is the eventual fix)" (:874-883). The watchdog `INSHORE_WATCHDOG_MS = 85_000` (:883) wraps
  the whole run in `withDeadline` (:887). When it fires, the A* still runs to the end.
- The provider's 80 ms paint yield (autoroutingThalassa.ts:73-75, :289-291) exists only so the status paints
  before that block. Its comment still says "20–47 s measured on iPhone" (May, before the grid speed-ups;
  unverified).
- Auto's ✕ and Clear abort the provider's controller (components/autorouting/AutoroutingTrialWorkspace.tsx:
  276-279, :333-336). That is only checked between phases (`assertCurrent`, autoroutingThalassa.ts:260-262),
  never inside the engine. While busy, the button reads "Calculating…" (:1233-1236), and Clear clears the pins
  too (:1028-1035).

**Measured (scratchpad/routew127/measure.md), Mac M1, the real Auto path end to end with timed stand-ins for the
network and storage, and a 4 ms heartbeat:**

| Route (synthetic archipelago, invented, 161.0E 20.3S) | Engine | Shadow | Main-thread block (WebKit) |
|---|---|---|---|
| 5 NM | 0.26-0.28 s | 0.03-0.04 s | 0.32-0.39 s |
| 12 NM | 0.47-0.49 s | 0.13-0.17 s | 0.63-0.85 s |
| 20 NM | 1.24-1.45 s | 0.40-0.41 s | 1.66-1.88 s |

- One long task per route: the engine is 75-80% of it, the shadow 18-25%, the rest about 1%. Chromium's
  long-task API matched the heartbeat to within 4 ms.
- JavaScriptCore is level with or faster than V8 on this code, so only moving it off the thread helps.
- Inside the engine at 20 NM:
  - main grid build 0.45-0.50 s;
  - shallow ring 0.35-0.38 s;
  - components 0.09-0.15 s;
  - A* 0.14-0.15 s;
  - smoothing 0.11-0.13 s.

  The grid is built 4-6 times per route. A warm grid cache cuts the engine by 60-80%.
- Phone estimate (not measured; no on-device timing exists): A17 Pro ≈ M1 per core, ×1-2.5 inside the app, ×3+
  hot or in Low Power Mode:

  | Route | Estimated freeze |
  |---|---|
  | Daydream | 1-2.5 s |
  | Cid Harbour | 2.5-7 s |
  | Whitehaven class | 3-9 s (up to ~15 s hot) |
  | Tangalooma class | 5-14 s |

  The rest of "about a minute" is network waiting, during which the screen still responds.
- With nominal delays, the synthetic 20 NM route took 8.8 s, of which 2.1 s was frozen.

**What the worker design must respect (all read in code):**
- **The grid cache is module state** (navGrid.ts `navGridCache`, 48 MB, 5 entries). The Seaway shadow's
  `routeCachedGrid` (InshoreRouter.ts:2230) and the lead shadow read the route's own cached grid. So the engine,
  both shadows and the promotion must run in the SAME worker.
- **The chart-water probe is a function.** `InshoreRouteResult.chartWater` (:634; its doc at :625-633 says "a
  function, never serialised or cloned") can't be posted. `inshoreRouteCrossesLand` already accepts
  `chartVerdicts` (services/routing/landBackstop.ts:232-254, :345-367). Three callers pass `chartWater`:
  - autoroutingThalassa.ts:435;
  - usePassagePlanner.ts:572-574;
  - useVoyageForm.ts:794.
- **The lead shadow's graph lives on the main thread.** `peekLeadGraphForView` (services/routing/leadOverlayData.ts:
  62) reads the chart overlay's compiled-graph cache for the finished line's box (InshoreRouter.ts:2241). It is
  telemetry only: the verdict is logged and never changes the route (:2256-2283).
- **Tide windows are IO-module code.** `pinTailTideWindows` (:2453) lives in services/routing/tideCeilings.ts,
  which imports TideHeightService. It runs on the main side.
- **The dormant Pi route** (`CLOUD_ROUTER_ENABLED = false`, :164, :2067-2150) is left as it is.
- **The engine is pure.** Its closure is 36 modules that pi-cache/scripts/sync-router-engine.mjs mirrors to Node,
  plus services/seaway/*. In that whole graph the only dynamic import and the only app-side global is
  createLogger's lazy `import('../services/sentry')` (utils/createLogger.ts:46): grep of every module, b2b865490.
- **An existing worker, and how it duplicates code.** services/engine/navGridWorkerHost.ts runs the tracer's
  grids in navGridWorker (:44). It keeps a sync fallback by importing `buildNavGrid` statically on main (:12), so
  Vite's separate worker build carries a second copy: `navGridWorker-*.js` is 35,001 B of the same navGrid code
  the main build already has. Its only user is services/routeTracer.ts.
- **Where the code sits in the bundle.** The whole engine sits in `ApplicationShell-*.js` today (the "SEAWAY
  SHADOW", "LEAD SHADOW" and "RENDERED ROUTE" strings are all in that one chunk of a b2b865490 build). Worker
  builds are separate Rollup builds (vite.config.ts:618-621, `format: 'es'`, `workerSentryNoop` :210-226), so
  nothing they bundle is shared with the main build.
- **Measured sizes** (esbuild `--minify`):
  - the engine closure is 257,567 B, or 287,123 B with the shadows;
  - main-thread code other than the router already imports 109,365 B of the same modules: routeTracer,
    landBackstop, autoroutingProposalSave, anchorAreaCheck, canalDepartureGeometry and routing/*.

  So a worker built the usual way (`new Worker(new URL('./x.ts', import.meta.url))`) duplicates about 287 KB
  with a sync fallback, and about 109 KB without one (74 KB with the navGrid worker folded in). Any of those is
  over the whole +41,943 B allowance.
- **Hand-off costs** (WebKit, measured):
  - posting 2.5-4.5 MB of layers costs the main thread 11-29 ms;
  - a result with a transferred 10 MB grid comes back in ~2 ms;
  - a real corridor of 10-20 MB is an estimated 0.1-0.3 s on the phone, as one task.
- **Memory.** A worker is a thread in the same WebContent process, so the 2 GB jetsam cap is shared
  (memory: thalassa-webcontent-2gb-jetsam).
- **No worker test today.** Playwright's `?engine=real` mode (e2e/fixtures/autorouting-trial.tsx:24-26, :199)
  already runs the real engine in the browser on a synthetic cell, but nothing measures the main thread.

## Decision (our recommendation)

1. **One worker job at the one seam.** Everything from InshoreRouter.ts:2157 to the return (:2485) becomes ONE
   job, `runRouteJob(job)`, in a new pure module **services/routing/routeJob.ts**:
   - the engine;
   - the lead shadow;
   - the Seaway shadow and promotion;
   - the mask audit;
   - the result assembly;
   - the chart verdicts.

   The promotion helpers at :193-470 move with it (`seawayPromotionBlockReason`, `polylineTouchesBbox`,
   `promotedSeawayRoute`, `seawayGraphSafetyFault`, and the probe half of `routeChartWater`). InshoreRouter.ts
   re-exports them, so tests/inshoreRouter.seawayPromotion.test.ts and every other import stay unchanged.
   `InshoreRouteResult` and `InshoreRouteFailure` (:476, :671) move to routeJob.ts as well and are re-exported,
   so the job never imports InshoreRouter.ts, not even for a type (critic). The dormant cloud branch
   (:2067-2150) stays on the main side; `routedOnCloud` is always false today, so the job always runs the engine.

   The prep stays on the main thread, unchanged: cells, OSM water, satellite water, bridges, marks and notices.
   That is the IO and the plugin bridge. The engine's own files are not edited, so the Pi mirror's `--check`
   stays clean and there is no Pi re-sync.
2. **Chart verdicts instead of the probe.** The job returns `chartVerdicts`: the probe's verdict at every point
   of `samplePolyline(polyline)` for the line it returns (engine or promoted). A probe that throws gives
   'unchecked' plus today's one warn line, as landBackstop does now (:356-362).
   - `samplePolyline` (:180, with its `dist` helper and the two constants at :96 and :112) moves to a new
     pure **services/routing/backstopSamples.ts**, which landBackstop.ts re-exports. So does the
     `BackstopChartVerdict` type (:237): landBackstop.ts imports GebcoDepthService, so routeJob.ts must not
     import from it, not even a type (critic).
   - All three callers check the backstop on `inshoreRes.polyline` / `ok.polyline`, the same line the job
     sampled (read 2026-10-10), so `chartVerdicts.length === samples.length` holds.
   - `InshoreRouteResult.chartWater` becomes `chartVerdicts: BackstopChartVerdict[]`.
   - The three callers pass `{ chartVerdicts }` (autoroutingThalassa.ts:435, usePassagePlanner.ts:572-574,
     useVoyageForm.ts:794).

   The same samples get the same verdicts, so the land check is unchanged. Its `chartVerdicts.length ===
   samples.length` rule (:364) holds by construction.
3. **The lead shadow's graph is looked up before the job.** The main side peeks the compiled graph for the
   route's corridor box (`inshoreOverlayBbox`, :798) and posts it with the job (`LeadGraph` is plain arrays,
   services/routing/leadCompiler.ts:293-304). In the normal case the overlay is off and it is null.
   - Only the box changes, from the finished line's to the corridor's, because the cache lives on the main
     thread.
   - It is telemetry only, so no route can differ.
4. **No duplication: the engine chunk IS the worker.** One copy by construction:
   - **One chunk.** A `manualChunks` rule (vite.config.ts:669) puts routeJob.ts and its whole static import
     closure into one main-build chunk, `router-engine`. The rule is computed with Rollup's `getModuleInfo` from
     routeJob.ts, never a hand list, so a new engine module joins it automatically. Leaves that the other
     entries (logs, beta, feedback, ocean, the legal boot shell) also import go to a tiny `engine-leaf` chunk,
     so those entries never load the engine. ApplicationShell imports `router-engine` exactly as it imports
     these modules today. The same bytes move out of ApplicationShell; they are not added.
   - **The chunk is the worker script.** routeJob.ts exports `ROUTE_ENGINE_URL = import.meta.url`, which in the
     build is the chunk's own URL. The host starts `new Worker(ROUTE_ENGINE_URL, { type: 'module' })`.
     routeJob.ts has one guarded top-level line, `if (inWorkerScope()) self.onmessage = …`, which does nothing
     on the main thread.
   - **The sync fallback is the same module.** It calls `runRouteJob` from that same chunk on the main thread.
   - **No worker build.** Nothing goes through Vite's worker build, so no worker-build bytes are added.
   - **Same URL scheme as today.** On iOS the chunk URL is capacitor://localhost/assets/router-engine-….js, the
     same scheme and folder navGridWorker uses.
   - **The logger leaf must import nothing.** createLogger's lazy Sentry import is the only dynamic import in
     the closure. In the main build it becomes a call to `__vitePreload` from `vendor-react` (vite.config.ts:
     677-681), and `vendor-react` also holds Vite's modulepreload polyfill, which touches `document` when it
     loads. A worker that imports it would most likely die on load (the spike confirms which). So
     `createLogger.error()` reports through a sink instead:
     - `setLoggerErrorSink(fn)`, registered once at boot in the main entry, does the same lazy Sentry import
       there;
     - errors before registration wait in a queue of at most 20;
     - in a worker no sink is ever set, so nothing is sent from there.

     The `workerSentryNoop` plugin then has nothing to resolve (the 74 B `_worker-sentry-noop` chunk goes), and
     tests/WorkerSentryNoop.test.ts is updated to match (its :155-159 asserts createLogger's `import(`).
   - **The sink moves the Pi mirror's stamp (critic).** createLogger.ts is in sync-router-engine.mjs's closure
     (LOGGER, :38) and its real source is hashed into the digest (:173). So after the edit, run
     `node pi-cache/scripts/sync-router-engine.mjs`: only syncedFrom.ts changes, because the Pi is given the
     logger shim either way (:151). Lane 2's mirror commits rewrite syncedFrom.ts too; whichever merges second
     re-runs the sync after rebasing. No Pi redeploy (nothing reads the digest at runtime).
   - **Spike alternative, if the sink misbehaves:** leave createLogger.ts alone and move `vite/preload-helper`
     out of `vendor-react` into `engine-leaf`, keeping the modulepreload polyfill in `vendor-react`. Vite 7.3.6's
     helper reads `document` at load only behind `typeof document !== "undefined"` (detectScriptRel), so it
     loads in a worker. No mirror stamp then, but an accidental `error()` in the worker graph would try to load
     the app entry there, so the purity test's no-`error()` rule becomes load-bearing.
5. **The spike comes first and gates everything else** (Phase 0, ~1 h, before any feature code):
   - Build b127 with only the chunk rule, the logger sink and an echo job.
   - Record dist JS before and after.
   - In the production preview, on Chromium and WebKit, the `router-engine` chunk must start as a module
     worker and answer a synthetic 5 NM job. Its answer must be bit-identical to the same built chunk run on
     that page's main thread, and equal to Node within float rounding (Gates: JSC and V8 differ in the last
     bits, measured).
   - The pass criteria are under Gates. If the spike fails, see decision 13.
6. **The host, services/routing/routeWorkerHost.ts** (modelled on navGridWorkerHost.ts and
   EncCellStore.ts:362-420):
   - **One worker, kept alive.** A single route worker lives as long as it isn't stopped, so the grid cache
     stays warm between routes as it does today on the main thread. One job runs at a time, first come first
     served.
   - **Every job carries an AbortSignal.**
     - Aborting a queued job removes it before it starts.
     - Aborting the running job calls `worker.terminate()`. The job rejects with an AbortError, and the next
       job starts a fresh worker with a cold cache.
   - **Deliberate stops don't count as crashes.** Terminations for a stop or the watchdog never count toward
     the crash cap. Otherwise three Stops would push the rest of the session back onto the main thread.
   - **Crashes and failures:**
     - after 3 crashes (`onerror`) the host uses the main thread for the rest of the session, as
       navGridWorkerHost.ts:29-30 does;
     - a crash mid-job, an `init-error`, or a `DataCloneError` on posting runs THAT job on the main thread,
       with a warn line, so a route always comes back where it does today;
     - with no `Worker` global (vitest, an old webview), the job runs on the main thread;
     - a job that throws in the worker is today's "local inshore route compute threw", so it returns null and
       the main thread never re-runs it.
   - **Stages.** The host tells its caller 'queued', 'routing' (posted), 'routing-main' (main-thread fallback)
     and 'done'.
   - **The tracer's grids fold in** (the navGrid worker goes). navGridWorkerHost.ts keeps its exported
     `buildNavGridAsync` and its fallback, but posts its grid jobs to a SECOND instance of the same worker
     script. A route never queues behind a tracer grid, and a tracer grid never queues behind a route.
     services/engine/navGridWorker.ts and its 35,001 B chunk are deleted, and routeTracer.ts is not touched.
7. **`tryInshoreRoute` can be stopped** (`opts.signal`, `opts.onStage`; the signature at :830-851 is
   otherwise unchanged):
   - The dedupe map (:822-828, :860-873) keeps its key, and each entry counts the callers that joined it.
   - When a caller aborts, only that caller detaches: its promise rejects with AbortError. The run stops when
     the LAST caller has detached.
   - **On that last detach the entry leaves the dedupe map at once (critic).** A run stopped in the prep keeps
     waiting on its network calls for up to 20-45 s, and today's `.finally` (:928-930) would leave it in the map
     all that time, so a re-tap of the same leg would join the stopped run. The `.finally` then deletes the key
     only if the map still holds this run.
   - When the 85 s watchdog fires, it stops the run (terminate). It returns today's `watchdog-timeout` failure
     with today's words.
   - A stop during the prep never posts the job (`signal.throwIfAborted()` just before posting). The prep's
     network waits can't be cancelled (CapacitorHttp), so their answers are dropped.
   - Callers that pass no signal (⚡, MapHub From/To, the planner, the voyage form) behave as today.
8. **The provider** passes `signal` and `onStage` through (autoroutingThalassa.ts:297) and maps the stages to
   words:

   | Stage | Words |
   |---|---|
   | queued | "Waiting for the route before this one…" |
   | routing | "Routing round the land…" |
   | routing-main | "Routing round the land (the screen may pause)…" |
   | before ETOPO (:432) | "Checking the route…" |

   `PAINT_YIELD_MS` stays (it paints "Following deep water…" before the prep), and its comment is corrected.
   `assertCurrent` is unchanged. This is the only provider change apart from decision 2's `chartVerdicts`.
9. **Auto's workspace** (AutoroutingTrialWorkspace.tsx):
   - the status line (:1159-1160) shows the provider's words plus " · N s", counted from the tap. The counter is
     `aria-hidden`, and the role=status paragraph (:1431-1434) announces the words only;
   - while the router is in the worker, the panel line "The chart stays live while it works. Stop ends it."
     shows;
   - while busy, the second footer button is **Stop** (`invalidate()` only, pins kept). After a stop the status
     reads "Stopped. Nothing changed.";
   - nothing else in the panel changes.
10. **Logs reach the Xcode console as they do today.** Capacitor shows the main thread's console in Xcode, not
    a worker's, and lines like "SEAWAY SHADOW", "LEAD SHADOW", "RENDERED ROUTE" and the engine's own warns are
    the Seaway programme's telemetry. So in the worker, `console.warn` is wrapped once: each line is posted to
    the main thread (strings only) and printed there with the same text. These lines are already logged today;
    nothing new is logged.
11. **One timing line, durations only.** The existing warn-level EXIT line (:916-925) gains the stage
    durations: `· prep 3104 ms · wait 0 ms · handoff 14 ms · engine 2410 ms · shadow 604 ms · back 3 ms ·
    worker`. That gives the real phone numbers the measurement could not get. No position, name or depth goes
    in it, and no new log line is added.
    - `elapsedMs` keeps its meaning: the engine's own time, now measured in the worker. 127-PYD-2's "router N s"
      reads the same figure.
    - Parity tests leave `elapsedMs` out.
12. **Memory (corrected by the critic, 2026-10-10 ~23:00).**
    - `tideUnchecked` and `structuresUnknownOn` (:2009-2010, :1053-1057) move into the job with their data
      (`structuresUnknownBbox` posted as entries, not a Map).
    - **The main side keeps the job until the worker answers,** because a mid-job crash re-runs that job there
      (decision 6). That costs little: `merged` holds the very feature objects EncCellStore's parsed-cell LRU
      holds (pushed by reference, :1111-1126), so dropping it early would free only the arrays.
    - **The worker's copy is the real extra memory.** A structured clone is a full copy, about 3× the corridor's
      JSON in heap, plus WebKit's serialized buffer while the message is in flight. Estimate about 4× the
      corridor's JSON at peak, 40-80 MB for a 10-20 MB corridor, freed when the job returns.
    - The worker lets go of the job's layers when the job returns. A cached grid keeps no layer state (the engine
      prices a cached grid's lazy ring in full, shallowRuns.ts:646-657), so only its grid cache (≤ 48 MB, as
      today on the main thread) stays.
    - **iOS memory warnings must reach the workers.** services/native/memoryGauge.ts:54 trims the MAIN thread's
      `navGridCache`, which is empty once routes run in the worker. The same listener also calls
      `trimRouteWorkers()` from routeWorkerHost (a dynamic import, as now). It posts 'trim' to both instances
      (`trimNavGridCache(0)` there) and ends an idle one (~0.1 KB). Without it, the warning no longer sheds the
      up-to-48 MB of route grids. This replaces C-c's optional line.
    - One route runs at a time.
    - 127-C-c's dock smoke measures memory against the 2 GB cap with a 30 NM corridor.
13. **If the spike fails** (the chunk won't load in a worker in WebKit, or its closure reaches an app or vendor
    chunk that can't be cut, or the split costs more than +5 KB): stop, and ship ROUTE-W's fallback half only:
    - decision 8's words, with 'routing-main' always;
    - decision 11's timing line;
    - Stop between phases, as today.

    That is about +0.6 KB. The worker moves to 128 with the spike's finding, and PYD-2 keeps its "the screen
    may pause" line. A separate worker build is NOT the fallback, because at +74 to +287 KB it can't fit in 127.
    Shane hears about it in the morning: no push 22:00-07:00, so run `date` first.

## Licence (127 "charts stay on the boat"; o-charts ruling 2026-10-10)

1. **In memory only.** The worker receives the merged layers as an in-memory structured clone, routes on them,
   and drops them. With 127-C-c, protected cells are memory-only on the main side as well. Either way, nothing
   the worker holds is written to any disk, storage API, the account or a log.
2. **No IO in the worker graph.** The job's module graph contains no storage or network API: no fetch,
   IndexedDB, Cache Storage, localStorage, sessionStorage, Filesystem or Capacitor. A test walks the graph and
   enforces this. It matches uses of the globals (`window.`, `document.`, `fetch(`, `typeof window`, an
   `@capacitor/` specifier), not bare words: tideCeiling.ts:376 and fairlead.ts:240 name a PARAMETER `window`,
   and a bare-word ban would force an engine edit and a real Pi re-sync. It skips `import type` lines. The worker never reads a cell and never calls a plugin; the Capacitor bridge doesn't exist in
   a worker. So routing can never hold the one serial plugin queue (memory: capacitor-bridge-queue). The cell
   reads stay in the prep, exactly as today.
3. **No new log data.** No log line gains a position, a name or a depth. The ENTRY line's two pins
   (:857-859) are left as they are, as 127-PYD-common rule 3 already notes.
4. **Charts are never sent anywhere.** The dormant Pi route (`CLOUD_ROUTER_ENABLED = false`) is untouched, and
   nothing in this package sends chart data off the phone.

## Not in this build

- **The satellite-water classifier in a worker** → 128. It takes 0.12-0.24 s per crop on the Mac, two crops per
  route, so two short pauses on the phone, each est. 0.15-0.6 s (0.3-1.2 s together). These become the longest
  remaining hitches. OffscreenCanvas and createImageBitmap exist in WebKit workers.
- **Running the independent waits side by side** → 128. The candidates are the cells, OSM water with the
  satellite crops, and ETOPO with the notice packs and local notices. On the synthetic 20 NM route that cuts
  6.7 s of waiting to ~3.6 s, and more in the field. It shortens "about a minute"; it does not touch the freeze.
- **Prep in the worker, or a worker that holds its own cells.** That would save the 0.1-0.3 s hand-off. It needs
  127-C-c's memory store to be readable from a worker. Later.
- **A progress percentage inside the A*.** That needs an engine-file change, which means a Pi re-sync. The
  seconds counter says "alive" without it.
- **Folding the glaze worker** (encGeometryWorker, 30,842 B). Not checked; it may not duplicate main code. A
  128 look.
- **Two different routes in parallel.** One route worker, one job at a time.
- **The Pi routing for every device aboard** (129, vision).
- **Changing the 85 s watchdog.**

## Gates

- **Spike pass (Phase 0, mine, before any feature code; recorded in the ledger):**
  - `npm run build` passes, and the chunk rule plus the logger sink alone move dist JS by ≤ +5 KB. (Was +3 KB.
    The plan's own estimate for these two is +1.1 to +3.2 KB, so +3 KB could fail a working split. The −35 KB
    fold in this same package pays for up to +5.);
  - the `router-engine` chunk's static import closure is ONLY `router-engine-*` and `engine-leaf-*` chunks. This
    is an allowlist: a denylist of vendor names would miss `main-*` (the index entry, where a shared leaf can
    land) and `sentrySdk-*`;
  - no entry other than index reaches `router-engine`;
  - `mainRaw` and `mainGzip` move by ≤ 0.5 KB;
  - in the prod preview, Chromium and WebKit, the chunk answers a synthetic 5 NM job as a module worker. The
    answer is bit-identical to the same chunk run on that page's main thread. Against Node it is equal apart
    from last-place float rounding: relative 1e-12 on numbers, exact on everything else.
    - *Measured by the critic, 2026-10-10* (scratchpad/routew127/parity/): the engine and shadow on the three
      synthetic dumps give identical polylines in Node, Chromium and WebKit, but JSC differs from V8 in the last
      bits of `distanceNM`, `chartedShallowSpans[].endT`, `dryRuns[].lengthM` and `near.clearanceM` (1-3 fields
      per route, ≤ 6e-14 absolute).
    - Node and Chromium are bit-identical. WebKit's page and a WebKit module worker are bit-identical.
    - An exact Node comparison would fail WebKit every time and send a working worker to 128.

  Fail → decision 13.
- **Merge (CI-identical, one heavy command at a time):**
  - vitest `--maxWorkers=1`, with every inshoreRouter*, autorouting*, landBackstop*, seaway* and routeTracer*
    suite at 4096 heap;
  - `node pi-cache/scripts/sync-router-engine.mjs --check` clean, after re-running the sync for createLogger.ts
    (decision 4: syncedFrom.ts stamp only; no engine module edited);
  - build + check:bundle, with the measured bytes logged;
  - the prod e2e spec and the keyboard-config spec below;
  - tests/WorkerSentryNoop.test.ts and tests/noProtectedChartData.test.ts green.
- **Ship:** Shane's device smoke (below), folded into 127-PYD-2's marina timings and 127-C-c's memory smoke.
- **Nothing else:** no DB, edge deploy, Pi step or master push of its own (it rides 127's release push).

## Tests (failing first)

Commit 1 holds the generator, the goldens captured on b127 BEFORE any change, and the failing tests. The
goldens are taken at b2b865490, or at the b127 HEAD the package starts from.

**Fixtures (synthetic or NOAA only; the licensed fixtures removed today are never recreated):**
- **tests/fixtures/syntheticArchipelago.ts** (new): scratchpad/routew127/genScene.mjs ported, built in memory
  from a fixed seed. It is invented geometry at 161.0E 20.3S (three cells at 1:1.5M, 1:90k and 1:12k, 26 islands,
  a marina, marks) with fictional `OC-99-SYN…` ids, which C-a's guard (tests/noProtectedChartData.test.ts:81)
  allows. Its routes are 5, 12 and 20 NM. No scene file is committed.
- **The existing `?engine=real` Tasman cell** (e2e/fixtures/autorouting-trial.tsx:199).
- **NOAA US5GA22M (public domain).** It sits in the main checkout's gitignored public/enc-samples. Tests that use
  it skip, with the reason printed, when it is absent (as in CI). The builder runs them locally and records the
  result in the commit. A worktree has no public/enc-samples (gitignored), so the tests read the path from an env
  var (the main checkout's absolute path) rather than the repo root, or they silently skip on the builder too.

**vitest (`--maxWorkers=1`):**
- **tests/routeJob.parity.test.ts (new).** Goldens are a canonical-JSON sha256 plus a readable summary (points,
  NM, first and last vertex, mask lengths), captured from today's `tryInshoreRoute`. `elapsedMs` is left out.
  `chartWater` is replaced by today's probe evaluated at `samplePolyline(polyline)`. Tides are synthetic and the
  clock is fixed (`vi.setSystemTime`; `pinTailTideWindows` reads `Date.now()`). The cases:
  - the archipelago 5/12/20 NM in strict, through `tryInshoreRoute` (the mocks recipe of
    tests/autoroutingThalassa.engine.test.ts: cells, OSM, notices);
  - one Seaway-promoted route (the synthetic buoyed channel of tests/inshoreRouter.seawayPromotion.test.ts);
  - NOAA US5GA22M in strict: refusal parity (the same code 'uncharted-corridor' and the same words);
  - NOAA US5GA22M in permissive, through `runRouteJob`: a full route on real NOAA geometry;
  - the provider: `calculateThalassaProposal` equals its golden apart from `id`, `createdAt` and
    `engine.elapsedMs`. ETOPO is mocked 'verified' on one scene and 'unavailable' on another, so
    `backstopCharts` is covered.

  This fails first: `routing/routeJob` doesn't exist yet.
- **tests/routeJob.clone.test.ts (new).**
  - `runRouteJob(structuredClone(job))` deep-equals `runRouteJob(job)`, and `structuredClone(result)`
    deep-equals `result`, for the 5 NM route, the promoted route and a refusal. This catches any function or
    class instance crossing the boundary.
  - The job carries no function.
- **tests/routeWorkerHost.test.ts (new)**, with a fake `Worker` that runs `runRouteJob` on a `structuredClone` of
  each message asynchronously:
  - jobs run one at a time, first come first served;
  - an aborted queued job never starts (the fake records starts);
  - an aborted running job → `terminate()` called, AbortError, and the next job spawns a fresh worker;
  - three deliberate terminations do NOT latch the sync fallback; three crashes do;
  - a crash mid-job, an `init-error` or a `DataCloneError` runs that job on the main thread (a `runRouteJob`
    spy), and so does a missing `Worker` global;
  - a job that throws gives null and no main-thread re-run;
  - the stages arrive in order: queued → routing → done;
  - forwarded log lines are printed on the main side with the same text;
  - grid jobs go to the second instance and never wait behind a route job.
- **tests/inshoreRouter.join.test.ts (new):**
  - two callers with the same key share one run;
  - A aborts → A rejects with AbortError, and B still gets the route;
  - both abort → the run is stopped (the fake host sees the abort);
  - the 85 s watchdog (fake timers) stops the run and returns 'watchdog-timeout';
  - a stop during the prep posts no job;
  - **after the last caller stops a run that is still in the prep, a new call with the same key starts a fresh
    run** (the stopped one has left the dedupe map), and the stopped run's late `.finally` doesn't delete the new
    entry (critic).
- **tests/routeJobPurity.test.ts (new):** walks routeJob.ts's static closure, comments stripped.
  - Every module must be either in the mirrored engine closure (sync-router-engine's list), or in
    services/seaway/*, or one of routing/routeJob.ts, routing/backstopSamples.ts, utils/createLogger.ts.
  - No module may USE the globals fetch, indexedDB, caches, localStorage, sessionStorage, document or window
    (member, call or `typeof` use), or import `@capacitor/*` or a Filesystem. Bare words are allowed:
    tideCeiling.ts:376 and fairlead.ts:240 have a parameter called `window`.
  - `import type` lines are skipped (types erase); every other import is followed.
  - No module may contain a dynamic `import(` (with decision 4's spike alternative, createLogger.ts is the one
    exemption, and the no-`error()` rule below is then what keeps it from running).
  - No module may call a logger's `error()`.
- **tests/landBackstop.test.ts:** the job's `chartVerdicts` equal today's probe verdicts at the same samples (on
  the archipelago); a probe that throws gives 'unchecked' plus one warn.
- **tests/autoroutingThalassa.test.ts:**
  - `signal` and `onStage` reach `tryInshoreRoute`;
  - the four stage words are exact;
  - the backstop gets `chartVerdicts`.

  Extended, never replaced (127-PYD-2 and 127-C-c extend it too).
- **tests/AutoroutingTrialWorkspace.test.tsx:**
  - while busy the button reads Stop; Stop aborts the fake provider and shows "Stopped. Nothing changed.";
  - the pins are kept;
  - the counter is `aria-hidden`;
  - the 'routing-main' words show.
- **tests/WorkerSentryNoop.test.ts:** navGridWorker.ts leaves its list (:164, :173, :181); routeJob.ts joins it as
  a worker entry. Its :155-159 (createLogger's `import('../services/sentry')`) is rewritten for the sink.
  **tests/createLogger.sink.test.ts (new):** `error()` reaches the sink once it is set; before
  that it waits in a queue of at most 20; createLogger.ts contains no `import(`.
- **tests/MemoryGaugeNativeContract.test.ts (extended; it already covers the warning listener) or a new tests/memoryGauge.workers.test.ts:** a warning calls `trimRouteWorkers()` as well as `trimNavGridCache(0)`; the
  host's trim posts 'trim' to a live instance and ends an idle one (decision 12).
- Every existing router, tracer and autorouting suite stays green unchanged. In vitest they run through the same
  `runRouteJob` on the main thread, because jsdom has no Worker.

**Playwright, dev fixtures: browser-tests/route-worker.spec.ts (NEW; one line in playwright.keyboard.config.ts
`testMatch`), Chromium + WebKit, `--workers=1`, `e2e/fixtures/autorouting-trial.html?engine=real&scene=archipelago`
(20 NM):**
- **The main thread stays responsive (the long-task test).** While the status reads "Routing round the land",
  a 4 ms heartbeat's longest gap stays < 150 ms, and requestAnimationFrame keeps firing. In Chromium no
  `longtask` entry is ≥ 150 ms. A click on a fixture probe button is handled within 150 ms. Today this fails:
  the gap is 1,660-1,880 ms in WebKit, one task.
- **Negative control:** with `&worker=off` the same harness sees ONE gap ≥ 1,000 ms. That proves it can see a
  freeze.
- **Parity in the browser:** the proposal's `coordinates` and `engine` (minus `elapsedMs`) with the worker are
  bit-identical to those from `&worker=off` in the SAME browser, in both browsers. That proves the clone round
  trip in JavaScriptCore. Never compare a WebKit result exactly with a V8 one (Gates: JSC and V8 differ in the
  last bits).
- **Stop:** tapping Stop mid-route gives "Stopped. Nothing changed." within 300 ms, no line drawn and no gap
  over 150 ms. A second Calculate then returns the parity route from a fresh worker.
- **The counter:** the seconds tick at least twice during a ≥ 2 s route.

**Playwright, production build: e2e/route-worker.spec.ts (NEW, in playwright.config.ts's prod-preview suite,
chromium + mobile-safari). It is the spike made permanent:**
- It finds `router-engine-*.js` in dist/assets.
- Its static import closure, parsed from the built files, is only `router-engine-*` and `engine-leaf-*` (the
  gate's allowlist).
- No `navGridWorker-*.js` remains in dist.
- In the page, `new Worker('/assets/router-engine-….js', { type: 'module' })` answers a synthetic 5 NM job built
  in Node. Its answer is bit-identical to the same chunk `import()`ed on the page's main thread. It equals the
  chunk `import()`ed in Node within relative 1e-12 on numbers and exactly on everything else, because mobile-safari
  is JSC (measured, Gates).

## Key files

- **New:** services/routing/routeJob.ts, services/routing/routeWorkerHost.ts, services/routing/backstopSamples.ts,
  tests/fixtures/syntheticArchipelago.ts, the goldens under tests/fixtures/routeJob/, tests/routeJob.parity.test.ts,
  tests/routeJob.clone.test.ts, tests/routeWorkerHost.test.ts, tests/inshoreRouter.join.test.ts,
  tests/routeJobPurity.test.ts, tests/createLogger.sink.test.ts, browser-tests/route-worker.spec.ts,
  e2e/route-worker.spec.ts.
- **Changed:**
  - services/InshoreRouter.ts (the seam, the join count, signal, stages, the EXIT durations, `chartVerdicts`,
    re-exports);
  - services/engine/navGridWorkerHost.ts (posts to the shared worker; the same export);
  - services/routing/landBackstop.ts (re-export only);
  - services/autoroutingThalassa.ts (:73-75 comment, :289-297, :432-435);
  - components/map/usePassagePlanner.ts (:572-574);
  - hooks/useVoyageForm.ts (:794);
  - components/autorouting/AutoroutingTrialWorkspace.tsx (status, panel line, Stop);
  - utils/createLogger.ts (the sink), the main entry's boot (one sink registration). Only index.tsx needs it:
    in the main checkout's dist of 2026-10-10 14:20, createLogger's code is in ApplicationShell alone,
    and the logs, beta, feedback and ocean entries don't load it;
  - pi-cache/src/routerEngine/syncedFrom.ts (the stamp the sync rewrites for createLogger.ts; no engine module);
  - services/native/memoryGauge.ts (one line: the warning also trims the route workers, decision 12);
  - vite.config.ts (`manualChunks` rule; `workerSentryNoop` left inert or removed);
  - e2e/fixtures/autorouting-trial.tsx (`scene=archipelago`, `worker=off`);
  - playwright.keyboard.config.ts (one `testMatch` line);
  - tests/WorkerSentryNoop.test.ts and the tests listed above.
- **Deleted:** services/engine/navGridWorker.ts.
- **Not touched:** any engine module (services/inshoreRouterEngine.ts and its mirrored closure), pi-cache apart
  from the syncedFrom.ts stamp,
  services/routeTracer.ts, Plan Your Day files (127-PYD-2 does those), MapHub.tsx and any Codex-owned file.

## JS estimate

| Item | KB |
|---|---|
| **New code (minified estimate)** | |
| routeJob glue (message handler, chart verdicts, timings, log forwarding) | +0.8-1.2 |
| routeWorkerHost (spawn, queue, stop, crash cap, fallback, grid instance) | +1.8-2.5 |
| InshoreRouter (signal, join count, stages, EXIT durations, job build) | +0.6-1.0 |
| Provider stage words and pass-through | +0.2-0.4 |
| Auto's Stop, counter and words | +0.3-0.6 |
| createLogger sink + boot registration, net of the removed lazy-import wrapper | +0.1-0.2 |
| Cross-chunk import/export lists from the new `router-engine` chunk | +1.0-3.0 |
| navGridWorkerHost rework | +0-0.2 |
| memoryGauge's worker trim (critic) | +0.1 |
| **New code total** | **+5 to +9** |
| **Removed** | |
| navGridWorker chunk, measured | −35.0 (−35,001 B) |
| `_worker-sentry-noop` chunk | −0.07 (−74 B) |
| **Net, if the spike passes** | **−26 to −30** |
| At 126's 1.5× overrun on the new code | −21 to −28 |
| Without the navGrid fold (if only the fold had to go) | +5 to +9 |
| The fallback half (decision 13) | about +0.6 |

- **Why not the usual worker.** A worker built the usual way would add +74 to +287 KB (measured closure sizes,
  Today). That is the reason for decision 4, and it is never the fallback.
- **First load does not move.** The engine moves from ApplicationShell to a sibling chunk that ApplicationShell
  imports. The entry chunks don't reach it (gate). `mainRaw`/`mainGzip` stay within 0.5 KB, and the Lighthouse
  ratchet is checked at assembly.
- **Measured, not estimated, at the spike.** The spike measures the chunk split and the sink before any feature
  code. If the split alone costs more than +5 KB, that is a spike failure (decision 13). The bar was +3 KB, below
  this table's own +1.1 to +3.2 for those two lines.

## Risks

1. **The engine chunk won't load in a worker on the phone.** The chunk URL uses the same capacitor:// scheme and
   folder as navGridWorker, which has run on device since July. **But no shipped worker has yet loaded a sibling
   chunk through a static import** (corrected by the critic). navGridWorker-*.js, encGeometryWorker-*.js and
   encParseWorker-*.js are each one self-contained file; navGridWorker's only import is a lazy `import()` of the
   74 B noop that never runs. Desktop WebKit in Playwright is not WKWebView behind Capacitor's scheme handler.
   So the first real proof is the iOS Simulator or the phone. Recommended: run the assembled 127 build once in the
   Simulator before TestFlight and read the EXIT line's `worker`/`main` (Safari's Web Inspector shows it).
   If it still fails on the device, the host falls back to the main thread
   (today's behaviour) and the words say "the screen may pause". The device smoke shows which one ran: its EXIT
   line ends in `worker` or `main`.
2. **The spike fails in WebKit, or the split costs too much** → decision 13. The fallback half ships, and the
   worker moves to 128.
3. **Memory against the 2 GB cap.** The worker's heap and the job's clone are in the same process. Mitigations:
   the worker's clone is the real extra (about 4× the corridor's JSON at peak, 40-80 MB for a 10-20 MB
   corridor; dropping `merged` on the main side frees almost nothing, because its features are EncCellStore's
   own cached objects). The worker lets go of the layers after each job, a memory warning trims both instances
   (decision 12), and one route runs at a time. 127-C-c's dock smoke measures it. If anything crashes to The Glass, get the JetsamEvent .ips
   first.
4. **After a Stop, the next route starts cold.** The terminated worker loses its warm grid cache. A re-tap is then
   a cold route, but off the thread.
5. **The chunk split puts the engine on the first load of another entry.** The build-graph gate and the prod spec
   catch it. The fix is to move that leaf to `engine-leaf`.
6. **A remaining hitch.** The hand-off clone of a big corridor is an estimated 0.1-0.3 s on the phone. It is one
   short task, and worker-held cells are a later step.
7. **Shared hunks:**
   - services/autoroutingThalassa.ts with 127-PYD-2 (next in lane 1; :285) and 127-C-c (lane 2; :274, :308-331,
     words). Separate hunks; the later merge rebases.
   - AutoroutingTrialWorkspace.tsx with 127-PYD-3 and 127-11b. ROUTE-W touches the status, panel and footer
     only.
   - usePassagePlanner.ts with 127-11 (:864, :1690). Different lines.
   - useVoyageForm.ts with 127-C-b (:832-850). Adjacent; C-b is likely to merge first.

## Device smoke (Shane, at the marina, on the TestFlight build; folded into 127-PYD-2's timings)

1. Auto, Coral Sea Marina → Cid Harbour:
   - while "Routing round the land · N s" shows, pan and pinch the chart: it moves, and the seconds keep
     ticking;
   - tap Stop: "Stopped. Nothing changed." at once;
   - Calculate again: the route arrives as before.
2. Plan Your Day (owner): tap "Route round the land" on Cid Harbour and scroll the sheet while it routes.
   Close the page mid-route and open it again: the button is back.
3. If a Mac is connected, the EXIT line shows the stage durations and ends in `worker`. These are the first real
   phone numbers for the freeze and the waits.
4. Memory: 127-C-c's 20-minute dock smoke includes one 30 NM corridor routed through the worker.

## Size and order

M-L, 3-3.5 h of lane time, the 1 h spike included. **The critic, 2026-10-10 ~23:00: more likely L, 5-6 h.** By
126's pace (L 3-4 h), this has a 1 h spike, 3 new modules (about 330 lines moved out of InshoreRouter.ts), a
ported 20 KB scene generator, goldens, 8 new or changed vitest files, 2 new Playwright specs, the navGrid fold,
the UI, and the full router suites on one worker on the 8 GB Mac. See the schedule's issue list for the split
that keeps PYD-2's start.
- **Lane 1:** after 127-PYD-4 (in flight), before 127-PYD-2, which routes through this package and rebases on
  its provider hunks.
- **Merge-order notes:**
  - It merges before PYD-3 (AutoroutingTrialWorkspace.tsx).
  - Against 127-C-c, whichever of the two merges second rebases its autoroutingThalassa.ts hunks.
  - C-c's optional memory-warning line is now ROUTE-W's (decision 12). C-c need not touch memoryGauge.ts.

## FILES-TOUCHED

Edited: the key files above. Shared:
- with 127-PYD-2: services/autoroutingThalassa.ts, separate hunks;
- with 127-C-c: services/autoroutingThalassa.ts;
- with 127-PYD-3 and 127-11b: AutoroutingTrialWorkspace.tsx;
- with 127-11: usePassagePlanner.ts;
- with 127-C-b: useVoyageForm.ts;
- with 127-H: vite.config.ts, which 127-H only reads (`releaseMinifyPublicScripts`).

Not touched: engine modules, pi-cache, routeTracer.ts, MapHub.tsx, Plan Your Day files, Codex files.

## Calls made on the standing order (no question blocks this package)

1. Worker in 127, as Shane's "yes" asked: **yes**.
2. The engine chunk is the worker (one copy) rather than a separate worker build: **yes**. A separate build can't
   fit the JS line.
3. Fold the tracer's navGrid worker into it: **yes**. It is the −35 KB that pays for this package and frees room
   for the rest of 127.
4. If the spike fails: ship the fallback half, move the worker to 128, and tell Shane in the morning: **yes**.
5. The satellite classifier and the parallel waits wait for 128: **yes**, so 127 stays inside its list.
