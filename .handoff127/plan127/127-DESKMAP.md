# 127-DESKMAP The desk chart: a light map, OpenSeaMap seamarks on top, honest about what stays aboard

Rewritten 2026-10-10 ~16:40 so the body matches Shane's three-layer default. Read-only on b127 at 719645bb7
(= 1b71c2ade + master 98aa277a6; that merge touched only .github/workflows/ci.yml, so every line below still
holds). The wind option is its own package, **127-DESKMAP-b**. Licence hygiene found on the way is **127-H**.
Revised ~17:45 for the critic's third pass: C1/C2 show the licensed-charts words only to an account whose paired Pi
holds licensed charts (the `boatCharts` flag), and honest open-chart words to everyone else.

**Authority.**
- Shane, 2026-10-10 ~15:35, verbatim: "we will need to have a fairly good map to use, on the desktop as the
  underlying map is dark and very hard to see what is water and what isnt."
- Shane, ~15:50, verbatim: "our own Relief map, which already shows seafloor depth; a light nautical-style base
  built from open coastline data; the free OpenSeaMap layer with buoys and beacons; - a combination of these 3
  would rock".
- Shane, verbatim: "the desktop experience needs to be 2nd to none. the best of the best" and "we work within
  the rules, but we need to make it bang claude. better than what we were going to do".
- o-charts (Roberto), 2026-10-10, verbatim: "Storing unencrypted data on any medium, and especially in the
  cloud, is strictly prohibited by the terms of the licenses signed with the chart providers." The desk never
  holds licensed cells; this package says so on screen (127-VISION §1, §2 item 4).
- Standing order, verbatim: "your recommendations for all work requiring an answer". Every call below is our
  recommendation on that order. Only the phone question at the end is left to Shane, because it would reverse
  his own words.
- His earlier words, quoted in the code and kept:
  - 2026-07-17: "the map is too dark to read — at least have the water and land in opposing colours"
    (components/map/useMapInit.ts:682).
  - 2026-07-17: "changing the layer on the chart page also changed the planning page" (MapHub.tsx:2206). The
    planner keeps its own base.
  - 2026-07-23: "any layer that is on in the charts page, shows up on the planning page ... we need our layer to
    show through" (useWeatherLayers.ts:340-347). The desk's seamarks and wind are the planner's OWN picks; Obs
    layers still never leak onto it.
  - 2026-07-15, on Hybrid: "this is the layer that I would like on the planning page in addition to the
    satellite… these are the only two layers that I want" (useMapInit.ts:778). That is why the **phone** planner
    does not change here.
  - 2026-07-09: OSM's raster icon stamped over the correct IALA glyph at Mooloolaba beacon 5
    (mapHub/useOpenSeaMapRasterHide.ts:71-76). OpenSeaMap must never double the chart's own marks.
  - 2026-09-06: "put them all in the same spot below the drop down box at the top middle of the screen"
    (creditsStrip.ts:4-7). Every new credit and label here goes in that strip.
  - 2026-07-18, on depth colours: "change it — let's keep it real" (encDepthStyle.ts:164).
- Evidence: the scratch harness (scratchpad/deskmap127: shots/, sheets/, index.html; contrast.cjs, flat3.cjs,
  glaze.cjs: WCAG contrast, CIEDE2000, Machado colour-blind simulation). Nothing in the repo was edited.

## Packaging (one package, three commits, in this order)

| Commit | What | Folded in |
|---|---|---|
| A | The Light base, the desk menu (bases), ENC on Light, overlay casings | **GA credit title (0 KB)**: it lives in reliefBase.ts and Credits.tsx, which A edits anyway |
| B | OpenSeaMap seamarks ON by default on the desk, the toggle, the community-data label, one raster not two, the chart-mark gate | **OpenSeaMap credit fix (7 sites, ~0 KB)**: seamarks cannot go on by default for every desk user with the wrong credit, so the fix must land in the same commit, not as a separate package |
| C | Off the boat, honestly: the "Licensed charts stay on …" line (licensed accounts only; the open wording for everyone else), the web no-charts sentences, grey "sketch, not checked" legs | the `boatCharts` settings type (C-c writes the flag) |

The wind row in the same menu is 127-DESKMAP-b; A builds the menu's toggle rows so b only adds one entry.

## What the skipper sees (the desk: the web planner's tracer and Route Planner maps)

