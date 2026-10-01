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
 *
 * Phase 2b (2026-10-01): a failure is no longer an empty overlay. The phone
 * read that empty 200 as "no canals here" and saved it over its last good
 * copy. Now an Overpass reply carrying a `remark` (a runtime error with
 * partial elements) is a failure, as the cloud's is (supabase/functions/
 * _shared/overpass-fetch.ts); an all-empty reply is served but never saved;
 * the query and the cache key use the same grid-expanded bbox (v6); and when
 * Overpass cannot be reached the newest saved copy for the key is served as
 * 'stale' with its own date — or getOsmOverlay throws
 * OsmOverlayUnavailableError and the route answers 503.
 *
 * Fix-up (2026-10-02): 'stale' goes only to a phone that asks for it
 * (acceptStale, the route's &stale=1). A phone from before 2b ignores
 * X-Osm-Overlay, so a stale copy would read to it as fresh — held 30 min and
 * written to its disk copy with no caveat; it gets the 503 it already reads
 * as a failure. And with a copy to fall back on, a hanging Overpass is waited
 * on for only STALE_AFTER_MS before the copy goes out (the phone gives up at
 * 20 s); the fetch carries on to its 45 s deadline and refreshes the cache.
 * Cache files are written to a temporary name and renamed, so a power cut on
 * the boat cannot truncate the only copy.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FeatureCollection, Feature, Polygon, LineString, Position } from 'geojson';
import { outboundFetch } from '../outboundHttp.js';

const OSM_CACHE_DIR = process.env.OSM_CACHE_DIR ?? '/opt/thalassa-pi-cache/osm-cache';
const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OVERPASS_TIMEOUT_MS = 45_000;
/** With a copy to fall back on, how long a slow Overpass is waited on before
 *  the copy is served stale: well inside the phone's 20 s read timeout
 *  (OsmRouteOverlayService FETCH_TIMEOUT_MS). */
const STALE_AFTER_MS = 12_000;
// Cache schema version. Bump when adding new fields to OsmRouteOverlay so
// old cache files (which lack the new fields) are bypassed and a fresh
// Overpass fetch happens. Old files stay on disk until LRU/manual cleanup —
// they're just ignored at read time.
//   v1 — original (water/reef/coastline/marina/breakwater)
//   v2 — adds aeroway (Brisbane Airport peninsula coverage)
//   v3 — adds canalLines (marina exit channels as navigable corridors)
//   v4 — adds navLines (charted leading/transit navigation lines →
//        preferred dredged-channel corridors, e.g. Brisbane River bar)
//   v5 — adds berths (man_made=pier/pontoon, floating=yes — the finger
//        pontoons inside a marina; the router carves them out of the basin
//        at fine resolution so the line follows the fairway between berth
//        rows instead of driving over the pens, Mooloolaba 2026-07-05)
//   v6 — the same fields; the key is the grid-expanded bbox the query now
//        uses too (W/S floored, E/N ceiled to 0.01°), so a cached reply always
//        covers the request; replies with an Overpass remark are never saved,
//        nor all-empty ones (Phase 2b, 2026-10-01). A v5 file is still read,
//        but only as a stale copy when Overpass cannot be reached.
const CACHE_SCHEMA_VERSION = 'v6';
const LEGACY_CACHE_SCHEMA_VERSION = 'v5';

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
    /** man_made=pier/pontoon + floating=yes structures — the finger
     *  pontoons / berth rows inside a marina (LineStrings mostly; some
     *  closed polygons). The router hard-blocks these at FINE resolution
     *  only, overriding the marina-authoritative water, so the marina leg
     *  rides the fairway lanes between berth rows instead of the geometric
     *  centre of the whole basin (which cut across the pens). The coarse
     *  grid ignores them, so a marina still reads as one navigable blob for
     *  the approach — no disconnection. Added 2026-07-05 (Mooloolaba: the
     *  route drove over the marina). Pi schema v5+; older Pi returns [] →
     *  router degrades to today's basin-centre line. */
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

type Bbox = [number, number, number, number];

