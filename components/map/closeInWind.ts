/**
 * closeInWind — the maths and the shared readout behind the Obs wind's
 * close-in mode (Shane 2026-10-06, at z14 over Airlie Beach marina: "i turned
 * wind on, but nothing showed up ... we need a way to show wind close inshore
 * with a high zoom").
 *
 * Why the normal field fails there: leaflet-velocity draws a GEO field. Once
 * the whole screen sits inside one or two forecast grid cells the field is
 * uniform anyway, the density ramp has thinned the particles, and the
 * map-scaled speed makes a light breeze a few slow specks. So past a
 * threshold computed from the ACTIVE grid's spacing and the viewport, Obs
 * draws the local wind in SCREEN space instead: one uniform flow across the
 * view, at an on-screen speed that grows with the wind (CloseInWindLayer).
 *
 * Pure, DOM-free and leaflet-free, so the pill (MapWeatherControls) can read
 * the readout without importing the renderer.
 */
import { useSyncExternalStore } from 'react';
import type { WindGrid } from '../../services/weather/windGridEncoding';
import type { TimestampedMetric } from '../../services/NmeaStore';
import { NMEA_LIVE_MAX_AGE_MS, NMEA_USABLE_MAX_AGE_MS } from '../../services/nmea/nmeaCadence';
import { degreesToCardinal } from '../../utils/format';
import { convertSpeed } from '../../utils/units';

// ── Threshold ───────────────────────────────────────────────────

/**
 * Close-in starts when the screen spans fewer than this many grid cells, and
 * ends only once it spans more than CLOSE_IN_EXIT_CELLS. "Spans" is the square
 * root of the viewport's area in cells, so a phone turned on its side keeps
 * its mode. For ECMWF's 0.25 deg on a 390x844 phone at Airlie that is z10.02
 * in and z9.68 out: a third of a zoom level of hysteresis, so a camera that
 * settles at the edge cannot flicker between the two renderers.
 */
export const CLOSE_IN_ENTER_CELLS = 1.5;
export const CLOSE_IN_EXIT_CELLS = 1.9;

/** Mapbox GL's world is 512 px wide at z0. */
const MAPBOX_WORLD_PX_AT_Z0 = 512;

export interface GridSpacing {
    dxDeg: number;
    dyDeg: number;
}

/** Mean column/row spacing of the grid actually on screen; null if it has a single row or column. */
export function windGridSpacingDeg(grid: Pick<WindGrid, 'lats' | 'lons'> | null | undefined): GridSpacing | null {
    if (!grid || !Array.isArray(grid.lons) || !Array.isArray(grid.lats)) return null;
    const { lons, lats } = grid;
    if (lons.length < 2 || lats.length < 2) return null;
    const dxDeg = Math.abs(lons[lons.length - 1] - lons[0]) / (lons.length - 1);
    const dyDeg = Math.abs(lats[lats.length - 1] - lats[0]) / (lats.length - 1);
    return Number.isFinite(dxDeg) && Number.isFinite(dyDeg) && dxDeg > 0 && dyDeg > 0 ? { dxDeg, dyDeg } : null;
}

export interface ViewportScale {
    zoom: number;
    widthPx: number;
    heightPx: number;
    centreLat: number;
}

/**
 * How many grid cells the viewport spans: sqrt(cells across x cells down),
 * from the Mercator scale at the centre. Obs is north-up and flat (rotation
 * and pitch are disabled in useMapInit), so the centre scale is the view's.
 * Null when the viewport has not been measured: never guess a mode.
 */
export function viewportGridCells(view: ViewportScale, spacing: GridSpacing): number | null {
    const { zoom, widthPx, heightPx, centreLat } = view;
    if (![zoom, widthPx, heightPx, centreLat, spacing.dxDeg, spacing.dyDeg].every(Number.isFinite)) return null;
    if (widthPx <= 0 || heightPx <= 0 || spacing.dxDeg <= 0 || spacing.dyDeg <= 0) return null;
    const degPerPx = 360 / (MAPBOX_WORLD_PX_AT_Z0 * Math.pow(2, zoom));
    const lonSpan = widthPx * degPerPx;
    const latSpan = heightPx * degPerPx * Math.cos((Math.max(-85, Math.min(85, centreLat)) * Math.PI) / 180);
    return Math.sqrt((lonSpan / spacing.dxDeg) * (latSpan / spacing.dyDeg));
}

