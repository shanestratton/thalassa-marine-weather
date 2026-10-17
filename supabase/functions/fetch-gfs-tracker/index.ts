// deno-lint-ignore-file
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, readResponseTextLimited } from '../_shared/http-security.ts';
import { type AdeckTrack, type ModelTrack, modelTracks, parseAdeck } from '../_shared/cyclone/adeck.ts';
import { parseTcvitals as readVitals } from '../_shared/cyclone/feed.ts';
import { ASK, fetchNhcAdecks, gfsTrackerUrls } from '../_shared/cyclone/sources.ts';

/**
 * fetch-gfs-tracker — GFS ATCF Track File Proxy
 *
 * Returns the GFS model's internal tropical cyclone eye positions at each
 * forecast hour (0, 6, 12, 18...). The client uses these to interpolate
 * the exact eye position for the current GRIB age.
 *
 * Source waterfall:
 *   1. the GFS tracker file — per-forecast-hour positions (ideal): NCEP's
 *      ens_tracker/prod/gfs.YYYYMMDD/CC/tctrack/avno.tCCz.cyclone.trackatcfunix
 *      (129-09b: the old gfs.tCCz.atcfunix.all under atmos/ answers 403 now;
 *      it is still tried second)
 *   2. tcvitals — T+0 analysis position only (fallback), read by column
 *      (_shared/cyclone/feed.ts: a long name runs into the date)
 *
 * Every model's track (129-09): `models` carries one labelled line per model
 * per storm, every a-deck tech it can credit, from the same atcfunix file
 * (every basin) and NHC's public a-decks for its active storms (AL/EP/CP:
 * ECMWF, UKMO, CMC, the hurricane models and the consensus as well as GFS).
 * `techs` lists every tech the files held, drawn or not; `sources` says which
 * answered, so a missing source is said, never shown as no models. `storms`
 * is unchanged for the builds that read only it.
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
    models: ModelTrack[];
    techs: string[];
    sources: { atcfunix: 'ok' | 'unavailable'; nhcAdecks: 'ok' | 'none' | 'unavailable' };
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

        // "28P" in the old file; the ens_tracker file leads with the basin ("EP, 20"), keyed "EP20".
        const stormId = /^[A-Z]{2}$/.test(cols[0]) && /^\d{1,2}$/.test(cols[1])
            ? `${cols[0]}${cols[1].padStart(2, '0')}`
            : cols[1].trim();
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
 * TC vitals as storms keyed like the tracker file ("EP20"), each with its
 * T+0 position: NCEP's fixed columns (_shared/cyclone/feed.ts parseTcvitals),
 * never split on spaces, as "TWENTY-ON:20261013" ran a name into its date.
 */
function parseTcvitals(text: string): Record<string, StormRecord> {
    const storms: Record<string, StormRecord> = {};
    for (const v of readVitals(text)) {
        const raw = `${v.key.slice(2)}${v.basin}`;
        const record = {
            name: v.name,
            positions: [
                {
                    fhr: 0,
                    lat: v.current.lat,
                    lon: v.current.lon,
                    vmax: v.current.windKts ?? 0,
                    mslp: v.current.pressureMb ?? 0,
                },
            ],
        };
        storms[v.key] = record;
        // The old tracker file's key ("28P") for the names it is matched against.
        storms[raw] = record;
    }
    return storms;
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== 'GET') {
        return corsResponse(JSON.stringify({ error: 'GET required' }), 405, { Allow: 'GET' });
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'gfs_tracker', 240, 120, 3600, true);
    if (caller instanceof Response) return withCors(caller, CORS);

    try {
        const { date, cycle } = getLatestGfsCycle();
        const gfsCycle = `${date}${cycle}`;

        // Calculate GRIB reference time as ISO string
        const refYear = parseInt(date.substring(0, 4), 10);
        const refMonth = parseInt(date.substring(4, 6), 10) - 1;
        const refDay = parseInt(date.substring(6, 8), 10);
        const refHour = parseInt(cycle, 10);
        const gfsRefTime = new Date(Date.UTC(refYear, refMonth, refDay, refHour)).toISOString();

        const result: TrackerResponse = {
            storms: {},
            gfsCycle,
            gfsRefTime,
            source: 'none',
            models: [],
            techs: [],
            sources: { atcfunix: 'unavailable', nhcAdecks: 'unavailable' },
        };
        let atcfText: string | null = null;

        console.info(`[fetch-gfs-tracker] GFS cycle: ${date}/${cycle}z (refTime: ${gfsRefTime})`);

        // ── Source 1: the GFS tracker file (per-forecast-hour positions) ──
        for (const atcfUrl of gfsTrackerUrls(date, cycle)) {
            if (atcfText !== null) break;
            try {
                console.info(`[fetch-gfs-tracker] Trying atcfunix: ${atcfUrl}`);
                const resp = await fetchWithTimeout(atcfUrl, ASK, 10_000);

                if (resp.ok) {
                    const text = await readResponseTextLimited(resp, 5_000_000);
                    if (text !== null && text.trim().length > 10 && !text.includes('<!DOCTYPE')) {
                        atcfText = text;
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
                    await resp.body?.cancel().catch(() => undefined);
                }
            } catch (e) {
                console.warn('[fetch-gfs-tracker] atcfunix fetch failed:', e);
            }
        }

        // ── Source 2: TCVitals fallback (T+0 only) ──
        if (result.source === 'none') {
            try {
                const vitalsUrl = `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/` +
                    `gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.syndata.tcvitals.tm00`;

                console.info(`[fetch-gfs-tracker] Trying tcvitals: ${vitalsUrl}`);
                const resp = await fetchWithTimeout(vitalsUrl, ASK, 10_000);

                if (resp.ok) {
                    const text = await readResponseTextLimited(resp, 1_000_000);
                    if (text !== null && text.trim().length > 10) {
                        result.storms = Object.fromEntries(
                            Object.entries(parseTcvitals(text)).filter(([sid]) => /^[A-Z]{2}\d{2}$/.test(sid)),
                        );
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
                const vitalsUrl = `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/` +
                    `gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.syndata.tcvitals.tm00`;
                const resp = await fetchWithTimeout(vitalsUrl, ASK, 5_000);
                if (resp.ok) {
                    const text = await readResponseTextLimited(resp, 1_000_000);
                    const vitals = text === null ? {} : parseTcvitals(text);
                    for (const [sid, storm] of Object.entries(vitals)) {
                        if (result.storms[sid]) {
                            result.storms[sid].name = storm.name;
                        }
                    }
                }
            } catch {
                /* ignore */
            }
        }

        // ── Every model's track (129-09) ──
        const nowMs = Date.now();
        const tracks: AdeckTrack[] = [];
        if (atcfText !== null) {
            result.sources.atcfunix = 'ok';
            tracks.push(...parseAdeck(atcfText));
        }
        const nhc = await fetchNhcAdecks(nowMs);
        if (nhc) {
            result.sources.nhcAdecks = nhc.storms > 0 ? 'ok' : 'none';
            tracks.push(...parseAdeck(nhc.text));
        }
        result.techs = [...new Set(tracks.map((t) => t.tech))].sort();
        result.models = modelTracks(tracks, nowMs);

        return corsResponse(JSON.stringify(result), 200, {
            'Cache-Control': 'public, max-age=600',
            'X-GFS-Cycle': `${cycle}z`,
        });
    } catch (err) {
        console.error('[fetch-gfs-tracker] Error:', err);
        return corsResponse(JSON.stringify({ error: 'Cyclone tracker fetch failed' }), 502);
    }
});
