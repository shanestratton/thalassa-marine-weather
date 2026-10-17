// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchOwnedOsmFromWx } from '../_shared/owned-osm-upstream.ts';
import { parseBoundedNumber, parseCoordinate, readJsonObject } from '../_shared/http-security.ts';

/**
 * proxy-overpass — OpenStreetMap Overpass API CORS Proxy
 *
 * Fetches seamark (navigation aid) data from the Overpass API for any
 * location worldwide. Browser can't call Overpass directly due to CORS,
 * so this edge function acts as a passthrough.
 *
 * Request: POST with JSON body:
 *   { lat: number, lon: number, radiusNM?: number }
 *
 * Response: GeoJSON FeatureCollection of seamark nodes with IALA classifications.
 *
 * No API key required — Overpass is a free public API.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number) {
    return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// NM → metres

// ── IALA Classification ────────────────────────────────────────

interface SeamarkProperties {
    _type: string;
    _class: string;
    [key: string]: string;
}

function classifySeamark(tags: Record<string, string>): SeamarkProperties {
    const props: SeamarkProperties = { _type: 'unknown', _class: 'other' };
    let seamarkType = 'unknown';

    for (const [key, value] of Object.entries(tags)) {
        if (key.startsWith('seamark:')) {
            const shortKey = key.substring(8); // strip 'seamark:'
            props[shortKey] = value;
            if (key === 'seamark:type') seamarkType = value;
        }
    }

    props._type = seamarkType;
    props._class = deriveClass(seamarkType, props);
    return props;
}

function deriveClass(seamarkType: string, props: Record<string, string>): string {
    // Lateral marks (channel sides)
    if (seamarkType.includes('lateral')) {
        for (const prefix of ['buoy_lateral', 'beacon_lateral']) {
            const colour = props[`${prefix}:colour`] || '';
            const category = props[`${prefix}:category`] || '';
            if (colour.includes('red') || category === 'port') return 'port';
            if (colour.includes('green') || category === 'starboard') return 'starboard';
        }
        return 'lateral';
    }

    // Cardinal marks (directional hazard markers)
    if (seamarkType.includes('cardinal')) {
        for (const prefix of ['buoy_cardinal', 'beacon_cardinal']) {
            const cat = props[`${prefix}:category`] || '';
            if (cat) return `cardinal_${cat[0]}`;
        }
        return 'cardinal';
    }

    if (seamarkType.includes('safe_water')) return 'safe_water';
    if (seamarkType.includes('isolated_danger')) return 'danger';
    if (seamarkType.includes('special_purpose')) return 'special';
    if (seamarkType.includes('light_major') || seamarkType === 'light_major') return 'light_major';
    if (seamarkType.includes('light_minor') || seamarkType === 'light_minor') return 'light_minor';
    if (seamarkType.includes('light')) return 'light';
    if (seamarkType.includes('landmark')) return 'landmark';
    if (seamarkType.includes('mooring')) return 'mooring';
    if (seamarkType.includes('berth')) return 'berth';
    if (seamarkType.includes('anchorage')) return 'anchorage';
    if (seamarkType.includes('harbour')) return 'harbour';
    if (seamarkType.includes('rock') || seamarkType.includes('wreck') || seamarkType.includes('obstruction')) {
        return 'danger';
    }
    if (seamarkType.includes('fairway')) return 'fairway';
    if (seamarkType.includes('gate')) return 'gate';
    return 'other';
}

// ── Main Handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405);
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'overpass_seamarks', 120, 30, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const body = await readJsonObject(req, 4096);
        const lat = parseCoordinate(body?.lat, 'lat');
        const lon = parseCoordinate(body?.lon, 'lon');
        const radiusNM = parseBoundedNumber(body?.radiusNM ?? 5, 0.1, 15);
        if (lat === null || lon === null || radiusNM === null) {
            return corsResponse(JSON.stringify({ error: 'Invalid lat/lon/radius bounds' }), 400);
        }

        const dLat = radiusNM / 60;
        const dLon = radiusNM / (60 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
        const data = await fetchOwnedOsmFromWx(
            { schema: 1, kind: 'nodes', bbox: [lat - dLat, lon - dLon, lat + dLat, lon + dLon] },
            (name) => Deno.env.get(name),
            req.signal,
        );
        if (data.elements.length > 5000) {
            return corsResponse(JSON.stringify({ error: 'Complete seamark inventory exceeds bounds' }), 503);
        }
        const elements = data.elements;

        // Convert Overpass JSON → GeoJSON FeatureCollection with IALA classification
        const features = elements
            .filter(
                (el: { type: string; lat?: number; lon?: number }) =>
                    el.type === 'node' && el.lat !== undefined && el.lon !== undefined,
            )
            .map((el: { lat?: number; lon?: number; tags?: Record<string, string> }) => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [el.lon, el.lat],
                },
                properties: classifySeamark(el.tags || {}),
            }));

        const geojson = {
            type: 'FeatureCollection',
            features,
            metadata: {
                center: [lon, lat],
                radiusNM,
                sourceAt: data.thalassaSource.sourceAt,
                cohortSha256: data.thalassaSource.cohortSha256,
                licence: data.thalassaSource.licence,
                count: features.length,
            },
        };

        console.info(`[proxy-overpass] Found ${features.length} seamarks`);
        return corsResponse(JSON.stringify(geojson), 200);
    } catch {
        // Do not log upstream bodies, query positions, credentials or exception text.
        return corsResponse(JSON.stringify({ error: 'Owned seamark reference unavailable' }), 503);
    }
});
