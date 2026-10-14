/**
 * seaPartitions — the sea in parts at one point: wind sea, swell and second
 * swell, each with its own height, period and the direction it comes FROM
 * (build 130, 130-04). One module owns the call, the snap guard and the words
 * for "no sea here", so the map popup, the Glass (130-06) and the briefing
 * (130-08) say the same thing.
 *
 * Measured 2026-10-14 on the commercial proxy and the tailnet wx server, and
 * what each finding decides here:
 *
 *   1. ONE CALL, TWO MODELS, HOURLY ONLY. models=meteofrance_wave,
 *      ncep_gfswave025 answers both under suffixed keys (`wave_height_
 *      meteofrance_wave`, `…_ncep_gfswave025`). A two-model `current` block
 *      answers for the FIRST model only, unsuffixed, so it is never asked for.
 *      Ten days of hours serve the popup's "now" and the Glass's hours alike.
 *   2. `secondary_swell_wave_peak_period` FAILS THE WHOLE REQUEST ("Cannot
 *      initialize … secondary_swell_wave_peak_period"; the proxy answers 502)
 *      although proxy-openmeteo still allows it. It is not in SEA_VARIABLES,
 *      and a test holds it out.
 *   3. SNAPPING. A point the model cannot see is answered from the nearest wet
 *      cell, confidently: Newport 10.7 km, Airlie Beach 17.7 km, an Annapolis
 *      marina ~14 km. The echoed coordinate is the FIRST model's cell, so
 *      MFWAM is listed first and only its 1/12° cell is checked, at the
 *      passage strip's tight pad (routeSeaSampler.ts, SEA_SNAP_PAD). A cell
 *      further than that is refused: no number, SEA_NONE_LONG. The cache keeps
 *      the CELL, not the verdict, keyed on the tap's OWN 1/12° cell, and the
 *      guard runs again for every tapped point. A refusal is only ever made
 *      on a reply to that point: far from a cell fetched for another tap
 *      proves nothing about shelter (see fetchSeaPartitions).
 *   4. GFS WAVE IS A SECOND OPINION, NEVER A NUMBER OF ITS OWN. Its zeros are
 *      land-mask cells, not calm (Airlie: every partition 0.0; the Gulf of
 *      Lion: second swell 0.0 m at 0°), and no echo can prove its 0.25° cell
 *      is local. It speaks only in seaModelsDiffer, offshore, where MFWAM's
 *      cell passed and the two totals differ by ×1.5 and by 0.3 m.
 *   5. MFWAM ANSWERS 9 DAYS: the last day of the ten is null. Nothing fills it.
 *
 * Metres and degrees here, as Open-Meteo sends them (the reply's own units are
 * checked). The report boundary is feet; 130-06 converts once, in its merge.
 * Attribution is a licence condition: SEA_CREDIT goes wherever a number from
 * here does, and SEA_CHECK_CREDIT wherever the GFS Wave line does.
 */
import { fetchOpenMeteoProxy, type OpenMeteoParameters } from './openMeteoProxy';
import { maxLegitimateSnapKm } from './api/marine';
import { calculateDistance } from '../../utils/navigationCalculations';

/** The popup's words where no number may be shown. */
export const SEA_NONE_LONG = 'No open-water wave model reaches here';
/** The briefing's (130-08). */
export const SEA_NONE_SHORT = 'No wave forecast here';

/** The number. Listed first: the echoed coordinate is its cell. */
export const SEA_PRIMARY_MODEL = 'meteofrance_wave';
/** The second opinion only (finding 4). */
export const SEA_CHECK_MODEL = 'ncep_gfswave025';
export const SEA_CREDIT = 'Waves: Météo-France MFWAM, E.U. Copernicus Marine (© Mercator Ocean) via Open-Meteo';
export const SEA_CHECK_CREDIT = 'GFS Wave: NOAA';

/** Never `secondary_swell_wave_peak_period` (finding 2). */
export const SEA_VARIABLES = [
    'wave_height',
    'wave_period',
    'wave_direction',
    'wind_wave_height',
    'wind_wave_period',
    'wind_wave_direction',
    'swell_wave_height',
    'swell_wave_period',
    'swell_wave_direction',
    'secondary_swell_wave_height',
    'secondary_swell_wave_period',
    'secondary_swell_wave_direction',
] as const;
export const SEA_FORECAST_DAYS = 10;

/** routeSeaSampler's pad over half the grid diagonal (Mackay marina's 7.1 km refused, the Passage's 6.2 km kept). */
export const SEA_SNAP_PAD = 1.03;
/** A partition under this reads "none". MFWAM's second swell is often 0.02-0.18 m. */
export const SEA_PART_NONE_M = 0.1;

export interface SeaPart {
    /** Significant height of this part, metres. */
    hM: number;
    periodS: number | null;
    /** Where it comes FROM, degrees true. */
    fromDeg: number | null;
}

