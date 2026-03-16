// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * fetch-precip-grid — NOAA GFS Precipitation Rate GRIB2 CORS Proxy
 *
 * Fetches PRATE (instantaneous precipitation rate) at multiple forecast hours
 * from NOAA NOMADS GFS GRIB Filter, concatenates the binary responses, and
 * proxies them back to the client.
 *
 * Request: POST with JSON body:
 *   { north, south, east, west, hours?: number[] }
 *
 * Response: application/octet-stream (concatenated GRIB2 binary — one message per hour).
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    'Access-Control-Expose-Headers': 'X-GFS-Date, X-GFS-Cycle, X-Frames, X-Hours, X-Model',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ── GFS cycle logic ───────────────────────────────────────────

function getLatestGfsCycle(): { date: string; cycle: string } {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const cycles = [18, 12, 6, 0];
    let selectedCycle = 0;

    for (const c of cycles) {
        if (utcHour >= c + 5) {
            selectedCycle = c;
            break;
        }
    }

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

// ── HRRR cycle logic ──────────────────────────────────────────
// HRRR runs every hour. We want the latest available run (usually current UTC hour - 1).

function getLatestHrrrCycle(): { date: string; cycle: string } {
    const now = new Date();
    // HRRR is usually available ~1 hour after the cycle time
    const cycleDate = new Date(now.getTime() - 60 * 60 * 1000);

    const yyyy = cycleDate.getUTCFullYear();
    const mm = String(cycleDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cycleDate.getUTCDate()).padStart(2, '0');
    const cycle = String(cycleDate.getUTCHours()).padStart(2, '0');

    return {
        date: `${yyyy}${mm}${dd}`,
        cycle,
    };
}

// ── Longitude conversion ──────────────────────────────────────

function toNoaaLon(lon: number): number {
    if (lon <= -180) return 0;
    return lon < 0 ? lon + 360 : lon;
}

// ── Resolution selection ──────────────────────────────────────

function selectResolution(
    north: number,
    south: number,
    east: number,
    west: number,
): {
    filter: string;
    filePrefix: string;
    label: string;
} {
    const latSpan = Math.abs(north - south);
    let lonSpan = east - west;
    if (lonSpan <= 0) lonSpan += 360;
    const areaDeg2 = latSpan * lonSpan;

    if (areaDeg2 > 10_000) {
        return { filter: 'filter_gfs_1p00.pl', filePrefix: 'pgrb2.1p00', label: '1.00°' };
    }
    if (areaDeg2 > 2_500) {
        return { filter: 'filter_gfs_0p50.pl', filePrefix: 'pgrb2full.0p50', label: '0.50°' };
    }
    return { filter: 'filter_gfs_0p25.pl', filePrefix: 'pgrb2.0p25', label: '0.25°' };
}

// ── Default forecast hours ────────────────────────────────────

const DEFAULT_HOURS = [0, 3, 6, 9, 12, 18, 24, 36, 48, 72];

// ── Types ─────────────────────────────────────────────────────

interface PrecipRequest {
    north: number;
    south: number;
    east: number;
    west: number;
    hours?: number[];
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
        const body: PrecipRequest = await req.json();
        const { north, south, east, west } = body;
        const hours = body.hours ?? DEFAULT_HOURS;

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

        // Convert longitudes to 0-360 for NOAA GFS
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

        // ── REGIONAL ROUTING ──
        // Check if bounds intersect the Continental US (CONUS)
        // Approximate CONUS bounding box: Lat 24° to 50°, Lon -125° to -66°
        // Note: West is handled via 0-360 or -180 to 180.
        // If the map window overlaps the USA coast, we will use the 3km HRRR model!

        let normalizedWest = west > 180 ? west - 360 : west;
        let normalizedEast = east > 180 ? east - 360 : east;
        if (normalizedEast < normalizedWest) normalizedEast += 360; // handle wrap

        // Loose CONUS overlap check (allowing for coastal offshore regions)
        const isConus = south < 52 && north > 20 && normalizedWest < -60 && normalizedEast > -130;

        if (isConus) {
            const { date, cycle } = getLatestHrrrCycle();
            console.info(`[fetch-precip-grid] Routing to HRRR ${date}/${cycle}z (${hours.length} hours)`);

            // HRRR model limits: max forecast is usually 18h (except 00z/06z/12z/18z which go 48h)
            // For safety, we only fetch what HRRR provides, clamping the array.
            const isExtendedHrrr = [0, 6, 12, 18].includes(parseInt(cycle));
            const maxHrrrHour = isExtendedHrrr ? 48 : 18;
            const hrrrHours = hours.filter((h) => h <= maxHrrrHour);

            const fetches = hrrrHours.map(async (h) => {
                const fHour = String(h).padStart(2, '0'); // HRRR uses 2 digits for hours (e.g., f00, f18)
                const params = new URLSearchParams({
                    dir: `/hrrr.${date}/conus`,
                    file: `hrrr.t${cycle}z.wrfsfcf${fHour}.grib2`,
                    var_PRATE: 'on',
                    lev_surface: 'on',
                    subregion: '',
                    // HRRR native lon is -180 to 180 or 0-360.NOMADS HRRR subsetter uses -180 to 180.
                    leftlon: normalizedWest.toFixed(2),
                    rightlon: normalizedEast.toFixed(2),
                    toplat: north.toFixed(2),
                    bottomlat: south.toFixed(2),
                });

                const url = `https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl?${params.toString()}`;

                try {
                    const resp = await fetch(url);
                    if (!resp.ok) {
                        console.warn(`[fetch-precip-grid] HRRR f${fHour} failed: ${resp.status}`);
                        return null;
                    }
                    const buf = await resp.arrayBuffer();
                    if (buf.byteLength < 100) return null;
                    return buf;
                } catch (e) {
                    return null;
                }
            });

            // Fall through to the assembly logic below...
            const results = await Promise.all(fetches);
            const validBuffers = results.filter((b): b is ArrayBuffer => b !== null);

            if (validBuffers.length === 0) {
                // If HRRR fails (e.g. recent hour not fully uploaded), we should fallback to GFS/Open-Meteo
                // For now, return an error so the client knows it failed.
                return corsResponse(JSON.stringify({ error: 'No precipitation data available from NOAA HRRR' }), 502, {
                    'Content-Type': 'application/json',
                });
            }

            const totalSize = validBuffers.reduce((sum, b) => sum + b.byteLength, 0);
            const combined = new Uint8Array(totalSize);
            let offset = 0;
            for (const buf of validBuffers) {
                combined.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
            }

            return corsResponse(combined as unknown as BodyInit, 200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(combined.byteLength),
                'X-GFS-Date': date,
                'X-GFS-Cycle': `${cycle}z`,
                'X-Frames': String(validBuffers.length),
                'X-Model': 'HRRR',
                'X-Hours': hrrrHours.filter((_, i) => results[i] !== null).join(','),
            });
        }

        // ── GLOBAL FALLBACK: NOAA GFS 0.25° (subregion clipped via NOMADS GRIB Filter) ──
        // Covers everywhere outside CONUS: Europe, Australia, Asia, Africa, etc.
        // DWD ICON-EU (7km Europe) was evaluated but rejected: DWD only serves bz2-compressed
        // full-grid files (~20MB each) with no subregion clipping capability.
        // ECMWF Open Data was evaluated but rejected: full global GRIB2 files (~300MB each).
        // GFS 0.25° via NOMADS is the only free GRIB source with server-side subregion clipping.
        const gfs = getLatestGfsCycle();
        const { filter, filePrefix, label } = selectResolution(north, south, east, west);
        console.info(`[fetch-precip-grid] Routing to GFS ${label} ${gfs.date}/${gfs.cycle}z (${hours.length} hours)`);

        const gfsHours = hours.filter((h) => h <= 384); // GFS goes up to 384h

        const fetches = gfsHours.map(async (h) => {
            const fHour = String(h).padStart(3, '0');
            const params = new URLSearchParams({
                dir: `/gfs.${gfs.date}/${gfs.cycle}/atmos`,
                file: `gfs.t${gfs.cycle}z.${filePrefix}.f${fHour}`,
                var_PRATE: 'on',
                lev_surface: 'on',
                subregion: '',
                leftlon: leftLon.toFixed(2),
                rightlon: rightLon.toFixed(2),
                toplat: north.toFixed(2),
                bottomlat: south.toFixed(2),
            });

            const url = `https://nomads.ncep.noaa.gov/cgi-bin/${filter}?${params.toString()}`;

            try {
                const resp = await fetch(url);
                if (!resp.ok) {
                    console.warn(`[fetch-precip-grid] GFS f${fHour} failed: ${resp.status}`);
                    return null;
                }
                const buf = await resp.arrayBuffer();
                if (buf.byteLength < 100) return null;
                return buf;
            } catch (e) {
                return null;
            }
        });

        const results = await Promise.all(fetches);
        const validBuffers = results.filter((b): b is ArrayBuffer => b !== null);

        if (validBuffers.length === 0) {
            return corsResponse(JSON.stringify({ error: 'No precipitation data available from NOAA GFS' }), 502, {
                'Content-Type': 'application/json',
            });
        }

        const totalSize = validBuffers.reduce((sum, b) => sum + b.byteLength, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const buf of validBuffers) {
            combined.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }

        return corsResponse(combined as unknown as BodyInit, 200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(combined.byteLength),
            'X-GFS-Date': gfs.date,
            'X-GFS-Cycle': `${gfs.cycle}z`,
            'X-Frames': String(validBuffers.length),
            'X-Model': 'GFS',
            'X-Hours': gfsHours.filter((_, i) => results[i] !== null).join(','),
        });
    } catch (err: unknown) {
        console.error('[fetch-precip-grid] Error:', err.message, err.stack);
        return corsResponse(JSON.stringify({ error: err.message || String(err), stack: err.stack }), 500, {
            'Content-Type': 'application/json',
        });
    }
});
