/**
 * Tropical-cyclone climatology along a planned route (W1-12).
 *
 * Data: public/climatology/tc-monthly-5deg.json, built from NOAA IBTrACS
 * v04r01 by scripts/build-tc-climatology.py — for every 5° box and calendar
 * month, WHICH tropical cyclones (34 kt+, tropical stage, 1991–2024, all
 * basins) passed through it. It is a static asset, fetched only when the
 * SeasonRiskCard mounts, never bundled into JS.
 *
 * "Near this route" (stated on the card):
 *  - the route is sampled every ROUTE_SAMPLE_STEP_NM along each leg, the short
 *    way across the antimeridian;
 *  - every 5° box whose nearest point is within NEAR_ROUTE_BUFFER_NM of a
 *    sample counts (true distance, not a lat/lon rectangle), so a route
 *    running just inside a box edge still sees the storms next door;
 *  - storms are unioned across those boxes, so a cyclone that crossed five of
 *    the route's boxes is ONE storm, not five.
 *
 * "Which month": every month a leg is under way, departure month through
 * arrival month (a 19 Dec → 8 Jan crossing is December AND January), each
 * counted over only the legs at sea that month. No date → whole-year strip
 * only.
 *
 * "In season": at least one storm a decade near the route that month
 * (count / years ≥ SEASON_MIN_STORMS_PER_YEAR).
 *
 * Coverage: IBTrACS holds what the RSMCs track, and none tracks the
 * Mediterranean's "medicanes" (Ianos 2020 and Daniel 2023 are not in it). A
 * route that enters the Med gets `mediterranean: true`, so the card can say a
 * 0 there is a gap in the data, not a measured absence of storms.
 *
 * This is climate, not a forecast, and storm counts, not intensities.
 */

export const TC_CLIMATOLOGY_URL = '/climatology/tc-monthly-5deg.json';
/** A box counts as near when any route sample lies within this distance of it. */
export const NEAR_ROUTE_BUFFER_NM = 60;
/** Spacing of route samples; well under the buffer so no box is skipped. */
export const ROUTE_SAMPLE_STEP_NM = 20;
/** One storm a decade near the route in a month marks that month as season. */
export const SEASON_MIN_STORMS_PER_YEAR = 0.1;

export const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
] as const;

export interface LatLon {
    lat: number;
    lon: number;
}

export interface TcClimatology {
    source: string;
    credit: string;
    accessed: string;
    firstYear: number;
    lastYear: number;
    years: number;
    boxDeg: number;
    minWindKt: number;
    storms: number;
    idWidth: number;
    /** "latSW,lonSW" → 12 month segments of concatenated storm tokens. */
    cells: Map<string, string[]>;
}

export interface RouteLeg {
    points: LatLon[];
    departureIso?: string | null;
    arrivalIso?: string | null;
}

export interface PlannedMonth {
    /** 0 = January. */
    month: number;
    count: number;
    inSeason: boolean;
}

export interface RouteSeason {
    /** Distinct storms near the whole route, per calendar month (0 = January). */
    monthly: number[];
    inSeason: boolean[];
    /** Months under way, in passage order, each over the legs at sea then. */
    planned: PlannedMonth[];
    years: number;
    firstYear: number;
    lastYear: number;
    boxCount: number;
    /** The route enters the Mediterranean, which IBTrACS does not cover (medicanes). */
    mediterranean: boolean;
}

// ── Parsing ──────────────────────────────────────────────────────────

const CELL_KEY = /^-?\d+,-?\d+$/;

