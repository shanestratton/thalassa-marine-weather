// deno-lint-ignore-file
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseForecastHours,
    parseGeoBounds,
    readJsonObject,
    readResponseArrayBufferLimited,
} from '../_shared/http-security.ts';
import { normalizeGlobalPressureFrames } from './global-longitudes.ts';

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
            ) {
                break;
            }

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
        if (
            !Number.isSafeInteger(numValues) ||
            numValues < 1 ||
            numValues > 2_000_000 ||
            totalLength < 16 ||
            offset + totalLength > buffer.byteLength
        ) {
            console.warn(`[GRIB2-Server] Refusing invalid grid/message dimensions: ${width}×${height}`);
            offset += Math.max(16, Math.min(totalLength || 16, buffer.byteLength - offset));
            continue;
        }
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
            `[GRIB2-Server] Frame avg pressure: ${
                avg.toFixed(1)
            } hPa (${numValues} values, ${bitsPerValue} bpv, D=${decimalScale})`,
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

    const caller = await requireAuthenticatedOrPublicQuota(req, 'pressure_grid', 60, 30, 3600);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const body = await readJsonObject(req, 4096);
        const bounds = body ? parseGeoBounds(body) : null;
        const forecastHours = body ? parseForecastHours(body.hours, [0, 3, 6, 9, 12], 8, 120) : null;
        const resolution = body?.resolution ?? '1p00';
        if (
            !bounds ||
            !forecastHours ||
            (resolution !== '0p25' && resolution !== '1p00') ||
            (resolution === '0p25' && bounds.latSpan * bounds.lonSpan > 2500)
        ) {
            return corsResponse(JSON.stringify({ error: 'Invalid pressure-grid request bounds' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        const { north, south, east, west, lonSpan } = bounds;

        let leftLon: number, rightLon: number;
        if (lonSpan >= 359.999) {
            leftLon = 0;
            rightLon = 360;
        } else {
            leftLon = toNoaaLon(west);
            rightLon = toNoaaLon(east);
            if (rightLon <= leftLon) rightLon += 360;
        }

        const { date, cycle } = getLatestGfsCycle();

        // Use requested resolution (0.25° for cyclone eye, 1° for synoptic isobars)
        const filter = resolution === '0p25' ? 'filter_gfs_0p25.pl' : 'filter_gfs_1p00.pl';
        const filePrefix = resolution === '0p25' ? 'pgrb2.0p25' : 'pgrb2.1p00';

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
                const upstream = await fetchWithTimeout(noaaUrl, {}, 15_000);
                if (!upstream.ok) return null;
                const buf = await readResponseArrayBufferLimited(upstream, 12_000_000);
                if (!buf) return null;
                if (buf.byteLength < 100) return null;
                return { fh, buf };
            } catch (e) {
                console.warn('[index]', e);
                return null;
            }
        });

        const results = await Promise.all(fetches);
        const decodedByForecastHour: { fh: number; frame: DecodedFrame }[] = [];

        // Each requested forecast hour must produce exactly one matching
        // pressure field. Previously failed files were dropped and the client
        // still received the original fhrs array, silently calling (say) +6h
        // "+3h". Failing closed lets the client use its explicit fallback
        // instead of showing a plausible-but-wrong synoptic chart.
        for (const result of results) {
            if (!result) continue;
            const decoded = decodeGrib2PressureServer(result.buf);
            if (decoded.length !== 1) {
                console.warn(`[fetch-pressure-grid] Expected one PRMSL frame for f${result.fh}, got ${decoded.length}`);
                continue;
            }
            decodedByForecastHour.push({ fh: result.fh, frame: decoded[0] });
        }

        if (decodedByForecastHour.length !== forecastHours.length) {
            return corsResponse(JSON.stringify({ error: 'Incomplete GFS pressure frame set' }), 502, {
                'Content-Type': 'application/json',
            });
        }

        const f0 = decodedByForecastHour[0].frame;
        if (decodedByForecastHour.some(({ frame }) => frame.width !== f0.width || frame.height !== f0.height)) {
            return corsResponse(JSON.stringify({ error: 'Mismatched GFS pressure frame dimensions' }), 502, {
                'Content-Type': 'application/json',
            });
        }
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
        const isFullGlobe = lonSpan >= 359.999;
        // Keep a dateline-crossing regional request on one continuous axis
        // (e.g. 170…190°), rather than treating it as a 340° span. Mapbox can
        // wrap these longitudes, while the contour algorithm needs monotonic
        // columns to preserve the local weather field.
        const gridWest = isFullGlobe ? -180 : normLon(west);
        const gridEast = isFullGlobe ? 180 : gridWest + lonSpan;

        // Use La1 as a sanity check — if it's reasonable, log for debugging
        const la1Check = f0.lat1;
        if (Math.abs(la1Check) <= 90) {
            console.info(
                `[GRIB2] La1=${
                    la1Check.toFixed(2)
                } (GRIB), using request bounds: ${gridSouth}→${gridNorth}, ${gridWest}→${gridEast}`,
            );
        } else {
            console.warn(`[GRIB2] La1=${la1Check} is out of range, ignoring GRIB coords`);
        }

        const dy = f0.height > 1 ? (gridNorth - gridSouth) / (f0.height - 1) : 1;
        // Build S→N latitude array.
        const lats: number[] = [];
        for (let i = 0; i < f0.height; i++) lats.push(gridSouth + i * dy);

        // Convert each frame's N→S data to S→N row-major 2D arrays
        let frames = decodedByForecastHour.map(({ frame }) => {
            const rows: number[][] = [];
            for (let r = 0; r < frame.height; r++) {
                const row: number[] = [];
                // r=0 → southernmost → read from GRIB row (height-1)
                const gribRow = frame.height - 1 - r;
                for (let c = 0; c < frame.width; c++) {
                    // ROUND TO 0.1 hPa BEFORE SERIALISING. The unpack at the
                    // top is (ref + packed*E)/D/100, i.e. raw float division,
                    // so a value arrives as 1003.0784359608183 — eighteen
                    // characters of JSON for a number GFS does not resolve
                    // anywhere near that finely. Measured on a global 1°
                    // grid (360x171) x 8 frames: 9.11 MB raw vs 3.56 MB at
                    // one decimal, a 61% cut, and that payload is what the
                    // phone waits on before a single isobar can draw (Shane
                    // 2026-08-22: "it is a little slow in arriving").
                    //
                    // 0.1 hPa is far below anything the display can express:
                    // isobars are drawn on a 4 hPa interval and the wash is a
                    // gradient over the same field. Integer hPa would save
                    // another 0.9 MB but risks visible banding in the wash,
                    // which is not worth it — this is already the big win.
                    row.push(Math.round(frame.pressure[gribRow * frame.width + c] * 10) / 10);
                }
                rows.push(row);
            }
            return rows;
        });

        let lons: number[];
        if (isFullGlobe) {
            // NOAA starts full-globe columns at 0°E. A Mapbox −180…180 axis
            // must rotate the values as well as the labels; relabelling alone
            // placed every high/low roughly half a world away.
            const normalized = normalizeGlobalPressureFrames(frames);
            frames = normalized.frames;
            lons = normalized.lons;
        } else {
            const dx = f0.width > 1 ? Math.abs(gridEast - gridWest) / (f0.width - 1) : 1;
            lons = Array.from({ length: f0.width }, (_, index) => gridWest + index * dx);
        }

        // Build the GFS run refTime (ISO string) so the client can align
        // its scrubber "Now" marker to wall-clock time instead of the model
        // run time. `date` is YYYYMMDD, `cycle` is HH in UTC.
        const refTimeIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${cycle}:00:00.000Z`;

        const responseBody = {
            frames, // [frameIdx][row_S_to_N][col_W_to_E] in hPa
            lats, // S→N
            lons, // W→E
            width: lons.length,
            height: f0.height,
            north: gridNorth,
            south: gridSouth,
            east: gridEast,
            west: gridWest,
            /** ISO timestamp of the GFS cycle that produced these frames.
             *  Lets the client compute "Now" as the frame closest to
             *  (Date.now() − refTime), not the frame at forecastHour[0]. */
            refTime: refTimeIso,
            /** The forecast-hour offsets (e.g. [0,3,6,9,12]) that `frames`
             *  correspond to, BEFORE the client's 30-min sub-frame
             *  interpolation. Used with refTime to compute nowIdx. */
            fhrs: decodedByForecastHour.map(({ fh }) => fh),
        };

        console.info(`[fetch-pressure-grid] Returning ${frames.length} frames, ${lons.length}×${f0.height} grid`);

        return corsResponse(JSON.stringify(responseBody), 200, {
            'Content-Type': 'application/json',
            'X-GFS-Date': date,
            'X-GFS-Cycle': `${cycle}z`,
            'Cache-Control': 'public, max-age=1800',
        });
    } catch (err) {
        console.error('[fetch-pressure-grid] Error:', err);
        return corsResponse(JSON.stringify({ error: 'Pressure grid fetch failed' }), 502, {
            'Content-Type': 'application/json',
        });
    }
});
