// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * fetch-wind-velocity — Server-side GRIB2 → Velocity JSON for ih-leaflet-velocity-ts
 *
 * Fetches 10m U/V wind from NOAA GFS, decodes the GRIB2 binary server-side,
 * and returns the pre-formatted velocity JSON array ready for Leaflet.
 *
 * This minimizes bandwidth for offline/satellite scenarios — the client
 * receives ~50-150KB of compressed JSON instead of raw GRIB2.
 *
 * Request: POST with JSON body:
 *   { north, south, east, west }
 *
 * Response: JSON array of two objects [{ header, data: number[] }, { header, data: number[] }]
 *   — first object is U-component (UGRD), second is V-component (VGRD).
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
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

// ── Longitude conversion ──────────────────────────────────────

function toNoaaLon(lon: number): number {
    if (lon <= -180) return 0;
    return lon < 0 ? lon + 360 : lon;
}

function normLon(lon: number): number {
    return lon > 180 ? lon - 360 : lon;
}

// ── Resolution selection ──────────────────────────────────────

function selectResolution(north: number, south: number, east: number, west: number) {
    const latSpan = Math.abs(north - south);
    let lonSpan = east - west;
    if (lonSpan <= 0) lonSpan += 360;
    const areaDeg2 = latSpan * lonSpan;

    if (areaDeg2 > 10_000) {
        return { filter: 'filter_gfs_1p00.pl', file: 'pgrb2.1p00.f000', label: '1.00°' };
    }
    if (areaDeg2 > 2_500) {
        return { filter: 'filter_gfs_0p50.pl', file: 'pgrb2full.0p50.f000', label: '0.50°' };
    }
    return { filter: 'filter_gfs_0p25.pl', file: 'pgrb2.0p25.f000', label: '0.25°' };
}

// ══════════════════════════════════════════════════════════════
// GRIB2 DECODER — Pure TypeScript, zero dependencies
// Adapted from decodeGrib2Wind.ts for Deno edge function use.
// Handles GFS simple packing (Data Representation Template 5.0).
// ══════════════════════════════════════════════════════════════

const GRIB_MAGIC = 0x47524942; // "GRIB"

/** Read a GRIB2 sign-magnitude int32 (high bit = sign, rest = magnitude).
 *  GRIB2 lat/lon values use this encoding, NOT two's complement. */
function getSignedGrib(dv: DataView, offset: number): number {
    const raw = dv.getUint32(offset);
    if (raw & 0x80000000) {
        // Negative: strip sign bit, negate
        return -(raw & 0x7fffffff);
    }
    return raw;
}

function extractBits(dv: DataView, byteOffset: number, totalBits: number, bitsPerValue: number): number[] {
    const count = Math.floor(totalBits / bitsPerValue);
    const values: number[] = new Array(count);
    let bitPos = 0;
    for (let i = 0; i < count; i++) {
        let val = 0;
        for (let b = bitsPerValue - 1; b >= 0; b--) {
            const absPos = bitPos++;
            const byteIdx = byteOffset + (absPos >>> 3);
            const bitIdx = 7 - (absPos & 7);
            if ((dv.getUint8(byteIdx) >>> bitIdx) & 1) {
                val |= 1 << b;
            }
        }
        values[i] = val;
    }
    return values;
}

interface GridMessage {
    data: Float32Array;
    nx: number;
    ny: number;
    lat1: number;
    lat2: number;
    lon1: number;
    lon2: number;
    dx: number;
    dy: number;
}