function fail(why: string): never {
    throw new Error(`tc-climatology: ${why}`);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validate the static JSON; throws rather than show numbers it cannot vouch for. */
export function parseTcClimatology(raw: unknown): TcClimatology {
    if (!raw || typeof raw !== 'object') fail('not an object');
    const r = raw as Record<string, unknown>;
    if (r.format !== 'thalassa.tc-climatology') fail('unknown format');
    if (r.version !== 1) fail(`unsupported version ${String(r.version)}`);
    for (const k of ['source', 'credit', 'accessed'] as const) {
        if (typeof r[k] !== 'string' || !(r[k] as string)) fail(`missing ${k}`);
    }
    if (!isInt(r.firstYear) || !isInt(r.lastYear) || r.lastYear < r.firstYear) fail('bad year span');
    if (typeof r.boxDeg !== 'number' || !(r.boxDeg > 0)) fail('bad box size');
    if (typeof r.minWindKt !== 'number') fail('missing wind threshold');
    if (!isInt(r.storms) || r.storms < 0) fail('bad storm count');
    if (!isInt(r.idWidth) || r.idWidth < 1 || r.idWidth > 4) fail('bad id width');
    if (!r.cells || typeof r.cells !== 'object') fail('missing cells');
    const idWidth = r.idWidth;
    const cells = new Map<string, string[]>();
    for (const [key, value] of Object.entries(r.cells as Record<string, unknown>)) {
        if (!CELL_KEY.test(key)) fail(`bad cell key ${key}`);
        if (typeof value !== 'string') fail(`bad cell ${key}`);
        const months = value.split('|');
        if (months.length !== 12) fail(`cell ${key} has ${months.length} months`);
        if (months.some((m) => m.length % idWidth !== 0)) fail(`cell ${key} has a ragged storm list`);
        cells.set(key, months);
    }
    return {
        source: r.source as string,
        credit: r.credit as string,
        accessed: r.accessed as string,
        firstYear: r.firstYear,
        lastYear: r.lastYear,
        years: r.lastYear - r.firstYear + 1,
        boxDeg: r.boxDeg,
        minWindKt: r.minWindKt,
        storms: r.storms,
        idWidth,
        cells,
    };
}

// ── Loading (lazy, once) ─────────────────────────────────────────────

type FetchLike = (url: string) => Promise<Response>;

let cached: Promise<TcClimatology> | null = null;

/** Fetch + parse the static JSON once per session; a failure is not cached. */
export function loadTcClimatology(fetchImpl: FetchLike = (url) => fetch(url)): Promise<TcClimatology> {
    if (cached) return cached;
    const pending = (async () => {
        const res = await fetchImpl(TC_CLIMATOLOGY_URL);
        if (!res.ok) throw new Error(`tc-climatology: HTTP ${res.status}`);
        return parseTcClimatology(await res.json());
    })();
    cached = pending;
    pending.catch(() => {
        if (cached === pending) cached = null;
    });
    return pending;
}

export function __resetTcClimatologyCacheForTests(): void {
    cached = null;
}

// ── Route → boxes ────────────────────────────────────────────────────

const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Key of the box holding (lat, lon): its south-west corner, lon in [-180, 180). */
export function boxKey(lat: number, lon: number, boxDeg = 5): string {
    const la = Math.min(Math.max(lat, -90), 90 - 1e-9);
    const latSw = Math.floor(la / boxDeg) * boxDeg;
    const lonSw = Math.floor(wrapLon(lon) / boxDeg) * boxDeg;
    // `${-0}` is "0", so the equator and prime meridian key cleanly.
    return `${latSw},${lonSw}`;
}

const EARTH_RADIUS_NM = 3440.065;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const h =
        Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Adds every box whose nearest point lies within `bufferNm` of (lat, lon). */
function addBoxesAround(out: Set<string>, lat: number, lon: number, boxDeg: number, bufferNm: number): void {
    // Candidates: the lat/lon rectangle around the sample (a superset)...
    const bLat = bufferNm / 60;
    const bLon = bufferNm / (60 * Math.max(Math.cos(toRad(lat)), 0.1));
    const lat0 = Math.max(lat - bLat, -90);
    const lat1 = Math.min(lat + bLat, 90 - 1e-9);
    for (let la = Math.floor(lat0 / boxDeg) * boxDeg; la <= lat1; la += boxDeg) {
        for (let lo = Math.floor((lon - bLon) / boxDeg) * boxDeg; lo <= lon + bLon; lo += boxDeg) {
            // ...kept only when the box's nearest point is truly within the
            // buffer: a rectangle's corners reach ~85 NM at 60 NM. `lo` is in
            // the sample's own (unwrapped) longitude frame, so clamping is safe
            // across 180°.
            const nearLat = clamp(lat, la, la + boxDeg);
            const nearLon = clamp(lon, lo, lo + boxDeg);
            if (haversineNm(lat, lon, nearLat, nearLon) <= bufferNm) out.add(boxKey(la, lo, boxDeg));
        }
    }
}

/** Visits the route every ROUTE_SAMPLE_STEP_NM, the short way across 180° (longitudes unwrapped). */
function sampleRoute(points: LatLon[], visit: (lat: number, lon: number) => void): void {
    const pts = points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    if (pts.length === 0) return;
    let prevLat = pts[0].lat;
    let prevLon = pts[0].lon;
    visit(prevLat, prevLon);
    for (let i = 1; i < pts.length; i++) {
        const lat = pts[i].lat;
        // Unwrap so 179°E → 179°W is 2° east, not 358° west.
        const lon = prevLon + wrapLon(pts[i].lon - prevLon);
        const midCos = Math.max(Math.cos(toRad((prevLat + lat) / 2)), 0.1);
        const distNm = Math.hypot((lat - prevLat) * 60, (lon - prevLon) * 60 * midCos);
        const steps = Math.max(1, Math.ceil(distNm / ROUTE_SAMPLE_STEP_NM));
        for (let s = 1; s <= steps; s++) {
            const f = s / steps;
            visit(prevLat + (lat - prevLat) * f, prevLon + (lon - prevLon) * f);
        }
        prevLat = lat;
        prevLon = lon;
    }
}

/** Every box within `bufferNm` of the route, sampled every ROUTE_SAMPLE_STEP_NM. */
export function boxesNearRoute(points: LatLon[], boxDeg = 5, bufferNm = NEAR_ROUTE_BUFFER_NM): Set<string> {
    const out = new Set<string>();
    sampleRoute(points, (lat, lon) => addBoxesAround(out, lat, lon, boxDeg, bufferNm));
    return out;
}

/**
 * The Mediterranean (Gibraltar to the Levant, Adriatic to the Gulf of Sidra),
 * where IBTrACS has no coverage: no RSMC tracks medicanes. A rough water box
 * is enough because routes are at sea: 30–46°N, 5.6°W–36.5°E, less the Bay of
 * Biscay (north of 43.2°N, west of 0°) and the Black Sea (north of 41.15°N,
 * east of 27.4°E). The Gulf of Cádiz, west of Tarifa, is Atlantic.
 */
export function inMediterranean(lat: number, lon: number): boolean {
    const lo = wrapLon(lon);
    if (lat < 30 || lat > 46 || lo < -5.6 || lo > 36.5) return false;
    if (lat > 43.2 && lo < 0) return false;
    if (lat > 41.15 && lo > 27.4) return false;
    return true;
}

function routeEntersMediterranean(points: LatLon[]): boolean {
    let found = false;
    sampleRoute(points, (lat, lon) => {
        if (!found && inMediterranean(lat, lon)) found = true;
    });
    return found;
}

/** Distinct storms across `boxes` in `month` (0 = January). */
export function stormsNearBoxes(clim: TcClimatology, boxes: Iterable<string>, month: number): number {
    const seen = new Set<string>();
    const w = clim.idWidth;
    for (const key of boxes) {
        const segment = clim.cells.get(key)?.[month];
        if (!segment) continue;
        for (let i = 0; i < segment.length; i += w) seen.add(segment.slice(i, i + w));
    }
    return seen.size;
}

export function isInSeason(count: number, years: number): boolean {
    return years > 0 && count / years >= SEASON_MIN_STORMS_PER_YEAR;
}

// ── Dates → months ───────────────────────────────────────────────────

const parseIso = (iso: string | null | undefined): Date | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t) : null;
};