const OVERLAY_FIELDS = [
    'water',
    'reef',
    'coastline',
    'marina',
    'breakwater',
    'aeroway',
    'canalLines',
    'navLines',
    'berths',
] as const;

/** No internet on the Pi and nothing saved for this bbox: the route answers
 *  503, never an empty overlay (Phase 2b, 2026-10-01). */
export class OsmOverlayUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OsmOverlayUnavailableError';
    }
}

/** fresh = just fetched; cache = a saved copy under 7 days; stale = an older
 *  copy served because Overpass could not be reached. */
export type OsmOverlayState = 'fresh' | 'cache' | 'stale';

export interface OsmOverlayResult {
    overlay: OsmRouteOverlay;
    state: OsmOverlayState;
    /** When this data came from Overpass (epoch ms). */
    fetchedAt: number;
}

/** What the Overpass POST sends. The URL is always OVERPASS_URL. */
export interface OverpassRequest {
    method: 'POST';
    body: string;
    headers: Record<string, string>;
    signal: AbortSignal;
}

/** The part of an HTTP reply the parser reads. */
export interface OverpassReply {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}

export interface OsmOverlayDeps {
    /** Sends the query to Overpass. Injected by tests: the outbound policy
     *  blocks loopback, so a local stub server cannot stand in for it. */
    fetchOverpass: (init: OverpassRequest) => Promise<OverpassReply>;
    cacheDir: string;
    now: () => number;
    /** The whole Overpass call, body included, is abandoned after this. */
    overpassTimeoutMs: number;
    /** With a stale copy to serve, Overpass is waited on only this long. */
    staleAfterMs: number;
}

export interface OsmOverlayOptions {
    /** The client reads X-Osm-Overlay and says so (the phone's &stale=1,
     *  2b on): only then is an old copy served as 'stale' (2026-10-02). */
    acceptStale?: boolean;
}

const defaultDeps: OsmOverlayDeps = {
    fetchOverpass: (init) => outboundFetch(OVERPASS_URL, init),
    cacheDir: OSM_CACHE_DIR,
    now: () => Date.now(),
    overpassTimeoutMs: OVERPASS_TIMEOUT_MS,
    staleAfterMs: STALE_AFTER_MS,
};

/**
 * The bbox the query asks for and the cache is keyed by: W/S floored and E/N
 * ceiled to 0.01°, so a saved reply always covers the request it answers.
 * The v5 key rounded to the nearest 0.01° while the query used the exact
 * bbox, so a later request with the same key could get water up to ~0.005°
 * short at an edge (the cloud names the same hazard, overpass-fetch.ts).
 */
function gridBbox([w, s, e, n]: Bbox): Bbox {
    const down = (v: number): number => Number((Math.floor(v * 100 + 1e-9) / 100).toFixed(2));
    const up = (v: number): number => Number((Math.ceil(v * 100 - 1e-9) / 100).toFixed(2));
    return [down(w), down(s), up(e), up(n)];
}

function gridKey(bbox: Bbox): string {
    return bbox.map((v) => v.toFixed(2)).join('_');
}