/** The mode after a settle, with hysteresis. */
export function nextCloseInMode(wasCloseIn: boolean, cells: number | null): boolean {
    if (cells === null || !Number.isFinite(cells)) return false;
    return wasCloseIn ? cells <= CLOSE_IN_EXIT_CELLS : cells < CLOSE_IN_ENTER_CELLS;
}

// ── Model sample ────────────────────────────────────────────────

const MS_TO_KT = 3600 / 1852;

/** Bracket `value` in an ascending axis: lower index and fraction, or null outside it. */
function bracket(axis: ArrayLike<number>, value: number): { i: number; t: number } | null {
    const n = axis.length;
    if (n < 2 || !Number.isFinite(value) || value < axis[0] || value > axis[n - 1]) return null;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (axis[mid] <= value) lo = mid;
        else hi = mid;
    }
    const span = axis[hi] - axis[lo];
    return { i: lo, t: span > 0 ? (value - axis[lo]) / span : 0 };
}

/**
 * The selected model's wind (m/s, u east, v north) at one point and a
 * fractional scrubber frame: the same vector interpolation leaflet-velocity
 * does between grid points, and the same frame blend windVelocityFrame does
 * between hours. Null outside the grid: an edge is never extrapolated.
 */
export function sampleWindGridAt(
    grid: WindGrid | null | undefined,
    frame: number,
    lat: number,
    lon: number,
): { u: number; v: number } | null {
    if (!grid || !Array.isArray(grid.lats) || !Array.isArray(grid.lons)) return null;
    const nx = Math.floor(grid.width);
    const ny = Math.floor(grid.height);
    const size = nx * ny;
    if (nx < 2 || ny < 2 || grid.lons.length !== nx || grid.lats.length !== ny) return null;
    const declared = Number.isFinite(grid.totalHours) ? Math.floor(grid.totalHours) : 0;
    const frames = Math.min(declared, grid.u?.length ?? 0, grid.v?.length ?? 0);
    if (frames < 1) return null;

    // The camera's longitude may be wrapped a world away from the grid's.
    let x: { i: number; t: number } | null = null;
    for (const candidate of [lon, lon + 360, lon - 360]) {
        x = bracket(grid.lons, candidate);
        if (x) break;
    }
    const y = bracket(grid.lats, lat);
    if (!x || !y) return null;

    const f = Math.max(0, Math.min(Number.isFinite(frame) ? frame : 0, frames - 1));
    const h0 = Math.floor(f);
    const h1 = Math.min(h0 + 1, frames - 1);
    const at = (field: Float32Array[], h: number): number | null => {
        const data = field[h];
        if (!data || data.length < size) return null;
        const i00 = y.i * nx + x.i;
        const corners = [data[i00], data[i00 + 1], data[i00 + nx], data[i00 + nx + 1]];
        if (!corners.every(Number.isFinite)) return null;
        const south = corners[0] * (1 - x.t) + corners[1] * x.t;
        const north = corners[2] * (1 - x.t) + corners[3] * x.t;
        return south * (1 - y.t) + north * y.t;
    };
    const u0 = at(grid.u, h0);
    const v0 = at(grid.v, h0);
    if (u0 === null || v0 === null) return null;
    const lerp = f - h0;
    const u1 = lerp > 0 ? at(grid.u, h1) : null;
    const v1 = lerp > 0 ? at(grid.v, h1) : null;
    // A malformed next frame holds the valid base frame, as the renderer does.
    if (u1 === null || v1 === null) return { u: u0, v: v0 };
    return { u: u0 * (1 - lerp) + u1 * lerp, v: v0 * (1 - lerp) + v1 * lerp };
}

export interface LocalWind {
    kt: number;
    /** Compass bearing the wind blows FROM (deg true); null = calm with no direction. */
    fromDeg: number | null;
}

