# 127 VISION: The boat is the navigator

Written 2026-10-10 ~16:00 AEST. Read-only on b127 (= master bd2d35b07 + 127-01 at 1b71c2ade).
Synthesised from four judged concepts (bang127/: skipper-day.md, pi-brain.md, open-base.md, moat.md)
and the two judges. Spine = the highest-scoring concept, "The Boat Is the Navigator" (Plan Your Day v3,
62 of 80 across both judges); grafts from "Ask the Boat" (58), "Open Chart" (57) and "Proven Water" (52).
Sits on top of the 127 plans already written: 127-01, 127-PYD-common and 127-PYD-1..10. 127-DESKMAP.md was
not written when this was (the investigation, scratchpad/deskmap127/, is shooting a light "chart day" base);
this file says what the vision needs from it and nothing more.

## Authority (verbatim, in order)

1. o-charts (Roberto), 2026-10-10: "Storing unencrypted data on any medium, and especially in the cloud,
   is strictly prohibited by the terms of the licenses signed with the chart providers." Also: "You can
   proceed as you are" (Pi decrypt like AvNav is tolerated).
2. Shane, after reading it: "ok, then we work within the rules, but we need to make it bang claude.
   better than what we were going to do. it has to be better. think think think. what can we do to make
   it better"
3. Shane, earlier today: Plan Your Day "only ever show[s] the same 3 destinations", "needs another good
   clean up", plotting "goes direct… straight over hills, rocks…", "the autoroute… is banging at the
   moment. so can we incorporate the autorouting into the plan your day thingy. once you have made it pop
   a little more"; the desktop "underlying map is dark and very hard to see what is water and what isnt";
   "our own Relief map… a light nautical-style base built from open coastline data… the free OpenSeaMap
   layer with buoys and beacons… a combination of these 3 would rock"; "can we include the wind layer on
   the desktop.?? as an option??"; and on the follow-up email: "no, we will wait for his response first".
4. Shane ~16:05: build 127 = charts stay on the boat + the desktop + Plan Your Day v3 with autorouting
   (+ 127-01, + 127-11 orientation modes); the old 127 list moves to 128 and later, order unchanged.
5. Standing order: "your recommendations for all work requiring an answer".

---

## 1. The promise (what a skipper feels)

You wake at the marina and open Plan Your Day. It shows three different places, each with the reason it
was picked: "Best fit", "Other way · more shelter", "New to you". You open Butterfly Bay. A few seconds
later it reads "Routed on your charts · 18.2 NM each way · leave 06:40–09:10 to carry the tide over the
shallow bit off Pioneer Point · your 07:00 works". Show route on chart draws exactly the line Auto would
draw (green, amber where it needs tide, red named), at your leave time. Never a straight line over an island
again. At home on the desktop the map is a light chart: sand land, pale water, a hard coastline, the
Relief seabed under it, OpenSeaMap buoys and beacons on top, wind if you want it. And a plain line says
"Licensed charts stay on Serene Summer."

Underneath, one rule runs everything: **the boat is the navigator.** Serene Summer keeps her licensed charts
aboard, encrypted at rest and opened only in memory. She (the Pi, or the phone aboard, which gets cells
from her) works out the way on them. Every other device gets **answers** (a line, plain words, times),
never charts. Everything else that makes a day good (wind, swell, tide, sun, rules, what she measured at
anchor) is not chart data, so it can go everywhere.

In later builds the boat does more of the thinking: the Pi routes for every device aboard, so phones
never freeze. Overnight it routes every anchorage within a day's sail, so Plan Your Day opens instantly
with real lines. It checks a PredictWind or Navionics route against her own charts. It keeps a log of
every night at anchor. Then, with every phone asleep, it looks ten minutes ahead on her charts and wakes
the watch before the shallows.

## 2. Why this beats what we were going to do

What we were going to do in 127, before the ruling and before this pass: the compliance clean-up (C1-C9),
Plan Your Day v3 (10 packages), a lighter desk map and orientation modes. That plan was good but
defensive: it took protected charts off the desktop and away from the boat and gave nothing back. This
version keeps all of it and adds five things:

