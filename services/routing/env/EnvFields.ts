/**
 * Environmental field contracts — Masterplan §5 / Phase 7.
 *
 * The physics layer of the routing stack: tide, current, wind and vessel
 * speed behind small, NULL-TOLERANT, provenance-tagged interfaces, so the
 * degradation ladder is a property of the TYPES — a consumer holding a
 * TideField never needs to know whether it came from billed station
 * heights, free cosine-from-extremes, or doesn't exist at all (null).
 *
 * DOCTRINE (enforced in review, masterplan §3 Phase 7 / §7):
 *   tide changes FEASIBILITY AND TIMING, never preference ordering.
 *   No consumer of these fields may use tide height to make one route
 *   GEOMETRY cheaper than another — only to label, gate, or time it.
 *
 * Everything here is pure and synchronous once constructed; all
 * construction inputs are plain data (testable without mocks).
 */

import type { TideCurve } from '../../TideHeightService';

// ── Provenance ──────────────────────────────────────────────────────

/** How a tide field was built — drives the "approx" labelling in UI. */
export type TideProvenance = 'STATION_HEIGHTS' | 'EXTREMES_INTERP' | 'NONE';

// ── Tide ────────────────────────────────────────────────────────────

export interface TideField {
    /** Metres above LAT at `timeMs`, or null outside the curve's range
     *  (callers must NOT extrapolate guess-tides). */
    heightAt(timeMs: number): number | null;
    /**
     * Earliest time ≥ `fromMs` at which the tide reaches `metres` or
     * higher, searched up to `untilMs`. Null if it never does within the
     * window (or the curve doesn't cover it). The primitive behind
     * "bar opens at 09:40".
     */
    nextTimeAtOrAbove(metres: number, fromMs: number, untilMs: number): number | null;
    /** Inclusive [startMs, endMs] the field can answer for. */
    coverage(): [number, number];
    provenance: TideProvenance;
}

/**
 * TideField over an interpolated curve (either provenance). The search
 * step is 5 minutes — fine enough for window edges that Phase 7 pads by
 * 30 minutes anyway, cheap enough to sweep days.
 */
export function tideFieldFromCurve(curve: TideCurve): TideField {
    const SEARCH_STEP_MS = 5 * 60_000;
    const [covStart, covEnd] = curve.rangeMs;
    return {
        provenance: curve.provenance,
        heightAt: (timeMs) => curve.heightAt(timeMs),
        coverage: () => [covStart, covEnd],
        nextTimeAtOrAbove(metres, fromMs, untilMs) {
            const start = Math.max(fromMs, covStart);
            const end = Math.min(untilMs, covEnd);
            for (let t = start; t <= end; t += SEARCH_STEP_MS) {
                const h = curve.heightAt(t);
                if (h !== null && h >= metres) return t;
            }
            return null;
        },
    };
}

// ── Current + wind (Phase 8 consumers; contracts land with the layer) ──

export interface Vector2 {
    /** East component, m/s. */
    u: number;
    /** North component, m/s. */
    v: number;
}

export interface CurrentField2D {
    /** Surface current at a point/time, or null where unknown. ETA-ONLY
     *  consumer contract: ≈1/12° source data cannot resolve channel
     *  jets — never use for feasibility. */
    currentAt(lat: number, lon: number, timeMs: number): Vector2 | null;
    provenance: 'CMEMS_HOURLY' | 'ESTIMATE' | 'NONE';
}

export interface WindField2D {
    /** 10 m wind at a point/time, or null where unknown. */
    windAt(lat: number, lon: number, timeMs: number): Vector2 | null;
    provenance: 'GFS' | 'OPEN_METEO' | 'NONE';
}

// ── Vessel speed ────────────────────────────────────────────────────

export interface SpeedModel {
    /** Speed through water on a leg, m/s. Phase 7 uses a constant; a
     *  polar-table model slots in behind the same call later. */
    stwMs(): number;
}

const KTS_TO_MS = 0.514444;
/** App-wide default when the vessel has no cruising speed set (kn). */
export const DEFAULT_CRUISING_KTS = 6;

/**
 * Constant-STW model from the vessel profile's cruisingSpeed (KNOTS —
 * same field + default departureWindow.ts already uses). Non-finite or
 * non-positive input falls back to DEFAULT_CRUISING_KTS.
 */
export function motoringSpeedModel(cruisingSpeedKts?: number | null): SpeedModel {
    const kts =
        typeof cruisingSpeedKts === 'number' && isFinite(cruisingSpeedKts) && cruisingSpeedKts > 0
            ? cruisingSpeedKts
            : DEFAULT_CRUISING_KTS;
    const ms = kts * KTS_TO_MS;
    return { stwMs: () => ms };
}
