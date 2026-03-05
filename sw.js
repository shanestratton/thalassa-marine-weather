
const CACHE_NAME = 'thalassa-v2-core';
const TILE_CACHE = 'thalassa-v2-tiles';
const DATA_CACHE = 'thalassa-v2-data';

const ASSETS = [
  '/',
  '/index.html',
  '/index.css',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((key) => {
        if (![CACHE_NAME, TILE_CACHE, DATA_CACHE].includes(key)) {
          return caches.delete(key);
        }
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. CHART TILES - CACHE FIRST (The Offline "Holy Grail")
  // We want tiles to stick around for a long time (e.g., 30 days) to support offshore usage.
  if (url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('openstreetmap.org') ||
    url.hostname.includes('openseamap.org') ||
    url.hostname.includes('mapbox.com')) {

    event.respondWith(
      caches.open(TILE_CACHE).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          // Return valid cache
          if (cachedResponse) {
            return cachedResponse;
          }
          // Fetch and Cache
          return fetch(event.request).then((networkResponse) => {
            // Only cache valid responses
            if (networkResponse.ok) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => {
            // Fallback for tiles? usually just return nothing or a placeholder
            return new Response('', { status: 404 });
          });
        });
      })
    );
    return;
  }

  // 2. DATA API - Network First, then Cache
  // Covers weather APIs (StormGlass, Open-Meteo) AND Supabase edge functions
  // (WeatherKit, tides, wind grid). Network first so we always get fresh data,
  // but we cache responses so users see last-known data when offline.
  if (url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('stormglass.io') ||
    (url.hostname.includes('supabase.co') && url.pathname.includes('/functions/v1/'))) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then(cache => {
              cache.put(event.request, clone);
              // Prune data cache to max 50 entries (prevent unbounded growth)
              cache.keys().then(keys => {
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
        .catch(() => caches.match(event.request)) // Fallback to offline data
    );
    return;
  }

  // 3. APP SHELL - Stale While Revalidate
  // Fast load from cache, then update in background
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        console.warn('[SW] Fetch failed for', event.request.url, err);
        return cachedResponse || new Response('', { status: 503, statusText: 'Offline' });
      });
      return cachedResponse || fetchPromise;
    })
  );
});