/** m/s components → knots and the meteorological FROM bearing. */
export function windFromVector(u: number, v: number): { kt: number; fromDeg: number } {
    const fromDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
    return { kt: Math.hypot(u, v) * MS_TO_KT, fromDeg };
}

// ── Source arbitration ──────────────────────────────────────────

export type CloseInWindSource = 'boat' | 'model';

export interface CloseInWind extends LocalWind {
    source: CloseInWindSource;
    /** Boat instruments in the store's stale tier (6.5-13 s since the sample). */
    stale: boolean;
}

export interface BoatWind extends LocalWind {
    stale: boolean;
}

type BoatWindMetrics = Record<'tws' | 'twd' | 'twaSigned' | 'headingTrue', TimestampedMetric>;

/** live | stale | null(dead), from the metric's own clock — the watchdog's tag can lag. */
function usableAge(metric: TimestampedMetric | undefined, now: number): 'live' | 'stale' | null {
    if (!metric || metric.value === null || !Number.isFinite(metric.value)) return null;
    if (metric.freshness === 'dead') return null;
    const age = now - metric.lastUpdated;
    if (!Number.isFinite(age) || metric.lastUpdated <= 0 || age < -1000) return null;
    if (age <= NMEA_LIVE_MAX_AGE_MS) return 'live';
    return age <= NMEA_USABLE_MAX_AGE_MS ? 'stale' : null;
}

/**
 * The boat's own TRUE wind, as the Glass reads it: TWS with TWD (MWD, a
 * compass bearing), else the explicit true heading plus the signed TWA. Never
 * apparent wind, and never the legacy `heading`, whose reference is unknown.
 * Usable = the store's live and stale tiers (13 s); a dead reading is gone.
 * A calm boat with no direction still reads Calm.
 */
export function pickBoatTrueWind(state: BoatWindMetrics, now: number = Date.now()): BoatWind | null {
    const speed = usableAge(state.tws, now);
    const kt = state.tws.value;
    if (!speed || kt === null || kt < 0) return null;

    let fromDeg: number | null = null;
    let worst: 'live' | 'stale' = speed;
    const twd = usableAge(state.twd, now);
    if (twd) {
        fromDeg = state.twd.value!;
        if (twd === 'stale') worst = 'stale';
    } else {
        const heading = usableAge(state.headingTrue, now);
        const twa = usableAge(state.twaSigned, now);
        if (heading && twa) {
            fromDeg = state.headingTrue.value! + state.twaSigned.value!;
            if (heading === 'stale' || twa === 'stale') worst = 'stale';
        }
    }
    if (fromDeg === null && kt >= CLOSE_IN_CALM_KT) return null;
    return { kt, fromDeg: fromDeg === null ? null : ((fromDeg % 360) + 360) % 360, stale: worst === 'stale' };
}

/**
 * One source, never a blend: the boat's instruments when they are usable, the
 * boat is on screen and the scrubber is at now; otherwise the selected model
 * at the screen centre for the scrubbed hour.
 */
export function resolveCloseInWind(input: {
    boat: BoatWind | null;
    boatInView: boolean;
    scrubAtNow: boolean;
    model: LocalWind | null;
}): CloseInWind | null {
    const { boat, boatInView, scrubAtNow, model } = input;
    if (boat && boatInView && scrubAtNow)
        return { kt: boat.kt, fromDeg: boat.fromDeg, source: 'boat', stale: boat.stale };
    if (model) return { kt: model.kt, fromDeg: model.fromDeg, source: 'model', stale: false };
    return null;
}

/** The scrubber's own Near-now test (MapWeatherControls' wind branch). */
export function isWindScrubAtNow(windHour: number, windNowIdx: number | undefined): boolean {
    return Number.isFinite(windHour) && Number.isFinite(windNowIdx) && Math.round(windHour) === windNowIdx;
}

// ── Screen speed and density ────────────────────────────────────

/** Below 1 kt (Beaufort 0) the field is Calm. */
export const CLOSE_IN_CALM_KT = 1;
const CLOSE_IN_CALM_PX_S = 3;
const CLOSE_IN_BASE_PX_S = 10;
const CLOSE_IN_PX_S_PER_KT = 4.5;
export const CLOSE_IN_MAX_PX_S = 170;

