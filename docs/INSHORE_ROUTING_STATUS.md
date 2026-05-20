# Inshore Routing — Live Status & Handoff

**Purpose:** running status of the Newport → Pinkenba (Brisbane River, AU)
inshore-routing work, so **Claude B** can follow along and weigh in.

**Ground rules (per Shane):** Claude B **reviews and comments only — does
NOT touch the code.** Claude A (me) owns the edits. This doc is updated +
committed alongside each routing commit so the picture stays current.

**Last updated:** DRGARE channel-connector fix (iOS-only; awaiting on-device
test). See §3 + Commit Log.
**Status:** route is safe + honest end-to-end. **Breakthrough on the
river-mouth bar (§3):** the dredged shipping channel IS in the chart as
DRGARE (deep, authoritative) — just gappy. Shipped a fix to connect it into
a continuous preferred ribbon; awaiting Shane's test. A temporary draft
hard-code is in place that **must be reverted before ship** (see §4).

> **Thanks to the other session (reliability/hardening) for the lead** that
> cracked this: "try the chart's own recommended-track / dredged-channel
> data before more cost-tuning." RECTRC turned out empty in this SENC, but
> the same instinct pointed straight at **DRGARE**, which had the channel.
> Also adopting their rule: **never depth-penalise inside a marked corridor**
> (RECTRC/FAIRWY/DRGARE/OSM-promoted) — bathymetry can't resolve a dredged
> cut. And **yes** to their offered multi-route regression harness in
> `tests/` (read-only imports, non-colliding) — that directly fights the
> whack-a-mole.

---

## 1. Objective

Route a 55′ Tayana (draft ~2.4 m) from **Newport Marina** (−27.2135,
153.0875) out through its canal estate, down Moreton Bay, into the
**Brisbane River**, to **Pinkenba / Rivergate** (−27.4268, 153.1267).
Benchmark: **ORCA chartplotter** routes it cleanly down the dredged
shipping channel. North-star: match/beat ORCA.

Engine: A\* on a 50 m navigability grid (8-connected, haversine
heuristic). iOS-local A\* is the source of truth (`CLOUD_ROUTER_ENABLED
= false` until the Pi engine is synced).

---

## 2. What's solved ✅

- **Origin starts at the real berth** (snap 24 m, was 2 km). Newport's
  canal estate is a ~361-cell component islanded from the bay by charted
  LNDARE; a **directed CAUTION bridge** carves a single 1-cell red
  corridor at the shortest gap (901 m, the canal mouth) so A\* exits the
  _correct_ way — out the top of the canal — flagged red as "verify
  pilotage." (commit `155724a0`)
- **Exits the canal mouth correctly** (NE, where the markers are) — not
  the earlier goal-biased diagonal across the suburb.
- **Crosses Moreton Bay in deep (5 m) water.**
- **Follows the charted river channel** up to Pinkenba (the OSM
  Brisbane-River polygon is promoted to a preferred 1.0× corridor).
- **Honest red warnings**: genuinely-shallow stretches render RED
  (`cautionMask` → `safety:'danger'`) instead of being hidden — exactly
  the safety behaviour Shane asked for. The draft fix (§4) is what makes
  these correct.

Latest result: **SUCCESS, 23.4 NM, 25 pts**, origin-snap 24 m, dest-snap 3 m.

---

## 3. The river-mouth bar crossing — BREAKTHROUGH (fix shipped, awaiting test)

**UPDATE 2026-05-20 (supersedes the "data wall" framing below):** it is NOT
a data wall — the dredged channel IS in the chart, as **DRGARE** (dredged
areas), and it's a **continuity** problem, not a coverage one.

Investigation (Pi cell forensics on `/opt/thalassa-pi-cache/enc-charts/cells`):

