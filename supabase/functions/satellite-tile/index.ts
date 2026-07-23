// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    hasPngSignature,
    parseBoundedInteger,
    parseBoundedNumber,
    parseCoordinate,
    readResponseArrayBufferLimited,
} from '../_shared/http-security.ts';

/**
 * satellite-tile — Satellite IR Tile Proxy
 *
 * Proxies near-real-time infrared satellite tiles from:
 *   - NASA GIBS: Himawari-9, GOES-East, GOES-West (individual)
 *   - NOAA nowCOAST: GMGSI global composite (all geostationary sats blended)
 *   - SSEC RealEarth: globalir-avn (pre-enhanced Dvorak IR global composite)
 *
 * GET /satellite-tile?sat=himawari&x=29&y=17&z=5
 *   → Returns Himawari Band 13 Clean IR tile from NASA GIBS
 *
 * GET /satellite-tile?sat=gmgsi&x=29&y=17&z=5
 *   → Returns GMGSI global composite IR tile from NOAA nowCOAST
 *
 * GET /satellite-tile?sat=ssec-ir&x=29&y=17&z=5
 *   → Returns SSEC RealEarth globalir-avn (pre-enhanced Dvorak IR)
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SATELLITE_LAYERS: Record<string, { type: 'gibs' | 'nowcoast' | 'ssec'; layer: string; sublayer?: number }> = {
    himawari: { type: 'gibs', layer: 'Himawari_AHI_Band13_Clean_Infrared' },
    'goes-west': { type: 'gibs', layer: 'GOES-West_ABI_Band13_Clean_Infrared' },
    'goes-east': { type: 'gibs', layer: 'GOES-East_ABI_Band13_Clean_Infrared' },
    gmgsi: { type: 'nowcoast', layer: 'sat_meteo_imagery_time', sublayer: 9 },
    'ssec-ir': { type: 'ssec', layer: 'globalir-avn' },
};

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'GET required' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'satellite_tile', 6000, 3000, 3600, true);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const url = new URL(req.url);
        const satParam = url.searchParams.get('sat') || 'gmgsi';
        const config = SATELLITE_LAYERS[satParam];
        if (!config) {
            return new Response(JSON.stringify({ error: 'Invalid satellite source' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        const xParam = url.searchParams.get('x');
        const yParam = url.searchParams.get('y');
        const zParam = url.searchParams.get('z') || url.searchParams.get('zoom') || '5';

        // GIBS max zoom is 6, SSEC max 7, nowcoast max 8
        const maxZoom = config.type === 'gibs' ? 6 : config.type === 'ssec' ? 7 : 8;
        const zoom = parseBoundedInteger(zParam, 0, maxZoom);
        if (zoom === null) {
            return new Response(JSON.stringify({ error: 'Invalid zoom' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        let xTile: number;
        let yTile: number;

        if (xParam !== null && yParam !== null) {
            const maxTile = 2 ** zoom - 1;
            const parsedX = parseBoundedInteger(xParam, 0, maxTile);
            const parsedY = parseBoundedInteger(yParam, 0, maxTile);
            if (parsedX === null || parsedY === null) {
                return new Response(JSON.stringify({ error: 'Invalid tile coordinates' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }
            xTile = parsedX;
            yTile = parsedY;
        } else {
            // Fallback: convert lat/lon to tile coords
            const lat = parseBoundedNumber(url.searchParams.get('lat') ?? '-27.20', -85.0511, 85.0511);
            const lon = parseCoordinate(url.searchParams.get('lon') ?? '153.10', 'lon');
            if (lat === null || lon === null) {
                return new Response(JSON.stringify({ error: 'Invalid coordinates' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }
            const n = Math.pow(2, zoom);
            xTile = Math.floor(((lon + 180) / 360) * n);
            yTile = Math.floor(
                ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
                    n,
            );
        }

        let imageBody: ArrayBuffer;
        let usedDate = '';

        if (config.type === 'ssec') {
            // ── SSEC RealEarth (pre-enhanced Dvorak IR) ──
            const tileUrl = `https://realearth.ssec.wisc.edu/tiles/${config.layer}/${zoom}/${xTile}/${yTile}.png`;
            const res = await fetchWithTimeout(
                tileUrl,
                { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } },
                10_000,
            );
            if (!res.ok) throw new Error(`SSEC: ${res.status}`);
            const body = await readResponseArrayBufferLimited(res, 2_000_000);
            if (!body) throw new Error('SSEC tile exceeded byte limit');
            imageBody = body;
            usedDate = new Date().toISOString().split('T')[0];
        } else if (config.type === 'nowcoast') {
            // ── NOAA nowCOAST ArcGIS export (GMGSI global composite) ──
            const n = Math.pow(2, zoom);
            const lon1 = (xTile / n) * 360 - 180;
            const lon2 = ((xTile + 1) / n) * 360 - 180;
            const lat1Rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (yTile + 1)) / n)));
            const lat2Rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yTile) / n)));
            const lat1 = (lat1Rad * 180) / Math.PI;
            const lat2 = (lat2Rad * 180) / Math.PI;

            const toMerc = (lonDeg: number, latDeg: number) => {
                const mx = (lonDeg * 20037508.34) / 180;
                const my =
                    ((Math.log(Math.tan(((90 + latDeg) * Math.PI) / 360)) / (Math.PI / 180)) * 20037508.34) / 180;
                return { x: mx, y: my };
            };
            const bl = toMerc(lon1, lat1);
            const tr = toMerc(lon2, lat2);

            const exportUrl =
                `https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/${config.layer}/MapServer/export` +
                `?bbox=${bl.x},${bl.y},${tr.x},${tr.y}` +
                `&bboxSR=3857&imageSR=3857` +
                `&size=256,256` +
                `&format=png32` +
                `&transparent=true` +
                `&layers=show:${config.sublayer}` +
                `&f=image`;

            const res = await fetchWithTimeout(
                exportUrl,
                { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } },
                10_000,
            );
            if (!res.ok) throw new Error(`nowCOAST: ${res.status}`);
            const body = await readResponseArrayBufferLimited(res, 2_000_000);
            if (!body) throw new Error('nowCOAST tile exceeded byte limit');
            imageBody = body;
            usedDate = new Date().toISOString().split('T')[0];
        } else {
            // ── NASA GIBS (individual satellites) ──
            const base = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';
            const params = new URLSearchParams({
                Service: 'WMTS',
                Request: 'GetTile',
                Version: '1.0.0',
                Layer: config.layer,
                Style: 'default',
                TileMatrixSet: 'GoogleMapsCompatible_Level6',
                TileMatrix: String(zoom),
                TileRow: String(yTile),
                TileCol: String(xTile),
                Format: 'image/png',
            }).toString();

            // Try today, yesterday, day-before (GIBS can lag ~40min)
            const dates: string[] = [];
            for (let d = 0; d < 3; d++) {
                dates.push(new Date(Date.now() - d * 86400000).toISOString().split('T')[0]);
            }

            for (const dateStr of dates) {
                try {
                    const res = await fetchWithTimeout(
                        `${base}?${params}&Time=${dateStr}`,
                        { headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' } },
                        10_000,
                    );
                    if (res.ok) {
                        const body = await readResponseArrayBufferLimited(res, 2_000_000);
                        if (!body) throw new Error('GIBS tile exceeded byte limit');
                        imageBody = body;
                        usedDate = dateStr;
                        break;
                    }
                    // Consume body to avoid connection leak
                    await res.body?.cancel().catch(() => {});
                    if (res.status !== 404) {
                        console.error(`[satellite-tile] GIBS ${dateStr}: ${res.status}`);
                    }
                } catch (err) {
                    console.error(`[satellite-tile] GIBS fetch error ${dateStr}:`, err);
                }
            }

            if (!imageBody!) {
                throw new Error(`No tiles from GIBS for ${config.layer} (tried ${dates.join(', ')})`);
            }
        }

        if (!hasPngSignature(imageBody)) throw new Error('Upstream returned a non-PNG tile');

        return new Response(imageBody, {
            status: 200,
            headers: {
                ...CORS,
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=600',
                'X-Satellite-Date': usedDate,
                'X-Satellite-Source': satParam,
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        console.error('[satellite-tile] Error:', (error as Error).message);
        return new Response(JSON.stringify({ error: 'Satellite tile fetch failed' }), {
            status: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
});
