// Bump these version numbers when shipping a change that must invalidate
// clients' local SW caches — otherwise users stay on the previous bundle
// indefinitely because the SW's stale-while-revalidate keeps serving it.
// v3: currents route moved from /currents/* to /api/currents/* (the old
// path 403s behind Vercel's Attack Challenge Mode).
// v4: Deepgram WS subprotocol changed from 'token' to 'bearer' — old
// cached bundle still hits 401 INVALID_AUTH. Forcing invalidation so
// the iOS SW picks up the new index-*.js with the auth fix.
// v55: Bumped because the iOS SW path was caching stale JS chunks
// across rebuilds — the bypass in index.tsx now also unregisters the
// SW on native, but bumping CACHE_NAME ensures any WEB-side stale
// caches get purged on next visit.
// v56: Navigations are NETWORK-FIRST now (Shane 2026-07-09: "every 10
// seconds the page refreshes and I lose all my work"). Stale-while-
// revalidate on the DOCUMENT meant every deploy day became a reload
// storm: the SW served yesterday's index.html, its hashed chunks
// 404'd, lazyRetry reloaded, and the background revalidation died
// with the page before it could freshen the cache — stale HTML
// survived every reload. Bump purges the poisoned core caches.
// v57: FORCE-PURGE the derived-contour hang (Shane 2026-07-13: "still
// locking up as the white layer arrives, ~zoom 7-8"). The z7-8 freeze
// was the sounding-derived-contour Delaunay pass shipped in 91161c0e;
// it's disabled in 02f6fd86 AND the styledata storm fixed in b8ef08d6,
// both deployed — but clients that loaded during the 91161c0e window
// keep running that bundle's JS until their SW cache is invalidated.
// This bump makes every stale client purge + re-fetch on next visit.
// v58: glaze clip goes shallow-bands-only (kills the black staircase
// flanking deep channels) + gesture-parked merge/uploads — make sure
// every client picks up the new bundle promptly (Shane 2026-07-14).
// v59: corridor-blackout fix round 2 (empty-vs-null coverage seams,
// DRGARE frame, robust DRVAL1) + clip-loop stall fix — purge so
// Shane's test devices pull the new bundle immediately (2026-07-14).
// v60: tracer pins broke geo-anchoring (inline position:relative on the
// Marker root overrode Mapbox's absolute — pins stacked into document
// flow, a fixed screen offset that reads as drift while zooming). Purge
// so every device drops the drifting-pin bundle immediately.
// v61: marine-blue water names + island names, glaze pre-warmed from
// z9.5, QLD-coast bridge set (30 published clearances + 67 display-only
// spans) — purge so bridges-au.json v3 and the new bundle land together.
// v62: flat-white glaze (kills the tinted-rectangle patchwork), clip
// threshold 10→5 m, VHF watch-channel badges on the leads.
// v65: stale-chart fix — rAF-parked upload queue gets a watchdog + a
// final repaint kick; numbered book-end pins; scrubber clears the nav
// bar. Purge hard: stale bundles are exactly what v65 fixes.
// v66: Dark base mode — the public voyage-page dark-v11 basemap as a
// third base under the chart.
// v70: tracer legs colour immediately + after reload (style-gate
// removed, churn loop killed = the growing slowdown), compass locked
// over the plotting card.
// v71: pin-nudge no longer stacks a duplicate waypoint (long-press
// stands down on marker grabs), whole tracer header folds the card,
// same-name save overwrites in place after an "Overwrite?" confirm.
// v72: hybrid is the boot base everywhere; lit marks answer as the
// MARK with their light folded in (was light-only, hiding cardinal
// pass-side info); S-57 colour codes decoded to names.
// v73: tracer perf overhaul — zoom pill no longer re-renders the tree
// per pinch frame (with N grid reads per render riding along), pin
// markers reconcile instead of rebuild, redundant verdict publishes
// and ghost-lane rescans killed. The "unresponsive with many
// waypoints" bundle must go.
// v74: ⇄ Reverse flips the trace for the return trip (legs re-grade
// for the opposite heading); Save also mirrors the route into the
// ship's log as a suggested (planned_%) route.
// v75: voyage picker goes summary-backed — the 3 July ocean passage
// had aged out of the newest-10k entry window (15,135 rows since
// 3 July, window floor 10 July) and could NEVER appear; summaries
// see the whole history, the polyline loads per-voyage on tap.
// v76: ⇄ reverse also flips the route NAME (Newport - Lady Musgrave →
// Lady Musgrave - Newport), so the return run saves as its own route.
// v77: the name actually flips — Save no longer clears the name box
// (save → ⇄ was flipping an empty string), sloppy spacing tolerated,
// and the flash announces the new name.
// v78: Save requires a route name — "Name the route first" + focus
// instead of minting anonymous date-stamped rows.
// v79: ⚡ Auto route button beside Route report — pin, pin, ⚡ and the
// tracer's fine-grid A* bends the last leg around shallows/land,
// splicing the bends as editable pins. Tracer grid only, never the
// four-tier engine.
// v80: perf audit batch 1 — kills the ~8 Hz default-config styledata
// loop (scrubber vs imagery over LNDARE_ISLET), the 60 s whole-log
// re-download while underway, the lightning empty-setData 16 Hz drain,
// halves the tracer grid build, dedupes the ENC bbox double-walk, one
// getStyle per apply pass, one mousemove delegate, tide-label render bail.
// v82: ⚡ Auto route now drives the REAL inshore engine (tryInshoreRoute,
// tideAssist) — follows deep water, treats land as a hard wall (NEVER
// crosses land), tide-checks shallow crossings. On any engine failure it
// changes nothing instead of drawing a straight line over land (the v81
// bug). v81's bespoke subdivide-and-straight-line router is gone.
// v83: ⚡ Auto route routes the leg INTO the highlighted pin (tap a pin
// first), and breaks the engine's deep-water line into depth-checkable
// pieces so a long open-water run no longer reads "depth unchecked" —
// the added pins sit on the engine's water line (never land), tide
// windows chip onto any shallow crossing.
// v84: ⚡ Auto route prefers DEEPEST water — 'safest' profile first (detours
// around shoals to deep water), 'tideAssist' only as fallback; every outcome
// flashes a distinct diagnosable message.
// v85: ⚡ auto route shows a PERSISTENT diagnostic banner (why it did/didn't
// route: routed / straight-kept / engine error / no coverage / threw) so a
// no-op is legible without the device console. Tap to dismiss.
// v86: ⚡ auto route SYNCS THE CHARTS on a coverage gap — pulls the missing
// detail cells nearest the leg from the boat's Pi, then retries the route
// automatically (no Pi Cache menu-diving). Honest messages when the Pi is
// unreachable or the stretch is genuinely uncharted even on the Pi.
// v87: THE auto-route root cause — cloud ENC cells were stuck at
// hazardCount 0, so the inshore router's coverage gate rejected EVERY
// cloud cell (inshore routing never worked on the web). downloadCloudCell
// now computes the real feature count; ⚡ auto route fills a coverage gap
// from the CLOUD (HTTPS, works in-browser) instead of the Pi (unreachable
// behind the page's HTTPS origin), then retries.
// v88: route-planning crash + route-quality. Engine grid path gets a
// 2.5M-cell ceiling (was uncapped → 12M cells / ~600 MB / 37-100s freeze);
// ⚡ auto route falls to tideAssist when 'safest' returns a >2.2× dogleg
// (the deranged shallow-bay tour); buildNavGrid logs START/DONE so the
// device console proves hang-vs-OOM. (Worker move is the next commit.)
// v89: the tracer's depth-grid build runs OFF the main thread (navGrid
// Web Worker) — the sync build froze the WKWebView long enough for iOS to
// kill the app while plotting. UI stays alive; sync fallback on any worker
// failure. (Engine/auto-route grid worker = next.)
// v90: tap a marker/beacon/light for its ENC info WITHOUT closing the
// tracer card — popups stay live while plotting (placement is the long
// press, so a tap is free to inspect). The "hold to drop a pin" coach
// only shows on an empty tap; the release-click after a placement is
// swallowed so a pin drop doesn't pop up the water beneath it.
// v91: nav marks (buoys/beacons/lights) show from ZOOM 10 onwards — a z10
// floor over their S-57 SCAMIN (which otherwise hid them to ~z13.5), an
// earlier SCAMIN still wins and high-zoom density thinning is untouched.
// v92: kill the first-open stall at zoom 4 — the ENC merge (30k-sounding
// explosion + every overview/coastal cell) ran at the Aus+NZ boot zoom
// where nothing but SCAMIN-thinned soundings render. Merge now gated to
// z6.5+ (the render floor), so it fires as you zoom toward your water.
// v93: two tracer fixes — (1) ⚡ Auto route parked (button hidden) + a new
// 'tideDirect' engine profile that commits to the near-direct crossing on
// the tide instead of a marina dogleg; (2) mark grading no longer cries
// "danger side" when you pass a solo lateral on the chart-confirmed clean side.
// v94: mark "danger side" fix, take 2 — v93 only covered NUMBERED ENC
// laterals (soloLaterals); Shane's nagging mark was an unnumbered/OSM beacon
// that has a disc but no soloLateral. §1 now chart-reads against the disc's
// OWN mark (merged.OBSTRN → ctx.markHazards) + probes past the disc, so an
// isolated red beacon on the clean side finally says nothing.
// v95: tracer — (1) type a GPS fix to drop the next pin (build a route by
// keying coords, decimal/DMM/DMS); (2) route report lists every waypoint in
// order (DMM, tap-to-fly); (3) special-purpose (yellow) marks show their
// charted purpose — CATSPM category + free-text INFORM/NINFOM, honest when
// the chart carries none.
// v96: when the chart can't call which side of a lateral mark is safe, the
// tracer now gives the IALA-A rule for the mark's hand instead of a vague
// "check which side" — e.g. "Red port-hand mark on your starboard — IALA-A:
// keep red to port heading in". Mark hand carried through markHazards.
// v97: passing a lateral mark on the correct side in safe water now reads
// GREEN with a confirming note ("Red mark to your port — correct side heading
// in") instead of an amber caution. New 'info' issue severity that doesn't
// escalate the leg grade; amber only when the depth is unproven or you're on
// the shoal side.
// v99: GPS-fix input placeholder is now the plain "Add a GPS coordinate"
// (Shane 2026-07-16) — no clipped example.
// v100: route report now shows the route heading (its name) and has a ⬇ PDF
// button — exports a shareable/printable PDF (title, health tally, departure
// window, every waypoint in DMM, per-leg verdicts) via the iOS share sheet /
// web download. jsPDF lazy-loaded off the main bundle.
// v101: (1) GPS-fix field placeholder → "Add a GPS Fix". (2) Deeper-water
// GHOST waypoints — a thin/no-go leg with deeper water abeam now drops a
// dashed, draggable ghost pin at that charted deep spot; tap or drag it to
// splice a real waypoint there and route the line through the deep water.
// v102: route report now shows per-waypoint WEATHER at the ETA you'd reach it
// (departing now at cruising speed) — arrival time + wind/gust from Open-Meteo,
// each waypoint sampled at its own arrival hour. In the on-screen report and
// the PDF. Degrades to ETAs-only when offline / no key / beyond forecast.
// v103: Undo is now a real multi-step history — it restores the route EXACTLY
// as it was before the last edit (a stray-tap waypoint, a drag, auto-route,
// anything), and steps back edit-by-edit right up to the last save (save/load
// = the floor). Was just "remove the last pin".
// v104: Redo — step forward again after an Undo (Shane's idea), edit-by-edit
// up to where you'd undone from. A fresh edit abandons the redo branch; save/
// load clear both stacks. Redo button beside Undo in both control rows.
// v105: route-report cruising speed shows one decimal ("8.9kt", not
// "8.899438184514795kt") — screen + PDF.
// v106: the chart opens at zoom 10 exactly (the golden size — every nav mark
// visible, local water fills the screen) centred on the selected location /
// GPS, instead of the whole-Aus+NZ fit. Only the no-fix fallback keeps the
// wide view.
// v107: (1) z10 boot actually sticks — the first weather-coords centring was
// jumping back out to the Aus+NZ fit right after boot; it now jumps to z10.
// (2) Deeper-water ghost waypoints REMOVED (went haywire — one on every thin
// leg); the 💡 text advisory stays.
// v108: charts follow the route by themselves — (a) on-demand cell loading
// now climbs device → PI → cloud (offline-with-Pi routing no longer starves);
// (b) corridor prefetch: the moment a trace has 2+ pins, the cells covering
// the padded corridor pull quietly in the background via the same ladder.
// v109: z10 boot speed batch (8 audit fixes) — first merge fires immediately
// (no 250ms debounce / 300ms idle ceiling on boot), merge pre-warms UNDER the
// tile network wait, glaze cache survives cell arrivals (content-keyed),
// cold-store downloads run 3-wide with paint-in-waves, unclamped merge
// yields, Pi auto-sync deferred out of the boot window, hydration skips a
// multi-MB re-stringify, and a [perf] line measures every merge.
// v110: departure date/time on the tracer (🕐 Depart picker, default now) —
// per-waypoint weather ETAs anchor at the chosen departure, per-leg tide
// windows evaluate at each leg's ARRIVAL time, and the departure-window
// headline shifts every gate back by its transit time (a true "leave X–Y").
// v111: routes auto-name as you plot — "Newport - Newport" on the first pin,
// the end updates live ("Newport - Scarborough"), coords when no place is
// nearby ("Newport - 27.14S 153.09E"). Typing your own name stops it; Clear
// wipes an auto name but keeps a typed one.
// v112: tracer tidy — Depart is two clean lines (date, then time) with an OK
// button that closes the iOS picker; ⚡ Auto-to-destination + the From/To
// course-frame boxes are parked (start by tapping the chart).
// v113: PLAN tab is now the tracer's front door — Comfort + Trip/Leg stay,
// then a Departure card, three ways in (paste a mate's coords / from a past
// voyage / saved routes — each opens the chart with the tracer ready), and
// the slider reads "Slide to Start Plotting". Old origin/destination
// calculate form parked.
// v114: PLAN front door tidy — paste-from-a-mate card removed; past-voyage +
// saved-routes cards open a picker MODAL right on the page (tap a route →
// taken straight to it on the chart); the hint card crowding the slide CTA
// removed.
// v115: "checking a leg" no longer drags the page — the nav-grid worker
// respawns after a crash instead of latching every later build onto the main
// thread; duplicate context builds coalesce; recent chart windows are kept
// (LRU of 3) so ping-pong edits stop rebuilding; corridor prefetch waits
// until grading settles; one needless full-page render per pin edit removed.
// v116: pins dropped (or dragged) within ~50 m of a charted lead/transit now
// snap exactly ONTO the lead — "Snapped onto the lead 🎯". Deliberate
// placement further away stays put.
// v117: faster chart draw at the z10 boot — cell files read 3-ahead of the
// parser (IO overlaps parse instead of strictly alternating), and the
// sounding-density ladder stops assigning rungs the current window culls
// anyway (~30-50% of ladder work at z10).
// v118: routing-page declutter — while the tracer is open the layer FAB,
// offline-download FAB, mic orb and the Clear All chip hide (Done brings
// them back); the tracer card is height-clamped (~44% of screen, legs scroll
// inside) so it never climbs under the compass/zoom box, and it sits clear
// above the detail scrubber.
// v119: tracer card slimmed — paste-from-a-mate / past-voyage / saved-routes
// rows removed from the card's bottom (the PLAN page owns those flows now).
// Share-with-a-mate + share-with-all-skippers stay.
// v120: recenter-on-weather-location FAB parked — GPS Locate Me now owns the
// bottom-right corner (it was hidden behind the detail scrubber).
// v121: depart pickers are 24-hour (the web time input's AM/PM clipped),
// default to right now, and grey out past dates/times; the tracer card can
// now grow to just under the zoom pill before its leg list scrolls.
// v122: multi-leg trips — Trip box on the PLAN page chains saved routes
// into legs; "plot the next leg" opens the tracer with pin 1 locked at the
// previous leg's exact arrival; saves badge "(2nd Leg)", retro-badge leg 1,
// and auto-heal keeps the chain welded when an earlier leg's arrival moves.
// v123: charts page goes bare — the Full/Clean scrubber and the tracer
// pill/card only appear while plotting (enter via the PLAN page); Done
// hands back a clean chart.
// v124: the minimised tracer card lifts 2rem clear of the Full/Clean
// scrubber (it sat on top of it when folded).
// v125: tracer-card Depart loses its OK button — the 24-hour selects
// dismiss themselves; the full-width Now button (back to leave-now) stays.
// v126: leg verdicts persist across reloads/deploys/tab-bounces — a kept
// route no longer re-checks the entire line when nothing changed. Cache
// drops itself on a draft change or a chart install (registry version).
// v127: the night-dim moon FAB moves to the top-left cluster — same row as
// the zoom pill, evenly seated between pill, compass rose and tracer card.
// v128: night-dim moon crosses to the far side of the compass rose —
// zoom pill left, rose centre, moon right, all on the 104px row.
// v129: the lead-snap grab radius widens 50 m → 120 m — easier to land a
// pin on a charted transit (leads are sparse, so a wide catch is safe).
// v130: night-dim moon sits just off the compass rose's right edge (was
// flung to the far right screen edge) — pill left, rose centre, moon beside.
// v131: the tracer card's two share rows (share with a mate / share with all
// skippers) are parked — the card ends at the harbourmaster queue now.
// v132: the tracer card is a FIXED height — adding waypoints no longer
// grows it. The waypoint list is the one scroll region (soaks up the slack),
// and Save/Report/Depart stay pinned and always reachable below it.
// v133: tracer card header controls are proper fat-finger buttons (fold /
// compass / Done, ≥36px targets); the standalone <boat>.thalassawx.app/plan
// page hides the bottom tab bar — no access to the rest of the app.
// v134: tracer card geometry fix — the fixed height was measured against the
// viewport (dvh) but the card lives in the shorter map container, so it
// overshot the top (covering the zoom pill / moon / compass rose). Now bound
// by top+bottom in container coords; Done properly collapses it to the strip.
// v135: tracer card top now clears the LOWEST top-furniture via max() — on
// the web (no safe-area) the pills sit lower than the compass rose, so tying
// the card top to the rose alone still let it cover the zoom/moon pills.
// v136: drop the pin-count "(N)" from the tracer header title — it wrapped
// onto a second line and buggered the header layout.
// v137: feature-info popups (tap a mark/depth/hazard) now sit ABOVE the
// compass rose, tracer card and every FAB. The ENC popup carried no z-index
// (rose/moon painted over it); the rest were only 800 — all now 10000.
// v138: the ENC popup close ✕ moves to a smaller disc straddling the box's
// top-right CORNER (was a 44px in-box disc covering the data rows) — floats
// clear of every word, still a comfy fat-finger tap.
// v139: the TRACER title is a proper boxed button now, matching the compass
// and DONE buttons beside it.
// v140: sign-in screen cleaned up — the blocky baked-in wordmark is now
// crisp live "THALASSA" text (compass mark kept), and the footer no longer
// overlaps the CTA button (it had conflicting relative+absolute classes).
// v141: drop the header health label ("1 NO-GO LEG" / "ALL CLEAR") from the
// tracer card — it crowded the header; per-leg rows already carry the verdict.
// v142: tracer card gains a utility strip — a KEY toggle (colour legend on
// demand) and OPEN A SAVED ROUTE (loads a previous track; the only path to
// saved routes on the standalone /plan web page).
// v143: park the Copy button from the tracer controls row — 6 buttons → 5,
// so Plot/Undo/Redo/Clear/⇄ get a fatter fat-finger target on a phone.
// v144: the card's "open a saved route" list now GROUPS by trip (multi-leg
// trips show a header + indented legs), sharing one grouping helper with the
// PLAN Trip box so the two can't drift.
// v145: cross-device vessel sync — sign-in is a TWO-WAY reconcile now. A
// vessel onboarded locally while signed out (draft/beam/etc.) uploads to the
// cloud on the next sign-in, so a second device (incl. the web) gets the keel.
// v146: removed the card's "Key" toggle (it jostled the card, no useful
// info — the empty-state help keeps the colour key), and opening a saved
// route now FITS THE WHOLE ROUTE on screen (overrides the z10 default).
// v147: tracer header is just the TRACER fold button now (Done + compass
// toggle removed; compass rose always shows + more opaque). Fixed the web
// "no signal" false-offline bug (probe used a CORS-blocked fetch on web) and
// dropped the redundant "Online" connectivity chip.
// v148: the night-dim ☾ pill is planning-only now — hidden on the bare
// charts page (still reachable from the chart-modes menu there).
// v149: compass rose LESS opaque (0.85 → 0.40) — reverting the "more opaque"
// tweak; the chart shows through it now.
// v150: the tracking page's "Skipper" link is RELATIVE /plan now — keeps the
// punter on THEIR boat subdomain (boat-name.thalassawx.app/plan) instead of
// the old absolute apex link that 308-redirected to www and dropped the handle.
// v151: routes export to GPX for chartplotters (OpenCPN/Garmin/B&G) — a ⬇ GPX
// button beside ⬇ PDF in the route report; shared/downloaded like the PDF.
// v152: public tracking page shows ONLY the route the boat is currently
// following (dashed violet passage line) — saved/planned routes no longer
// leak in as clutter (client filters planned track lines; edge fn drops
// planned rows from the track + waypoint pins at source).
// v153: follow-a-route lives on the Log page now. The FOLLOW button (and the
// new "Following a route?" cast-off prompt when you slide to start tracking)
// PUBLISH the picked route to your public page; "Sail it" removed from the
// tracer. Following is a cast-off decision, not a plotting one.
// v154: the Charts source-picker category is parked off the radial layer FAB
// (the boat's ENC/o-charts are automatic) — the fan falls back to 3
// categories (weather/tactical/nav). Reversible via CHARTS_FAB_CATEGORY_VISIBLE.
// v155: Marks / Tides / No-Go / Window parked out of the radial FAB's
// Tactical fan (wrong page). AIS, Anchor and Inspect stay.
// v156: AIS shows only vessels in the CURRENT map view — the render is clipped
// to the viewport (padded), so panning to the Whitsundays shows the yachts up
// there and none from home (was: local store dumped every target everywhere).
// v157: the charts page boots on the CLEAN DARK chart (dark-v11 base + ENC
// depth bands) instead of the glazed hybrid satellite. Satellite/hybrid stay
// one tap away via the base toggle.
// v158: radial layer FAB spaces its 3 categories (SKY/SEA/TACTICAL) evenly
// again (the 4->3 drop when Charts was parked had bunched them); the clean
// dark chart now paints water a marine blue vs land a lighter slate so the
// coastline is readable.
// v159: bridges + Notices to Mariners are plotting-only now — they ride with
// the tracer (plan surface) and leave the browsing chart page clean.
// v160: water lightened again on the dark chart (#0d2c49 -> #1f5a85) — a
// readable mid marine blue against the land slate.
// v161: the base layer follows the SURFACE — browsing chart = clean dark,
// PLOTTING = hybrid imagery so the white keel-clearance glaze ("zoom 10
// whites") is back on the plan page. Changing one no longer changes the other.
// v162: that per-surface base is now DERIVED rather than set by an effect, so
// nothing can race or undo it — "plotting ⇒ imagery on" is structurally true,
// which is what actually keeps the white keel glaze painted.
// v163: THE actual keel-glaze fix. v161/v162 closed the OPACITY channel; a
// layout visibility:'none' beats opacity, and ENC-master / clean-chart /
// route-focus can each set it — so the plotting surface could still lose its
// whole depth read while the tracer's force-shown marks kept it looking
// populated. Plotting now raises a keel FLOOR that outranks all three: depth
// bands (glaze over imagery, DEPARE on chart), the safety contour, and
// wrecks/rocks/obstructions — which the marks list never covered. Also stops
// MapHub's stale hand-copy of SATELLITE_HIDE_LAYERS from killing the amber
// keel-limit line that syncDepareBaseTreatment repaints every pass.
// v164: glaze legibility round 2 — the on-device review v163 asked for came
// back negative. Sub-safe water was three pale near-whites against a white
// safe band, so "will ground you" and "sail here" composited to one wash.
// White now means GO and nothing else; shallow/caution move into the amber of
// the safety contour. Alpha keeps its monotonic depth ramp (shallow stays most
// see-through so the imagery shows the real bank) — chroma carries the warning.
// Legend now imports those colours instead of hand-copied hexes, and is gated
// on imageryOn so HYBRID finally teaches the glaze key instead of paper-chart.
// v165: Waves / Sea Ice / MLD off the chart page's layer pickers. One shared
// PARKED_SEA_LAYERS list drives both pickers (the radial fan and the overlay
// drawer) so they can't disagree, and the persisted active-layer set filters
// through it too — otherwise a saved 'waves' would restore ON with its control
// gone. Layer keys and CMEMS plumbing stay wired; empty the list to restore.
// v166: tracer card centres on the DEVICE only (web keeps the left rail), and
// the half-moon night-dim button no longer hides itself. The moon was gated on
// encVisible, so it vanished for anyone whose ENC master was off -- and since
// the plotting keel floor force-shows the depth read regardless of that toggle,
// it disappeared exactly when the chart it dims was on screen.
// v167: "Sea chart ON/off" row in the chart-modes menu. The ENC master toggle
// did exist, but only in the layer drawer (gated on encCellCount > 0) while
// Clear All -- which switches it OFF -- sits in the chart-modes menu. One tap
// could strip the depth bands, contours, marks and hazards with no obvious way
// back. Off and on now live in the same menu.
// v168: the plan page's detail scrubber is sized for thumbs. The Tailwind h-1
// track made the whole INPUT 4px tall, so the grabbable strip was 4px; it is
// now a 26px input with a 22px thumb over a slim 6px bar, and w-72 for more
// travel between detents. The tracer card's open offset rises 8.4 -> 9.5rem to
// keep its clearance over the taller slider.
// v169: the tab bar stays on PLAN while plotting. "Slide to Start Plotting"
// does setPage('map'), so the bar lit CHARTS and contradicted the journey the
// skipper was actually on. Both tabs now consult tracerActive (already
// dispatched by MapHub), so plotting reads as Plan and the two can't both light.
// v170: two Glass niggles. The hero's degree ring sat above the numerals (its
// glyph rides high in its own em box, and the column pinned BOX top to BOX
// top) -- dropped by the digits' cap-height inset, scaled per size class. And
// a forecast day's overview card no longer claims "00:00 - 01:00": it is an
// average standing for no hour, and only selectedTime could tell it apart from
// the real 00:00 card (both report activeHour 0).
// v171: an in-progress trace can be resumed after a tab hop. coordCaptureMode
// is useState(false) with no false-setter, so it died on any MapHub unmount --
// every tab except Charts -- while the PINS survived in sessionStorage. The
// 🧭 re-entry pill existed but was gated behind the very flag it restores
// (outer && coordCaptureMode vs inner !coordCaptureMode), i.e. unreachable.
// Un-parked, shown only when unfinished pins exist. The leg CHAIN and the
// route name now persist with the pins too, so a resumed leg 2 no longer saves
// silently unchained.
// v172: the route report sits CENTRED and safe-area-inset instead of pinned to
// the bottom edge, where a short report hugged the screen bottom and the "Fix
// all" button sat under the home indicator. Also fixes the heights: the body
// was capped at 46vh inside an 80vh card that also stacked a header, a
// departure row and a footer, so the footer could be pushed out. Now a flex
// column -- fixed chrome, flexing leg list -- capped in dvh, not vh.
// v173: hero time ranges are back on the hour cards, and now actually track the
// swipe: overview (no time), 00:00-01:00, 01:00-02:00, ... v170 suppressed the
// label using selectedTime === undefined, but onTimeSelect is NEVER called with
// a real timestamp, so that test matched every slide and killed them all. The
// honest signal is the RAW slide index -- activeHour is lossy, mapping both the
// overview and 00:00 to hour 0 -- so HeroSlide now reports it upstream.
// v174: Charts is reachable from the plan chart at last — every other tab left
// trace mode by unmounting MapHub, but Charts is already ON the map, so its tap
// was inert. It now closes the tracer (keeping the pins, 🧭 pill to resume).
// Layout: the scrubber moves off the Locate FAB onto the left rail and the
// tracer card docks directly above it, open or folded, so the two read as one
// column instead of drifting apart.
// v175: the cast-off "Following a route?" sheet opens at the TOP, under the
// Ship's Log header, instead of at the far bottom of the screen — and each row
// is now named by its endpoints ("Newport -> Scarborough") instead of every row
// reading an identical "Suggested route". The naming hook is shared with the
// voyage cards, so a route is called the same thing in both places, and the
// lookups are cached so showing both no longer geocodes a berth twice.
// v176: Watch Status (Anchor / Guardian / MOB / Radio) is pinned to the screen
// on the Vessel page, joining NavStationHero's existing sticky block rather
// than adding a second one that would overlap it; its heading is gone, which is
// what pays for the pinned rows. Charts boot on SATELLITE again -- note that
// also boots the full satellite ENC treatment (white keel glaze, hidden land
// fills) instead of the dark ECDIS look.
// v177: the "Following a route?" sheet is a true centred modal. It kept landing
// low because PageTransition animates the page with translate3d, and a
// transformed ancestor becomes the containing block for `fixed` children — so
// `fixed inset-0` was covering the PAGE box, not the screen. Portalled to
// <body> (the pattern LocationStarMenu already uses) so `fixed` means the
// viewport again, and centred so no measured offset can be wrong.
// v178: the cast-off picker lists each passage ONCE. A ⇄ reversed route is a
// separate saved voyage, so every passage appeared twice. Pairs collapse to the
// direction that STARTS nearest the boat -- the way you are about to sail --
// marked ⇄ so a folded return leg is visible rather than silently dropped.
// v179: BATHYMETRY as its own chart base. The MapTiler Ocean raster has always
// been there, but only as a 0.45 tint on top of satellite; as a base it becomes
// the water itself -- depth contours as the chart, no photo. Counts as imagery
// so ENC goes translucent over it (otherwise the 0.95-opaque DEPARE ramp would
// paint straight over the bathymetry), and drops under the ENC stack rather
// than floating above it the way a tint does.
// v180: no tracer furniture on the browsing chart again. Dropping a pin made the
// 🧭 resume pill appear over on Charts; that pill was un-parked as a way back
// from a stranded trace, but persisting the pins was the actual fix -- the Plan
// page's slide already restores the trace whole -- so it was a redundant second
// door costing the chart its cleanliness.
// v181: the PLAN start page's three pickers are proper centred modals. Saved
// routes and Past voyages were bottom sheets; the Trip box unrolled its legs
// INLINE, which shoved "Slide to Start Plotting" off the bottom of the page —
// the one control the page exists to present. All three are portalled to <body>
// so `fixed` means the screen, not PageTransition's transformed page box.
// v182: a chained leg's first pin is locked as an INVARIANT, not six separate
// per-path guards. Drag/delete/reverse/insert/clear/load all already refused to
// move it, but adopting a ghost lane replaced the whole pin array and broke
// every one of them at once. Now re-asserted centrally: whatever rewrites the
// route, pin 1 returns to the previous leg's arrival.
// v183: Trip box placeholder reads "New Trip or Route" (was "Continue a trip or
// route…").
// v184: Watch Status goes FOUR ACROSS on one line. These tiles are pinned, so
// their height is permanent screen — two rows cost ~172px of it, one row ~78px,
// and the ~95px goes back to the Boat Binder. Quarter width (~80px) still
// clears the 44pt touch minimum but not the old icon-beside-text layout, so each
// tile stacks chip/name/state and the state shrinks to one word.
// v185: the public page falls back to the boat's LAST KNOWN POSITION when there
// is no recent track — it used to open on a globe view of nowhere. Rides as
// telemetry, not a one-point track, so it cannot be swallowed by the
// land-voyage vote (a boat at its berth can read as majority-land). Labelled
// "Last known · Nd ago" and not pinging, so a stale fix never poses as live.
// v186: public page — wind-barb toggle parked (a skipper's tool, not a
// viewer's), and the no-track camera goes z10 -> z13 so "where are they" reads
// as an anchorage rather than a region.
// v187: Anchor Watch opens again. The four-across rewrite (v184) rebuilt the
// tile and sent it to a route named 'anchor' that does not exist — the screen
// has always lived under 'compass'. Blank page, my fault.
// v188: public page — the header now distinguishes "Live · 2 min ago" from
// "Not tracking · 21 h ago" (it said "Live" for ANY telemetry, which the
// last-known fallback turned into a lie). No-track zoom z13 -> z12. And the
// fallback no longer resolves to a PLANNED waypoint: those rows carry ETAs, so
// ordering by timestamp desc was returning a position six hours in the future.
const CACHE_NAME = 'thalassa-v188-core';
const TILE_CACHE = 'thalassa-v188-tiles';
const DATA_CACHE = 'thalassa-v188-data';
const LAN_TILE_CACHE = 'thalassa-v57-lan-tiles';