function parseGrib2Message(buf: ArrayBuffer, offset: number): { msg: GridMessage; nextOffset: number } {
    const dv = new DataView(buf);

    // Section 0 — Indicator
    const magic = dv.getUint32(offset);
    if (magic !== GRIB_MAGIC) throw new Error(`Not GRIB2 at offset ${offset}`);
    const totalLen = Number(dv.getBigUint64(offset + 8));
    let pos = offset + 16;

    let nx = 0,
        ny = 0;
    let lat1 = 0,
        lat2 = 0,
        lon1 = 0,
        lon2 = 0;
    let dx = 0,
        dy = 0;
    let R = 0,
        E = 0,
        D = 0,
        bitsPerVal = 0;
    let numPoints = 0;
    let data = new Float32Array(0);

    while (pos < offset + totalLen - 4) {
        const secLen = dv.getUint32(pos);
        const secNum = dv.getUint8(pos + 4);

        // End marker "7777"
        if (secLen === 0x37373737) break;

        switch (secNum) {
            case 3: {
                // Grid Definition Section — Template 3.0 (Lat/Lon)
                numPoints = dv.getUint32(pos + 6);
                nx = dv.getUint32(pos + 30);
                ny = dv.getUint32(pos + 34);
                // La1/Lo1 — use sign-magnitude decoder (GRIB2 spec)
                lat1 = getSignedGrib(dv, pos + 46) / 1e6;
                lon1 = getSignedGrib(dv, pos + 50) / 1e6;

                // La2/Lo2 byte offsets are unreliable in some GRIB2 encoders.
                // Strategy: try standard offset, then +1, then infer from grid dims.
                let la2Raw = getSignedGrib(dv, pos + 55) / 1e6;
                let lo2Raw = getSignedGrib(dv, pos + 59) / 1e6;

                // Try +1 byte offset if standard fails
                if (Math.abs(la2Raw) > 90.001) {
                    la2Raw = getSignedGrib(dv, pos + 56) / 1e6;
                    lo2Raw = getSignedGrib(dv, pos + 60) / 1e6;
                }

                const la2Valid = Math.abs(la2Raw) <= 90.001;
                const lo2Valid = lo2Raw > 0 && lo2Raw <= 360.001;

                if (la2Valid && lo2Valid) {
                    lat2 = la2Raw;
                    lon2 = lo2Raw;
                } else {
                    // Infer from grid dimensions
                    const dLat = nx > 1 && ny > 1 ? 180.0 / (ny - 1) : 1.0;
                    const dLon = nx > 1 ? 360.0 / nx : 1.0;
                    lat2 = la2Valid ? la2Raw : lat1 - (ny - 1) * dLat;
                    lon2 = lo2Valid ? lo2Raw : lon1 + (nx - 1) * dLon;
                }

                // Extract dx/dy — try standard offsets, fall back to inference
                const dxRaw = dv.getUint32(pos + 63) / 1e6;
                const dyRaw = dv.getUint32(pos + 67) / 1e6;
                dx = dxRaw > 0 && dxRaw < 10 ? dxRaw : Math.abs(lon2 - lon1) / Math.max(nx - 1, 1);
                dy = dyRaw > 0 && dyRaw < 10 ? dyRaw : Math.abs(lat1 - lat2) / Math.max(ny - 1, 1);
                break;
            }
            case 5: {
                // Data Representation Section — Template 5.0 (Simple Packing)
                const refBytes = new Uint8Array(buf, pos + 11, 4);
                const refDv = new DataView(refBytes.buffer.slice(refBytes.byteOffset, refBytes.byteOffset + 4));
                R = refDv.getFloat32(0);
                E = dv.getInt16(pos + 15);
                D = dv.getInt16(pos + 17);
                bitsPerVal = dv.getUint8(pos + 19);
                break;
            }
            case 7: {
                // Data Section — unpack: Y = (R + packed × 2^E) / 10^D
                if (bitsPerVal === 0) {
                    data = new Float32Array(numPoints).fill(R / Math.pow(10, D));
                } else {
                    const dataStart = pos + 5;
                    const dataBits = (secLen - 5) * 8;
                    const packed = extractBits(dv, dataStart, dataBits, bitsPerVal);
                    const factor2E = Math.pow(2, E);
                    const factor10D = Math.pow(10, D);
                    data = new Float32Array(packed.length);
                    for (let i = 0; i < packed.length; i++) {
                        data[i] = (R + packed[i] * factor2E) / factor10D;
                    }
                }
                break;
            }
        }
        pos += secLen;
    }

    return {
        msg: { data, nx, ny, lat1, lat2, lon1, lon2, dx, dy },
        nextOffset: offset + totalLen,
    };
}