- **RECTRC empty** — the layer key exists but ships 0 features in this AU
  SENC. (The other session's primary hypothesis; closed it out.)
- **DRGARE has the channel** — `OC-61-10ENB5` has 43 dredged-area polygons
  at **DRVAL1 10–14 m** tracing a continuous line from the river
  (−27.45,153.07) NE up into the bay to **−27.329,153.196**. That's the
  Brisbane shipping channel, authoritative.
- Pass 4 already marks each DRGARE polygon `preferred` (1.0×) — but they sit
  **1–2 km apart**, so the preferred corridor has GAPS. A\* can't follow a
  broken ribbon, so it cut the shallow bar instead.

**Fix shipped (iOS-only, no Pi redeploy):** connect each DRGARE centroid to
its 2 nearest neighbours (≤4 km) and feed the connectors into the NAVLINE
layer → the engine's Pass 5b rasterises them into a continuous deep
preferred ribbon (skipping hardBlocked cells, so it never carves land).
Expectation: A\* swings east onto the now-continuous dredged channel and
rides it through the bar, collapsing the red diagonal. **Awaiting Shane's
on-device test.** Watch the log for:
`connected N DRGARE polys → M channel-corridor links → NAVLINE`.

<details><summary>Original "data wall" diagnosis (pre-DRGARE, kept for history)</summary>

The route cuts a **red CAUTION diagonal** from the bay (−27.30, 153.12)
SE across the **river-mouth bar** to the river mouth (−27.35, 153.18),
instead of detouring east onto the deep dredged shipping channel like a
big ship (ORCA does the latter).

**Why it does this — a genuine data wall, not an algorithm bug:**

- The dredged channel **is not in the chart** as FAIRWY. Diagnostic:
  `chart FAIRWY total=3, in Newport→river corridor=0`.
- The lateral channel markers in the bay are **~4 km apart** — too sparse
  for marker-pair clustering to stitch into a continuous ribbon.
- OSM **does** have the channel as `seamark:type=navigation_line`
  (leading/transit lines) — we now pull these (commit `d20219e3`) — **but
  they cover the river + river mouth only.** They do **not** extend over
  the open-bay bar approach where the route cuts red. Result:
  `NAVLINE: 21 navigation lines → 0 channel cells rescued/preferred` —
  every line lands on already-preferred river cells or off-route bay
  cells, so the route is unchanged.
- The bar (shallow flats N of Brisbane Airport) is **genuinely shallow**
  in the 30 m bathymetry, so the direct cut is correctly RED. A\* takes
  it because it's the _shortest_ path and there's no continuous deep
  preferred corridor to pull it east.

**The decision Shane is weighing (and where Claude B's read helps):**

1. **Call it the win.** It's a safe, honest _suggested_ route (real berth
   → deep bay → RED bar warning → river → Pinkenba), with the standard
   "confirm pilotage" disclaimer. Then do cleanup (§4, §5).
2. **One more swing at the bar** — force the eastern channel by extending
   the leading-line **bearings** into the bay (the real nautical
   technique) and/or penalising the bar cut. Caveats: speculative, makes
   the route a few NM longer, and a direct-with-red-warning track may
   actually suit a _yacht_ better than a 5-mile ship-channel dogleg.

> **Claude B — the question for you:** for a 2.4 m yacht, is a _direct
> bar crossing flagged RED_ an acceptable suggested route, or must we
> force the deep-channel detour? And is extending charted leading-line
> bearings into uncharted bay water a sound idea or a footgun?

</details>

---

## 4. ⚠️ TEMPORARY draft hard-code — MUST REVERT before ship

The vessel-profile draft comes through as **0.914 m (3 ft)** — a bad
auto-estimate (`round(LOA × 0.16)` with LOA in metres ≈ 3, stored as
_feet_) — far too shallow for the Tayana, so the router treated 2 m
skinny water as navigable instead of red. Shane asked to **hard-code
2.4 m** for testing until the route is dialled in.

Two entry points were pinned (there are two callers of `tryInshoreRoute`):

- `hooks/useVoyageForm.ts` (voyage form) — commit `2d2c9ce5`
- `components/map/usePassagePlanner.ts` (the **chart** route — the one you
  see on the map) — commit `cf43c8b9`

Both carry a loud `⚠️ TEMPORARY HARD-CODE — REVERT BEFORE SHIP ⚠️` marker
and `const … = 2.4; // TODO(revert): = …FromProfile;`.

**Revert plan:** delete both hard-codes (use the `…FromProfile` value) AND
fix the root causes: (a) the draft auto-estimate units bug, (b) a
codebase-wide inconsistency where `vessel.draft` is read as **feet** in
some places and **metres** in others (`isochroneEnhancer`,
`departureWindow`, `bathymetricRouter`, parts of `usePassagePlanner`).

---

## 5. Cleanup backlog (deferred until route is signed off)

- Revert the draft hard-code (§4) + fix the auto-estimate + reconcile the
  feet/metres draft reads app-wide.
- Strip the verbose debug logging (`CELL TRACE`, `COMPONENTS`,
  `ribbon continuity`, `chart FAIRWY`, canal/Scarborough dumps,
  `NAVLINE`/`BRIDGE` lines) — these were diagnostic scaffolding.
- Sync the **Pi-cache routing engine** with the iOS engine changes, then
  re-enable `CLOUD_ROUTER_ENABLED = true`.

---

## 6. Architecture / key files

- **`services/inshoreRouterEngine.ts`** — the A\* engine. Builds a nav
  grid in passes: Pass1 DEPARE → 1b CANAL carve → 2 LNDARE → 2b coastline
  → 3 point obstrns → 4 FAIRWY/DRGARE → 5 markers → **5b NAVLINE (new)** →
  6 LNDARE buffer. Then connected-component labelling, **directed
  CAUTION bridge**, shared-component snap, A\*, smooth/​Douglas-Peucker.
    - Cost tiers (`cellCostMultiplier`): preferred 1.0× · deep≥10 5× ·
      ≥5 6× · >0 8× · CAUTION(−1) 40× · UNKNOWN(0) 500×. **Do not
      depth-grade the preferred tier** — tried, backfired (§7).
    - Shallow cells (`DRVAL1 < draft+safety`) → CAUTION(−1) → render RED.
- **`services/InshoreRouter.ts`** — orchestrator. Merges chart cells +
  OSM overlay (water→DEPARE+promoted FAIRWY, marina→DEPARE, reef→OBSTRN,
  breakwater→LNDARE, aeroway→OBSTRN, canalLines→CANAL, **navLines→NAVLINE**),
  marker pairing/ribbon synthesis, diagnostics.
- **`services/OsmRouteOverlayService.ts`** — iOS client that pulls the
  assembled overlay from the Pi (`/api/osm/overlay`). Has a 30-min
  in-memory cache (clears on app reload).
- **`pi-cache/src/services/osm.ts`** — Pi side: Overpass query + assembly
    - file cache. Cache schema **v4** (navLines). Bump the version to bust
      the cache when adding fields.

---

## 7. Approaches tried (the journey + lessons)

| #   | Approach                                              | Commit                | Outcome                                                                                                                           |
| --- | ----------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Grid-wide LNDARE relax on far snap                    | `88b3b7bb`            | ❌ **Crossed land** — global CAUTION let A\* shortcut the mainland. Reverted.                                                     |
| 2   | Localized relax _zones_ around far endpoints          | `dea3db37`            | ⚠️ Fixed the snap but A\* took a goal-biased red diagonal out the wrong side of the canal. Superseded by #4.                      |
| 3   | Directed CAUTION **bridge** (shortest-gap corridor)   | `155724a0`            | ✅ Correct canal-mouth exit, red barrier. **Kept.**                                                                               |
| 4   | Depth-grade the _preferred_ cost tier                 | `b7111063`            | ❌ **Backfired** — the channel reads 2 m in bathymetry, so penalising shallow-preferred pushed A\* OFF it. Reverted (`d55ea29f`). |
| 5   | Hard-code draft 2.4 m                                 | `2d2c9ce5`,`cf43c8b9` | ✅ Correct shallow→RED behaviour; exposed the channel-coverage gap. **Temporary (§4).**                                           |
| 6   | Pull OSM `navigation_line` → preferred corridor       | `d20219e3`            | ⚠️ Data confirmed river is right, but lines don't cover the bar approach → no change to the bar (§3).                             |
| 7   | Investigate RECTRC / DRGARE (other session's lead)    | (forensics)           | 🔎 RECTRC empty; **DRGARE has the deep channel** (10–14 m), just gappy — the real find.                                           |
| 8   | Connect DRGARE polygons → continuous preferred ribbon | _this commit_         | ⏳ Shipped, awaiting on-device test (§3). Expected to ride the dredged channel through the bar.                                   |

**Lessons:** (a) global relaxation / blunt cost-tuning amplify artefacts —
the engine's own comments warned about both, and both bit. (b) The
remaining problems are **data-coverage**, not algorithm — fixes that _add
honest data_ (the bridge, the draft, navlines) are safe; fixes that
_re-weight costs_ are fragile.

---

## 8. Pi deploy gotcha (so nobody loses an hour again)

The systemd service `thalassa-cache` runs from **`/opt/thalassa-pi-cache`**
(`ExecStart=/usr/bin/node dist/server.js`), **not** from the source
checkout at `~/thalassa-marine-weather/pi-cache`. A bare `systemctl
restart` just reloads the _old_ `/opt` dist. The bridge is **`redeploy.sh`**
(rsync source → `/opt`, rebuild, restart) — needs sudo. `/opt` itself is
skipper-writable, so a non-sudo path is: rsync+build into `/opt` as
skipper, then `sudo systemctl restart thalassa-cache` (the only sudo step).
Cache schema bump (e.g. v3→v4) auto-voids the old OSM cache. After
redeploy, **Cmd+R the app** to clear the iOS overlay mem-cache.

---

## 9. Commit log (routing-relevant; Claude B's interleaved commits noted)

- `d20219e3` feat(routing): OSM navigation lines → preferred channel ← **HEAD-ish**
- `dccd6101` diag(routing): chart-FAIRWY coverage logging
- `cf43c8b9` test(routing): TEMP hard-code chart draft 2.4 m
- `2d2c9ce5` test(routing): TEMP hard-code voyage-form draft 2.4 m
- `d55ea29f` revert(routing): undo depth-grade (backfired)
- `b7111063` fix(routing): depth-grade preferred _(reverted)_
- `155724a0` fix(routing): directed CAUTION bridge for islanded marina endpoints
- `6e320f22` diag(routing): per-chain marker-ribbon continuity logging
- `dea3db37` fix(routing): localized LNDARE relaxation
- `88b3b7bb` fix(routing): grid-wide relax _(reverted — crossed land)_

_Claude B's interleaved (non-routing) commits on master: `b5e99f17`
(hide Marketplace/Crew Finder), `29b19997` + `92900772` + `f556b52d`
(harden / async-failure / summary-staleness work). Noted so we both know
the tree is shared._

---

## 10. Claude B's notes

_(Claude B: add your 2 cents below — observations, risks, second
opinions. Claude A will read and act; you don't touch code.)_

-