/** Every month the leg is under way (device-local calendar, as the sheet shows dates), max 12. */
export function monthsUnderWay(
    departureIso: string | null | undefined,
    arrivalIso: string | null | undefined,
): number[] {
    const dep = parseIso(departureIso);
    if (!dep) return [];
    const arr = parseIso(arrivalIso);
    const months = [dep.getMonth()];
    if (!arr || arr.getTime() <= dep.getTime()) return months;
    let y = dep.getFullYear();
    let m = dep.getMonth();
    const endY = arr.getFullYear();
    const endM = arr.getMonth();
    while ((y < endY || (y === endY && m < endM)) && months.length < 12) {
        m += 1;
        if (m === 12) {
            m = 0;
            y += 1;
        }
        months.push(m);
    }
    return months;
}

// ── Route season ─────────────────────────────────────────────────────

/** The season along the route: a 12-month strip, plus the months the legs are at sea. */
export function assessRouteSeason(clim: TcClimatology, legs: RouteLeg[]): RouteSeason | null {
    const legBoxes = legs.map((leg) => boxesNearRoute(leg.points ?? [], clim.boxDeg));
    const all = new Set<string>();
    for (const boxes of legBoxes) for (const key of boxes) all.add(key);
    if (all.size === 0) return null;

    const monthly = Array.from({ length: 12 }, (_, m) => stormsNearBoxes(clim, all, m));
    const inSeason = monthly.map((n) => isInSeason(n, clim.years));

    const byMonth = new Map<number, Set<string>>();
    legs.forEach((leg, i) => {
        if (legBoxes[i].size === 0) return;
        for (const m of monthsUnderWay(leg.departureIso, leg.arrivalIso)) {
            const boxes = byMonth.get(m) ?? new Set<string>();
            for (const key of legBoxes[i]) boxes.add(key);
            byMonth.set(m, boxes);
        }
    });
    const planned = [...byMonth].map(([month, boxes]) => {
        const count = stormsNearBoxes(clim, boxes, month);
        return { month, count, inSeason: isInSeason(count, clim.years) };
    });

    return {
        monthly,
        inSeason,
        planned,
        years: clim.years,
        firstYear: clim.firstYear,
        lastYear: clim.lastYear,
        boxCount: all.size,
        mediterranean: legs.some((leg) => routeEntersMediterranean(leg.points ?? [])),
    };
}