export interface SeaHour {
    /** Start of the hour, epoch ms. */
    t: number;
    /** MFWAM's total sea; its mean period. */
    total: SeaPart | null;
    windSea: SeaPart | null;
    swell: SeaPart | null;
    swell2: SeaPart | null;
    /** GFS Wave's total height, metres: for seaModelsDiffer only, never shown alone. Null for its zeros. */
    checkM: number | null;
}

export interface SeaPartitions {
    fetchedAt: number;
    /** The cell MFWAM answered from; null when the reply did not say. */
    gridLat: number | null;
    gridLon: number | null;
    /** How far that cell is from the point asked about. */
    snappedKm: number | null;
    /** The cell passed the guard. False: `hours` is empty and SEA_NONE_LONG is the answer. */
    local: boolean;
    hours: SeaHour[];
    /** Show with any number from here. */
    credit: string;
}

/** What the cache keeps: the cell, so the guard can run again per point. */
interface SeaCell {
    fetchedAt: number;
    gridLat: number | null;
    gridLon: number | null;
    hours: SeaHour[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The one request. A test holds `current` and the peak period out of it. */
export function seaRequestParams(lat: number, lon: number): OpenMeteoParameters {
    return {
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        hourly: SEA_VARIABLES.join(','),
        models: `${SEA_PRIMARY_MODEL},${SEA_CHECK_MODEL}`,
        timeformat: 'unixtime',
        forecast_days: SEA_FORECAST_DAYS,
    };
}

type Columns = Record<string, unknown>;
const at = (hourly: Columns, key: string, i: number): number | null => {
    const column = hourly[key];
    return Array.isArray(column) ? num(column[i]) : null;
};

function mfwamPart(hourly: Columns, prefix: string, i: number): SeaPart | null {
    const hM = at(hourly, `${prefix}_height_${SEA_PRIMARY_MODEL}`, i);
    if (hM === null || hM < 0) return null;
    return {
        hM,
        periodS: at(hourly, `${prefix}_period_${SEA_PRIMARY_MODEL}`, i),
        fromDeg: at(hourly, `${prefix}_direction_${SEA_PRIMARY_MODEL}`, i),
    };
}

/** GFS Wave's total, or null for a literal 0 m, 0 s or 0° (a land-mask cell, finding 4). */
function checkHeight(hourly: Columns, i: number): number | null {
    const hM = at(hourly, `wave_height_${SEA_CHECK_MODEL}`, i);
    if (hM === null || hM <= 0) return null;
    if (at(hourly, `wave_period_${SEA_CHECK_MODEL}`, i) === 0) return null;
    if (at(hourly, `wave_direction_${SEA_CHECK_MODEL}`, i) === 0) return null;
    return hM;
}

/** Parse one marine reply. Throws on a reply that is not one (a failure, never a shelter). */
export function parseSeaCell(reply: unknown, fetchedAt: number): SeaCell {
    const r = reply as { latitude?: unknown; longitude?: unknown; hourly?: unknown; hourly_units?: unknown } | null;
    const hourly = r && typeof r.hourly === 'object' ? (r.hourly as Columns | null) : null;
    if (!hourly || !Array.isArray(hourly.time)) throw new Error('sea reply has no hours');
    const units = (r?.hourly_units ?? {}) as Columns;
    if (units[`wave_height_${SEA_PRIMARY_MODEL}`] !== 'm') throw new Error('sea reply in unexpected units');

    const hours: SeaHour[] = [];
    for (let i = 0; i < hourly.time.length; i++) {
        const sec = num(hourly.time[i]);
        // timeformat=unixtime: seconds, rising. Anything else ends the series.
        if (sec === null || (hours.length > 0 && sec * 1000 <= hours[hours.length - 1].t)) break;
        let total = mfwamPart(hourly, 'wave', i);
        // MFWAM's own land mask answers 0 m with no period: not a flat calm.
        if (total && total.hM === 0 && !total.periodS) total = null;
        hours.push({
            t: sec * 1000,
            total,
            windSea: total ? mfwamPart(hourly, 'wind_wave', i) : null,
            swell: total ? mfwamPart(hourly, 'swell_wave', i) : null,
            swell2: total ? mfwamPart(hourly, 'secondary_swell_wave', i) : null,
            checkM: checkHeight(hourly, i),
        });
    }
    return { fetchedAt, gridLat: num(r?.latitude), gridLon: num(r?.longitude), hours };
}

/** The guard, for THIS point: a cell further than the tight pad, or one that did not say where it is, is refused. */
export function guardSeaCell(cell: SeaCell, lat: number, lon: number): SeaPartitions {
    const { gridLat, gridLon } = cell;
    const snappedKm =
        gridLat === null || gridLon === null ? null : calculateDistance(lat, lon, gridLat, gridLon) * 1.852;
    const local = snappedKm !== null && snappedKm <= maxLegitimateSnapKm(lat, SEA_SNAP_PAD);
    return {
        fetchedAt: cell.fetchedAt,
        gridLat,
        gridLon,
        snappedKm,
        local,
        hours: local ? cell.hours : [],
        credit: SEA_CREDIT,
    };
}

/** The hour that contains `nowMs`, or null when none does (before the first, or past the last). */
export function seaHourAt(sea: SeaPartitions, nowMs: number): SeaHour | null {
    let hit: SeaHour | null = null;
    for (const hour of sea.hours) {
        if (hour.t > nowMs) break;
        hit = hour;
    }
    return hit && nowMs - hit.t < 3_600_000 ? hit : null;
}

/** "Wave models differ": MFWAM's believed total against GFS Wave's, when they part by ×1.5 and 0.3 m. */
export function seaModelsDiffer(hour: SeaHour | null): { mfwamM: number; gfsM: number } | null {
    const mfwamM = hour?.total?.hM ?? null;
    const gfsM = hour?.checkM ?? null;
    if (mfwamM === null || gfsM === null) return null;
    const hi = Math.max(mfwamM, gfsM);
    const lo = Math.min(mfwamM, gfsM);
    // A hair of slack for float sums: 1.5 × 0.8 is 1.2000000000000002.
    return hi >= 1.5 * lo - 1e-9 && hi - lo >= 0.3 - 1e-9 ? { mfwamM, gfsM } : null;
}

/**
 * The line itself, NOAA credited beside GFS Wave's number: "Wave models
 * differ: MFWAM 0.8 m, GFS Wave (NOAA) 1.3 m". The rows' rule holds here too:
 * a height under 0.1 m is "under 0.1 m", never a 0.0 that reads as a
 * measured calm.
 */
export function seaDifferWords(differ: { mfwamM: number; gfsM: number }, height: (m: number) => string): string {
    const say = (m: number) => (m < SEA_PART_NONE_M ? `under ${height(SEA_PART_NONE_M)}` : height(m));
    return `Wave models differ: MFWAM ${say(differ.mfwamM)}, GFS Wave (NOAA) ${say(differ.gfsM)}`;
}

// ── Cache: the tap's own MFWAM cell × 1 h, the cell not the verdict ──

const CACHE_MAX = 120;
/** MFWAM's grid: 1/12°, its cell centres on odd multiples of 1/24° (services/weather/api/marine.ts). */
const CELLS_PER_DEG = 12;

interface CacheEntry {
    /** The point the reply answers, as it was sent. */
    asked: string;
    cell: Promise<SeaCell>;
}
const cache = new Map<string, CacheEntry>();

/**
 * Keyed on the 1/12° cell the tap lies in, and the clock hour. A 0.05°
 * bucket (5.5 km) straddles two of MFWAM's cells (9.3 km), so a second tap in
 * the neighbouring cell was measured against the first tap's cell centre and
 * refused in open water (130-04 review: 53.48, 3.02 refused at 8.0 km, its own
 * cell 2.8 km off). Keyed on its own cell, an open-water tap is guarded
 * against the cell it lies in.
 */
const cacheKey = (lat: number, lon: number, now: number): string =>
    `${Math.floor(lat * CELLS_PER_DEG)}:${Math.floor(lon * CELLS_PER_DEG)}:${Math.floor(now / 3_600_000)}`;

const askedFor = (lat: number, lon: number): string => {
    const params = seaRequestParams(lat, lon);
    return `${params.latitude},${params.longitude}`;
};

/** Drop the cache — for tests, and for a hard refresh. */
export function clearSeaPartitionsCache(): void {
    cache.clear();
}

function ask(key: string, lat: number, lon: number): Promise<SeaCell> {
    const cell = fetchOpenMeteoProxy<unknown>('marine', seaRequestParams(lat, lon)).then((reply) =>
        parseSeaCell(reply, Date.now()),
    );
    const entry: CacheEntry = { asked: askedFor(lat, lon), cell };
    cache.delete(key); // the newest goes to the back, so the oldest is dropped first
    cache.set(key, entry);
    // A failure is not remembered: the next tap asks again.
    cell.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
    });
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return cell;
}

/**
 * The sea at a point, ten days of hours. Rejects when the source fails or
 * answers nonsense; resolves `local: false` (no hours) where the model's cell
 * is too far away to be this water.
 *
 * A cached cell serves a second tap when the guard believes it for that tap.
 * When it does not, and the reply was to another point, this point asks for
 * itself before it is told "no sea here": in a dry cell (a berth, a tie on a
 * cell edge) its own answer can be a nearer wet cell than the first tap's.
 */
export async function fetchSeaPartitions(lat: number, lon: number, now: number = Date.now()): Promise<SeaPartitions> {
    const key = cacheKey(lat, lon, now);
    const hit = cache.get(key);
    if (hit) {
        const sea = guardSeaCell(await hit.cell, lat, lon);
        if (sea.local || hit.asked === askedFor(lat, lon)) return sea;
    }
    return guardSeaCell(await ask(key, lat, lon), lat, lon);
}
