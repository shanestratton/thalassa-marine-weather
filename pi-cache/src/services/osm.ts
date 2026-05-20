/**
 * OSM (OpenStreetMap) route-overlay service.
 *
 * Fetches navigation-relevant OSM features from the Overpass API, caches
 * them on the Pi filesystem, and serves them to the iOS app. Fills the
 * structural gaps in S-57 ENC data:
 *
 *   - rivers inside coastal landmass polygons (Brisbane River is "inside"
 *     LNDARE on the chart — needs OSM water=river to be navigable)
 *   - marina exit channels (chart doesn't tessellate them in detail —
 *     OSM water=canal + leisure=marina basin captures them)
 *   - reef extents (chart marks reefs as a single UWTROC point — OSM
 *     natural=reef polygons describe the actual shape)
 *   - breakwaters / piers (chart sometimes omits — OSM man_made=breakwater)
 *
 * Caching: per-bbox-tile (0.01° rounded) in `OSM_CACHE_DIR`, 7-day TTL.
 * Overpass is rate-limited and slow on cold queries (~5-30s); cache aggressively.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FeatureCollection, Feature, Polygon, LineString, Position } from 'geojson';

const OSM_CACHE_DIR = process.env.OSM_CACHE_DIR ?? '/opt/thalassa-pi-cache/osm-cache';
const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OVERPASS_TIMEOUT_MS = 45_000;
// Cache schema version. Bump when adding new fields to OsmRouteOverlay so
// old cache files (which lack the new fields) are bypassed and a fresh
// Overpass fetch happens. Old files stay on disk until LRU/manual cleanup —
// they're just ignored at read time.
//   v1 — original (water/reef/coastline/marina/breakwater)
//   v2 — adds aeroway (Brisbane Airport peninsula coverage)
//   v3 — adds canalLines (marina exit channels as navigable corridors)
//   v4 — adds navLines (charted leading/transit navigation lines →
//        preferred dredged-channel corridors, e.g. Brisbane River bar)
const CACHE_SCHEMA_VERSION = 'v4';

export interface OsmRouteOverlay {
    /** natural=water polygons (rivers, lakes, harbours, basins). Used as
     *  authoritative DEPARE in the router so the boat can traverse rivers
     *  even when chart LNDARE wrongly covers them. */
    water: FeatureCollection;
    /** natural=reef polygons. Used as polygon OBSTRN in the router so A*
     *  detours the entire reef extent, not just a single hazard point. */
    reef: FeatureCollection;
    /** natural=coastline lines. Reference for visual rendering AND used
     *  in the router as land-side context — cells on the LAND side of
     *  the coastline stay blocked even where chart LNDARE has gaps. */
    coastline: FeatureCollection;
    /** leisure=marina polygons. Treated like water (basin) so the router
     *  can enter marinas. */
    marina: FeatureCollection;
    /** man_made=breakwater. Treated as LNDARE so the router doesn't try
     *  to plough through a breakwater to exit a marina (Newport problem). */
    breakwater: FeatureCollection;
    /** aeroway=aerodrome/runway/taxiway/apron polygons. Treated as LNDARE
     *  in the router so reclaimed-land airport peninsulas (Brisbane
     *  Airport's eastern runway, Sydney Mascot, Hong Kong Chek Lap Kok)
     *  block routing. Chart LNDARE often pre-dates the reclamation; OSM
     *  is the only honest source. Added 2026-05-19 after a Newport→
     *  Rivergate route cut diagonally across Brisbane Airport. */
    aeroway: FeatureCollection;
    /** waterway=canal/fairway/dock LineStrings (NOT closed polygons). The
     *  navigable centreline of dredged channels — marina exit channels,
     *  port approach cuts. Bresenham-rasterised by the router into a
     *  1-cell navigable corridor so canal estates (Newport Marina) stay
     *  connected to open water across chart LNDARE that tessellates the
     *  channel banks as land at 50 m resolution. Closed waterway polygons
     *  still go to `water`; only the line variants land here. Added
     *  2026-05-20 after Newport Marina canal interior was a 349-cell
     *  isolated component (origin tap snapped 2 km away). */
    canalLines: FeatureCollection;
    /** seamark:type=navigation_line LineStrings — the charted leading &
     *  transit lines ships steer along to stay in the dredged channel
     *  (clearing lines are excluded — those mark danger limits, not the
     *  path). Rasterised by the router into a PREFERRED channel corridor
     *  that also rescues shallow-reading cells to navigable, so A* rides
     *  the real channel through bars/approaches the 30 m bathymetry reads
     *  as too shallow. Added 2026-05-20: Newport→Pinkenba was cutting a
     *  red CAUTION diagonal across the Brisbane River mouth bar because
     *  the dredged channel isn't in chart FAIRWY and the lateral markers
     *  are too sparse to stitch — but OSM has it as navigation lines. */
    navLines: FeatureCollection;
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
    };
}

