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
// v63: Terrain base mode (shaded-relief land, chart water untouched).
const CACHE_NAME = 'thalassa-v63-core';
const TILE_CACHE = 'thalassa-v63-tiles';
const DATA_CACHE = 'thalassa-v63-data';
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
