// deno-lint-ignore-file
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * fetch-pressure-grid — NOAA GFS Pressure Grid (server-decoded)
 *
 * Fetches PRMSL (Pressure Reduced to Mean Sea Level) GRIB2 from NOAA NOMADS,
 * decodes the binary server-side, and returns a clean JSON grid.
 * This avoids client-side GRIB2 parsing issues entirely.
 *
 * Request: POST { north, south, east, west, hours?: number[] }
 * Response: JSON { frames: [{ pressure: number[], width, height, north, south, east, west }], lats, lons }
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

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
    return { date: `${yyyy}${mm}${dd}`, cycle: String(selectedCycle).padStart(2, '0') };
}

function toNoaaLon(lon: number): number {
    if (lon <= -180) return 0;
    return lon < 0 ? lon + 360 : lon;
}

// ── GRIB2 Binary Decoder (server-side) ────────────────────────

const GRIB_MAGIC = 0x47524942;

function extractBitsServer(data: DataView, byteOffset: number, totalBits: number, bitsPerValue: number): number[] {
    const values: number[] = [];
    let bitPos = 0;
    const count = Math.floor(totalBits / bitsPerValue);
    for (let i = 0; i < count; i++) {
        let value = 0;
        let bitsLeft = bitsPerValue;
        const startBit = bitPos;
        while (bitsLeft > 0) {
            const byteIdx = byteOffset + Math.floor((startBit + (bitsPerValue - bitsLeft)) / 8);
            const bitIdx = (startBit + (bitsPerValue - bitsLeft)) % 8;
            const available = 8 - bitIdx;
            const take = Math.min(bitsLeft, available);
            if (byteIdx >= data.byteLength) break;
            const mask = ((1 << take) - 1) << (available - take);
            const bits = (data.getUint8(byteIdx) & mask) >> (available - take);
            value = (value << take) | bits;
            bitsLeft -= take;
        }
        values.push(value);
        bitPos += bitsPerValue;
    }
    return values;
}

interface DecodedFrame {
    pressure: number[]; // hPa values, row-major N→S, W→E
    width: number; // Ni = longitude count
    height: number; // Nj = latitude count
    lat1: number; // First latitude (typically north)
    lat2: number; // Last latitude (typically south)
    lon1: number; // First longitude (west)
    lon2: number; // Last longitude (east)
}