// ── Trip legs → geometry ─────────────────────────────────────────────

/** The voyage-row fields this needs (a Voyage, optionally with the planner's geometry). */
export interface TripLegLike {
    id: string;
    departure_port: string | null;
    destination_port: string | null;
    departure_time: string | null;
    eta: string | null;
    saved_route_id?: string | null;
    routeCoordinates?: LatLon[];
    departureCoords?: LatLon;
    arrivalCoords?: LatLon;
    durationHours?: number;
}

/** A saved planned route (RoutesAndTracks' RouteOrTrack, structurally). */
export interface PlannedRouteLike {
    label: string;
    points: LatLon[];
    linkedPlanId?: string;
    savedRouteId?: string;
}

const usable = (pts: LatLon[] | undefined | null): LatLon[] | null => {
    const ok = (pts ?? []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    return ok.length >= 2 ? ok.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
};

const normLabel = (s: string): string => s.trim().toLowerCase();

/**
 * The leg's route: its own saved geometry, else the planned route linked to
 * this voyage id, else the canonical saved route, else the "A → B" label the
 * Trip Overview already matches on, else a straight line between known ends.
 */
export function resolveLegGeometry(leg: TripLegLike, routes: PlannedRouteLike[]): LatLon[] | null {
    const own = usable(leg.routeCoordinates);
    if (own) return own;
    const linked = routes.find((r) => r.linkedPlanId && r.linkedPlanId === leg.id);
    if (linked && usable(linked.points)) return usable(linked.points);
    if (leg.saved_route_id) {
        const saved = routes.find((r) => r.savedRouteId === leg.saved_route_id);
        if (saved && usable(saved.points)) return usable(saved.points);
    }
    if (leg.departure_port && leg.destination_port) {
        const want = normLabel(`${leg.departure_port} → ${leg.destination_port}`);
        const byLabel = routes.find((r) => normLabel(r.label) === want);
        if (byLabel && usable(byLabel.points)) return usable(byLabel.points);
    }
    if (leg.departureCoords && leg.arrivalCoords) return usable([leg.departureCoords, leg.arrivalCoords]);
    return null;
}

/** Arrival: the ETA, else departure + the planned duration, else unknown. */
export function legArrivalIso(leg: TripLegLike): string | null {
    if (parseIso(leg.eta)) return leg.eta;
    const dep = parseIso(leg.departure_time);
    if (dep && typeof leg.durationHours === 'number' && leg.durationHours > 0) {
        return new Date(dep.getTime() + leg.durationHours * 3_600_000).toISOString();
    }
    return null;
}