- **A light chart, three layers deep (Shane's "combination of these 3"):**
  1. **The light base.** Buff land and a pale blue sea, bluest in the shallows and lighter offshore. A crisp
     dark-brown coastline between them (OpenStreetMap water, drawn by Mapbox, credited). Place names dark on a
     white halo.
  2. **Our Relief seabed under it.** Seafloor shading shows the shape of the bottom offshore. In Queensland
     GA's 30 m grid draws reefs and channels to about z14; the GBR at z8 reads like a chart.
  3. **OpenSeaMap seamarks on top, ON by default.** Buoys, beacons and lights from the OpenSeaMap community.
     Under the menu a small label says what they are: "Seamarks: OpenSeaMap community data, not verified" with
     an ⓘ to OpenSeaMap.
- **Water with no depth data is a plain grey-blue, never white.** Outside Queensland the coarse world model
  fades out between z11 and z12; a harbour at z13 shows flat water with no false blobs or tile edges. White is
  kept for charted water (hard rule 1: unknown depth never reads as deep).
- **One menu, top centre** (the same pill as Obs, labelled with the base, e.g. "LIGHT ▾"):
  - Bases: **Light** ("Easiest to read · seabed is a guide, mean sea level"), **Relief + Sat**, **Hybrid**.
  - On top: **Seamarks** ("OpenSeaMap community data, not verified", ON) and, from 127-DESKMAP-b, **Wind**
    (OFF).
  - The base and the seamark choice are remembered on that computer only. No ENC row: the tracer raises its
    own chart floors.
- **Where a chart draws its own marks, OpenSeaMap steps aside.** In US waters NOAA cells draw as a paper
  chart on Light (S-52 depth bands, white deep, blue shallows, the chart's land and coastline, the amber
  safety contour, marks, lights and soundings), and the OpenSeaMap icons hide wherever those cells are on
  screen, so a buoy is never drawn twice.
- **Honest about the boat, and only when there is one (critic pass 3).**
  - **Licensed account:** an account whose paired Pi holds licensed charts sees, under the menu, "Licensed
    charts stay on Serene Summer" (the vessel's name; "stay aboard" with no name). The test is the account flag
    `boatCharts.licensed`, written by the phone aboard (127-C-c decision 7).
  - **Everyone else**, whether NOAA-only, no Pi, a crew account or signed out, never sees "licensed" or a boat
    name. Over water no chart covers, the line reads "No chart for this area". Where a NOAA cell is on screen
    there is no line: the chart speaks for itself.
  - Legs the desk has no chart for draw as **grey dashes on a dark edge, "sketch, not checked"**, never amber or
    green. The tracer card says "No chart for here on this device: these legs are a sketch, not checked."
- **On the web Obs chart**, the no-charts notice replaces "No verified ENC charts installed…":
  - a licensed account sees "Licensed charts stay on Serene Summer. Open charts show here where they exist
    (NOAA, US waters).";
  - everyone else sees "No chart for this area. Open charts (NOAA) show here in US waters."
- **Routes and legs read on the pale sea.** Green, amber and red legs, the harbour dashes and the
  model-comparison lines get the route line's dark edge. The bearing hint and the proven-lane ghost turn slate,
  thin and dotted, never route weight.
- **Night mode** keeps today's dim night palette, with white labels.
- **Credits** (Mapbox ⓘ): Mapbox and © OpenStreetMap; GEBCO 2026 Grid with its DOI; GA's grid under its
  catalogue title, CC BY 4.0, section 5 disclaimer; "coastline © OpenStreetMap contributors"; "Seamarks ©
  OpenSeaMap contributors, CC BY-SA 2.0; data © OpenStreetMap contributors, ODbL"; "Not for navigation".
- **The phone app is unchanged** except two truth-telling fixes that are the same code everywhere: the
  OpenSeaMap credit wording, and grey sketch legs where the phone has no chart (which after 127 C-c is every
  protected area away from the Pi). Obs's base picker, the phone planner's Hybrid and Obs's Sea marks toggle
  look as today, except that Sea marks now hide under ENC like every other OpenSeaMap raster (see B.4).

## Today (b127 719645bb7; every line below read)

**The style and the load-time recolour (useMapInit.ts).**
- dark-v11 (MapHub.tsx:337). Container background `#191a1a` (useMapInit.ts:570).
- At `load` (:628-720): roads, tunnels, buildings and aeroways hidden; label-like symbols white on black (:673);
  every background slate `#333b45` (:691); every water fill `#1f5a85` (:702); every land, landcover, wood or
  sand fill slate (:714).
- Sources, in order: satellite (:725-775); Hybrid via the Static Tiles API (:781-812); the seamless sea
  `addReliefBase(map)` (:818, before the embedded early return); **OpenSeaMap `openseamap-permanent`, born
  hidden (:841-870)**, credited "Map data: © OpenSeaMap contributors" (:849), no licence named.

**The sea (components/map/reliefBase.ts).**
- GEBCO 2026 at z0-9 (`SETS` 'global', :91); tint fades z13.5→14.5, shade z10→11. GA GBR 30 m at z8-13 inside
  `RELIEF_AU_BOUNDS` (:52, :92). Bands to z9 and a coast line from the composite `water` source-layer
  (`addReliefBase` :213-326). `seaBaseLayers(base)` (:329-339).
- `setReliefPalette(map, 'day'|'night'|'enc')` (:348-374) repaints only `land`, `landuse`, `national-park`,
  `water`, `waterway` and LAND_STRUCTURE; never labels; writes only on a palette change (the `painted` WeakMap,
  reset per style load at :218).
- `RELIEF_ATTRIBUTION` (:69-73) and src/ocean/Credits.tsx:33 name GA's grid "Great Barrier Reef Bathymetry 2020
  30 m".

**Which base the planner shows (MapHub.tsx).**
- `planningSurface = shouldSuppressChartOverlays(cleanPlanningMap, coordCaptureMode, passage.showPassage)`
  (:2103).
- `shownBase = planningSurface && !baseExplicit ? 'hybrid' : mapBase` (:2213). `explicit` is true whenever the
  account has any saved `settings.obsChartBase` (useMapBase.ts:33-45), so a fresh account plans on Hybrid and
  **any Obs pick on any device overrides the planner**. Shane's account has Relief saved: that is the dark map
  he described.
- The picker is hidden on the planning surface (`visible={!planningSurface && …}`, :3822-3823).
- `imageryOn` is `true` on every base (:2222), so ENC land and coastline hide and DEPARE draws only as the keel
  glaze. The chart-mode branch (`!imageryOn`, :2499-2509; encDepthStyleState.ts opaque `DEPARE_CHART_OPACITY`
  with tier filters; ChartKeyPanel.tsx:111-143) is maintained but unreachable since 4e33987f2 (2026-10-05).
- Palette call: `setReliefPalette(map, nightMode ? 'night' : encDrawn ? 'enc' : 'day')` (:2315).
- On the planner the ENC master is off (mapHub/useEncAtOpen.ts:30) but the tracer forces marks, lights, leads
  and soundings visible (mapHub/useTracerChartFloors.ts:34-80) whenever cells are loaded.
- The desktop only ever has NOAA cells (cloudCellSync.ts NOAA-only; personalCellSync.ts:68
  `PERSONAL_CHART_CLOUD_ENABLED = false`).

**Weather layers and seamarks on the planner.**
- `activeLayers = planMode ? EMPTY_LAYERS : userLayers` (useWeatherLayers.ts:385-386), with `planMode =
  planningSurface` (MapHub.tsx:3213-3221). Nothing from Obs paints on the planner, including the 'sea' toggle.
- `openseamap-permanent` has **two writers**: useWeatherLayers' 'sea' sync sets it to the toggle on every
  weather-layer change (:2242-2256), and useOpenSeaMapRasterHide re-asserts after it (MapHub.tsx:3683;
  useOpenSeaMapRasterHide.ts:35-45): `permanent: !hide && activeLayers.has('sea')` with `hide = chartsActive ||
  encActive`.
- `encActive = encVisible && encCellCount > 0` (MapHub.tsx:3295) is a **global** gate ("panning outside ENC
  coverage with cells loaded shows no OSM seamarks there — accepted", :3288-3294), and it ignores the tracer's
  forced marks (encVisible is false on the planner).
- **The 'sea' toggle draws OpenSeaMap twice.** `TILE_LAYERS` includes 'sea' (useWeatherLayers.ts:2173-2174), so
  a second raster `tiles-sea` from `STATIC_TILES.sea` (mapConstants.ts:312-314) is added at
  useWeatherLayers.ts:2761-2785 **with no attribution and outside the ENC hide**. With Obs Sea marks and ENC both
  on, OpenSeaMap icons still stamp over the IALA glyphs (the Mooloolaba bug, alive through this path), and every
  seamark tile is requested from OpenSeaMap's free server under two source ids.
- Cell bboxes are available in memory: `listCells()` (services/enc/EncCellMetadata.ts:239) returns `EncCell`
  with `bbox: [minLon, minLat, maxLon, maxLat]` (services/enc/types.ts:661-662).

**OpenSeaMap credit sites (the "six", found to be seven).** None names CC BY-SA 2.0 or ODbL:
useMapInit.ts:849; logMap.ts:85; ThalassaMap.tsx:79; passage/SpatiotemporalMap.tsx:56; chat/PinMapViewer.tsx:131-136
(no attribution at all); mapConstants.ts:313 via useWeatherLayers.ts:2778 (no attribution at all);
useOfflineBaseLayer.ts:61 ("© OpenSeaMap contributors" only).

**Off the boat, today.**
- Tracer legs with no chart: `cautionVerdict('no ENC chart here — depth unchecked')` (services/traceGrading.ts:298)
  and `'chart load failed — depth unchecked, will retry'` (:308), both grade 'caution', drawn amber
  `#ffb300` like a needs-tide leg (useTracerTraceLayer.ts:154-180). The card banner reads "No ENC charts here —
  legs can't be depth-checked." in amber (MapHub.tsx:4429-4432).
- Web Obs no-charts notice: "No verified ENC charts installed. Library imports are reference-only."
  (ChartDepthControls.tsx:227-229).

**Overlay ink was tuned for a dark sea** (WCAG against the pale sea, 2 m stop to deep stop):

| Layer | Where | Ink | Contrast on pale sea | Edge today |
| --- | --- | --- | --- | --- |
| Tracer legs `trace-line-glow`/`-core` | useTracerTraceLayer.ts:154-180 | clear `#00e676`, caution `#ffb300` | 1.2-1.8:1 | none |
| `route-harbour-dash` | useMapInit.ts:1019-1029 | `#38bdf8` | 1.05-2.1:1 | none |
| Confidence-braid cores | useMapInit.ts:983-1010 | `#22d3ee` | 1.1-1.8:1 | none |
| `trace-dest-hint-line` | useTracerTraceLayer.ts:345-354 | `#38bdf8` at 0.45 | below 1.05-2.1:1 | none |
| `trace-ghost-line` | useTracerTraceLayer.ts:218-227 | `#94a3b8` | 1.3-2.6:1 | none |
| Route line | inshoreRouteState.ts:673-680 | – | 8.6-17.5:1 | `#1c1917` casing (since 2026-10-05) |

**Measured in the harness (1440x900).** Today's Relief and Ocean (slate on navy) are 1.16-1.54:1, land against
water ΔE2000 15.5. Hybrid at sea is a stitched mosaic with near-black deep water. A light palette makes land and
water obvious at every zoom; its one fault is the GEBCO tint at z13 (450 m blobs and a straight tile seam,
shots/lymington-z13-5-chartday.png).

## Decision (our recommendation)

### A1. A new base, "Light" (`'light'`)

Light is the relief sea in a light palette. It is not called "Chart": it is not a chart. Row description:
"Easiest to read · seabed is a guide, mean sea level" (GA and GEBCO are both MSL; the vision's datum chip is
these words plus the credits, not a separate chip).

- **Palette `LIGHT` in reliefBase** (starting values; the tests set the bar and the implementer tunes the hexes
  to pass):
  - **Land** `#d6c590`, equal to the ENC land fill (EncVectorLayer.ts:303), so charted land meets it with no seam.
  - **Coastline** `#4a3b22`: ≥ 5.3:1 against every water colour, 6.3:1 against land.
  - **Depth ramp** anchored on the ENC band colours (encDepthStyle.ts:172-180): 2 m `#8bbcdd`, 5 m `#a6cce6`,
    10 m `#c0dcee`, climbing to a deepest stop of about `#d4e6f2` (ΔE 9.8 from white). **It never reaches
    white:** white means charted deep water.
  - **Flat water** (the vector `water` fill wherever no depth tint draws): neutral `#cdd3d8`, ΔE 10.2 from white,
    ≥ 5.8 from every ramp stop, 7.2:1 to the coastline.
  - **Bands**: the ramp's equivalents. **Hillshade**: shadow `rgba(40,80,110,0.30)`, highlight
    `rgba(255,255,255,0.35)`. **Labels**: `#1e2b38` on a `rgba(255,255,255,0.9)` halo, width 1.5 (14.4:1).
- **Land against water is carried by hue plus the coastline**, as on a paper chart (luminance alone 1.0-1.7:1).
  Minimum ΔE2000: normal 21.4 (today 15.5), deuteranopia 21.5, protanopia 22.3, tritanopia 18.7.
- **On Light only, the world tint fades out at z11→12** (`setLayerZoomRange` on the GEBCO layers; other bases
  restore it). The GA tint keeps its 13.5→14.5 fade. We accept GA's pyramid edge at z12+ near 29.5°S
  (Yamba/Iluka) and 9.8°S (Torres Strait); the fix is a tools/relief rebuild. **This replaces the vision's
  "hatched, model depth" idea**: flat neutral water past z12 says "no depth here" without a pattern layer or a
  GEBCO mask, and between z9 and z11 the credits and the row's "seabed is a guide" carry the words.
- **`setReliefPalette` becomes complete and loop-safe.** It paints every land and water fill the load pass
  paints through **one exported regex pair** shared with useMapInit's load pass (otherwise landcover, wood and
  sand stay slate patches on buff land). It paints base-style labels (symbol layers whose source is
  `composite`), never app-owned ones. Every palette carries its own label ink (day/night/enc white on black;
  Light dark on white). It still writes only when the palette changes.
- **The palette argument** becomes `nightMode ? 'night' : shownBase === 'light' ? 'light' : encDrawn ? 'enc' :
  'day'`. Light is never damped to 'enc'.
- **`seaBaseLayers('light')`** lights what Relief lights; land imagery and land shade stay off.
- **Without relief tiles it still reads**: flat grey-blue water, buff land, the coastline.

### A2. The desk planner gets its own base and its own menu

- **`deskPlanner = !Capacitor.isNativePlatform() && (cleanPlanningMap || coordCaptureMode)`.** The tracer and
  the Route Planner maps (full-screen, picker mode and inline) on the web. A computed passage shown on the Obs
  chart (`showingPassage`) keeps today's rule.
- **The base:** `shownBase = deskPlanner ? deskBase : (planningSurface && !baseExplicit ? 'hybrid' : mapBase)`.
  `deskBase` is this computer's pick, default `'light'`. A saved Obs pick no longer overrides the desk (Shane's
  2026-07-17 rule). Native: today's rule, unchanged.