/** Round bbox edges to 0.01° (~1 km) so neighbouring routes share cache hits. */
function bboxCacheKey(bbox: [number, number, number, number]): string {
    const round = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${round(bbox[0])}_${round(bbox[1])}_${round(bbox[2])}_${round(bbox[3])}`;
}

function cachePath(bbox: [number, number, number, number]): string {
    return path.join(OSM_CACHE_DIR, `${CACHE_SCHEMA_VERSION}_${bboxCacheKey(bbox)}.json`);
}

async function loadCache(bbox: [number, number, number, number]): Promise<OsmRouteOverlay | null> {
    try {
        const text = await fs.readFile(cachePath(bbox), 'utf8');
        const parsed = JSON.parse(text) as { ts: number; data: OsmRouteOverlay };
        if (Date.now() - parsed.ts < CACHE_TTL_MS) return parsed.data;
    } catch {
        // Cache miss — fall through to fetch.
    }
    return null;
}

async function saveCache(bbox: [number, number, number, number], data: OsmRouteOverlay): Promise<void> {
    await fs.mkdir(OSM_CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath(bbox), JSON.stringify({ ts: Date.now(), data }), 'utf8');
}

/**
 * Overpass QL query — fetches all navigation-relevant features inside the
 * bbox. `out body` then `>` then `out skel qt` is the standard pattern to
 * include both ways and the nodes they reference.
 *
 * Note: `(s,w,n,e)` is Overpass's bbox order (south, west, north, east).
 * Our internal bbox is [W, S, E, N] so swap accordingly.
 */
function buildQuery(bbox: [number, number, number, number]): string {
    const [w, s, e, n] = bbox;
    // `out geom` returns inline geometry for each way/relation — eliminates
    // node-table lookups AND makes multipolygon relations easy to parse
    // (the canonical OSM tagging for Brisbane River, harbours, etc.).
    return `
        [out:json][timeout:30];
        (
          way["natural"="water"](${s},${w},${n},${e});
          relation["natural"="water"](${s},${w},${n},${e});
          way["natural"="reef"](${s},${w},${n},${e});
          relation["natural"="reef"](${s},${w},${n},${e});
          way["natural"="coastline"](${s},${w},${n},${e});
          way["leisure"="marina"](${s},${w},${n},${e});
          relation["leisure"="marina"](${s},${w},${n},${e});
          way["man_made"="breakwater"](${s},${w},${n},${e});
          way["waterway"~"^(canal|fairway|dock|river|riverbank)$"](${s},${w},${n},${e});
          way["aeroway"~"^(aerodrome|runway|taxiway|apron)$"](${s},${w},${n},${e});
          relation["aeroway"~"^(aerodrome|runway|taxiway|apron)$"](${s},${w},${n},${e});
          way["seamark:type"="navigation_line"](${s},${w},${n},${e});
        );
        out geom;
    `.trim();
}

interface OverpassWayGeom {
    type: 'way';
    id: number;
    geometry: Array<{ lat: number; lon: number }>;
    tags?: Record<string, string>;
}
interface OverpassRelationMember {
    type: 'way' | 'node' | 'relation';
    ref: number;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
}
interface OverpassRelationGeom {
    type: 'relation';
    id: number;
    members: OverpassRelationMember[];
    tags?: Record<string, string>;
}
type OverpassElement = OverpassWayGeom | OverpassRelationGeom;
interface OverpassResponse {
    elements: OverpassElement[];
}

async function fetchFromOverpass(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const query = buildQuery(bbox);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    let response: Response;
    try {
        // Overpass convention: POST with body `data=<query>` URL-encoded.
        // Raw query in body without `data=` returns 406. Apache also
        // requires a User-Agent — without one we get 406 Not Acceptable
        // from the front-end before the query even reaches Overpass.
        response = await fetch(OVERPASS_URL, {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'thalassa-pi-cache/1.0 (https://thalassawx.app)',
            },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
    if (!response.ok) {
        throw new Error(`Overpass returned HTTP ${response.status}`);
    }
    const json = (await response.json()) as OverpassResponse;
    return assembleOverlay(json);
}

/** Coordinates of a way returned by `out geom` (Overpass inline geometry). */
function wayCoords(el: OverpassWayGeom): Position[] {
    if (!el.geometry) return [];
    return el.geometry.map((p) => [p.lon, p.lat]);
}

function isClosed(coords: Position[]): boolean {
    return (
        coords.length >= 4 &&
        coords[0][0] === coords[coords.length - 1][0] &&
        coords[0][1] === coords[coords.length - 1][1]
    );
}

/**
 * Assemble multipolygon-relation member ways into closed rings.
 *
 * OSM multipolygons may need consecutive member ways chained together —
 * one ring can be split across multiple ways that share endpoints. We
 * greedy-chain by matching way endpoints.
 *
 * Returns array of {ring, role} where role is 'outer' (boundary) or
 * 'inner' (hole). Single-polygon emit: pair holes with their containing
 * outer by point-in-polygon (the caller decides).
 */
function assembleMultipolygonRings(rel: OverpassRelationGeom): Array<{ ring: Position[]; role: 'outer' | 'inner' }> {
    interface Segment {
        coords: Position[];
        role: 'outer' | 'inner';
    }
    // Bucket member ways by role.
    const remaining: Segment[] = [];
    for (const m of rel.members ?? []) {
        if (m.type !== 'way' || !m.geometry) continue;
        const coords = m.geometry.map((p) => [p.lon, p.lat] as Position);
        if (coords.length < 2) continue;
        const role: 'outer' | 'inner' = m.role === 'inner' ? 'inner' : 'outer';
        remaining.push({ coords, role });
    }

    const closed: Array<{ ring: Position[]; role: 'outer' | 'inner' }> = [];

    while (remaining.length > 0) {
        const start = remaining.shift()!;
        let ring = start.coords.slice();
        let extended = true;
        // Chain other segments of the same role that share endpoints.
        while (extended && remaining.length > 0) {
            extended = false;
            const tail = ring[ring.length - 1];
            for (let i = 0; i < remaining.length; i++) {
                const seg = remaining[i];
                if (seg.role !== start.role) continue;
                const segStart = seg.coords[0];
                const segEnd = seg.coords[seg.coords.length - 1];
                if (segStart[0] === tail[0] && segStart[1] === tail[1]) {
                    // append seg forward
                    for (let j = 1; j < seg.coords.length; j++) ring.push(seg.coords[j]);
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
                if (segEnd[0] === tail[0] && segEnd[1] === tail[1]) {
                    // append seg reversed
                    for (let j = seg.coords.length - 2; j >= 0; j--) ring.push(seg.coords[j]);
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
            }
        }
        // Close ring if it self-closes (start==end after chaining)
        const head = ring[0];
        const tail = ring[ring.length - 1];
        if (!(head[0] === tail[0] && head[1] === tail[1])) {
            // Force-close — multipolygon members SHOULD form closed rings
            // when chained. If they don't (broken OSM data), close anyway
            // and accept the geometric distortion.
            ring.push([head[0], head[1]]);
        }
        if (ring.length >= 4) closed.push({ ring, role: start.role });
    }

    return closed;
}

/**
 * Convert Overpass JSON (ways + multipolygon relations, both with inline
 * geometry via `out geom`) into per-class FeatureCollections.
 */
function assembleOverlay(osm: OverpassResponse): OsmRouteOverlay {
    const overlay = emptyOverlay();

    for (const el of osm.elements) {
        if (el.type === 'way') {
            const coords = wayCoords(el);
            if (coords.length < 2) continue;
            const tags = el.tags ?? {};
            const closed = isClosed(coords);
            const props: Record<string, unknown> = { ...tags, _source: 'osm', _osmId: el.id };

            const polyFeature = (): Feature<Polygon> => ({
                type: 'Feature',
                properties: props,
                geometry: { type: 'Polygon', coordinates: [coords] },
            });
            const lineFeature = (): Feature<LineString> => ({
                type: 'Feature',
                properties: props,
                geometry: { type: 'LineString', coordinates: coords },
            });

            if (tags.natural === 'water' && closed) {
                overlay.water.features.push(polyFeature());
            } else if (tags.natural === 'reef' && closed) {
                overlay.reef.features.push(polyFeature());
            } else if (tags.natural === 'coastline') {
                overlay.coastline.features.push(lineFeature());
            } else if (tags.leisure === 'marina' && closed) {
                overlay.marina.features.push(polyFeature());
            } else if (tags.man_made === 'breakwater') {
                if (closed) overlay.breakwater.features.push(polyFeature());
                else overlay.breakwater.features.push(lineFeature() as unknown as Feature<Polygon>);
            } else if (
                (tags.waterway === 'canal' ||
                    tags.waterway === 'fairway' ||
                    tags.waterway === 'dock' ||
                    tags.waterway === 'river' ||
                    tags.waterway === 'riverbank') &&
                closed
            ) {
                overlay.water.features.push(polyFeature());
            } else if (tags.waterway === 'canal' || tags.waterway === 'fairway' || tags.waterway === 'dock') {
                // Non-closed (LineString) navigable waterways — the
                // dredged centreline of marina exit channels and port
                // approach cuts. The router Bresenham-rasterises these
                // into a 1-cell navigable corridor. NOT river/riverbank:
                // those line variants are usually large-river centrelines
                // already represented as `natural=water` polygons, and
                // their lines can cut misleading corridors through land.
                overlay.canalLines.features.push(lineFeature());
            } else if (
                tags.aeroway === 'aerodrome' ||
                tags.aeroway === 'runway' ||
                tags.aeroway === 'taxiway' ||
                tags.aeroway === 'apron'
            ) {
                // Only emit polygon variants — runways are most reliably
                // mapped as closed polygons in OSM (the linear `aeroway=
                // runway` LineString variant exists but its width info is
                // a separate `width=*` tag we'd have to buffer ourselves,
                // not worth the complexity for now).
                if (closed) overlay.aeroway.features.push(polyFeature());
            } else if (tags['seamark:type'] === 'navigation_line') {
                // Charted leading/transit lines = the channel centreline
                // ships steer along. Exclude `clearing` lines — those mark
                // a danger limit you stay clear of, not a path to follow.
                // Uncategorised navigation lines are kept (still steer-
                // along by definition). Router rasterises these into a
                // preferred channel corridor.
                if (tags['seamark:navigation_line:category'] !== 'clearing') {
                    overlay.navLines.features.push(lineFeature());
                }
            }
        } else if (el.type === 'relation') {
            const tags = el.tags ?? {};
            if (tags.type !== 'multipolygon') continue;
            const rings = assembleMultipolygonRings(el);
            if (rings.length === 0) continue;

            const outers = rings.filter((r) => r.role === 'outer').map((r) => r.ring);
            const inners = rings.filter((r) => r.role === 'inner').map((r) => r.ring);
            // Emit each outer as its own Polygon with all inners as holes.
            // Strict pairing (which hole belongs to which outer) needs
            // point-in-polygon; for our routing use case the simple
            // "all holes apply to all outers" approach is adequate
            // because A* only cares about cell-by-cell coverage anyway.
            const props: Record<string, unknown> = { ...tags, _source: 'osm', _osmId: el.id };
            for (const outer of outers) {
                const polygon: Position[][] = [outer, ...inners];
                const feature: Feature<Polygon> = {
                    type: 'Feature',
                    properties: props,
                    geometry: { type: 'Polygon', coordinates: polygon },
                };
                if (tags.natural === 'water') overlay.water.features.push(feature);
                else if (tags.natural === 'reef') overlay.reef.features.push(feature);
                else if (tags.leisure === 'marina') overlay.marina.features.push(feature);
                else if (
                    tags.aeroway === 'aerodrome' ||
                    tags.aeroway === 'runway' ||
                    tags.aeroway === 'taxiway' ||
                    tags.aeroway === 'apron'
                ) {
                    overlay.aeroway.features.push(feature);
                }
            }
        }
    }

    return overlay;
}

/**
 * Public entry: fetch (or load cached) OSM overlay for a route bbox.
 * Caller passes [W, S, E, N]. Returns an empty overlay on any failure so
 * the router can fall back to chart-only cleanly.
 */
export async function getOsmOverlay(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    try {
        const cached = await loadCache(bbox);
        if (cached) return cached;
        const fresh = await fetchFromOverpass(bbox);
        await saveCache(bbox, fresh);
        return fresh;
    } catch (err) {
        console.warn('[osmService] fetch failed:', err instanceof Error ? err.message : err);
        return emptyOverlay();
    }
}
