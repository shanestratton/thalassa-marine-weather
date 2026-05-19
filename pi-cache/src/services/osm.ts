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
}

function emptyOverlay(): OsmRouteOverlay {
    return {
        water: { type: 'FeatureCollection', features: [] },
        reef: { type: 'FeatureCollection', features: [] },
        coastline: { type: 'FeatureCollection', features: [] },
        marina: { type: 'FeatureCollection', features: [] },
        breakwater: { type: 'FeatureCollection', features: [] },
    };
}

/** Round bbox edges to 0.01° (~1 km) so neighbouring routes share cache hits. */
function bboxCacheKey(bbox: [number, number, number, number]): string {
    const round = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${round(bbox[0])}_${round(bbox[1])}_${round(bbox[2])}_${round(bbox[3])}`;
}

function cachePath(bbox: [number, number, number, number]): string {
    return path.join(OSM_CACHE_DIR, `${bboxCacheKey(bbox)}.json`);
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
    return `
        [out:json][timeout:30];
        (
          way["natural"="water"](${s},${w},${n},${e});
          relation["natural"="water"](${s},${w},${n},${e});
          way["natural"="reef"](${s},${w},${n},${e});
          way["natural"="coastline"](${s},${w},${n},${e});
          way["leisure"="marina"](${s},${w},${n},${e});
          way["man_made"="breakwater"](${s},${w},${n},${e});
          way["waterway"~"^(canal|fairway|dock|river|riverbank)$"](${s},${w},${n},${e});
        );
        out body;
        >;
        out skel qt;
    `.trim();
}

interface OverpassNode {
    type: 'node';
    id: number;
    lat: number;
    lon: number;
}
interface OverpassWay {
    type: 'way';
    id: number;
    nodes: number[];
    tags?: Record<string, string>;
}
interface OverpassResponse {
    elements: Array<OverpassNode | OverpassWay>;
}

async function fetchFromOverpass(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const query = buildQuery(bbox);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(OVERPASS_URL, {
            method: 'POST',
            body: query,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

/**
 * Convert Overpass JSON (flat nodes + ways) into per-class FeatureCollections.
 * Each way's nodes are looked up to build the line/polygon coordinates.
 */
function assembleOverlay(osm: OverpassResponse): OsmRouteOverlay {
    const nodes = new Map<number, [number, number]>();
    for (const el of osm.elements) {
        if (el.type === 'node') {
            nodes.set(el.id, [el.lon, el.lat]);
        }
    }

    const overlay = emptyOverlay();

    for (const el of osm.elements) {
        if (el.type !== 'way' || !el.nodes) continue;
        const coords: Position[] = [];
        for (const nodeId of el.nodes) {
            const pt = nodes.get(nodeId);
            if (pt) coords.push(pt);
        }
        if (coords.length < 2) continue;
        const tags = el.tags ?? {};
        const closed =
            coords.length >= 4 &&
            coords[0][0] === coords[coords.length - 1][0] &&
            coords[0][1] === coords[coords.length - 1][1];

        const props: Record<string, unknown> = {
            ...tags,
            _source: 'osm',
            _osmId: el.id,
        };

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

        // Route OSM tag → overlay layer.
        if (tags.natural === 'water' && closed) {
            overlay.water.features.push(polyFeature());
        } else if (tags.natural === 'reef' && closed) {
            overlay.reef.features.push(polyFeature());
        } else if (tags.natural === 'coastline') {
            // Coastline is conventionally a LineString with land on the LEFT.
            // Used as visual reference + router land-context.
            overlay.coastline.features.push(lineFeature());
        } else if (tags.leisure === 'marina' && closed) {
            overlay.marina.features.push(polyFeature());
        } else if (tags.man_made === 'breakwater') {
            // Treat closed breakwater rings as polygons; long groynes/jetties
            // as LineStrings (the router buffers around these).
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
            // Closed waterway ways are basins/canals/dock outlines — add to
            // water layer with the waterway tag preserved for downstream
            // classification.
            overlay.water.features.push(polyFeature());
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
