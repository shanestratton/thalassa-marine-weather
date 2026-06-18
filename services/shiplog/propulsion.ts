/**
 * propulsion — heuristic sail-vs-motor ESTIMATE for spans the skipper
 * didn't declare with the engine toggle.
 *
 * Honesty first: this is a best-guess from GPS speed/course + the
 * FORECAST wind on each entry (not measured apparent wind, no engine
 * RPM). It returns 'unknown' rather than guess when the signal is weak
 * or wind data is missing (common offshore). The declared engine state
 * always wins; this only fills the gaps, and the UI labels it estimated.
 *
 * Signals, strongest first:
 *   1. No-go zone — a sailboat can't sail closer than ~35° to the true
 *      wind. Moving + heading into that cone ⇒ motor.
 *   2. Calm but moving — < ~3 kt wind but making way ⇒ motor.
 *   3. Outrunning the wind — a displacement cruiser won't notably exceed
 *      true wind speed; clearly faster ⇒ motor.
 *   4. Otherwise, adequate wind + plausible speed + not upwind ⇒ sail.
 */
import type { ShipLogEntry } from '../../types';

export type Propulsion = 'motor' | 'sail' | 'unknown';

const CARDINALS_16 = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
];

/** 16-point cardinal ("NNE") → degrees (the direction the wind is FROM). */
export function cardinalToDegrees(cardinal: string | null | undefined): number | null {
    if (!cardinal) return null;
    const i = CARDINALS_16.indexOf(cardinal.trim().toUpperCase());
    return i < 0 ? null : i * 22.5;
}

/** Smallest angle between two bearings, 0–180. */
function angularDiff(a: number, b: number): number {
    const d = Math.abs(((a - b + 540) % 360) - 180);
    return d;
}

// Tunables.
const MOVING_KTS = 0.8; // below this we're drifting/anchored — unknown
const CALM_WIND_KTS = 3; // nothing to sail with below this
const NOGO_DEG = 35; // can't sail closer than this to the wind
const SAIL_MIN_WIND_KTS = 5; // need at least this much to call it sailing

/**
 * Estimate propulsion for a single track point. Pure. Conservative:
 * only calls 'motor' on a clear physical can't-be-sailing signal, only
 * 'sail' when conditions plainly support it, else 'unknown'.
 */
export function estimatePropulsion(
    e: Pick<ShipLogEntry, 'speedKts' | 'courseDeg' | 'windSpeed' | 'windDirection'>,
): Propulsion {
    const sog = e.speedKts;
    if (typeof sog !== 'number' || sog < MOVING_KTS) return 'unknown';
    const wind = e.windSpeed;
    if (typeof wind !== 'number') return 'unknown'; // no wind data → can't judge

    // 2. Calm but moving.
    if (wind < CALM_WIND_KTS && sog > 2.5) return 'motor';

    // 1. No-go zone — heading within NOGO_DEG of where the wind comes from.
    const windFrom = cardinalToDegrees(e.windDirection);
    if (windFrom != null && typeof e.courseDeg === 'number') {
        if (angularDiff(e.courseDeg, windFrom) < NOGO_DEG && sog > 2) return 'motor';
    }

    // 3. Outrunning the wind (heavy cruiser can't, much).
    if (sog > wind * 1.2 + 1.5) return 'motor';

    // 4. Clearly sailable: adequate wind, plausible speed, not upwind.
    if (wind >= SAIL_MIN_WIND_KTS && sog >= 1 && sog <= wind * 1.1 + 1) return 'sail';

    return 'unknown';
}