| # | Added | Why it matters | Cost |
|---|---|---|---|
| 1 | **The leave window** on every routed stop: "leave 06:40–09:10 to carry the tide over…" | Turns amber "needs tide" into a decision. Both engines already exist: `sweepDepartures` (services/routing/DepartureSweepInshore.ts:42, the passage planner's "when should I leave?") and `shallowRunsToDepartureSpots` (services/routing/inshoreTideSpots.ts:125), which turns the router's shallow runs into sweep spots. | S, new 127-PYD-11 |
| 2 | **The watch can never be stalled by charts.** The Pi's chart work (decrypt, parse, later routing) runs as its own process with a CPU cap. The in-process route endpoint is switched off. | Verified: `routeInshore(...)` runs synchronously inside the HTTP handler (pi-cache/src/routes/enc.ts:1619), in the same Node process as AnchorWatchRunner, PiAlarmRelay and AisNightWatch (pi-cache/src/server.ts:226-261), and there are no worker_threads in pi-cache/src. Nothing in the app calls it today (services/InshoreRouter.ts:164 `CLOUD_ROUTER_ENABLED = false`), so it is a **trap, not a live bug**. It goes live the day anything asks the Pi to route, and C1 will move parsing onto the Pi anyway. | Folded into the Pi package (no extra lane) |
| 3 | **The hidden chart stores, closed.** The audit found cells. I found three more places where numbers and positions taken from protected charts are written to disk, outside the C-list (details in §6). | Roberto's rule covers "any medium". Fixing only the cells would leave us non-compliant without knowing it. | S-M, new C10 |
| 4 | **Honest off the boat.** A chip ("Licensed charts stay on Serene Summer: showing the open chart"). Off-boat lines are grey dashes labelled "sketch, not checked", never green. | Today the desktop just says "No verified ENC charts installed" (since 15:30). The honest version tells the skipper why, and what to do. | S, in DESKMAP and PYD-2 |
| 5 | **Licence hygiene we found on the way** (Mapbox and Open-Meteo, §6). | These are live problems in today's code, and each is cheap to fix now. | S, 127-H |

And it sets the direction for 128-130 (§5), so every later build adds to one idea instead of a list.

## 3. Why it beats the competitors (sourced; counted claims only)

- **PredictWind.** Its Departure Planning compares departures across models but "is always run fastest
  time" and ignores comfort settings
  (help.predictwind.com/en/articles/2884536-how-to-use-the-departure-planning). Its depth avoidance uses
  global 2/5/10/20/30 m contours and tells you to check the route yourself
  (help.predictwind.com/en/articles/9786902-faq-depth-avoidance). We pick the PLACE as well as the time, at
  her limits, and route on her licensed charts at her draft and air draft with the tide at her leave time.
  From 128 we can check a PredictWind GPX against her charts. Honest limit: their proprietary 1 km models
  and offshore maturity stay ahead until our replay benchmark says otherwise (memory
  thalassa-offshore-best-of-best).
- **Savvy Navvy** is the closest. It routes on charted depth, tide and weather and scans departures every
  30 min (help.savvy-navvy.com, departure scheduler). We beat it on choosing where to go, her own boat data
  (learned polar, her wind, from 128 her nights at anchor), the model spread and the chain from choosing a
  stop to arming the anchor watch. We are behind on one thing: it needs no hardware for charts, and we need
  the Pi outside open-data waters.
- **Plotters** (Garmin Auto Guidance) do route on licensed charts aboard, using a safe depth and a vertical
  clearance (Garmin GPSMAP manual, "Auto Guidance Path Configurations"). But the route stays on the
  plotter, uses no tide window and doesn't choose where to go. So we must **never** claim "the only app that
  routes on your charts aboard".
- **Orca** routes on draft, height and width, with offline routing in Plus
  (help.getorca.com/en/articles/6541858). **Navily** scores protection from reviews, not measurements
  (YBW thread in skipper-day.md).
- **True claims we can make today** (survey wf_ce48a18b-3c1): "the only app where your boat's own wind
  drives the wind map around her, aboard or from home". From 128: "measured nights at anchor", but say it
  only once the log exists. Every other "only" waits for a count.

## 4. The architecture: who holds what

### 4.1 The constitution (every package obeys)

1. **Protected cells have one home: the licensed Pi.** "Protected" means o-charts oeSENC (AU, NC) and
   anything like it. They are encrypted at rest and decrypted only into the vault process's RAM. S-63
   (ChartWorld) never feeds Thalassa: the o-charts shop terms make it OpenCPN-only (ocharts-audit
   shop_terms.txt L53), and 127 retires the adapter.
2. **No chart numbers or positions on any disk.** This covers cells, features, grids, charted depths, mark
   and hazard positions, and pictures of charts. They are not written to the phone, the Pi, the cloud,
   logs, fixtures or backups. Memory only, with `Cache-Control: no-store` on every chart-bearing response.
3. **What may be stored is the skipper's own line and plain words.** These are the route positions and the
   per-leg grade (clear / caution / danger) or "needs tide". Auto's Save already does this. Whether they may
   **leave the boat** is the first question for Roberto (§7). The current behaviour continues until he
   answers (Decision 6).
4. **The watch is sacred.** The anchor watch, AIS night watch, alarm relay and telemetry never share a
   CPU-bound thread with charts.
5. **Advice, not walls** (memory thalassa-castoff-advisory). Amber with a reason; red named; never refuse a
   whole route for a shallow stretch (Shane 2026-10-08).
6. **Honest coverage words** wherever we can't see: no chart on this device, boat offline, forecast old,
   "model depth, not a chart".
7. **Every data source has a commercial licence we can cite** (§4.3), and every credit we owe is shown.
8. **Global first.** Every feature has a non-Queensland test and an honest answer where data is thin.

### 4.2 Data flows

```
  THE BOAT (licensed chart room)                                     OFF THE BOAT
  ┌───────────────────────────────────────────────────────┐
  │ Pi "calypso"                                           │
  │  o-charts .oesu (ENCRYPTED at rest)                    │
  │     │ oexserverd FIFO (kernel pipe, no file)           │
  │     ▼                                                  │
  │  chart VAULT process (127): RAM LRU, no temp files,    │
  │   nice 10, CPU cap leaves the watch a core, killed     │
  │   first on OOM, no core dumps, zram only               │
  │     │   + BRAIN in the same process (128-129):         │
  │     │     route / check / leave window / overnight     │
  │  WATCH process: anchor, AIS night watch, alarm relay,  │
  │   telemetry (unchanged, own core)                      │
  └─────┬─────────────────────────────────────────────────┘
        │ boat LAN only · paired devices · no-store
        ▼
  phone / iPad ABOARD: cells held in memory only (127 C3; Roberto Q1 pending)
   → Plan Your Day, Auto, Route report, Glass: line + words + numbers on screen
        │
        │  may be STORED / leave the boat:  her line + grade words   (Auto Save today; Roberto follow-up 1-2)
        │  NEVER:  cells, features, depth polygons, chart numbers/positions, chart pictures
        ▼
  ACCOUNT (Supabase): saved routes (line + words), later her nights and sketch requests
        ▲
        │  open data only
  DESKTOP / PHONE ASHORE: light chart base (Mapbox vector styled, rendered only) + Relief seabed
   + OpenSeaMap seamarks + wind option; NOAA ENC routes in US waters; elsewhere grey "sketch" lines
```

| Flow | What travels | Licence basis | When |
|---|---|---|---|
| F1 o-charts set → Pi vault | Encrypted .oesu at rest; decrypted cells in the vault's RAM | Roberto 2026-10-10 ("proceed as you are"; never unencrypted on any medium); AvNav ochartsng precedent (local net, RAM). Needs root checks on calypso: disk swap off (zram only) and LimitCORE=0. The o-charts audit did not check swap. | 127 (C1) |
| F2 Pi → phone aboard | Cells over the boat LAN to paired devices; phone memory only | Pending Roberto Q1 (sent 10 Oct). This goes beyond AvNav, whose clients get pictures. If he says no, routing aboard moves to the Pi (F3) and phones get answers only. | 127 (C2, C3) |
| F3 Pi brain → devices aboard | Answers: line, words, numbers, tide windows | Local-net, like AvNav. Nothing stored except the line. | 128-129 |
| F4 Device → account | Her line + grade words. Numbers and positions from protected cells are never stored (C10). | OpenCPN exports routes as GPX (wiki "Manage Routes and Marks"). Our reading is yes; Roberto follow-up 1-2. | Today (Auto Save); kept |
| F5 Account → Pi ("send to boat") | Her sketch route (her data). The Pi checks it in RAM and the result stays aboard. | Nothing chart-derived leaves the boat, so nothing to ask. | 129 |
| F6 Pi → devices off the boat (tailnet / sealed mailbox) | Line + words (+ numbers) | Needs Roberto's written OK (follow-up 1, 3, 4). Built behind one flag, OFF until then. | 129+ |
| F7 Open data → every device | Relief, styled base, seamarks, NOAA ENC | See §4.3 | 127 |
| F8 Weather → every device | Model fields and point forecasts, with model credits | See §4.3 (UKMO is share-alike) | 127 desktop wind |
| F9 Her instruments → Pi / account | GPS, wind, depth, heel, anchor log, polar | Her own data. Sharing beyond the owner needs a consent version (Sightings pattern). | 128+ |

### 4.3 Data sources and their licences

| Source | Use | Licence (cited) | Conditions |
|---|---|---|---|
| o-charts oeSENC AU (€35), NC | Pi only, RAM | o-charts EULA + Roberto 2026-10-10 | One licensed system + one backup (EULA L513). Each app/device consumes its own licence. Nothing unencrypted on any medium. |
| S-63 (ChartWorld FR466870, GB501494) | **Excluded** | o-charts shop terms L53 (OpenCPN only); EULA L535 (no interfering with the encryption) | Retired in 127 C5. Do not renew GB501494 (30 Nov) for Thalassa. |
| NOAA ENC | Route + display, every device | CC0 / US public domain (catalog.data.gov NOAA ENC) | Credit NOAA. Redistributed copies are not "official". |
| GEBCO 2026 (Relief) | Display + "model depth" only | Public domain with attribution (gebco.net terms) | "Should NOT be used for navigation". Never inshore routing depth. |
| GA GBR 30 m (Relief) | Display | CC BY 4.0. GA cleared commercial use 2026-10-07 (memory thalassa-obs-relief-basemap) | GA's "Based on…" wording is still owed in credits. Vertical datum MSL, so label "below mean sea level". |
| OpenStreetMap (water pack, anchorages, coastline thumbnails) | Route + display | ODbL | "© OpenStreetMap contributors". A derived database is offered under ODbL; keep our own data in separate layers. |
| OpenSeaMap seamark tiles | Desktop display | Tiles CC BY-SA 2.0, data ODbL (openseamap.org FAQ) | Credit both. Free, donation-funded server: access can be withdrawn, so our own seamark layer comes later. Never bake into a static image without CC BY-SA. |
| Mapbox (styled vector base, satellite) | Rendered layers only | Mapbox Product Terms Oct 2025 (bang127/mapbox-terms.txt) | §1.6/§1.9: no extracting or tracing. §2.8.1: device cache ≤30 days, no proxying. §2.7.2: no storing or caching temporary geocodes. §1.5(iv): never use Mapbox to benchmark a substitute. |
| Weather: ECMWF, DWD, NOAA (+ JMA, Météo-France: verify per model before global launch) | Forecasts, wind layer | CC BY 4.0 | Name the models used on every surface. |
| Weather: UK Met Office global | Shown and credited | **CC BY-SA 4.0** (registry.opendata.aws/met-office-global-deterministic: "British Crown copyright… licensed under CC BY-SA"; open-meteo.com/en/licence agrees) | Never blend it into anything we publish unless that product carries CC BY-SA. CLAUDE.md's "CC-BY-4.0 (… UKMO …)" is wrong (Decision 8). |
| Open-Meteo customer API (paid) | HTTPS web wind and weather | Commercial subscription | The free endpoints are non-commercial. supabase/functions/proxy-bosun-fallback/index.ts:346,372,385 still calls them (127-H). |
| WorldTides (paid) | Tide windows | worldtides.info/terms | Results may be cached, and stored "on behalf of an individual end user". Redisplay to that user only. "Do not use WorldTides as the only source for navigation". So: never on public pages or shared cards. |
| NOAA CO-OPS / LINZ tides | Tides | US public domain / CC BY 4.0 | Clean for shared surfaces. |
| Allen Coral Atlas | Reef keep-out (129) | CC BY 4.0 (allencoralatlas.org/resources) | Never the Planet mosaic (CC BY-NC-SA). Label "satellite-estimated, not surveyed". |
| ProtectedSeas Navigator | Rules (130) | CC BY 4.0 (figshare dataset 25970488) | Use the dataset, not the paper (CC BY-NC-ND). Show the data date. |
| AISHub | Boats at anchor (129) | Desimir's written OK 2026-09-02 for public display | Confirm with him that derived counts are covered too. |
| Her instruments | Everything "her" | Her data | Sharing beyond the owner only with a versioned consent. |

## 5. Roadmap

### 127: "Aboard, it's the real thing" (about 2 days, 3 lanes)

Measured pace: build 126 merged 29 packages in about 20 hours on three lanes. 127's MUST list is about 20
planner-days by the planners' own sizes, so two days is tight but real. The cut line below protects the
ship date. Rules from 126 apply: at most 3 builders, one heavy command at a time (8 GB Mac), named files
only, .env files copied into every worktree, `df` before builds.

**Lane 1: Route the day (Plan Your Day routing)**
1. 127-PYD-1 Say why (S): reasons on ✕ rows, thunder in the headline, one glyph language, AA button, "Local notes".
2. 127-PYD-2 Route the stop she opens (M): Auto's strict provider at the CHOSEN departure (`departureMs`
   through autoroutingThalassa.ts:285); honest no-route words; times from the routed line.