/**
 * On-screen streak speed, CSS px per second: 24 at 3 kt (a drift, under a
 * pixel a frame), 78 at 15 kt (brisk), 145 at 30 kt (racing), capped from
 * 35.6 kt, where the colour ramp is already shouting. Linear, so twice the
 * wind reads about twice as fast. Calm is a near-still 3 px/s. Tuned on the
 * Relief harness: at 6 px/s per knot an 18 kt field read as rain.
 */
export function closeInScreenSpeed(kt: number): number {
    if (!Number.isFinite(kt) || kt < CLOSE_IN_CALM_KT) return CLOSE_IN_CALM_PX_S;
    return Math.min(CLOSE_IN_MAX_PX_S, CLOSE_IN_BASE_PX_S + CLOSE_IN_PX_S_PER_KT * kt);
}

/** One streak per this many CSS px² — about 235 on a 390x844 phone. */
const CLOSE_IN_PX2_PER_PARTICLE = 1400;
const CLOSE_IN_CALM_DENSITY = 0.3;

/** A fixed, comfortable population, scaled by the device tier (utils/deviceTier) and thinned for Calm. */
export function closeInParticleCount(widthPx: number, heightPx: number, kt: number, tierScale: number): number {
    if (!(widthPx > 0) || !(heightPx > 0)) return 0;
    const calm = !Number.isFinite(kt) || kt < CLOSE_IN_CALM_KT ? CLOSE_IN_CALM_DENSITY : 1;
    const tier = Number.isFinite(tierScale) && tierScale > 0 ? Math.min(1, tierScale) : 1;
    return Math.round(((widthPx * heightPx) / CLOSE_IN_PX2_PER_PARTICLE) * calm * tier);
}

// ── Readout ─────────────────────────────────────────────────────

const UNIT_LABEL: Record<string, string> = { kts: 'kt', mph: 'mph', kmh: 'km/h', mps: 'm/s' };

/** '8 kt SE' in the app's speed unit, the 16-point compass, wind FROM; 'Calm' below 1 kt. */
export function formatCloseInWind(wind: LocalWind, speedUnit: string | undefined): string {
    if (!Number.isFinite(wind.kt) || wind.kt < CLOSE_IN_CALM_KT) return 'Calm';
    const unit = speedUnit && UNIT_LABEL[speedUnit] ? speedUnit : 'kts';
    const converted = convertSpeed(wind.kt, unit) ?? wind.kt;
    const value = unit === 'mps' && converted < 10 ? converted.toFixed(1) : String(Math.round(converted));
    const point = wind.fromDeg === null ? '' : ` ${degreesToCardinal(((wind.fromDeg % 360) + 360) % 360)}`;
    return `${value} ${UNIT_LABEL[unit]}${point}`;
}

let readout: CloseInWind | null = null;
const readoutListeners = new Set<() => void>();

function sameReadout(a: CloseInWind | null, b: CloseInWind | null): boolean {
    if (a === null || b === null) return a === b;
    const deg = (d: number | null) => (d === null ? null : Math.round(d) % 360);
    return (
        a.source === b.source &&
        a.stale === b.stale &&
        Math.round(a.kt * 10) === Math.round(b.kt * 10) &&
        deg(a.fromDeg) === deg(b.fromDeg)
    );
}

/** Written by MapboxVelocityOverlay while close-in is showing; null otherwise. */
export function setCloseInWindReadout(next: CloseInWind | null): void {
    if (sameReadout(readout, next)) return;
    readout = next ? { ...next } : null;
    for (const listener of [...readoutListeners]) listener();
}

export function getCloseInWindReadout(): CloseInWind | null {
    return readout;
}

export function subscribeCloseInWindReadout(listener: () => void): () => void {
    readoutListeners.add(listener);
    return () => {
        readoutListeners.delete(listener);
    };
}

export function useCloseInWindReadout(): CloseInWind | null {
    return useSyncExternalStore(subscribeCloseInWindReadout, getCloseInWindReadout, getCloseInWindReadout);
}
