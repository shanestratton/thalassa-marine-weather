// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

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

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// NM → metres
const NM_TO_M = 1852;

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
    if (seamarkType.includes('rock') || seamarkType.includes('wreck') || seamarkType.includes('obstruction'))
        return 'danger';
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

    try {
        const { lat, lon, radiusNM = 5 } = await req.json();

        if (typeof lat !== 'number' || typeof lon !== 'number') {
            return corsResponse(JSON.stringify({ error: 'lat and lon are required numbers' }), 400);
        }

        // Clamp radius to prevent abuse (max 15 NM = ~28 km)
        const radiusM = Math.min(radiusNM, 15) * NM_TO_M;

        // Build Overpass QL query — fetch all seamark nodes within radius
        const query = `
[out:json][timeout:20];
node["seamark:type"](around:${radiusM},${lat},${lon});
out body;
`;

        console.info(
            `[proxy-overpass] Fetching seamarks within ${radiusNM}NM of [${lat.toFixed(3)}, ${lon.toFixed(3)}]`,
        );

        const res = await fetch(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`,
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`[proxy-overpass] Overpass error ${res.status}:`, text);
            return corsResponse(
                JSON.stringify({
                    error: `Overpass API returned ${res.status}`,
                    detail: text.slice(0, 500),
                }),
                502,
            );
        }

        const data = await res.json();
        const elements = data.elements || [];

        // Convert Overpass JSON → GeoJSON FeatureCollection with IALA classification
        const features = elements
            .filter((el: any) => el.type === 'node' && el.lat !== undefined && el.lon !== undefined)
            .map((el: any) => ({
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
                fetchedAt: new Date().toISOString(),
                count: features.length,
            },
        };

        console.info(`[proxy-overpass] Found ${features.length} seamarks`);
        return corsResponse(JSON.stringify(geojson), 200);
    } catch (e) {
        console.error('[proxy-overpass] Error:', e);
        return corsResponse(JSON.stringify({ error: 'Internal proxy error' }), 500);
    }
});
