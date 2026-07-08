/**
 * OSM route-overlay client.
 *
 * iOS-side fetcher for OSM features needed by the inshore router. The Pi
 * runs the actual Overpass query + cache; we just pull the assembled
 * GeoJSON via HTTP. Results are also cached locally (memory + Capacitor
 * Filesystem) so subsequent routes within the same bbox tile reuse them
 * without round-tripping the Pi.
 *
 * Used by InshoreRouter — when assembling the layer set for a route
 * bbox, after pulling chart cells we also fetch the OSM overlay and
 * merge water polygons (→ supplement DEPARE), reef polygons
 * (→ supplement OBSTRN), and breakwaters (→ supplement LNDARE). That
 * fills the structural gaps in S-57 ENC data: rivers inside coastal
 * landmass polygons, marina exit channels, reef extents.
 */

import type { FeatureCollection } from 'geojson';

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('OsmRouteOverlay');

const MEM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-process
// A COLD Overpass fetch over a whole passage bbox (Mooloolaba→Newport =
// ~990 pier/berth ways) measured 13 s Pi-side — 8 s silently timed out and
// served the stale disk copy WITHOUT berths, so the marina-carve had nothing
// to carve (Shane 2026-07-06 "that change did not land"). 20 s clears it. This
// only ever blocks that long when the Pi is REACHABLE but computing a cold
// query — `piCache.isAvailable()` short-circuits an out-of-range Pi straight
// to the disk fallback below, so a Pi that's gone still fails fast. Once the
// Pi caches the tile (7-day TTL) the fetch is <1 s again.
const FETCH_TIMEOUT_MS = 20_000;
// Disk copies never expire for FALLBACK use — a months-old OSM canal
// polygon beats "the marina is land". A fresh Pi fetch still replaces
// the disk copy whenever the Pi is reachable.
const DISK_DIR = 'osm-overlay';

export interface OsmRouteOverlay {
    water: FeatureCollection;
    reef: FeatureCollection;
    coastline: FeatureCollection;
    marina: FeatureCollection;
    breakwater: FeatureCollection;
    /** aeroway=aerodrome/runway/taxiway/apron polygons from OSM. Injected
     *  into LNDARE in InshoreRouter to block reclaimed-land airport
     *  peninsulas (Brisbane Airport's eastern runway is the canonical
     *  case — chart LNDARE doesn't cover the post-2020 reclamation, so
     *  A* threaded a straight diagonal across the runway).
     *  Added 2026-05-19. Pi side must be on cache schema v2 or newer for
     *  this field to be populated; older Pi versions return [] which is
     *  fine (router falls through to chart-only for the airport area). */
    aeroway: FeatureCollection;
    /** waterway=canal/fairway/dock LineStrings from OSM — navigable
     *  dredged-channel centrelines (marina exit channels, port approach
     *  cuts). Bresenham-rasterised into a 1-cell navigable corridor by
     *  the engine so canal estates connect to open water across chart
     *  LNDARE that tessellates the channel banks as land at 50 m.
     *  Added 2026-05-20 for the Newport Marina exit. Pi must be on cache
     *  schema v3+; older Pi returns [] → router degrades to chart-only,
     *  the canal estate stays islanded (origin snap stays large). */
    canalLines: FeatureCollection;
    /** seamark=navigation_line LineStrings (charted leading/transit lines,
     *  clearing lines excluded Pi-side). The dredged-channel centreline a
     *  vessel steers along. Rasterised by InshoreRouter into a preferred
     *  channel corridor (+ shallow-cell rescue) so A* rides the real
     *  channel through bars/approaches the coarse bathymetry reads as too
     *  shallow — the Brisbane River mouth bar is the canonical case.
     *  Added 2026-05-20. Pi must be on cache schema v4+; older Pi returns
     *  [] → router degrades to chart-only (route reverts to cutting the
     *  red CAUTION diagonal across the bar, which is at least honest). */
    navLines: FeatureCollection;
    /** man_made=pier/pontoon + floating=yes — marina finger pontoons /
     *  berth rows. Injected into the engine as layers.BERTH and hard-blocked
     *  at FINE resolution only, overriding the marina-authoritative water, so
     *  the marina leg rides the fairway lanes between berth rows instead of
     *  cutting across the pens (Mooloolaba 2026-07-05). Pi must be on cache
     *  schema v5+; older Pi returns [] → router keeps today's basin-centre
     *  line (no regression). */
    berths: FeatureCollection;
}