3. 127-PYD-4 Different places, picked for a reason (M): every place in reach, no channels, diverse picks
   with true tags, five route-checked and three shown, depth at the pin (memory only).
4. 127-PYD-3 Plot on chart = the routed line (M): Auto's dormant day-plan mode; "Plot by hand" with two marks
   and the reason when there is no route; the straight-pin path deleted. **Its Save card waits for C-b.**
5. 127-PYD-5 Every place opens (S-M).
6. **127-PYD-11 Leave window (S, NEW).** On a routed stop, `shallowRunsToDepartureSpots` +
   `sweepDepartures` over the routed line give "Leave 06:40–09:10 to carry the tide over the shallow bit off
   Pioneer Point; your 07:00 works", or "No leave time today clears it: the deep way round, or tomorrow's
   tide". It is computed in memory and never stored (C10). With no tide data it says "tide not known" and
   never guesses (the sweep's 'unknown', DepartureSweepInshore.ts:26-28). Footnote: "Tide from WorldTides;
   check the official table." WorldTides' terms forbid it being the only navigation source. JS about +1 to
   +1.5 KB.

**Lane 2: Charts stay on the boat (compliance), then orientation**
1. **127-C-b: provenance + evidence + C10 (S-M).**
   - C7: the `licence: 'protected' | 'open'` flag, carried to the phone; protected by default.
   - C8: proposal evidence from protected cells is held in memory only, not "local on disk".
   - **C10 NEW:** no chart numbers or positions on any disk (list in §6). Grades, words and the line stay.
   - Goes first, because PYD-3's Save card depends on it.
2. 127-C-a: delete and guard (S).
   - C9: personal-shelf code deleted.
   - C5: the S-63 XOR adapter and encWatcher S-63 branch retired.
   - C6: CI guard so no chart-derived fixture can enter the repo.
   - This lowers JS, which pays part of 127's bill.
3. 127-C-c C3, phone memory-only (M): protected cells never written. The store moves out of Documents to
   Library/Application Support with isExcludedFromBackup. UIFileSharingEnabled dropped if only S-63 setup
   needed it. Existing protected files purged at upgrade. Then the device smoke: PYD routing from memory-only
   cells, one 30 NM corridor, watch memory against the 2 GB WebContent cap.
4. 127-C-d **Pi update 3, staged for Shane** (M-L; measure decrypt-on-demand on calypso first).
   - C1: the chart vault, i.e. oexserverd FIFO into a RAM LRU (start at ~600 MB and measure; the AU set
     decrypted in 75 s, ~80 ms a cell). The vault runs **as its own process** (systemd unit: Nice=10, a
     CPUQuota that leaves the watch a core, OOMScoreAdjust so the vault dies first, LimitCORE=0). The
     plaintext JSON store (1,031 cells, 2.0 GB, the last unencrypted copy on any medium) is deleted, and a
     startup sweep clears TEMP_ROOT.
   - C2: paired-device token on every /api/enc route, boat LAN only, `Cache-Control: no-store` on every
     chart response (none today: 0 hits in pi-cache/src/routes/enc.ts), at most 5 devices.
   - `/api/enc/route` and `/route-prepped` answer 503 "routing runs on your phone in this build". They read
     the store C1 deletes and would stall the watch. The brain hosts routing in 128-129.
   - The DELETE API removes the blob, not just the index entry (found at Pi update 2).
   - The Pi geocode cache stops sharing Mapbox results across devices (§2.7.2; pi-cache/src/routes/misc.ts:182-199).
   - Shane's root checks before install: `swapon --show` shows zram only, `ulimit -c` / systemd LimitCORE=0.
   - Not a TestFlight blocker: the app works with the old or new Pi. Shane installs at the dock.
5. 127-11 chart orientation modes (M; Shane asked for it in 127).
6. 127-H licence hygiene (S):
   - public/sw.js gets a 30-day age cap on mapbox.com tiles (§2.8.1; :665-705 has a count cap only);
   - proxy-bosun-fallback moves to the Open-Meteo customer endpoints, including geocoding at :346 (Shane deploys).

**Lane 3: The desk and the pop**
1. 127-DESKMAP (M), Shane's "combination of these 3".
   - The base: a light chart day base (buff land, pale water, a coastline that holds 4.5:1 or better against
     both; today land #333b45 vs water #1f5a85 measures 1.16-1.54:1, components/map/reliefBase.ts:136-161).
   - Our Relief seabed under it.
   - OpenSeaMap seamarks on top, credited.
   - A night variant for the phone.
   - Desktop and Plan Your Day default to the day base. Datum chip: "depths below mean sea level". At z11
     and closer, where only GEBCO speaks, the water is hatched and labelled "model depth, not a chart",
     never plain "deep".
   - The "Licensed charts stay on Serene Summer" chip, and grey dashed "sketch, not checked" lines off the boat.
     (Critic pass 3: the chip shows only for an account whose paired Pi holds licensed charts. Everyone else
     gets "No chart for this area"; see 127-DESKMAP C1.)
2. 127-DESKMAP-b, wind layer option on the desktop (S). The 12-model wx server is tailnet-only plain HTTP,
   which deployed HTTPS web can't reach (wxServer.ts gate). So the web uses the paid Open-Meteo customer API,
   with model credits (UKMO marked CC BY-SA). The app and Pi keep the wx server.
3. 127-PYD-6 Day ribbon (M).
4. 127-PYD-7 Best fit + two alternates (M).

**Cut line (if Monday evening arrives first).** Slide, in this order: PYD-7, then PYD-6, then 127-H's
service-worker half, to 128. **Never cut:** PYD-1..5 + 11 (the routed plot works without any visual
package, per PYD-common), C-a, C-b, C-c, DESKMAP + wind, and 127-11 (Shane asked for it; ask him before
cutting). C-d ships on its own clock.

**Slips to 128 by plan:** PYD-8 (stop page), PYD-9 (route pictures + shelter rose, OSM only), PYD-10 (places
worldwide; its extra public-Overpass query must be cached and capped, see 129).

**JS.** b127 headroom is 12,829 B (leave127/after-summary.txt). 127's MUST list adds roughly +25 to +35 KB
(PYD 1-7 + 11 ≈ 21 KB, DESKMAP + wind + orientation ≈ 6-10 KB); C9 takes some back. Do the trims first
(PYD-common list + C9), then move the tripwire once, deliberately, with the reason in the
check-bundle-size.js comment.

**127 gates.**
- Shane's five-minute marina timing sets "route on open" vs "tap to route" (PYD-common Q2).
- The Auto route (trial) default (Q1).
- C-d root checks + install.
- The proxy-bosun-fallback deploy.
- No DB push expected.
- Roberto's reply (~Tue 13 Oct) can change C3 (§7). 127 ships either way.

### 128: Finish 127, the shifted list, and three starters that can't wait

- 127 slips first: PYD-8, PYD-9, PYD-10 (+ anything cut).
- **The old 127 list, moved to 128 in its own order** (Shane ~16:05): official warnings + marine text,
  boat-went-quiet, the StormGlass chain, UKC/datum, the gap-register items.
- Starter 1: **Her nights** (M), the anchor log.
  - Weigh anchor closes a record of the stay: depth at the drop, rode, swing, the strongest gust held and
    its direction (Pi windHistory extended to 24 h, Shane installs), alarms and late-set moves, and roll
    from heel_deg (pi-cache/src/telemetryPublisher.ts:104).
  - Two taps: what came up on the anchor, and how rolly the night was.
  - Owner only, her data.
  - Starts now because nights can't be back-filled. From 129 it feeds the picks ("you held here in 28 kn").
- Starter 2: **Check a route from another app** (S-M). Import a PredictWind / Navionics / OpenCPN GPX
  (gpx-import page exists, components/RoutePlanner.tsx:882-885) and grade it on her charts at her draft
  and the tide at her leave time (Route report exists). Verify with a real PredictWind export first. This is
  the direct answer to PredictWind's own "check the route yourself".
- Starter 3: **the brain begins** (L, staged across 128-129).
  - Routing moves into the vault process.
  - tryInshoreRoute (services/InshoreRouter.ts:830) becomes a pure pipeline with injected IO, so the Pi runs
    Auto's exact rules: strict, hard-land audit, tide ceilings, air draft and bridges, charted leads. Today
    the Pi mirrors the engine only (36 modules) and its endpoint runs permissive, with 9 layers and no tides.
  - A parity harness runs ON the Pi, in memory: the same request gives the same line on phone and Pi.
    Chart fixtures never go in git.
- Measure (scratch only): OSM water vs Mapbox Streets/satellite water in strict mode, against his sailed
  tracks and the hard-land audit. It is not compared with Mapbox data (§1.5(iv)).
- **If Roberto says no to cells in phone memory:** aboard routing moves to the Pi first, ahead of everything
  above except the safety items. The phone gets answers (and, if he wants the AvNav shape, Pi-rendered
  pictures on the LAN).

### 129: "The boat thinks for you"

- The Pi routes Plan Your Day and Auto for every device aboard, so the phone never freezes. The phone engine
  stays as the fallback away from the Pi (open data, NOAA).
- **Morning watch.** Overnight the Pi routes every Plan Your Day candidate within a day's sail for tomorrow's
  tides and every model we hold for that spot, with her learned polar, and re-runs when a model run lands.
  Plan Your Day opens instantly with routed lines aboard. The Pi stores route lines only; evidence stays in RAM.
- **Plan at home, she checks it aboard** (F5). "Send to boat" puts the sketch in her inbox (her data). The Pi
  checks it in RAM and the result waits aboard; ashore you're told "Serene Summer checked it: open aboard to
  see". With Roberto's written yes (F6), the line turns green at home: "Checked on Serene Summer's charts,
  ed. 2026-1-34, 14:02". The tailnet desk page sits behind the same flag.
- **One-tap Go, as advice and never a wall:**
  - the route goes on the chart and the departure is set;
  - Cast Off cards are prefilled;
  - crew get a note;
  - the anchor watch arms itself when she stops within 0.3 NM of the stop, with a "tap to adjust" notification;
  - a diary entry is drafted on arrival.
- Mapbox satellite/streets water retired from the router (Mapbox §1.6), using 128's measurement. Our own OSM
  extract on wx replaces per-user public Overpass (whose policy says commercial use should self-host).
- Allen Coral Atlas reef keep-out with a buffer, for the Pacific. It is never proof of clear water.
- AIS: "at least N boats at anchor with AIS" per stop (after Desimir's OK on derived counts).

### 130: "She keeps watch with charts"

- **Look-ahead on the Pi night watch.**
  - It projects 6-12 min along COG/SOG or the active route, against charted depth at the predicted tide.
  - It wakes locked phones through the existing pi-alarm-relay.
  - Output is text + bearing + distance only.
  - It is tuned on his sailed tracks so it does not cry wolf.
- **Anchor swing at tonight's low**: "At 02:14 the circle reaches 1.9 m charted water 35 m NE". Checked at
  arming and at each tide turn.
- **Which model was right at her.** Uses the Pi's 24 h wind history against as-issued forecasts. The survey
  says we're BEHIND Expedition, qtVlm and PredictWind Observations here. UKMO is credited and never blended
  into what we publish.
- Rules here: ProtectedSeas, GBRMPA, NOAA MPA. "No anchoring here" excludes a place, with its reason and the
  data date.
- Where to drop (the z14 arrival view), a reef-light chip, and comfort-aware departure windows on routed legs.
- The sealed mailbox for asking the boat from anywhere: only with Roberto's yes.
- Day card share. Open sources only: no WorldTides numbers, no Mapbox imagery baked into the image.

### Later (measured or permitted first)

- Offshore berth-to-berth, designed WITH Shane: replay benchmark on his 2026 legs first, then inshore ends +
  per-model routes + learned polar. "Better than PredictWind" only on a measured score.
- Our own open vector base + seamarks (OSM via planetiler on wx, ODbL; offline packs on Pi and phone).
- Seabed v2 with datum honesty, and "how sure is this seabed".
- Her soundings layer. Crowd CSB to the IHO DCDB (CC0), with a fresh consent.
- Fleet truth (holding, roll, model scores): k ≥ 3 boats, consent, delay. With one boat today it would only
  ever say "not enough boats yet", so it waits.
- Roberto-gated: boat's-eye previews off the LAN; a home brain; the encrypted phone cache (C4).
- Parked: the Sentinel-2 crowd climatology (prove yacht detection first; 10 m pixels vs ~12 m yachts), a
  Thalassa Box, a Navionics SDK deal.

## 6. Hidden chart stores found in this pass (C10, 127 lane 2)

Roberto's rule is "any medium". The audit covered cells, cloud, backups and fixtures. These four stores of
chart-derived numbers or positions were outside it:

| Store | What it holds | Where | Fix (127 C10) |
|---|---|---|---|
| Leg-verdict cache, localStorage `thalassa_leg_verdicts_v4`, up to 500 legs | `TraceLegVerdict`: `minDepthM`, `minAt` (position of the shallowest charted point), `nudgeTo` (a charted deep spot), issues with mark positions | services/routeTracer.ts:2030-2066 (`persistLegVerdicts`), type at :125-139 | Protected-cell verdicts stay in memory only; persist grades only, or nothing. A relaunch regrades (that was the old behaviour; the crash-loop guard must stay). |
| Saved route's proposal evidence | Per-leg `minDepthM`, `minAt`, issue `at`/`mark` positions, chart-track labels | services/autoroutingProposalEvidence.ts:34-48 | C8 becomes **memory-only**, not just "local": recomputed aboard when the route opens. |
| Voyage plan route GeoJSON | `properties.shallowRuns` (charted minimum depths per run), "restored from an older client or cloud record" | services/routing/inshoreTideSpots.ts:1-36 | Strip shallowRuns from protected routes when stored. Aboard, the tide gate recomputes; ashore it says "tide gate needs the boat's charts". |
| `saved_routes.verification` + `voyages.notes` trace envelope | Per-leg grade words, draft, tide-window label (no depths or positions) | services/traceVerification.ts:17-34; services/savedRoutesSync.ts:82 | Words class: keep, tagged with C7 provenance, and ask Roberto (follow-up 2). |

## 7. What needs Roberto's written OK

Already asked (Shane's reply sent 10 Oct ~08:55; answer expected ~Tue 13 Oct):
- Q1: may the phone or tablet aboard hold decrypted vector cells **in memory** (127 C3)? If no, 128 moves
  aboard routing to the Pi and phones get answers only. If he prefers AvNav's shape, Pi-rendered pictures go
  to the LAN.
- Q2: may it keep an **encrypted cache**, keyed by the user's own Pi (C4)? Or must every device hold its own
  licence, and how would that work on iOS?

ONE follow-up after his reply (Shane's call: "we will wait for his response first"). Each item says what we
do until he answers:
1. **The route line.** May a route (positions only, like an OpenCPN GPX export) worked out on his charts be
   saved in the owner's account and sent to the owner's own devices away from the boat, end-to-end
   encrypted? *Until then: Auto's Save keeps working as today (Decision 6); nothing new sends it off the boat.*
2. **Plain words with a route.** May a per-leg grade (clear / caution / danger) and a tide-window label be
   saved with it? *Already stored today in saved_routes.verification; kept, tagged.*
3. **Numbers off the boat.** May an answer sent off the boat carry the minimum charted depth per leg or the
   tide height needed? *Until then: numbers on screen aboard only, never stored (C10).*
4. **Remote access.** May the owner reach the Pi over their own private VPN (tailnet) and see answers, or a
   rendered preview, with nothing stored? The o-charts conditions say charts work over VNC
   (conditions_en.txt:28). *Until then: LAN only.*
5. **Our terms in writing.** Please give Thalassa AvNav-equivalent terms in writing: Pi decrypt in RAM, boat
   LAN clients, a cap of 5 devices.
6. **A home brain.** May a second licensed system at home answer when the boat is offline? The EULA (L513,
   one install plus one backup) and the conditions page (L20, up to 5) disagree. *Not built until he answers.*
7. **A sounder note.** May a "your sounder read shallower than the chart here" note, worked out in Pi memory,
   be stored? *Until then: shown live only.*
- Tell him, not ask: the public-repo fixtures are gone (history rewrite Sun 11 Oct); the S-63 converter is
  retired in 127. Offer a listing as an o-charts-compatible app and links to the o-charts shop.

## 8. Decisions for Shane (each with my recommendation)

1. **Auto route (trial) default for Plan Your Day.** Rec: keep it off for testers and on for you. Flip it in
   one line after your marina smoke of PYD routes.
2. **Five minutes on your phone at the marina.** Time Coral Sea Marina to Cid Harbour, Whitehaven and
   Daydream with Auto. Rec: if all three take 8 s or less, routing starts when a stop opens; otherwise a
   "Route round the land" tap starts it, and the Pi brain (129) removes the wait.
3. **127 cut line.** Rec: if time runs out, PYD-7 then PYD-6 slide to 128 first. Never the routed plot, the
   leave window, charts-stay-on-the-boat, the desk map + wind, or orientation modes.
4. **Desktop asking the boat moves out of 127.** Rec: yes. It needs Roberto's yes (your "wait for his
   response") and the Pi engine port. 127 gives the desk a readable map and honest sketches; 129 brings
   "send to boat" (clean without Roberto), and the green line comes home when he agrees.
5. **Pi update 3 (vault in RAM, plaintext store deleted, in-process route off).** Rec: install at the dock
   once staged, after two root checks (zram-only swap, core dumps off). It removes the last unencrypted copy
   of the charts.
6. **Keep saving routes worked out on o-charts cells while we wait for Roberto.** Rec: yes. It's a line plus
   words (OpenCPN exports the same as GPX). If he says no, we stop and purge the evidence-free lines.
7. **Desktop wind source.** Rec: the paid Open-Meteo customer API for the web (HTTPS, licensed), with model
   credits. A Cloudflare tunnel to the wx server can come later if you want all 12 models on the web.
8. **UKMO is CC BY-SA 4.0, not CC BY.** Rec: correct the line in reef-recycling-social/CLAUDE.md. Check
   whether the Spitfire blend or any published card mixes UKMO in. If it does, drop UKMO from the blend or
   label the card CC BY-SA.
9. **OpenSeaMap tiles on the desktop.** Rec: yes, with credit and a short courtesy note to OpenSeaMap
   (plus a donation if you like). Our own seamark layer comes later, so we are never stuck if their free
   server says no.

## 9. Adversarial pass: what I attacked and changed

- **"Live safety bug" was overclaimed.** Nothing calls /api/enc/route today (`CLOUD_ROUTER_ENABLED = false`;
  only /route-prepped sits behind that gate, InshoreRouter.ts:2067-2077). Reworded to a trap. The fix stays:
  switch both off in 127 (C1 deletes the store they read anyway) and host routing in the vault process later.
- **"Ask the boat from anywhere" in 127 was fluff** for two reasons: Shane said wait for Roberto, and the
  orchestrator port is L. Moved to 128-129 behind a flag. 129's "send to boat" was added because it is
  licence-clean without him.
- **"Nobody routes on licensed charts aboard" was false.** Garmin Auto Guidance does, on the plotter. The
  claim was replaced by the specific combination we do and they don't, and Savvy Navvy is named as closest.
- **The "leave window" is not unique** (Savvy Navvy scans departures). It is in 127 because it's cheap
  (both functions exist) and turns amber into a decision, not because it's a moat.
- **"Evidence kept local" still broke "any medium".** Local disk is a medium, so C8 became memory-only and
  C10 was added for three more stores found in code (§6).
- **"12 models" in Plan Your Day was untrue.** Its point block holds 7. Now "every model we hold for that spot".
- **Fleet layers with one boat are fluff for a season.** Kept "later". Only the private nights log starts now,
  because nights can't be back-filled.
- **Sentinel-2 crowd climatology is unproven.** Parked; AIS "at least N with AIS" is honest now.
- **A GEBCO "≈2.2 m at lowest tide" readout invites navigational reliance**, which GEBCO's terms forbid. Only
  "model depth, not a chart" wording and hatching are in 127; datum conversion waits for seabed v2.
- **The router A/B "against Mapbox water" would be benchmarking a substitute** (§1.5(iv)). The measurement
  is now against sailed tracks and the hard-land audit.
- **Shared day cards with WorldTides numbers would break its terms** (redisplay to the end user only), and
  Mapbox imagery baked into an image breaks §2.8.1. Card data is restricted to open sources.
- **NONNA, Traficom and EAHC** (non-navigational or no-redistribution licences) were dropped from the open-chart graft.
- **The desktop wind layer can't reach the tailnet wx server from HTTPS.** Named the source (Open-Meteo
  customer API) rather than leaving a broken promise.
- **Every Roberto-gated flow sits behind one flag.** Nothing in 127 needs his new OK beyond what he already
  allowed (Pi decrypt) and what we already asked (Q1). If Q1 is no, the 128 fallback is written above.
- **A sceptical skipper's test, applied to every 127 item:** does it change what he sees or what he can do
  on Monday? The routed stops, the leave window, the varied picks, every place opening, the readable desk map
  and wind all pass. C-a..d are invisible but are what lets us keep the charts at all, and C-d protects the
  anchor watch. Nothing decorative is in the MUST list.

## Evidence index

- Plans: scratchpad/plan127/127-PYD-common.md, 127-PYD-1..10.md, 127-01.md; ocharts-audit/plan.md (C1-C9,
  compliance design 1-12); bang127/pi-brain.md, skipper-day.md, open-base.md, moat.md, mapbox-terms.txt.
- Code (b127 @ 1b71c2ade):
  - pi-cache/src/routes/enc.ts:1610-1632;
  - pi-cache/src/server.ts:52-58, 226-261;
  - services/InshoreRouter.ts:164, 1700-1762;
  - services/routing/DepartureSweepInshore.ts:1-60;
  - services/routing/inshoreTideSpots.ts:1-40, 125, 159;
  - services/routeTracer.ts:101-139, 2026-2066;
  - services/autoroutingProposalEvidence.ts:20-50;
  - services/traceVerification.ts:1-34;
  - services/savedRoutesSync.ts:82-126;
  - pi-cache/src/routes/misc.ts:180-199;
  - public/sw.js:660-705;
  - supabase/functions/proxy-bosun-fallback/index.ts:346,372,385;
  - pi-cache/src/telemetryPublisher.ts:104;
  - components/RoutePlanner.tsx:882-885.
- Web:
  - registry.opendata.aws/met-office-global-deterministic (UKMO CC BY-SA);
  - open-meteo.com/en/licence;
  - www.worldtides.info/terms;
  - www.openseamap.org/index.php?id=faq&L=1;
  - Garmin GPSMAP manual "Auto Guidance Path Configurations" (www8.garmin.com/manuals/webhelp/...);
  - the PredictWind, Savvy Navvy, Orca, AvNav, Mapbox, GEBCO, Allen Coral Atlas and ProtectedSeas sources
    as cited in bang127/*.md.