function decodeGrib2PressureServer(buffer: ArrayBuffer): DecodedFrame[] {
    const view = new DataView(buffer);
    const frames: DecodedFrame[] = [];
    let offset = 0;

    while (offset < buffer.byteLength - 16) {
        const magic = view.getUint32(offset, false);
        if (magic !== GRIB_MAGIC) {
            offset++;
            continue;
        }

        const lenHi = view.getUint32(offset + 8, false);
        const lenLo = view.getUint32(offset + 12, false);
        const totalLength = lenHi > 0 ? lenHi * 0x100000000 + lenLo : lenLo;

        let pos = offset + 16;
        let width = 0,
            height = 0;
        let la1 = 0,
            la2 = 0,
            lo1 = 0,
            lo2 = 0;
        let refValue = 0,
            binaryScale = 0,
            decimalScale = 0,
            bitsPerValue = 0;
        let packedData: number[] = [];
        const endOfMessage = offset + totalLength;

        while (pos < endOfMessage - 4) {
            if (
                view.getUint8(pos) === 0x37 &&
                view.getUint8(pos + 1) === 0x37 &&
                view.getUint8(pos + 2) === 0x37 &&
                view.getUint8(pos + 3) === 0x37
            )
                break;

            const sectionLength = view.getUint32(pos, false);
            const sectionNum = view.getUint8(pos + 4);
            if (sectionLength < 5 || pos + sectionLength > endOfMessage) break;

            if (sectionNum === 3) {
                width = view.getUint32(pos + 30, false);
                height = view.getUint32(pos + 34, false);
                la1 = view.getInt32(pos + 46, false) / 1e6;
                lo1 = view.getInt32(pos + 50, false) / 1e6;
                // La2 at octet 56 (offset 55), Lo2 at octet 60 (offset 59)
                la2 = view.getInt32(pos + 55, false) / 1e6;
                lo2 = view.getInt32(pos + 59, false) / 1e6;
                // Sanity check La2
                if (Math.abs(la2) > 90.001) {
                    la2 = view.getInt32(pos + 56, false) / 1e6;
                    lo2 = view.getInt32(pos + 60, false) / 1e6;
                }
                console.info(`[GRIB2-Server] Grid ${width}×${height}: La1=${la1} Lo1=${lo1} La2=${la2} Lo2=${lo2}`);
            }

            if (sectionNum === 5) {
                refValue = view.getFloat32(pos + 11, false);
                binaryScale = view.getInt16(pos + 15, false);
                decimalScale = view.getInt16(pos + 17, false);
                bitsPerValue = view.getUint8(pos + 19);
            }

            if (sectionNum === 7) {
                const dataStart = pos + 5;
                const dataBits = (sectionLength - 5) * 8;
                if (bitsPerValue > 0) {
                    packedData = extractBitsServer(view, dataStart, dataBits, bitsPerValue);
                }
            }

            pos += sectionLength;
        }

        // Unpack: Y = (R + X × 2^E) / 10^D → Pa → /100 → hPa
        const E = Math.pow(2, binaryScale);
        const D = Math.pow(10, decimalScale);
        const numValues = width * height;
        const pressure: number[] = new Array(numValues);

        for (let i = 0; i < numValues && i < packedData.length; i++) {
            pressure[i] = (refValue + packedData[i] * E) / D / 100;
        }

        // Sanity check: average pressure should be 950-1060 hPa
        let sum = 0;
        const sampleCount = Math.min(100, pressure.length);
        for (let i = 0; i < sampleCount; i++) {
            sum += pressure[Math.floor((i * pressure.length) / sampleCount)];
        }
        const avg = sum / sampleCount;
        console.info(
            `[GRIB2-Server] Frame avg pressure: ${avg.toFixed(1)} hPa (${numValues} values, ${bitsPerValue} bpv, D=${decimalScale})`,
        );

        if (avg > 900 && avg < 1100 && width > 0 && height > 0) {
            frames.push({ pressure, width, height, lat1: la1, lat2: la2, lon1: lo1, lon2: lo2 });
        } else {
            console.warn(`[GRIB2-Server] Skipping frame: avg=${avg.toFixed(1)} w=${width} h=${height}`);
        }

        offset += totalLength;
    }

    return frames;
}

