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
const CACHE_NAME = 'thalassa-v103-core';
const TILE_CACHE = 'thalassa-v103-tiles';
const DATA_CACHE = 'thalassa-v103-data';
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
