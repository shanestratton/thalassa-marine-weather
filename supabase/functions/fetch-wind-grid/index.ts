// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * fetch-wind-grid — NOAA GFS GRIB2 CORS Proxy
 *
 * Accepts a bounding box via POST, builds a NOAA NOMADS GFS GRIB Filter URL
 * for 10m U/V wind components, fetches the raw GRIB2 binary, and proxies it
 * back to the client with CORS headers.
 *
 * Single upstream request — no per-cell loops, no rate limits.
 *
 * Request: POST with JSON body:
 *   { north, south, east, west }
 *
 * Response: application/octet-stream (raw GRIB2 binary).
 *
 * Client must decode the GRIB2 response (e.g. using grib2-simple or a
 * custom DataView decoder).
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Access-Control-Expose-Headers': 'X-GFS-Date, X-GFS-Cycle, X-Frames, X-Hours, X-Bounds',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ── GFS cycle logic ───────────────────────────────────────────

/**
 * Calculate the latest available GFS run.
 * GFS publishes 4×/day at 00z, 06z, 12z, 18z.
 * Data becomes available ~4.5h after cycle time,
 * so we pick the most recent cycle that is at least 5h old.
 */
function getLatestGfsCycle(): { date: string; cycle: string } {
    const now = new Date();
    const utcHour = now.getUTCHours();

    // Available cycles in reverse order
    const cycles = [18, 12, 6, 0];
    let selectedCycle = 0;

    for (const c of cycles) {
        // Cycle is available if current UTC hour is at least cycle + 5
        if (utcHour >= c + 5) {
            selectedCycle = c;
            break;
        }
    }

    // If no cycle from today is ready yet (utcHour < 5), use yesterday's 18z
    let cycleDate = now;
    if (utcHour < 5) {
        selectedCycle = 18;
        cycleDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    const yyyy = cycleDate.getUTCFullYear();
    const mm = String(cycleDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cycleDate.getUTCDate()).padStart(2, '0');

    return {
        date: `${yyyy}${mm}${dd}`,
        cycle: String(selectedCycle).padStart(2, '0'),
    };
}

// ── Longitude conversion ──────────────────────────────────────

/** Convert -180..180 longitude to NOAA's 0..360 format. */
function toNoaaLon(lon: number): number {
    // -180 should map to 0, not 360 (avoids leftlon=rightlon=180 for global requests)
    if (lon <= -180) return 0;
    return lon < 0 ? lon + 360 : lon;
}

// ── Resolution selection ──────────────────────────────────────

/** Pick the GFS grid resolution based on requested area size. */
function selectResolution(
    north: number,
    south: number,
    east: number,
    west: number,
): {
    filter: string;
    fileBase: string;
    label: string;
} {
    const latSpan = Math.abs(north - south);
    let lonSpan = east - west;
    if (lonSpan <= 0) lonSpan += 360; // handle antimeridian wrap
    const areaDeg2 = latSpan * lonSpan;

    if (areaDeg2 > 10_000) {
        return { filter: 'filter_gfs_1p00.pl', fileBase: 'pgrb2.1p00', label: '1.00°' };
    }
    if (areaDeg2 > 2_500) {
        return { filter: 'filter_gfs_0p50.pl', fileBase: 'pgrb2full.0p50', label: '0.50°' };
    }
    return { filter: 'filter_gfs_0p25.pl', fileBase: 'pgrb2.0p25', label: '0.25°' };
}

// ── Types ─────────────────────────────────────────────────────

// ── Forecast hours to fetch ───────────────────────────────────

const FORECAST_HOURS = [0, 3, 6, 9, 12, 18, 24, 36, 48, 72];

// ── Types ─────────────────────────────────────────────────────

interface WindRequest {
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return corsResponse(null, 204);
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405, { 'Content-Type': 'application/json' });
    }

    try {
        const body: WindRequest = await req.json();
        const { north, south, east, west } = body;

        if (
            typeof north !== 'number' ||
            typeof south !== 'number' ||
            typeof east !== 'number' ||
            typeof west !== 'number'
        ) {
            return corsResponse(JSON.stringify({ error: 'Missing bounds (north, south, east, west)' }), 400, {
                'Content-Type': 'application/json',
            });
        }

        const lonSpan = east - west;
        let leftLon: number;
        let rightLon: number;

        if (lonSpan >= 360) {
            leftLon = 0;
            rightLon = 360;
        } else {
            leftLon = toNoaaLon(west);
            rightLon = toNoaaLon(east);
            if (rightLon <= leftLon) rightLon += 360;
        }

        const { date, cycle } = getLatestGfsCycle();
        const res = selectResolution(north, south, east, west);

        // Fetch all forecast hours in parallel
        const fetchPromises = FORECAST_HOURS.map(async (fhr) => {
            const fhrStr = String(fhr).padStart(3, '0');
            const params = new URLSearchParams({
                dir: `/gfs.${date}/${cycle}/atmos`,
                file: `gfs.t${cycle}z.${res.fileBase}.f${fhrStr}`,
                var_UGRD: 'on',
                var_VGRD: 'on',
                lev_10_m_above_ground: 'on',
                subregion: '',
                leftlon: leftLon.toFixed(2),
                rightlon: rightLon.toFixed(2),
                toplat: north.toFixed(2),
                bottomlat: south.toFixed(2),
            });

            const noaaUrl = `https://nomads.ncep.noaa.gov/cgi-bin/${res.filter}?${params.toString()}`;
            console.info(`[fetch-wind-grid] f${fhrStr}: ${noaaUrl}`);

            try {
                const upstream = await fetch(noaaUrl);
                if (!upstream.ok) {
                    console.warn(`[fetch-wind-grid] f${fhrStr}: NOAA returned ${upstream.status}`);
                    return null;
                }
                const buf = await upstream.arrayBuffer();
                if (buf.byteLength < 200) {
                    console.warn(`[fetch-wind-grid] f${fhrStr}: too small (${buf.byteLength}B)`);
                    return null;
                }
                return new Uint8Array(buf);
            } catch (err) {
                console.warn(`[fetch-wind-grid] f${fhrStr}: fetch failed:`, err);
                return null;
            }
        });

        const results = await Promise.all(fetchPromises);
        const validChunks: Uint8Array[] = [];
        const validHours: number[] = [];

        for (let i = 0; i < results.length; i++) {
            if (results[i]) {
                validChunks.push(results[i]!);
                validHours.push(FORECAST_HOURS[i]);
            }
        }

        if (validChunks.length === 0) {
            return corsResponse(JSON.stringify({ error: 'No valid GRIB data from NOAA' }), 502, {
                'Content-Type': 'application/json',
            });
        }

        // Concatenate all valid chunks
        const totalSize = validChunks.reduce((sum, c) => sum + c.byteLength, 0);
        const concatenated = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of validChunks) {
            concatenated.set(chunk, offset);
            offset += chunk.byteLength;
        }

        console.info(
            `[fetch-wind-grid] ${validChunks.length}/${FORECAST_HOURS.length} hours, ` +
                `${totalSize} bytes (GFS ${date}/${cycle}z @ ${res.label})`,
        );

        return corsResponse(concatenated as unknown as BodyInit, 200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(totalSize),
            'X-GFS-Date': date,
            'X-GFS-Cycle': `${cycle}z`,
            'X-Frames': String(validChunks.length),
            'X-Hours': validHours.join(','),
            'X-Bounds': `${south},${north},${west},${east}`,
        });
    } catch (err) {
        console.error('[fetch-wind-grid] Error:', err);
        return corsResponse(JSON.stringify({ error: String(err) }), 500, { 'Content-Type': 'application/json' });
    }
});
