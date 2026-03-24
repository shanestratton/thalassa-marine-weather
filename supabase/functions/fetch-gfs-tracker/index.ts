// deno-lint-ignore-file
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * fetch-gfs-tracker — GFS ATCF Track File Proxy
 *
 * Returns the GFS model's internal tropical cyclone eye positions at each
 * forecast hour (0, 6, 12, 18...). The client uses these to interpolate
 * the exact eye position for the current GRIB age.
 *
 * Source waterfall:
 *   1. gfs.tCCz.atcfunix.all — per-forecast-hour positions (ideal)
 *   2. tcvitals — T+0 analysis position only (fallback)
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: string | null, status: number, extra?: Record<string, string>) {
    return new Response(body, {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
    });
}

// ── GFS cycle logic ─────────────────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────

interface TrackerPosition {
    fhr: number;
    lat: number;
    lon: number;
    vmax: number;
    mslp: number;
}

interface StormRecord {
    name: string;
    positions: TrackerPosition[];
}

interface TrackerResponse {
    storms: Record<string, StormRecord>;
    gfsCycle: string;
    gfsRefTime: string; // ISO string of the GRIB reference time
    source: 'atcfunix' | 'tcvitals' | 'none';
}

// ── ATCF Unix Parser (atcfunix.all) ──────────────────────────
/**
 * Parse the GFS atcfunix.all file.
 * 
 * Format (comma-separated):
 *   JTWC, 28P, 2026032318, 03, AVNO, 000,  214S,  1635E,  62, 0990, ...
 *   JTWC, 28P, 2026032318, 03, AVNO, 006,  220S,  1638E,  58, 0992, ...
 *   JTWC, 28P, 2026032318, 03, AVNO, 012,  228S,  1641E,  55, 0994, ...
 *
 *   col[0] = agency (JTWC, NHC)
 *   col[1] = storm ID (28P, 04L)
 *   col[2] = date+cycle (YYYYMMDDHH)
 *   col[3] = tech number
 *   col[4] = tech (AVNO = GFS tracker)
 *   col[5] = forecast hour (tau)
 *   col[6] = lat (e.g. "214S" = -21.4°)
 *   col[7] = lon (e.g. "1635E" = 163.5°)
 *   col[8] = vmax (kt)
 *   col[9] = mslp (mb)
 */
function parseAtcfunix(text: string, cycleHour: string): Record<string, StormRecord> {
    const storms: Record<string, StormRecord> = {};
    const cycleHH = cycleHour.padStart(2, '0');

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const cols = line.split(',').map((c) => c.trim());
        if (cols.length < 10) continue;

        // Only AVNO (GFS) tech
        const tech = cols[4];
        if (tech !== 'AVNO' && tech !== 'GFSO') continue;

        // Match our cycle hour
        const dateFull = cols[2]; // "2026032318"
        if (dateFull.length >= 10) {
            const recordHH = dateFull.substring(8, 10);
            if (recordHH !== cycleHH) continue;
        }

        const stormId = cols[1].trim(); // "28P"
        const fhr = parseInt(cols[5], 10) || 0;

        // Parse lat: "214S" → -21.4
        const latStr = cols[6];
        const latDir = latStr.slice(-1);
        const latVal = parseInt(latStr.slice(0, -1), 10) / 10;
        const lat = latDir === 'S' ? -latVal : latVal;

        // Parse lon: "1635E" → 163.5
        const lonStr = cols[7];
        const lonDir = lonStr.slice(-1);
        const lonVal = parseInt(lonStr.slice(0, -1), 10) / 10;
        const lon = lonDir === 'W' ? -lonVal : lonVal;

        const vmax = parseInt(cols[8], 10) || 0;
        const mslp = parseInt(cols[9], 10) || 0;

        if (!storms[stormId]) {
            storms[stormId] = { name: stormId, positions: [] };
        }
        storms[stormId].positions.push({ fhr, lat, lon, vmax, mslp });
    }

    // Sort positions by forecast hour
    for (const sid of Object.keys(storms)) {
        storms[sid].positions.sort((a, b) => a.fhr - b.fhr);
    }

    return storms;
}

// ── TCVitals Parser (fallback, T+0 only) ─────────────────────
/**
 * Parse tcvitals. Real format:
 *   JTWC 28P TWENTY-EI 20260323 1800 214S 1635E 165 072 0990 ...
 */