const ASSETS = ['/', '/index.html', '/index.css', '/manifest.json'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (![CACHE_NAME, TILE_CACHE, DATA_CACHE, LAN_TILE_CACHE].includes(key)) {
                        return caches.delete(key);
                    }
                }),
            ),
        ),
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // ── DEV MODE BYPASS ──
    // On localhost, let ALL requests pass through to Vite dev server directly.
    // Without this, the stale SW cache serves old module files, blocking hot reload.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return; // Don't call event.respondWith — browser fetches normally
    }

    // 0. LAN CHART TILES — Cache-first for AvNav/Pi chart tiles over local network.
    // These are o-charts, NOAA MBTiles, etc. served by AvNav on the Pi.
    // Cache-first gives instant rendering; stale-while-revalidate keeps tiles fresh.
    // Matches: 192.168.x.x, 10.x.x.x, 172.16-31.x.x, *.local hostnames.
    const isLanTile =
        (url.hostname.match(/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/) ||
            url.hostname.endsWith('.local') ||
            url.hostname === 'openplotter.local') &&
        url.pathname.match(/\/\d+\/\d+\/\d+/); // Tile URL pattern: /{z}/{x}/{y}

    if (isLanTile) {
        event.respondWith(
            caches.open(LAN_TILE_CACHE).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    // Stale-while-revalidate: return cache immediately, refresh in background
                    const fetchPromise = fetch(event.request)
                        .then((networkResponse) => {
                            if (networkResponse.ok) {
                                cache.put(event.request, networkResponse.clone());
                            }
                            return networkResponse;
                        })
                        .catch(() => cachedResponse || new Response('', { status: 404 }));

                    // If cached, return instantly (huge speed win for chart panning)
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // No cache — wait for network
                    return fetchPromise;
                });
            }),
        );
        // Prune LAN tile cache every ~100 requests (max 2000 tiles ≈ 50–100 MB)
        if (Math.random() < 0.01) {
            caches.open(LAN_TILE_CACHE).then((cache) => {
                cache.keys().then((keys) => {
                    if (keys.length > 2000) {
                        const excess = keys.length - 2000;
                        for (let i = 0; i < excess; i++) {
                            cache.delete(keys[i]);
                        }
                    }
                });
            });
        }
        return;
    }

    // 1. CHART TILES - CACHE FIRST (The Offline "Holy Grail")
    // We want tiles to stick around for a long time (e.g., 30 days) to support offshore usage.
    if (
        url.hostname.includes('cartocdn.com') ||
        url.hostname.includes('openstreetmap.org') ||
        url.hostname.includes('openseamap.org') ||
        url.hostname.includes('mapbox.com')
    ) {
        event.respondWith(
            caches.open(TILE_CACHE).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    // Return valid cache
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Fetch and Cache
                    return fetch(event.request)
                        .then((networkResponse) => {
                            // Only cache valid responses
                            if (networkResponse.ok) {
                                cache.put(event.request, networkResponse.clone());
                            }
                            return networkResponse;
                        })
                        .catch(() => {
                            // Fallback for tiles? usually just return nothing or a placeholder
                            return new Response('', { status: 404 });
                        });
                });
            }),
        );
        return;
    }

    // 2. DATA API - Network First, then Cache
    // Covers weather APIs (StormGlass, Open-Meteo) AND Supabase edge functions
    // (WeatherKit, tides, wind grid). Network first so we always get fresh data,
    // but we cache responses so users see last-known data when offline.
    if (
        url.hostname.includes('open-meteo.com') ||
        url.hostname.includes('stormglass.io') ||
        url.hostname.includes('nomads.ncep.noaa.gov') ||
        url.hostname.includes('gebco.net') ||
        (url.hostname.includes('supabase.co') && url.pathname.includes('/functions/v1/'))
    ) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(DATA_CACHE).then((cache) => {
                            cache.put(event.request, clone);
                            // Prune data cache to max 50 entries (prevent unbounded growth)
                            cache.keys().then((keys) => {
                                if (keys.length > 50) {
                                    // Remove oldest entries (first in = oldest)
                                    const excess = keys.length - 50;
                                    for (let i = 0; i < excess; i++) {
                                        cache.delete(keys[i]);
                                    }
                                }
                            });
                        });
                    }
                    return response;
                })
                .catch(() => caches.match(event.request)), // Fallback to offline data
        );
        return;
    }

    // 3a. NAVIGATIONS (the HTML document) - NETWORK FIRST, cache only
    // as the offline fallback. The document carries the hashed-chunk
    // manifest: serving it stale after a deploy hands the app a map of
    // chunks Vercel has already purged → 404s → lazyRetry reload loop
    // (the "page refreshes every 10 seconds" field bug, 2026-07-09).
    // The document is ~15 KB from Vercel's edge — the SWR latency win
    // was never worth the poisoned manifest.
    if (event.request.mode === 'navigate' || event.request.destination === 'document') {
        event.respondWith(
            fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse.ok) {
                        const responseToCache = networkResponse.clone();
                        event.waitUntil(
                            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache)),
                        );
                    }
                    return networkResponse;
                })
                .catch(() => caches.match(event.request).then((c) => c || caches.match('/index.html'))),
        );
        return;
    }

    // 3b. APP SHELL ASSETS - Stale While Revalidate
    // Safe here: /assets/* filenames are content-hashed (immutable per
    // hash), so a cache hit is correct by construction. waitUntil keeps
    // the background revalidation alive past page teardown.
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse.ok) {
                        const responseToCache = networkResponse.clone();
                        event.waitUntil(
                            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache)),
                        );
                    }
                    return networkResponse;
                })
                .catch((err) => {
                    console.warn('[SW] Fetch failed for', event.request.url, err);
                    return cachedResponse || new Response('', { status: 503, statusText: 'Offline' });
                });
            return cachedResponse || fetchPromise;
        }),
    );
});