/** Parse GRIB2 buffer with two messages (UGRD, VGRD) into velocity JSON */
function grib2ToVelocityJson(buf: ArrayBuffer, refTime: string) {
    const { msg: uMsg, nextOffset } = parseGrib2Message(buf, 0);
    const { msg: vMsg } = parseGrib2Message(buf, nextOffset);

    // leaflet-velocity-ts expects la1 = north, scanning top→bottom.
    // NOAA subregion requests may return la1 = south (bottom→top scan).
    // If so, flip the data rows so la1 is always the northern latitude.
    function normalizeGrid(msg: GridMessage): { data: number[]; north: number; south: number } {
        if (msg.lat1 < msg.lat2) {
            // South-to-north scan — reverse rows
            const flipped = new Float32Array(msg.data.length);
            for (let y = 0; y < msg.ny; y++) {
                const srcRow = y * msg.nx;
                const dstRow = (msg.ny - 1 - y) * msg.nx;
                for (let x = 0; x < msg.nx; x++) {
                    flipped[dstRow + x] = msg.data[srcRow + x];
                }
            }
            return { data: Array.from(flipped), north: msg.lat2, south: msg.lat1 };
        }
        // Already north-to-south — use as-is
        return { data: Array.from(msg.data), north: msg.lat1, south: msg.lat2 };
    }

    const uNorm = normalizeGrid(uMsg);
    const vNorm = normalizeGrid(vMsg);

    return [
        {
            header: {
                parameterCategory: 2,
                parameterNumber: 2, // UGRD
                la1: uNorm.north,
                lo1: normLon(uMsg.lon1),
                la2: uNorm.south,
                lo2: normLon(uMsg.lon2),
                dx: uMsg.dx,
                dy: uMsg.dy,
                nx: uMsg.nx,
                ny: uMsg.ny,
                refTime,
                forecastTime: 0,
            },
            data: uNorm.data,
        },
        {
            header: {
                parameterCategory: 2,
                parameterNumber: 3, // VGRD
                la1: vNorm.north,
                lo1: normLon(vMsg.lon1),
                la2: vNorm.south,
                lo2: normLon(vMsg.lon2),
                dx: vMsg.dx,
                dy: vMsg.dy,
                nx: vMsg.nx,
                ny: vMsg.ny,
                refTime,
                forecastTime: 0,
            },
            data: vNorm.data,
        },
    ];
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

interface VelocityRequest {
    north: number;
    south: number;
    east: number;
    west: number;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return corsResponse(null, 204);
    }

    try {
        let north: number, south: number, east: number, west: number;

        if (req.method === 'GET') {
            // GET: ?lat=-24.5&lon=159.5&radius=10
            const url = new URL(req.url);
            const lat = parseFloat(url.searchParams.get('lat') || '');
            const lon = parseFloat(url.searchParams.get('lon') || '');
            const radius = parseFloat(url.searchParams.get('radius') || '15');

            if (isNaN(lat) || isNaN(lon)) {
                return corsResponse(JSON.stringify({ error: 'Missing lat/lon query params' }), 400, {
                    'Content-Type': 'application/json',
                });
            }

            north = lat + radius;
            south = lat - radius;
            east = lon + radius;
            west = lon - radius;
        } else if (req.method === 'POST') {
            // POST: { north, south, east, west }
            const body: VelocityRequest = await req.json();
            north = body.north;
            south = body.south;
            east = body.east;
            west = body.west;
        } else {
            return corsResponse(JSON.stringify({ error: 'GET or POST required' }), 405, {
                'Content-Type': 'application/json',
            });
        }

        if (
            typeof north !== 'number' ||
            typeof south !== 'number' ||
            typeof east !== 'number' ||
            typeof west !== 'number' ||
            isNaN(north) ||
            isNaN(south) ||
            isNaN(east) ||
            isNaN(west)
        ) {
            return corsResponse(JSON.stringify({ error: 'Invalid bounds' }), 400, {
                'Content-Type': 'application/json',
            });
        }

        // Convert longitudes to NOAA 0-360 format
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

        const params = new URLSearchParams({
            dir: `/gfs.${date}/${cycle}/atmos`,
            file: `gfs.t${cycle}z.${res.file}`,
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
        console.info(`[fetch-wind-velocity] GFS ${date}/${cycle}z @ ${res.label} → ${noaaUrl}`);

        // Fetch raw GRIB2 from NOAA
        const upstream = await fetch(noaaUrl);

        if (!upstream.ok) {
            const errText = await upstream.text();
            console.error(`[fetch-wind-velocity] NOAA error ${upstream.status}: ${errText}`);
            return corsResponse(
                JSON.stringify({
                    error: `NOAA NOMADS returned ${upstream.status}`,
                    detail: errText.substring(0, 500),
                }),
                502,
                { 'Content-Type': 'application/json' },
            );
        }

        const gribData = await upstream.arrayBuffer();

        // Guard against empty/HTML error responses
        if (gribData.byteLength < 200) {
            const text = new TextDecoder().decode(gribData);
            console.error(`[fetch-wind-velocity] Tiny response (${gribData.byteLength}B): ${text}`);
            return corsResponse(
                JSON.stringify({ error: 'NOAA returned empty or invalid data', detail: text.substring(0, 300) }),
                502,
                { 'Content-Type': 'application/json' },
            );
        }

        // ── Server-side GRIB2 decode → Velocity JSON ──
        const refTime = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${cycle}:00:00Z`;
        const velocityJson = grib2ToVelocityJson(gribData, refTime);

        const jsonStr = JSON.stringify(velocityJson);
        const sizeKB = (jsonStr.length / 1024).toFixed(1);

        console.info(
            `[fetch-wind-velocity] Decoded ${gribData.byteLength}B GRIB2 → ${sizeKB}KB JSON ` +
                `(${velocityJson[0].data.length} points, GFS ${date}/${cycle}z @ ${res.label})`,
        );

        return corsResponse(jsonStr, 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            'X-GFS-Date': date,
            'X-GFS-Cycle': `${cycle}z`,
            'X-Grid-Resolution': res.label,
            'X-Grid-Points': String(velocityJson[0].data.length),
            'X-Bounds': `${south},${north},${west},${east}`,
        });
    } catch (err) {
        console.error('[fetch-wind-velocity] Error:', err);
        return corsResponse(JSON.stringify({ error: String(err) }), 500, { 'Content-Type': 'application/json' });
    }
});