- **Stored per computer, written only on a pick:** one try/catch localStorage key `thalassa_desk_map_v1` =
  `{ base?: 'light'|'reliefSat'|'hybrid', seamarks?: boolean }`. A field is present only once picked, so a later
  default change still reaches computers that never picked. No account setting, no sync, no DB; a desk pick
  never reaches the phone. A private window opens on Light with seamarks on. (Wind is session-only and lives in
  127-DESKMAP-b, matching Shane's 2026-09-05 "layers don't persist from app restarts".)
- **Where the menu shows:** every web desk-planner surface **at any width**, except picker mode (the "Tap to
  select" label owns top centre), embedded maps and pin view. *Changed from the first draft's ≥1024 px gate:*
  the seamark toggle must be visible wherever seamarks draw, and the Obs picker already proves this pill fits
  between the zoom pill and the mic down to 320 px. Picker-mode and embedded desk maps get Light with no
  seamarks and no strip (a point-picking map does not need them; their credits stay in the ⓘ).
- **MapBaseSelector props** (Obs passes none and is unchanged):
  - `options` (default `MAP_BASE_OPTIONS`); the desk passes Light, Relief + Sat, Hybrid. Relief and Ocean, the
    dark bases, are not offered on the desk.
  - `encRow` (default true); the desk passes false.
  - `toggles: { id, label, detail, on, onToggle }[]`, rendered after a separator as `menuitemcheckbox` rows in
    the ENC row's style, ON/OFF on the right, included in the arrow-key ring (`itemCount`). A toggle closes the
    menu and refocuses the trigger, as the ENC row does.
- **Types:** `MapBaseKind` gains `'light'`; `seaBaseLayers` and `mapBaseVisibility` take `MapBaseKind`.
  `ObsChartBase` (the account field) does not gain it, and useMapBase's Obs `KINDS` stay four, so **Light is not
  offered on Obs in 127**.

### A3. ENC on Light: the paper-chart treatment

`imageryOn = shownBase !== 'light'`. Every other base keeps the keel glaze exactly as today.
- On Light, NOAA cells paint opaque S-52 depth areas (white deep, blue shallow, fixed bands), the chart's land
  and coastline, the amber safety contour (restyled on both bases, encDepthStyleState.ts:319-339), marks, lights
  and soundings: the "keep it real" convention on the one base built to sit under it.
- Why not the glaze on Light (glaze.cjs): over a pale sea the glaze's safe white differs from no-data water by
  only ΔE 3-6 at harbour zooms; uncharted would nearly read as safe (hard rule 1). Opaque charted white against
  the `#cdd3d8` no-chart sea is ΔE 10.2, and band edges, contours and soundings mark charted water too.
- Given up on Light: the keel-keyed area wash (Shane 2026-07-12, encDepthStyle.ts:183). On Light the keel read is
  the amber safety contour, the 2-5 m band and the tracer's per-leg grade. The glaze stays on the imagery bases.
- Exposure: the desktop tracer in US waters only. No ENC code changes; only which existing branch runs. Chart
  mode has been unreachable since 2026-10-05, so the browser test below proves it before merge.

### A4. Overlays that must read on a pale sea

- **A dark casing** (`#1c1917`, the route line's `SURVEY_DASH.casing`) under `trace-line-core`,
  `route-harbour-dash` and both confidence-braid cores, on every base.
- **Hints stay hint weight.** `trace-dest-hint-line` and `trace-ghost-line` take slate `#475569` on Light
  (4.6-7.6:1; the hint at 0.7 opacity), no casing, widths and dots unchanged; written in MapHub's base pass as a
  conditional write against the layer's current paint (never a remembered flag). The bearing hint stays visibly
  thinner and lighter than any leg.
- Route colours keep their meaning on every base.

### A5. The GA credit title (folded into A, 0 KB)

GA's record eCat 115066 is titled **"AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model
(20170025C)"**; the grids used are its "Version 10 Nov 2020" A-D (checked on ecat.ga.gov.au 2026-10-10; same
record, renamed). Use that title plus "version 10 Nov 2020" in `RELIEF_ATTRIBUTION`, src/ocean/Credits.tsx and
tools/relief/README.md:20 and :35. GA's derivative wording stays ("Based on <title + link> by Geoscience
Australia, © Commonwealth of Australia, CC BY 4.0 <link>, subject to the section 5 disclaimer of warranties").

### B1. Seamarks ON by default on the desk, behind a visible toggle

- **The desk menu's Seamarks row**: label "Seamarks", detail "OpenSeaMap community data, not verified", ON by
  default, stored in `thalassa_desk_map_v1.seamarks` only when picked.
- **One writer for `openseamap-permanent`.** useWeatherLayers' 'sea' sync (:2242-2256) drops
  `'openseamap-permanent'` from its list (it keeps the harbour-seamark circles and nav markers), and
  useOpenSeaMapRasterHide becomes the single owner:
  `permanent = !hide && (activeLayers.has('sea') || deskSeamarksShown)`, with
  `deskSeamarksShown = deskPlanner && !pickerMode && !embedded && deskSeamarks && !deskChartMarksInView`.
  Toggling desk wind (127-DESKMAP-b) therefore never blinks the seamarks.
- **Seamarks step aside where a chart draws its own marks (bbox gate, desk only).** `deskChartMarksInView` is
  true when `(encActive || coordCaptureMode)` and the viewport intersects any `listCells()` bbox. Recomputed on
  `moveend` (coalesced like the hook's styledata pass, 120 ms) and when `encCellCount` changes. Off the desk,
  today's global `hide = chartsActive || encActive` is unchanged. Partial overlap (a cell edge on screen) hides
  OpenSeaMap for the whole view: a missing OSM buoy is honest, a doubled one is the Mooloolaba bug.
- **Zoom:** the layer's existing `minzoom: 6` (useMapInit.ts:856) stands.
- **Honest when OpenSeaMap is down.** A map `error` event whose `sourceId` is `openseamap-permanent` and whose
  status is not 404 (a 404 is an empty tile and mapbox-gl stays quiet about it, reliefBase.ts:21-23) counts;
  three within 30 s while seamarks show turn the label amber: "Seamarks: OpenSeaMap not answering". The next
  `moveend` with no new error restores it.

### B2. The label and the credit, in the strip under the menu

The desk uses the Obs credits strip (creditsStrip.ts: `CREDITS_STRIP_POSITION_CLASS`, `creditsStripTop()`),
centred under the menu, fixed slots so nothing jumps:
- slot 0 (C1): "Licensed charts stay on Serene Summer" for a licensed account, "No chart for this area" for
  everyone else with no chart on screen, and its box kept but blank over a NOAA cell (C1 says when);
- slot 1 (seamarks shown): "Seamarks: OpenSeaMap community data, not verified ⓘ", the ⓘ a `hit-target-44`
  button opening openseamap.org through `openExternalUrl` (the RainViewer pill's pattern,
  MapWeatherControls.tsx:777-800), `data-map-credit` so the layer menu's scrim cuts it out;
- slot 2 is 127-DESKMAP-b's wind credit.
10 px semibold slate on `bg-slate-950/70`, as the radar pill; max width `min(300px, 100vw - 152px)`.

### B3. The OpenSeaMap credit fix (folded into B; 7 sites)

One constant, `OPENSEAMAP_ATTRIBUTION`, in a new dependency-free module components/map/seamarkCredit.ts (so
logMap and the chat viewer pull in nothing else): 'Seamarks © <a href="https://www.openseamap.org">OpenSeaMap</a>
contributors, <a href="https://creativecommons.org/licenses/by-sa/2.0/">CC BY-SA 2.0</a>; data ©
<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ODbL' (openseamap.org FAQ:
tiles CC BY-SA 2.0, data ODbL, commercial use allowed), plus a plain-text twin for the strip's aria-label.
Used at useMapInit.ts:849, logMap.ts:85, ThalassaMap.tsx:79, SpatiotemporalMap.tsx:56, PinMapViewer.tsx:131
(adds the missing `attribution`), useOfflineBaseLayer.ts:61. The seventh site, `STATIC_TILES.sea`
(mapConstants.ts:313 → useWeatherLayers.ts:2778, no credit), is deleted by B4.

### B4. One OpenSeaMap raster, not two (folded into B)

Remove 'sea' from `TILE_LAYERS` (useWeatherLayers.ts:2173-2174) and delete `STATIC_TILES.sea`
(mapConstants.ts:313). Obs's Sea marks toggle then draws through `openseamap-permanent` alone, which obeys the
ENC hide: Sea marks + ENC no longer doubles icons on the phone, and each seamark tile is asked for once. The
visible change on Obs: seamarks draw at the permanent layer's 0.85 opacity instead of two stacked rasters.
This matters now because the desk turns OpenSeaMap on by default for everyone, on a donation-funded server.

### C1. "Licensed charts stay on Serene Summer", only for an account with licensed charts aboard

**The problem (critic pass 3).** Pass 2's slot 0 showed "Licensed charts stay on …" to every account on every desk
surface. For a NOAA-only sailor, a tester with no Pi, or a signed-out visitor, that claims a boat and a licence
they don't have. Thalassa is global, and the words must be true for every account.

**The signal.** `settings.boatCharts?.licensed === true`.
- The field: `boatCharts?: { licensed: boolean } | null` in types/settings.ts. This package adds the type,
  because it merges first.
- The writer is 127-C-c's `registerFromPiIndex`. It writes true when the paired Pi's index has a protected row
  (C-b's classifier: every non-NOAA id). It writes only when the value changes. `forgetPairing` sets it to null.
- It rides `user_settings` through `merge_user_settings`. That RPC has a deny-list only
  (20260728090000_user_settings_contract.sql:125-135), so there is no migration. It is not in
  `settingsForCloudSync`'s strip list either (stores/settingsStore.ts:336-350).
- It is one boolean: no count, no ids, no positions.
- **Why not "a saved verification fingerprint naming a protected id"** (the schedule's earlier brief): the four
  other accounts pulled licensed cells from the old cloud shelves before 126-20 (127-C-c, What the skipper
  sees). Any check they saved then can name protected ids with no Pi behind it, and they would get the chip
  falsely. The flag means exactly "this account's
  paired Pi holds licensed charts".
- Until C-c merges, no account has the flag, so every desk shows the open wording: the safe default.

**The words** come from `boatChartsLine(state, name, 'strip' | 'notice')` (127-C-c decision 11; whichever
package merges second folds the other's strings in). The strip lines are below; the notice sentences are C2's.
- `'web'` (licensed): `Licensed charts stay on ${ownBoatName}` (MapHub's `ownBoatName`, :3117), or "Licensed
  charts stay aboard" with no name.
- `'web-open'` (everyone else): "No chart for this area", shown only when no registered cell's bbox meets the
  view. That is the same viewport test as B1's `deskChartMarksInView`, without its `encActive ||
  coordCaptureMode` term, computed in the same coalesced `moveend` pass. With a NOAA cell on screen, slot 0's
  text is hidden (its box stays).
- Never "licensed", "stay on" or a boat name for a non-licensed account. A crew account sees the open wording:
  its own account has no boat charts.

**Nothing jumps (B2's fixed slots).** Slot 0 always keeps its one-line box on desk surfaces. For a non-licensed
account, panning onto a NOAA cell hides the text (`visibility: hidden`, so the box stays and slot 1 never moves)
rather than removing it. The words change at most once per session, when the cloud settings land after
sign-in.

### C2. The web Obs no-charts sentence

ChartDepthControls.tsx:226-229, web only (`!Capacitor.isNativePlatform()`, a new import from @capacitor/core
there), when `encCellCount === 0`. The words follow C1's flag:
- licensed account: "Licensed charts stay on Serene Summer. Open charts show here where they exist (NOAA, US
  waters).";
- everyone else: "No chart for this area. Open charts (NOAA) show here in US waters."

ChartDepthControls gets the flag and the name as two props from MapHub, which already reads settings. The
Library button and the native sentence are unchanged (127-C-c owns the Library's future, its question 1).

**Shared lines (critic pass 2).** 127-C-c rewrites the same notice for the phone through its `boatChartsLine`
helper. These two sentences go in as that helper's `'web'` and `'web-open'` notice states, not as strings in
ChartDepthControls. Whichever package merges second folds them in.

### C3. Sketch legs: grey dashes, "not checked", on every platform

- `TraceLegVerdict` gains optional `unchecked?: true`, set only by the two no-chart verdicts
  (traceGrading.ts:298 and :308). **The grade stays 'caution'** for every consumer (Save words, the report, the
  verification envelope, the leg-verdict cache, which never holds these volatile verdicts anyway,
  useTracerGrading.ts:164-170), so nothing downstream changes meaning.
- Messages: "Not checked: no chart for here on this device" (:298) and "Not checked: the chart didn't load,
  trying again" (:308).
- Drawing: a new `trace-line-sketch` layer (filter `['==', ['get', 'sketch'], true]`; `line-dasharray`
  [2, 1.5], ink `#cbd5e1` on the A4 `#1c1917` casing, core width), and `trace-line-glow`/`-core` filter it out.
  A separate layer, because `line-dasharray` is not reliably data-driven in our GL JS; the filter costs nothing.
- **Z-order (critic pass 2).** The new `trace-line-sketch` layer and every new casing layer (A4) join
  `TRACE_LAYER_IDS`, in draw order, so `promoteTraceLayers` (components/map/isobarLayerSetup.ts:1110, called
  from useTracerTraceLayer.ts:392 and :416) lifts them above ENC and imagery that mount later; otherwise they
  are the "waypoints but no line" bug again (useTracerTraceLayer.ts:9-18). They are installed ABOVE the issue
  loop like every other trace layer (the file's "do not reorder sync()" rule), and `layersUp()` keeps checking
  exactly its three layers. The braid and harbour-dash casings in useMapInit.ts follow those layers' own
  promotion path.
- The card banner (MapHub.tsx:4429-4432): "No chart for here on this device: these legs are a sketch, not
  checked."
- ChartKeyPanel's plan key gains one row: grey dashes on a dark edge, "Sketch, not checked: no chart for here on
  this device". It is worded apart from the router's red-and-white "Not checked yet" (ChartKeyPanel.tsx:29-38).
- **Why every platform:** it is one verdict. After 127 C-c a phone away from the Pi has no protected cells, so
  the phone's tracer shows the same truth. Never green, never amber-as-if-tide.

### What this package never does

- No licensed chart data anywhere new: Light is GEBCO, GA, Mapbox and OSM; OpenSeaMap is a raster drawn as
  served; no ENC is rendered into tiles; nothing o-charts or S-63 goes near the cloud; the desk draws only NOAA
  cells, as today.
- No route geometry. The desk draws only the skipper's own pins and the tracer's grades. "Ask the boat to route
  from the desk" is 129 (Shane: wait for Roberto). Never a straight origin-to-destination line.
- No bulk download of OpenSeaMap tiles (MapOfflineService already fails closed, MapOfflineService.ts:286-300).

## Licence and cost

- **GEBCO 2026 Grid:** public domain; credit, no endorsement, not for navigation.
- **GA GBR 30 m:** CC BY 4.0; GA confirmed commercial derived tiles 2026-10-07 (memory thalassa-obs-relief-basemap).
- **Mapbox dark-v11 vector tiles, recoloured at runtime:** Mapbox terms; logo and "© Mapbox © OpenStreetMap /
  Improve this map" stay visible. Rendered only (§1.6, §1.9).
- **OpenStreetMap water and coastline:** ODbL Produced Work credit.
- **OpenSeaMap seamark tiles:** CC BY-SA 2.0 tiles, ODbL data, commercial use allowed (openseamap.org FAQ).
  Shown as served, credited, labelled as community data. Their server is donation-funded and can withdraw access:
  B1's "not answering" state is the honest failure, our own seamark layer is "later" in the vision, and a
  courtesy note to OpenSeaMap is Shane's (For Shane).
- **NOAA ENC:** public domain.
- **Cost:** the same R2 relief tiles and Mapbox map loads. The desk default stops pulling Hybrid's Static Tiles
  API ($0.50 per 1,000 past 200k a month). OpenSeaMap requests halve on Obs (B4).

## Not in this build

- **Light on the phone** (the Obs picker, the phone planner's default): Shane's call (For Shane). The wind
  streak palette for a light base exists after 127-DESKMAP-b, which removes one of the two blockers; rain, SST,
  AIS and isobars still need their check on a pale sea.
- **Light as the web Obs default.** Obs keeps Relief + Sat (Shane 2026-10-06).
- **Plan Your Day's routed plot** runs in Auto's workspace chart (127-PYD-3, "Changing Auto's base map" is out of
  that plan), whose own light/dark palette is untouched here. The vision's "PYD defaults to the day base" is
  therefore Auto's existing light mode, not this package.
- **Hatching "model depth, not a chart"** (vision lane 3): replaced by A1's fade to flat water; revisit with
  seabed v2.
- **A bbox-aware ENC gate on Obs** (today's global gate stays off the desk).
- **tools/relief rebuild** (feather GA's grid edges; EMODnet CC BY 4.0, NOAA BlueTopo public domain, LINZ CC BY
  4.0 to verify per record): a wx tile build plus a credit line each.
- **Our own seamark layer** (OSM seamark:* via planetiler on wx, ODbL): vision "later".
- **Ruled out:** NOAA Chart Display Service raster (US only, ~3.9 s per uncached tile, duplicates our cells);
  LINZ chart rasters (licence unclear); Esri Ocean (paid key; Shane 2026-10-04); MapTiler (non-commercial key);
  EOX Sentinel-2 cloudless (CC BY-NC-SA); any decrypted o-charts or S-63 in the cloud.

## Gates

- None: no DB, edge function, Pi, R2 upload or tile build.
- The web goes live with the release's master push (Vercel), which Shane runs.
- The iOS build carries A and B inert (native is gated off) and C3 live (sketch legs).
- Node: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` (24.21.0); `/usr/local/bin/node` 24.12 is the fallback.
  `df -h` before `npm run build`.

## Tests (failing first)

vitest `--maxWorkers=1`; Playwright `--workers=1`, a free port, Chromium and WebKit. New specs are added to
`testMatch` in playwright.keyboard.config.ts (CI runs it in three keyboard shards since 98aa277a6).

**tests/reliefBase.test.ts**
- `seaBaseLayers('light')` gives Relief's sea layers, land imagery and land shade off.
- `setReliefPalette(map, 'light')` over a full dark-v11-shaped layer list (landcover, wood, sand, national-park,
  land-structure, water and composite labels, plus one label layer from another source): every load-pass land
  fill ends buff and every water fill `#cdd3d8`; composite labels dark on white; the other source's label
  untouched; 'day' restores slate fills and white labels; 'light' after 'night' restores dark labels; a repeat
  call writes nothing.
- On Light the GEBCO layers' zoom range ends at 12 and other bases restore it; the AU fade is unchanged.
- Colour bars (test-only helpers, Machado matrices): coastline vs land and every Light water ≥ 4.5:1; labels vs
  halo ≥ 7:1; land vs every water (normal, deutan, protan, tritan) ΔE2000 ≥ 15; flat water vs white ΔE ≥ 10;
  flat water vs every ramp stop ΔE ≥ 5; deepest stop vs white ΔE ≥ 8. The 2, 5 and 10 m stops equal
  DEPARE_BAND_COLORS; land equals the ENC land fill.
- `RELIEF_ATTRIBUTION` and Credits.tsx carry GA's catalogue title and "10 Nov 2020", the 115066 link, the GEBCO
  DOI, the CC BY 4.0 link, "section 5", "OpenStreetMap", "Not for navigation".

**tests/MapBaseDisplayMode.test.tsx and tests/MapBaseSelector.test.tsx**
- "keeps the planning surface on Hybrid unless the skipper picked a base" (MapBaseDisplayMode :134) keeps its
  native assertion and gains the desk branch; never delete an assertion.
- With `deskPlanner`: the base is the computer's pick, default Light; each of the four saved Obs picks leaves it
  unchanged; `imageryOn` is false only on Light and the SATELLITE_KEY mirror follows; the palette argument is
  `'light'` even with ENC drawn. Native: today's rule exactly.
- The desk menu renders on web desk surfaces at 1440, 1024, 390 and 320 px wide, not in picker mode, embedded or
  pin view; it lists Light, Relief + Sat, Hybrid, no ENC row, then Seamarks (ON); arrow keys reach every row; a
  base pick and a Seamarks toggle write `thalassa_desk_map_v1` (only the picked field) and never call
  `updateSettings`; a throwing localStorage still opens on Light with seamarks on.
- The Obs picker is unchanged: four bases, the ENC row, no toggles; a saved `'light'` in `obsChartBase` is not
  accepted.

**tests/OpenSeaMapDesk.test.ts (new)**
- useOpenSeaMapRasterHide: desk + seamarks on + no cells → `openseamap-permanent` visible; desk + cells loaded
  but none intersecting the view → visible; tracing with a cell bbox on screen → hidden; Obs 'sea' + ENC active →
  hidden (today's rule); desk seamarks off → hidden.
- useWeatherLayers' 'sea' sync never writes `openseamap-permanent` (spy on `setLayoutProperty`); toggling a
  plan-layer set (127-DESKMAP-b's wind) leaves it visible.
- `TILE_LAYERS` has no 'sea'; `getTileUrl('sea')` is undefined; no source id `tiles-sea` is ever added.
- The not-answering state: three non-404 `error` events for `openseamap-permanent` in 30 s → amber label; three
  404s → no change; a quiet `moveend` restores.

**tests/MapAttributionContract.test.ts** (extended)
- Every source whose tiles are `tiles.openseamap.org` carries `OPENSEAMAP_ATTRIBUTION` (useMapInit, logMap,
  ThalassaMap, SpatiotemporalMap, PinMapViewer, useOfflineBaseLayer), and the string names "CC BY-SA 2.0",
  "OpenStreetMap" and "ODbL". A grep guard: no other file names `tiles.openseamap.org` except MapOfflineService
  and PiCacheService (fail-closed offline and the Pi tile proxy).

**Sketch legs** (beside the existing traceGrading and useTracerTraceLayer tests)
- A no-chart cluster and a context-build failure produce `grade: 'caution'`, `unchecked: true` and the new
  messages; a real verdict never carries `unchecked`.
- The trace source marks those legs `sketch: true`; `trace-line-sketch` has a dasharray and the `#1c1917`
  casing beneath; `trace-line-core`/`-glow` exclude sketch legs; a sketch leg is never green or `#ffb300`.
- Saved-route words for a sketch leg are unchanged from today (still 'caution').

**Overlay tests** (beside useTracerTraceLayer and inshoreRouteState)
- `trace-line-core`, `route-harbour-dash` and both braid cores have a `#1c1917` casing beneath them.
- Hint and ghost: no casing; the hint ≤ 1.5 px, dotted, opacity ≤ 0.7; the ghost keeps its width; slate on Light,
  today's ink elsewhere.
- Table test: every planning-surface line's outer ink reaches ≥ 3:1 against every Light water colour.

**Playwright: browser-tests/desk-map-light.spec.ts + e2e/fixtures/desk-map.tsx (new)**, offline on
e2e/helpers/syntheticChartTiles.ts (its `seamarkTile` already serves buoys from z10), screenshots at 1440x900 and
1024x768, wide fonts (e2e/helpers/wideFonts.ts `applyWideFonts` + `expectWideFaceDrawn`). The map is built
through useMapInit's own load pass, `addReliefBase` and `setReliefPalette`, on the synthetic Solent (England,
outside every Australian set) and Whitsundays.
- At z8, z11 and z13: a land pixel buff, a water pixel pale blue, ΔE ≥ 15 apart, a coastline pixel dark.
- Solent z13: open water flat, no row-to-row jump across a tile boundary. Whitsundays z13: GA tint still shows.
- Solent z12 with seamarks on: synthetic buoy pixels present; seamarks off: absent; strip slot 1 shows the label.
- A fictional NOAA-shaped cell (via `importCell`, as autorouting-trial does) placed off a fictional Chesapeake
  shore, tracer active: with the cell on screen the OpenSeaMap raster is hidden and the cell's own marks draw; pan
  until the cell is off screen and the buoys return.
- The cell on Light: opaque bands, charted white ≥ ΔE 10 from the no-chart sea outside it; ENC land matches base
  land; the amber safety contour and marks show; the chart key shows its chart-mode legend.
- Light → Relief + Sat → Light with no reload: the cell goes chart → glaze → chart; a 2 s idle has zero style
  writes (the styledata-loop rule).
- Tracer legs in all four grades plus a sketch leg over Light: the cased line probes ≥ 3:1; the sketch leg is
  dashed grey; the bearing hint is thinner and lighter than every leg.
- Seamark tiles answering 503: after three, the label reads "OpenSeaMap not answering".
- Credits: opening ⓘ lists Mapbox, OSM, GEBCO, the GA title, CC BY 4.0, OpenSeaMap with CC BY-SA 2.0 and ODbL,
  and Not for navigation; the Mapbox logo is uncovered.
- Night: the NIGHT palette and white labels; leaving night restores Light.

**Playwright: the real app planner** (plan-page-fit.spec.ts's way into the real Plan tab, `ONBOARDED_STORAGE`
(e2e/helpers/storageState.ts), every Mapbox, relief and OpenSeaMap request routed to the synthetic tiles; Route
Planner's full-screen map if the tracer needs a session; wide fonts). At **1440x900, 1024x768, 390x844 and
320x568**:
- the menu sits top centre and the strip under it; neither box intersects the tracer card, the zoom pill, the
  mic and status pair, the chart key, the detail scrubber, PlannerVesselLocator, the scale bar, the Mapbox ⓘ or
  logo;
- the strip's slots never overlap each other;
- **slot 0, two accounts:**
  - with `boatCharts: { licensed: true }` seeded into the fixture's settings, slot 0 reads "Licensed charts stay
    on Fixture Boat" (fictional) everywhere;
  - with no flag, over the Solent and the Whitsundays it reads "No chart for this area"; over the fictional
    Chesapeake cell its box stays but the text is hidden; the page text never contains "Licensed" or "Fixture
    Boat";
  - panning across the cell edge never moves slot 1 (bounding boxes compared before and after);
- picking Hybrid and turning Seamarks off, then reloading, keeps both; a fresh context opens on Light with
  seamarks on; picker mode shows no menu, no strip, no seamarks; the inline (embedded) map shows Light only.

**Playwright: web Obs** (obs-layer-key-layout's harness): the no-charts notice reads C2's licensed sentence with
the flag seeded and the open sentence without it (no "Licensed"), and today's sentence with the native flag
stubbed; both web sentences fit the notice at 320x568 with wide fonts; Obs Sea marks + a fictional cell: one
raster, hidden under the cell.

**tests/DeskBoatChartsLine.test.tsx (new; C1/C2, fails on b127 today)**
- MapHub's slot-0 selector:
  - flag true + name → the licensed line; flag true, no name → "stay aboard";
  - flag false, null, absent, or signed out → "No chart for this area" with no cell in view, and a hidden box
    with a cell in view;
  - never a boat name without the flag.
- ChartDepthControls on web, `encCellCount === 0`: each flag value renders exactly one of the two C2 sentences,
  through `boatChartsLine` (no second string in the component); native renders today's sentence.
- The flag is read, never written, by this package (spy on `updateSettings`).

**Manual, not CI** (attach to the review): the scratch harness on live tiles at z12.5 off Yamba (29.45°S
153.4°E) and Thursday Island (10.58°S 142.2°E); Chesapeake z11 and z14 on the live NOAA shelf; live OpenSeaMap at
the Solent z12 and Airlie z13 on Light.

**Stay green.** Unit: GlazeImageryFade, ImageryOrderAnchor, LiveMiniMapReliefSat, TrackMapViewerReliefSat,
MapCreditsStrip, PaneAwareAttribution. Browser: log-mini-map-layout, track-map-viewer-layout,
obs-layer-key-layout, enc-scale-order, enc-hazard-labels, mbtiles-csp (the CSP already allows openseamap.org
and thalassatiles.com, vercel.json and index.html), autorouting-trial at 1024x768, plan-page-fit.

## Key files

- components/map/reliefBase.ts: LIGHT palette, shared regexes, label ink, Light zoom range, `seaBaseLayers`, the
  GA title.
- components/map/useMapInit.ts: the load pass uses the shared regexes; harbour-dash and braid casings; the
  OpenSeaMap credit constant.
- components/map/MapHub.tsx: `deskPlanner`, `deskBase`/`deskSeamarks` (one storage helper), `shownBase`,
  `imageryOn`, the palette argument, the menu's props and visibility, the strip slots 0-1 (slot 0 from the
  `boatCharts` flag and the in-view test), the hint and ghost ink, the sketch banner.
- components/map/MapBaseSelector.tsx: `options`, `encRow`, `toggles`, the Light option.
- components/map/mapHub/useOpenSeaMapRasterHide.ts: single owner, desk term, bbox gate, not-answering state.
- components/map/useWeatherLayers.ts: 'sea' out of `TILE_LAYERS`; the 'sea' sync stops writing the permanent
  raster.
- components/map/mapConstants.ts: `STATIC_TILES.sea` deleted.
- components/map/seamarkCredit.ts (new): `OPENSEAMAP_ATTRIBUTION` and its plain twin.
- logMap.ts, ThalassaMap.tsx, passage/SpatiotemporalMap.tsx, chat/PinMapViewer.tsx, useOfflineBaseLayer.ts: the
  credit.
- services/traceGrading.ts, services/routeTracer.ts (the type), components/map/useTracerTraceLayer.ts,
  components/map/ChartKeyPanel.tsx: sketch legs.
- components/map/ChartDepthControls.tsx: the two web sentences, through `boatChartsLine` (two new props).
- types/settings.ts: `boatCharts?: { licensed: boolean } | null` (type only; 127-C-c writes it).
- src/ocean/Credits.tsx, tools/relief/README.md: the GA title.
- Read only: encDepthStyle.ts, encDepthStyleState.ts, mapHub/useTracerChartFloors.ts, services/enc/EncCellMetadata.ts,
  inshoreRouteState.ts, creditsStrip.ts.
- Tests above; e2e/helpers/syntheticChartTiles.ts; playwright.keyboard.config.ts (testMatch).

## JS estimate

About **+3.6 KB** minified (≈ +1.35 KB gz; +3.4 before critic pass 3's slot-0 fix). Budget 4 KB. No new
library, no new tile source, no lazy chunk.

| Item | Size |
| --- | --- |
| LIGHT palette, label ink, Light zoom range, Light option | 0.95 KB |
| `deskPlanner`, desk base + seamark storage, picker visibility | 0.45 KB |
| Menu `options` / `encRow` / `toggles` rows | 0.3 KB |
| `imageryOn` per base | 0.05 KB |
| Four casings, hint and ghost ink | 0.6 KB |
| Seamarks: single owner, desk term, bbox gate, not-answering state | 0.4 KB |
| Strip slots 0-1, slot 0's flag and in-view test | 0.35 KB |
| OpenSeaMap credit constant (7 inline strings → 1), `tiles-sea` and `STATIC_TILES.sea` deleted | −0.1 KB |
| Sketch legs (flag, layer, messages, key row, banner) | 0.35 KB |
| Web no-charts sentences (two, flag-chosen) and the `boatCharts` type | 0.15 KB |
| GA credit title | 0.05 KB |

Measure the sum of dist/**/*.js before and after (as 127-01 did) and record it in the merge message.

## Sceptic pass (re-read 2026-10-10 ~16:40, and what it changed)

1. **"Chart" was misleading for a GEBCO and OSM picture.** Renamed Light, "seabed is a guide" in its row.
2. **Flat water `#cfe6f5` read as ~20 m deep.** No-data water is neutral `#cdd3d8`; the ramp never reaches white.
3. **The glaze on a pale sea fails hard rule 1** (ΔE 3-6). Chart mode on Light only, cost stated, exposure bounded.
4. **`setReliefPalette` would have left landcover slate, and 'enc' damping would repaint the dark ramp.** Fixed and tested.
5. **Tracer legs fell to 1.1-1.8:1 on a pale sea.** Dark casings; hints deliberately uncased.
6. **The dark bases are off the desk menu**, closer to "only two layers" than five.
7. **The first draft said "an OpenSeaMap toggle on the planner: not here (crowd-sourced, never authoritative)".**
   Shane overruled it at 15:50; the answer to "never authoritative" is the "community data, not verified" label
   and the chart-mark gate, not hiding the layer.
8. **OpenSeaMap on by default would have doubled NOAA marks while tracing**, because the tracer forces ENC marks
   while `encVisible` is false, so today's `encActive` hide never fires on the planner. Added the bbox gate.
9. **Two writers on one raster** would have blinked seamarks every time desk wind toggled. One owner now.
10. **The 'sea' toggle's second raster had no credit and ignored the ENC hide** (the Mooloolaba doubled icon,
    alive). Deleted (B4), which also halves our load on OpenSeaMap's free server.
11. **The ≥1024 px menu gate left narrow web windows with seamarks and no way to turn them off.** Gate removed;
    tested at 390 and 320.
12. **"Licensed charts stay on Serene Summer" would be wrong for anyone without licensed charts aboard**
    (critic pass 3: pass 2 showed it to every account). It now shows only with the `boatCharts.licensed` account
    flag. Everyone else gets "No chart for this area", or nothing over a NOAA cell. "Stay aboard" remains only for
    a licensed account with no vessel name (C1).
13. **Grey sketch legs changing the grade would ripple into Save words and the report.** The grade stays
    'caution'; only the paint and words change.
14. **"Never a straight line"**: the first draft said "127's Pi autoroute owns the route line". Stale: desk
    routing via the boat is 129. The desk draws only her own pins.
15. **Moreton Bay's straight line in Relief and Light is the Port of Brisbane channel in GA's grid**, drawn in
    sea colours at no route weight. Confirm on the harness before merge.
16. **The vision's "12-model wx server can't reach HTTPS web (wxServer.ts gate)"**: there is no wxServer.ts;
    see 127-DESKMAP-b, Today.

## For Shane

- **One question only you can answer:** should the phone's plotting surface move from Hybrid (your 2026-07-15
  pick) to Light, with Light joining the Obs picker? **Our recommendation:** not in 127. Try Light on the desk
  first; in 128, after a pale-sea check of rain, SST, AIS and isobars (wind is already done in 127-DESKMAP-b),
  move the phone planner and add Light to Obs.
- **One thing only you can do:** a short courtesy note to OpenSeaMap before the web goes live (we're showing
  their seamarks by default, credited, with the "community data" label), and a donation if you like. Draft on
  request; we never send it.
