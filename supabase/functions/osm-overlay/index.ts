/**
 * osm-overlay — Overpass proxy for the DESKTOP PASSAGE BUILDER (masterplan
 * Phase 5.2). The browser can't reach the boat's Pi, so this edge function
 * serves the SAME OSM route overlay the pi-cache does: identical Overpass
 * query, identical feature classing (v5 schema incl. berths), cached in the
 * `osm_overlay_cache` table with the same 7-day/0.01°-tile semantics.
 *
 * PORTED from pi-cache/src/services/osm.ts — if the recipe changes there,
 * mirror it here (both sites marked). Deployed with default JWT verification:
 * the desktop builder is a signed-in surface; the boat app keeps using the
 * Pi first and its disk cache offline.
 *
 * GET/POST ?bbox=w,s,e,n  →  OsmRouteOverlay JSON
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { FeatureCollection, Feature, Polygon, LineString, Position } from 'npm:@types/geojson';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseCoordinate,
    readJsonObject,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_SCHEMA_VERSION = 'v5';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface OsmRouteOverlay {
    water: FeatureCollection;
    reef: FeatureCollection;
    coastline: FeatureCollection;
    marina: FeatureCollection;
    breakwater: FeatureCollection;
    aeroway: FeatureCollection;
    canalLines: FeatureCollection;
    navLines: FeatureCollection;
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

function bboxCacheKey(bbox: [number, number, number, number]): string {
    const round = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${CACHE_SCHEMA_VERSION}_${round(bbox[0])}_${round(bbox[1])}_${round(bbox[2])}_${round(bbox[3])}`;
}

// ── SHARED RECIPE (verbatim from pi-cache/src/services/osm.ts) ─────────────
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

async function fetchFromOverpass(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const query = buildQuery(bbox);
    // Overpass convention: POST with body `data=<query>` URL-encoded.
    // Raw query in body without `data=` returns 406. Apache also
    // requires a User-Agent — without one we get 406 Not Acceptable.
    const response = await fetchWithTimeout(
        OVERPASS_URL,
        {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'thalassa-osm-overlay/1.0 (https://thalassawx.app)',
            },
        },
        OVERPASS_TIMEOUT_MS,
    );
    if (!response.ok) {
        throw new Error(`Overpass returned HTTP ${response.status}`);
    }
    const text = await readResponseTextLimited(response, 20_000_000);
    if (text === null) throw new Error('Overpass response exceeded byte limit');
    const json = JSON.parse(text) as OverpassResponse;
    if (!json || !Array.isArray(json.elements) || json.elements.length > 25_000) {
        throw new Error('Overpass response schema is invalid');
    }
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

// ── Edge entry ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'GET' && req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'GET or POST required' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json', Allow: 'GET, POST' },
        });
    }
    const caller = await requireAuthenticatedOrPublicQuota(req, 'osm_overlay', 120, 20, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceRoleKey) {
            return new Response(JSON.stringify({ error: 'Overlay cache is not configured' }), {
                status: 500,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const url = new URL(req.url);
        let bboxStr = url.searchParams.get('bbox');
        if (!bboxStr && req.method === 'POST') {
            const body = await readJsonObject(req, 4096);
            bboxStr =
                typeof body?.bbox === 'string' ? body.bbox : Array.isArray(body?.bbox) ? body.bbox.join(',') : null;
        }
        const parts = (bboxStr ?? '').split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            return new Response(JSON.stringify({ error: 'bbox=w,s,e,n required' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        const [w, s, e, n] = parts;
        if (
            parseCoordinate(w, 'lon') === null ||
            parseCoordinate(e, 'lon') === null ||
            parseCoordinate(s, 'lat') === null ||
            parseCoordinate(n, 'lat') === null
        ) {
            return new Response(JSON.stringify({ error: 'bbox coordinates are invalid' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        // Size guard — a runaway bbox would hammer Overpass and blow the
        // response limit. 2°×2° covers any tracer/builder context.
        if (e - w > 2 || n - s > 2 || e <= w || n <= s) {
            return new Response(JSON.stringify({ error: 'bbox too large (max 2 deg per side)' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        const bbox: [number, number, number, number] = [w, s, e, n];
        const key = bboxCacheKey(bbox);

        const { data: hit } = await admin
            .from('osm_overlay_cache')
            .select('payload, fetched_at')
            .eq('tile_key', key)
            .maybeSingle();
        if (hit && Date.now() - new Date(hit.fetched_at as string).getTime() < CACHE_TTL_MS) {
            return new Response(JSON.stringify(hit.payload), {
                headers: {
                    ...CORS,
                    'Content-Type': 'application/json',
                    'X-Overlay-Cache': 'hit',
                    'Cache-Control': 'public, max-age=3600',
                },
            });
        }

        const fresh = await fetchFromOverpass(bbox);
        await admin
            .from('osm_overlay_cache')
            .upsert({ tile_key: key, payload: fresh as unknown, fetched_at: new Date().toISOString() });
        return new Response(JSON.stringify(fresh), {
            headers: {
                ...CORS,
                'Content-Type': 'application/json',
                'X-Overlay-Cache': 'miss',
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch (err) {
        console.warn('[osm-overlay] failed:', err instanceof Error ? err.message : err);
        // Same degradation contract as the pi-cache: empty overlay, never 500.
        return new Response(JSON.stringify(emptyOverlay()), {
            headers: { ...CORS, 'Content-Type': 'application/json', 'X-Overlay-Cache': 'error' },
        });
    }
});