function parseTcvitals(text: string): Record<string, StormRecord> {
    const storms: Record<string, StormRecord> = {};

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.length < 50) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 10) continue;

        const stormId = parts[1]; // "28P"
        const name = parts[2];   // "TWENTY-EI"

        const latStr = parts[5];
        const latDir = latStr.slice(-1);
        const latVal = parseInt(latStr.slice(0, -1), 10) / 10;
        const lat = latDir === 'S' ? -latVal : latVal;

        const lonStr = parts[6];
        const lonDir = lonStr.slice(-1);
        const lonVal = parseInt(lonStr.slice(0, -1), 10) / 10;
        const lon = lonDir === 'W' ? -lonVal : lonVal;

        const mslp = parseInt(parts[9], 10) || 0;
        const vmax = parseInt(parts[8], 10) || 0;

        storms[stormId] = {
            name,
            positions: [{ fhr: 0, lat, lon, vmax, mslp }],
        };

        console.info(
            `[fetch-gfs-tracker] Parsed tcvitals: ${name} (${stormId}) at ${lat.toFixed(1)}, ${lon.toFixed(1)}`,
        );
    }

    return storms;
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    try {
        const { date, cycle } = getLatestGfsCycle();
        const gfsCycle = `${date}${cycle}`;

        // Calculate GRIB reference time as ISO string
        const refYear = parseInt(date.substring(0, 4), 10);
        const refMonth = parseInt(date.substring(4, 6), 10) - 1;
        const refDay = parseInt(date.substring(6, 8), 10);
        const refHour = parseInt(cycle, 10);
        const gfsRefTime = new Date(Date.UTC(refYear, refMonth, refDay, refHour)).toISOString();

        const result: TrackerResponse = { storms: {}, gfsCycle, gfsRefTime, source: 'none' };

        console.info(`[fetch-gfs-tracker] GFS cycle: ${date}/${cycle}z (refTime: ${gfsRefTime})`);

        // ── Source 1: ATCF Unix file (per-forecast-hour positions) ──
        try {
            const atcfUrl =
                `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/` +
                `gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.atcfunix.all`;

            console.info(`[fetch-gfs-tracker] Trying atcfunix: ${atcfUrl}`);
            const resp = await fetch(atcfUrl, { signal: AbortSignal.timeout(10_000) });

            if (resp.ok) {
                const text = await resp.text();
                if (text.trim().length > 10 && !text.includes('<!DOCTYPE')) {
                    result.storms = parseAtcfunix(text, cycle);
                    const count = Object.keys(result.storms).length;
                    if (count > 0) {
                        result.source = 'atcfunix';
                        for (const [sid, storm] of Object.entries(result.storms)) {
                            console.info(
                                `[fetch-gfs-tracker] ✅ atcfunix: ${sid} — ${storm.positions.length} forecast hours ` +
                                `(fhr 0-${storm.positions[storm.positions.length - 1]?.fhr || 0})`,
                            );
                        }
                    }
                }
            } else {
                console.warn(`[fetch-gfs-tracker] atcfunix: ${resp.status} ${resp.statusText}`);
            }
        } catch (e) {
            console.warn('[fetch-gfs-tracker] atcfunix fetch failed:', e);
        }

        // ── Source 2: TCVitals fallback (T+0 only) ──
        if (result.source === 'none') {
            try {
                const vitalsUrl =
                    `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/` +
                    `gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.syndata.tcvitals.tm00`;

                console.info(`[fetch-gfs-tracker] Trying tcvitals: ${vitalsUrl}`);
                const resp = await fetch(vitalsUrl, { signal: AbortSignal.timeout(10_000) });

                if (resp.ok) {
                    const text = await resp.text();
                    if (text.trim().length > 10) {
                        result.storms = parseTcvitals(text);
                        const count = Object.keys(result.storms).length;
                        if (count > 0) {
                            result.source = 'tcvitals';
                            console.info(`[fetch-gfs-tracker] ✅ tcvitals: ${count} storms (T+0 only)`);
                        }
                    }
                }
            } catch (e) {
                console.warn('[fetch-gfs-tracker] tcvitals fetch failed:', e);
            }
        }

        // ── If atcfunix worked, enrich with tcvitals names ──
        if (result.source === 'atcfunix') {
            try {
                const vitalsUrl =
                    `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/` +
                    `gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.syndata.tcvitals.tm00`;
                const resp = await fetch(vitalsUrl, { signal: AbortSignal.timeout(5_000) });
                if (resp.ok) {
                    const text = await resp.text();
                    const vitals = parseTcvitals(text);
                    for (const [sid, storm] of Object.entries(vitals)) {
                        if (result.storms[sid]) {
                            result.storms[sid].name = storm.name;
                        }
                    }
                }
            } catch { /* ignore */ }
        }

        return corsResponse(JSON.stringify(result), 200, {
            'Cache-Control': 'public, max-age=600',
            'X-GFS-Cycle': `${cycle}z`,
        });
    } catch (err) {
        console.error('[fetch-gfs-tracker] Error:', err);
        return corsResponse(JSON.stringify({ error: String(err) }), 500);
    }
});