// ── Main Handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return corsResponse(null, 204);
    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405, { 'Content-Type': 'application/json' });
    }

    try {
        const body = await req.json();
        const { north, south, east, west } = body;
        const forecastHours: number[] = body.hours || [0, 3, 6, 9, 12];

        if (
            typeof north !== 'number' ||
            typeof south !== 'number' ||
            typeof east !== 'number' ||
            typeof west !== 'number'
        ) {
            return corsResponse(JSON.stringify({ error: 'Missing bounds' }), 400, {
                'Content-Type': 'application/json',
            });
        }

        const lonSpan = east - west;
        let leftLon: number, rightLon: number;
        if (lonSpan >= 360) {
            leftLon = 0;
            rightLon = 360;
        } else {
            leftLon = toNoaaLon(west);
            rightLon = toNoaaLon(east);
            if (rightLon <= leftLon) rightLon += 360;
        }

        const { date, cycle } = getLatestGfsCycle();

        // Always use 1° resolution for synoptic scale
        const filter = 'filter_gfs_1p00.pl';
        const filePrefix = 'pgrb2.1p00';

        // Fetch all forecast hours in parallel
        const fetches = forecastHours.map(async (fh) => {
            const fhStr = String(fh).padStart(3, '0');
            const params = new URLSearchParams({
                dir: `/gfs.${date}/${cycle}/atmos`,
                file: `gfs.t${cycle}z.${filePrefix}.f${fhStr}`,
                var_PRMSL: 'on',
                lev_mean_sea_level: 'on',
                subregion: '',
                leftlon: leftLon.toFixed(2),
                rightlon: rightLon.toFixed(2),
                toplat: north.toFixed(2),
                bottomlat: south.toFixed(2),
            });

            const noaaUrl = `https://nomads.ncep.noaa.gov/cgi-bin/${filter}?${params.toString()}`;
            console.info(`[fetch-pressure-grid] f${fhStr}: ${noaaUrl}`);

            try {
                const upstream = await fetch(noaaUrl);
                if (!upstream.ok) return null;
                const buf = await upstream.arrayBuffer();
                if (buf.byteLength < 100) return null;
                return buf;
            } catch (e) {
                console.warn('[index]', e);
                return null;
            }
        });

        const results = await Promise.all(fetches);
        const validBuffers = results.filter((r): r is ArrayBuffer => r !== null);

        // Decode each GRIB2 buffer into a pressure frame
        const allFrames: DecodedFrame[] = [];
        for (const buf of validBuffers) {
            const decoded = decodeGrib2PressureServer(buf);
            allFrames.push(...decoded);
        }

        if (allFrames.length === 0) {
            return corsResponse(JSON.stringify({ error: 'No valid frames decoded' }), 502, {
                'Content-Type': 'application/json',
            });
        }

        const f0 = allFrames[0];
        const normLon = (lon: number) => (lon > 180 ? lon - 360 : lon);

        // ── Build lat/lon arrays from REQUEST BOUNDS + grid dimensions ──
        // GRIB2 La2/Lo2 parsing is unreliable (byte offset alignment varies
        // across producers). Instead, use the known request bounds and grid
        // dimensions (Ni/Nj) which are always correct.
        //
        // La1/Lo1 from GRIB2 are typically reliable (first 4 bytes of the
        // coordinate block), so use La1 as a sanity reference.
        const gridNorth = north;
        const gridSouth = south;
        const gridWest = normLon(west);
        const gridEast = normLon(east);

        // Use La1 as a sanity check — if it's reasonable, log for debugging
        const la1Check = f0.lat1;
        if (Math.abs(la1Check) <= 90) {
            console.info(
                `[GRIB2] La1=${la1Check.toFixed(2)} (GRIB), using request bounds: ${gridSouth}→${gridNorth}, ${gridWest}→${gridEast}`,
            );
        } else {
            console.warn(`[GRIB2] La1=${la1Check} is out of range, ignoring GRIB coords`);
        }

        const dy = f0.height > 1 ? (gridNorth - gridSouth) / (f0.height - 1) : 1;
        const dx = f0.width > 1 ? Math.abs(gridEast - gridWest) / (f0.width - 1) : 1;

        // Build S→N lat array, W→E lon array
        const lats: number[] = [];
        for (let i = 0; i < f0.height; i++) lats.push(gridSouth + i * dy);
        const lons: number[] = [];
        for (let i = 0; i < f0.width; i++) lons.push(gridWest + i * dx);

        // Convert each frame's N→S data to S→N row-major 2D arrays
        const frames = allFrames.map((frame) => {
            const rows: number[][] = [];
            for (let r = 0; r < frame.height; r++) {
                const row: number[] = [];
                // r=0 → southernmost → read from GRIB row (height-1)
                const gribRow = frame.height - 1 - r;
                for (let c = 0; c < frame.width; c++) {
                    row.push(frame.pressure[gribRow * frame.width + c]);
                }
                rows.push(row);
            }
            return rows;
        });

        const responseBody = {
            frames, // [frameIdx][row_S_to_N][col_W_to_E] in hPa
            lats, // S→N
            lons, // W→E
            width: f0.width,
            height: f0.height,
            north: gridNorth,
            south: gridSouth,
            east: gridEast,
            west: gridWest,
        };

        console.info(`[fetch-pressure-grid] Returning ${frames.length} frames, ${f0.width}×${f0.height} grid`);

        return corsResponse(JSON.stringify(responseBody), 200, {
            'Content-Type': 'application/json',
            'X-GFS-Date': date,
            'X-GFS-Cycle': `${cycle}z`,
        });
    } catch (err) {
        console.error('[fetch-pressure-grid] Error:', err);
        return corsResponse(JSON.stringify({ error: String(err) }), 500, { 'Content-Type': 'application/json' });
    }
});
