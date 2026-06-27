/**
 * windOverTide — the wind-vs-tide relationship for the Glass-page tide flip.
 *
 * "Wind over tide" is the sailor's danger case: when the wind blows AGAINST the
 * tidal stream, the waves stack up short and steep. This module is the pure,
 * tested core of that judgement.
 *
 * CONVENTIONS (important — get these wrong and the warning inverts):
 *  - windDeg = direction the wind blows FROM (meteorological — same as the
 *    forecast windDegree the arrows rotate +180 to point "to").
 *  - streamDeg / floodDir / currentDir = direction the water flows TOWARD
 *    (oceanographic "set").
 *
 * Wind-over-tide ⇒ wind blows against the flow. Wind blows toward (windDeg+180);
 * stream flows toward streamDeg; opposed when (windDeg+180) ≈ streamDeg+180,
 * i.e. when windDeg(FROM) ≈ streamDeg(TOWARD). So a SMALL angle between the
 * wind-FROM bearing and the stream-TOWARD bearing means they oppose = chop.
 */

export type TidePhase = 'flood' | 'ebb' | 'slack';
export type WindTideRelation = 'with' | 'against' | 'cross' | 'unknown';

const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** Smallest absolute angle between two bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
    let d = Math.abs(norm360(a) - norm360(b)) % 360;
    if (d > 180) d = 360 - d;
    return d;
}

/**
 * Ebb/flood from two consecutive tide heights. Rising = flood, falling = ebb,
 * effectively level (near a high/low) = slack.
 */
export function tidePhase(currentHeight: number, nextHeight: number, slackEps = 0.03): TidePhase {
    const diff = nextHeight - currentHeight;
    if (Math.abs(diff) <= slackEps) return 'slack';
    return diff > 0 ? 'flood' : 'ebb';
}

/**
 * Direction the tidal stream FLOWS TOWARD at this phase.
 * - With a user-set flood direction (the way the stream runs on a rising tide):
 *   flood ⇒ floodDir, ebb ⇒ floodDir+180. True tidal stream — most accurate.
 * - Otherwise fall back to the modelled current direction (tide-dominated near
 *   the coast, but not purely tidal). Null when neither is known.
 */
export function streamDirection(
    phase: TidePhase,
    floodDir: number | null | undefined,
    modelledCurrentDir: number | null | undefined,
): number | null {
    if (floodDir != null && Number.isFinite(floodDir)) {
        if (phase === 'flood') return norm360(floodDir);
        if (phase === 'ebb') return norm360(floodDir + 180);
        return null; // slack — no meaningful stream direction
    }
    return modelledCurrentDir != null && Number.isFinite(modelledCurrentDir) ? norm360(modelledCurrentDir) : null;
}

export interface WindTideResult {
    relation: WindTideRelation;
    /** Angle (0..180) between wind-FROM and stream-TOWARD. Small = against. */
    angle: number | null;
    /** True when opposed AND both wind and stream are strong enough to kick up steep chop. */
    windOverTide: boolean;
    /** Whether the stream direction came from a user flood-direction (true) or modelled current (false). */
    streamFromSetting: boolean;
    label: string;
}

/** Thresholds at which opposed wind + stream actually produce dangerous steep chop. */
export const WIND_OVER_TIDE_WIND_KTS = 12;
export const WIND_OVER_TIDE_CURRENT_KTS = 0.7;

export function windVsTide(args: {
    windDeg: number | null | undefined; // FROM
    windKts: number | null | undefined;
    streamDeg: number | null | undefined; // TOWARD
    currentKts: number | null | undefined;
    streamFromSetting?: boolean;
}): WindTideResult {
    const { windDeg, windKts, streamDeg, currentKts, streamFromSetting = false } = args;

    if (windDeg == null || !Number.isFinite(windDeg) || streamDeg == null || !Number.isFinite(streamDeg)) {
        return {
            relation: 'unknown',
            angle: null,
            windOverTide: false,
            streamFromSetting,
            label: 'Stream direction unavailable',
        };
    }

    const angle = angleBetween(windDeg, streamDeg);
    let relation: WindTideRelation;
    if (angle < 60) relation = 'against';
    else if (angle > 120) relation = 'with';
    else relation = 'cross';

    const windOverTide =
        relation === 'against' &&
        (windKts ?? 0) >= WIND_OVER_TIDE_WIND_KTS &&
        (currentKts ?? 0) >= WIND_OVER_TIDE_CURRENT_KTS;

    const label =
        relation === 'against'
            ? windOverTide
                ? 'Wind over tide — expect short, steep chop'
                : 'Wind against the stream'
            : relation === 'with'
              ? 'Wind with the stream — easier going'
              : 'Wind across the stream';

    return { relation, angle, windOverTide, streamFromSetting, label };
}