function emptyOverlay(): OsmRouteOverlay {
    return {
        water: { type: 'FeatureCollection', features: [] },
        reef: { type: 'FeatureCollection', features: [] },
        coastline: { type: 'FeatureCollection', features: [] },
        marina: { type: 'FeatureCollection', features: [] },
        breakwater: { type: 'FeatureCollection', features: [] },
        aeroway: { type: 'FeatureCollection', features: [] },
        canalLines: { type: 'FeatureCollection', features: [] },
        navLines: { type: 'FeatureCollection', features: [] },
        berths: { type: 'FeatureCollection', features: [] },
    };
}

interface MemCacheEntry {
    ts: number;
    data: OsmRouteOverlay;
}
const memCache = new Map<string, MemCacheEntry>();

function bboxKey(bbox: [number, number, number, number]): string {
    const r = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${r(bbox[0])}_${r(bbox[1])}_${r(bbox[2])}_${r(bbox[3])}`;
}

/**
 * Fetch the OSM route overlay for a bbox. Returns an empty overlay on any
 * failure — the router falls back cleanly to chart-only data.
 *
 * @param bbox [W, S, E, N] in degrees
 */
export async function getOsmRouteOverlay(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const key = bboxKey(bbox);
    const cached = memCache.get(key);
    if (cached && Date.now() - cached.ts < MEM_CACHE_TTL_MS) {
        log.info(`mem-cache hit for bbox ${key}`);
        return cached.data;
    }

    if (!piCache.isAvailable()) {
        // The overlay is the ONLY water source for OSM-charted canal estates
        // (the ENC paints them land). Fallback ladder away from the Pi:
        // CLOUD edge function (fresh, powers the desktop builder where the
        // Pi is unreachable by definition) → last good DISK copy (any age)
        // → empty (router degrades to chart-only).
        const cloud = await fetchOverlayFromCloud(bbox);
        if (cloud) {
            log.warn(`Pi not reachable — CLOUD overlay for bbox ${key}`);
            memCache.set(key, { ts: Date.now(), data: cloud });
            void writeOverlayToDisk(key, cloud);
            return cloud;
        }
        const disk = await readOverlayFromDisk(key);
        if (disk) {
            log.warn(`Pi not reachable — serving DISK overlay for bbox ${key}`);
            memCache.set(key, { ts: Date.now(), data: disk });
            return disk;
        }
        log.warn('Pi not reachable, no cloud/disk copy — OSM overlay empty (router will fall back to chart-only)');
        return emptyOverlay();
    }

    const url = `${piCache.baseUrl}/api/osm/overlay?bbox=${bbox.join(',')}`;
    log.warn(`fetching OSM overlay for bbox ${key} via ${url}`);
    const t0 = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            log.warn(`OSM overlay HTTP ${res.status} — using empty overlay`);
            return emptyOverlay();
        }
        const raw = (await res.json()) as Partial<OsmRouteOverlay>;
        // Fill any fields the Pi didn't send (older Pi versions don't
        // know about `aeroway`). Older Pis return [] for the missing
        // field, which is the same behaviour as a successful fetch over
        // an aeroway-free bbox — router degrades cleanly to chart-only
        // for those features.
        const data: OsmRouteOverlay = {
            water: raw.water ?? { type: 'FeatureCollection', features: [] },
            reef: raw.reef ?? { type: 'FeatureCollection', features: [] },
            coastline: raw.coastline ?? { type: 'FeatureCollection', features: [] },
            marina: raw.marina ?? { type: 'FeatureCollection', features: [] },
            breakwater: raw.breakwater ?? { type: 'FeatureCollection', features: [] },
            aeroway: raw.aeroway ?? { type: 'FeatureCollection', features: [] },
            canalLines: raw.canalLines ?? { type: 'FeatureCollection', features: [] },
            navLines: raw.navLines ?? { type: 'FeatureCollection', features: [] },
            berths: raw.berths ?? { type: 'FeatureCollection', features: [] },
        };
        const counts = `water=${data.water.features.length} reef=${data.reef.features.length} coast=${data.coastline.features.length} marina=${data.marina.features.length} bw=${data.breakwater.features.length} aeroway=${data.aeroway.features.length} canalLines=${data.canalLines.features.length} navLines=${data.navLines.features.length} berths=${data.berths.features.length}`;
        log.warn(`OSM overlay fetched in ${Date.now() - t0}ms — ${counts}`);
        memCache.set(key, { ts: Date.now(), data });
        void writeOverlayToDisk(key, data); // fire-and-forget — next offline launch has it
        return data;
    } catch (err) {
        log.warn(
            `OSM overlay fetch failed (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Same cloud→disk ladder as the Pi-unreachable path — a mid-fetch
        // dropout must not degrade an area we have served before.
        const cloud = await fetchOverlayFromCloud(bbox);
        if (cloud) {
            memCache.set(key, { ts: Date.now(), data: cloud });
            void writeOverlayToDisk(key, cloud);
            return cloud;
        }
        const disk = await readOverlayFromDisk(key);
        if (disk) {
            log.warn(`fetch failed — serving DISK overlay for bbox ${key}`);
            memCache.set(key, { ts: Date.now(), data: disk });
            return disk;
        }
        return emptyOverlay();
    } finally {
        clearTimeout(timer);
    }
}