/** The pre-2b key: each edge of the REQUEST bbox rounded to 0.01°. */
function legacyCacheKey(bbox: Bbox): string {
    const round = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${round(bbox[0])}_${round(bbox[1])}_${round(bbox[2])}_${round(bbox[3])}`;
}

function overlayIsAllEmpty(overlay: OsmRouteOverlay): boolean {
    return OVERLAY_FIELDS.every((k) => overlay[k].features.length === 0);
}

/** A saved overlay with every field present; null when the file is not one. */
function overlayFromSaved(value: unknown): OsmRouteOverlay | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<Record<(typeof OVERLAY_FIELDS)[number], { features?: unknown }>>;
    const overlay = emptyOverlay();
    for (const k of OVERLAY_FIELDS) {
        const fc = raw[k];
        if (fc === undefined) continue; // older schemas lack the newer fields
        if (!fc || !Array.isArray(fc.features)) return null;
        overlay[k] = fc as FeatureCollection;
    }
    return overlay;
}

async function readSaved(file: string): Promise<{ ts: number; data: OsmRouteOverlay } | null> {
    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { ts?: unknown; data?: unknown };
        const data = overlayFromSaved(parsed.data);
        if (!data || typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
        return { ts: parsed.ts, data };
    } catch {
        return null; // no copy (or an unreadable one) for this key
    }
}

/** Written to a temporary name and renamed over the old copy (as
 *  encChartStore and windHistory do): a power cut mid-write leaves the old
 *  copy whole, never a truncated one (2026-10-02). */
async function saveCache(file: string, bbox: Bbox, ts: number, data: OsmRouteOverlay): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify({ ts, schema: CACHE_SCHEMA_VERSION, bbox, data }), 'utf8');
        await fs.rename(temporary, file);
    } catch (err) {
        await fs.unlink(temporary).catch(() => {});
        throw err;
    }
}

/**
 * Overpass QL query — fetches all navigation-relevant features inside the
 * bbox. `out body` then `>` then `out skel qt` is the standard pattern to
 * include both ways and the nodes they reference.
 *
 * Note: `(s,w,n,e)` is Overpass's bbox order (south, west, north, east).
 * Our internal bbox is [W, S, E, N] so swap accordingly.
 */
function buildQuery(bbox: Bbox): string {
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
          way["man_made"~"^(pier|pontoon)$"](${s},${w},${n},${e});
          way["floating"="yes"](${s},${w},${n},${e});
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

/**
 * The Overpass reply as an element list. A 200 can carry a runtime error in
 * `remark` with PARTIAL elements (a timeout part-way through the query): that
 * is a failure, never a complete inventory of the bbox — the cloud's
 * parseOverpassDocument rule (Phase 2b, 2026-10-01).
 */
export function parseOverpassReply(text: string): OverpassResponse {
    let value: { elements?: unknown; remark?: unknown };
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error('Overpass reply is not JSON');
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.elements)) {
        throw new Error('Overpass reply has no element list');
    }
    if (value.remark !== undefined && value.remark !== '') {
        throw new Error('Overpass runtime error (partial reply)');
    }
    return { elements: value.elements as OverpassElement[] };
}

async function fetchFromOverpass(
    bbox: Bbox,
    fetchOverpass: OsmOverlayDeps['fetchOverpass'],
    timeoutMs: number,
): Promise<OsmRouteOverlay> {
    const query = buildQuery(bbox);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // The deadline settles the call even if the fetch ignores the abort, so
    // a hung request can never pin the single-flight entry for its key.
    const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Overpass did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
    });
    const work = (async () => {
        // Overpass convention: POST with body `data=<query>` URL-encoded.
        // Raw query in body without `data=` returns 406. Apache also
        // requires a User-Agent — without one we get 406 Not Acceptable
        // from the front-end before the query even reaches Overpass.
        const response = await fetchOverpass({
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'thalassa-pi-cache/1.0 (https://thalassawx.app)',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Overpass returned HTTP ${response.status}`);
        }
        // The body read is inside the deadline too: a reply that stalls
        // mid-body is a failure, not a hang.
        return assembleOverlay(parseOverpassReply(await response.text()));
    })();
    // A late failure after the deadline won is nobody's to handle.
    work.catch(() => {});
    try {
        return await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timeout);
    }
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
        const ring = start.coords.slice();
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
            } else if (tags.man_made === 'pier' || tags.man_made === 'pontoon' || tags.floating === 'yes') {
                // Marina finger pontoons / berth rows. Mostly LineStrings
                // (the pontoon centreline); some closed polygons. Router
                // hard-blocks these at FINE res only, so the marina leg
                // follows the fairway between rows instead of the pens.
                if (closed) overlay.berths.features.push(polyFeature());
                else overlay.berths.features.push(lineFeature() as unknown as Feature<Polygon>);
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

/** One Overpass call per cache file at a time: a request that arrives while
 *  one is in flight (a stale copy already served, the fetch carrying on)
 *  joins it rather than asking Overpass again. */
const inflight = new Map<string, Promise<{ overlay: OsmRouteOverlay; fetchedAt: number }>>();

function refresh(
    grid: Bbox,
    file: string,
    d: OsmOverlayDeps,
): Promise<{ overlay: OsmRouteOverlay; fetchedAt: number }> {
    const running = inflight.get(file);
    if (running) return running;
    const job = (async () => {
        const overlay = await fetchFromOverpass(grid, d.fetchOverpass, d.overpassTimeoutMs);
        const fetchedAt = d.now();
        // An all-empty reply is served (a bbox of open sea is genuinely
        // empty) but not saved: an empty copy cannot be told from a lost one
        // later.
        if (!overlayIsAllEmpty(overlay)) {
            try {
                await saveCache(file, grid, fetchedAt, overlay);
            } catch (err) {
                console.warn('[osmService] cache write failed:', err instanceof Error ? err.message : err);
            }
        }
        return { overlay, fetchedAt };
    })();
    inflight.set(file, job);
    const done = (): void => {
        if (inflight.get(file) === job) inflight.delete(file);
    };
    job.then(done, (err) => {
        console.warn('[osmService] fetch failed:', err instanceof Error ? err.message : err);
        done();
    });
    return job;
}

/**
 * Public entry: the OSM overlay for a route bbox ([W, S, E, N]) and how fresh
 * it is. A v6 copy under 7 days is served as 'cache'. Otherwise Overpass is
 * asked: a good reply is 'fresh' (saved unless it is all-empty). When
 * Overpass fails — or, with a copy to fall back on, has not answered within
 * staleAfterMs — and the client accepts stale, the newest saved copy for the
 * key at any age (v6, else the pre-2b v5 file) is served as 'stale' with its
 * own date, and nothing is written; a slow fetch carries on and refreshes the
 * cache. Otherwise this throws OsmOverlayUnavailableError: the route answers
 * 503 instead of an empty overlay the phone would take for "no canals here"
 * (Phase 2b, 2026-10-01; acceptStale and the short wait 2026-10-02).
 */
export async function getOsmOverlay(
    bbox: Bbox,
    opts: OsmOverlayOptions = {},
    deps: Partial<OsmOverlayDeps> = {},
): Promise<OsmOverlayResult> {
    const d: OsmOverlayDeps = { ...defaultDeps, ...deps };
    const grid = gridBbox(bbox);
    const file = path.join(d.cacheDir, `${CACHE_SCHEMA_VERSION}_${gridKey(grid)}.json`);
    const saved = await readSaved(file);
    if (saved && d.now() - saved.ts < CACHE_TTL_MS) {
        return { overlay: saved.data, state: 'cache', fetchedAt: saved.ts };
    }
    // What a failure may fall back on — only for a client that reads the
    // state. An all-empty v5 file may be a failure the old Pi saved as an
    // answer: it is never served as the boat's copy of the water.
    let copy: { ts: number; data: OsmRouteOverlay } | null = null;
    if (opts.acceptStale) {
        const legacy = saved
            ? null
            : await readSaved(path.join(d.cacheDir, `${LEGACY_CACHE_SCHEMA_VERSION}_${legacyCacheKey(bbox)}.json`));
        copy = saved ?? (legacy && !overlayIsAllEmpty(legacy.data) ? legacy : null);
    }
    const fetching = refresh(grid, file, d);
    if (!copy) {
        try {
            const { overlay, fetchedAt } = await fetching;
            return { overlay, state: 'fresh', fetchedAt };
        } catch {
            throw new OsmOverlayUnavailableError('Overpass unavailable and nothing saved for this bbox');
        }
    }
    let wait: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        fetching.then(
            (fresh) => ({ fresh }),
            () => ({ failed: true as const }),
        ),
        new Promise<{ slow: true }>((resolve) => {
            wait = setTimeout(() => resolve({ slow: true }), d.staleAfterMs);
        }),
    ]);
    clearTimeout(wait);
    if ('fresh' in outcome)
        return { overlay: outcome.fresh.overlay, state: 'fresh', fetchedAt: outcome.fresh.fetchedAt };
    return { overlay: copy.data, state: 'stale', fetchedAt: copy.ts };
}
