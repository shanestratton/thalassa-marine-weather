/**
 * Quality control shared by every buoy network (build 123, W1-11).
 *
 * Near-real-time buoy data is not quality-assured by its publishers, and the
 * failure modes are concrete, all seen live on 2026-10-07:
 *   - sentinels: `MM` (NDBC), `-99.90` (Queensland), `-999` (Irish fill),
 *     `-99` (NDBC spectral MWD), `0` as a period (KMA via NDBC);
 *   - `0,0` positions on three Queensland port buoys when their GPS drops;
 *   - flat zeros: 0.0 m rows from a dead sensor (one live today, and KMA rows
 *     sat at 0.0 for hours). A 0.0 is not a calm sea anyone can vouch for;
 *   - rows that are hours old, or stamped in the future by a bad clock.
 * A rejected row is skipped, so a network with several rows per station falls
 * back to that station's previous good one.
 */
import type { BuoyObs } from './types';

/** Older than this, a reading is history, not "measured nearby". */
export const BUOY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Clock-skew allowance before a row counts as from the future. */
const FUTURE_SLACK_MS = 15 * 60 * 1000;

/**
 * A number from a feed cell, or null when the cell is empty, non-numeric or a
 * sentinel. Every network's missing-value code is ≤ -99 or textual.
 */
export function reading(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '' || text === 'MM') return null;
    const value = typeof text === 'number' ? text : Number(text);
    if (!Number.isFinite(value) || value <= -99) return null;
    return value;
}

const within = (value: number | null, lo: number, hi: number): number | null =>
    value !== null && value >= lo && value <= hi ? value : null;

/** A real position (not 0,0 or a fill value) and a time that is recent and not in the future. */
export function placedAndFresh(obs: BuoyObs, nowMs: number): boolean {
    const { lat, lon, time } = obs;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    if (lat === 0 && lon === 0) return false;
    return Number.isFinite(time) && time <= nowMs + FUTURE_SLACK_MS && nowMs - time <= BUOY_MAX_AGE_MS;
}

/**
 * The observation as it may be shown, or null when it is not a usable wave
 * reading at `nowMs`. Out-of-range secondary readings are blanked rather than
 * sinking the row: a good height with a garbled period is still a height.
 */
export function qcObservation(obs: BuoyObs, nowMs: number): BuoyObs | null {
    if (!placedAndFresh(obs, nowMs)) return null;
    const { hsM } = obs;
    // Flat zero and absurd heights (NDBC writes 99.00 for missing in some files).
    if (hsM === null || !(hsM > 0) || hsM > 25) return null;
    return {
        ...obs,
        periodS: within(obs.periodS, 1, 30),
        fromDeg: within(obs.fromDeg, 0, 360),
        sstC: within(obs.sstC, -2, 36),
    };
}