// ── Cloud fallback (osm-overlay edge function, desktop builder) ─────
// Same recipe as the pi-cache (ported verbatim, v5 schema incl. berths),
// cached server-side in osm_overlay_cache. Signed-in only (the function
// verifies the JWT) — a signed-out browser degrades to disk/empty.

async function fetchOverlayFromCloud(bbox: [number, number, number, number]): Promise<OsmRouteOverlay | null> {
    try {
        const { supabase, isSupabaseConfigured } = await import('./supabase');
        if (!isSupabaseConfigured() || !supabase) return null;
        const { data, error } = await supabase.functions.invoke('osm-overlay', {
            body: { bbox: bbox.join(',') },
        });
        if (error || !data || typeof data !== 'object') return null;
        const raw = data as Partial<OsmRouteOverlay>;
        if (!raw.water || !Array.isArray(raw.water.features)) return null;
        return {
            water: raw.water,
            reef: raw.reef ?? { type: 'FeatureCollection', features: [] },
            coastline: raw.coastline ?? { type: 'FeatureCollection', features: [] },
            marina: raw.marina ?? { type: 'FeatureCollection', features: [] },
            breakwater: raw.breakwater ?? { type: 'FeatureCollection', features: [] },
            aeroway: raw.aeroway ?? { type: 'FeatureCollection', features: [] },
            canalLines: raw.canalLines ?? { type: 'FeatureCollection', features: [] },
            navLines: raw.navLines ?? { type: 'FeatureCollection', features: [] },
            berths: raw.berths ?? { type: 'FeatureCollection', features: [] },
        };
    } catch (err) {
        log.warn(`cloud overlay failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

// ── Disk cache (Capacitor Filesystem) ────────────────────────────────
// The header above always promised "memory + Capacitor Filesystem"; the
// Filesystem half was never built, so every fresh app session away from
// the Pi lost all OSM water. One JSON file per bbox key under Data/ —
// a handful of route corridors at ~0.5–2 MB each.

async function writeOverlayToDisk(key: string, data: OsmRouteOverlay): Promise<void> {
    try {
        await Filesystem.writeFile({
            path: `${DISK_DIR}/${key}.json`,
            data: JSON.stringify(data),
            directory: Directory.Data,
            encoding: Encoding.UTF8,
            recursive: true,
        });
    } catch (e) {
        log.warn(`overlay disk write failed (${key}): ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function readOverlayFromDisk(key: string): Promise<OsmRouteOverlay | null> {
    try {
        const res = await Filesystem.readFile({
            path: `${DISK_DIR}/${key}.json`,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
        });
        const parsed = JSON.parse(res.data as string) as Partial<OsmRouteOverlay>;
        if (!parsed || !parsed.water) return null;
        return {
            water: parsed.water,
            reef: parsed.reef ?? { type: 'FeatureCollection', features: [] },
            coastline: parsed.coastline ?? { type: 'FeatureCollection', features: [] },
            marina: parsed.marina ?? { type: 'FeatureCollection', features: [] },
            breakwater: parsed.breakwater ?? { type: 'FeatureCollection', features: [] },
            aeroway: parsed.aeroway ?? { type: 'FeatureCollection', features: [] },
            canalLines: parsed.canalLines ?? { type: 'FeatureCollection', features: [] },
            navLines: parsed.navLines ?? { type: 'FeatureCollection', features: [] },
            berths: parsed.berths ?? { type: 'FeatureCollection', features: [] },
        };
    } catch {
        return null; // no disk copy for this bbox yet
    }
}
