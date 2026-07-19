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

/**
 * How confident we are that the stream is actually running hard enough to
 * stack the sea up.
 *
 *  - 'measured'  — we have a current speed in knots and it clears the bar.
 *  - 'inferred'  — no speed, but the tide is demonstrably running (not slack)
 *                  and, where we know it, the spring/neap ratio says the
 *                  streams are lively.
 *  - 'unknown'   — the tide is running but we have nothing to say about how
 *                  hard. NOT the same as "weak".
 *  - 'below'     — we have a speed and it is genuinely too slow to matter.
 */
export type StreamConfidence = 'measured' | 'inferred' | 'unknown' | 'below';

export interface WindTideResult {
    relation: WindTideRelation;
    /** Angle (0..180) between wind-FROM and stream-TOWARD. Small = against. */
    angle: number | null;
    /** True when opposed AND the stream is — or is very likely — running hard. */
    windOverTide: boolean;
    /** How the stream-strength judgement was reached. Drive UI hedging off this. */
    confidence: StreamConfidence;
    /** Whether the stream direction came from a user flood-direction (true) or modelled current (false). */
    streamFromSetting: boolean;
    label: string;
}

/** Thresholds at which opposed wind + stream actually produce dangerous steep chop. */
export const WIND_OVER_TIDE_WIND_KTS = 12;
export const WIND_OVER_TIDE_CURRENT_KTS = 0.7;

/**
 * Wind speed above which opposed wind kicks up steep chop even on a modest
 * stream. Above this we warn on tidal phase alone rather than staying silent
 * for want of a current speed.
 */
export const WIND_OVER_TIDE_WIND_KTS_NO_SPEED = 18;

/**
 * Spring/neap ratio (this cycle's range ÷ the location's typical range) above
 * which tidal streams run noticeably harder. Dimensionless on purpose: an
 * absolute metre threshold is meaningless across a global user base, where
 * ranges run from ~0.3 m in the Mediterranean to >12 m in the Bay of Fundy.
 */
export const SPRING_TIDE_RATIO = 1.15;

/**
 * Judge stream strength without assuming absence of data means absence of danger.
 *
 * A missing current speed used to coalesce to 0, which silently failed the
 * `>= 0.7 kt` test and suppressed the warning entirely. That is the wrong way
 * round for a safety cue: not knowing how hard the stream runs is not the same
 * as knowing it runs slowly.
 *
 * No global model resolves tidal streams in a narrow entrance anyway — inside
 * Moreton Bay the best available product peaks around 0.8 kt against a real
 * flood of several knots — so a knots threshold was never going to carry this
 * on its own. Tidal phase and spring/neap state are the honest signal.
 */
function judgeStreamStrength(
    currentKts: number | null | undefined,
    windKts: number | null | undefined,
    phase: TidePhase | null | undefined,
    springNeapRatio: number | null | undefined,
): StreamConfidence {
    // Slack water is the one case where "no stream" is a positive finding.
    if (phase === 'slack') return 'below';

    if (currentKts != null && Number.isFinite(currentKts)) {
        return currentKts >= WIND_OVER_TIDE_CURRENT_KTS ? 'measured' : 'below';
    }

    // No speed available. Fall back to what we can actually stand behind.
    if ((windKts ?? 0) >= WIND_OVER_TIDE_WIND_KTS_NO_SPEED) return 'inferred';
    if (springNeapRatio != null && Number.isFinite(springNeapRatio) && springNeapRatio >= SPRING_TIDE_RATIO) {
        return 'inferred';
    }
    return 'unknown';
}

export function windVsTide(args: {
    windDeg: number | null | undefined; // FROM
    windKts: number | null | undefined;
    streamDeg: number | null | undefined; // TOWARD
    currentKts: number | null | undefined;
    streamFromSetting?: boolean;
    /** Tide phase, when known. Slack is the only state that positively rules out a stream. */
    phase?: TidePhase | null;
    /** This cycle's tidal range ÷ the location's typical range. Dimensionless — see SPRING_TIDE_RATIO. */
    springNeapRatio?: number | null;
}): WindTideResult {
    const {
        windDeg,
        windKts,
        streamDeg,
        currentKts,
        streamFromSetting = false,
        phase = null,
        springNeapRatio = null,
    } = args;

    if (windDeg == null || !Number.isFinite(windDeg) || streamDeg == null || !Number.isFinite(streamDeg)) {
        return {
            relation: 'unknown',
            angle: null,
            windOverTide: false,
            confidence: 'unknown',
            streamFromSetting,
            label: 'Stream direction unavailable',
        };
    }

    const angle = angleBetween(windDeg, streamDeg);
    let relation: WindTideRelation;
    if (angle < 60) relation = 'against';
    else if (angle > 120) relation = 'with';
    else relation = 'cross';

    const confidence = judgeStreamStrength(currentKts, windKts, phase, springNeapRatio);
    const windStrong = (windKts ?? 0) >= WIND_OVER_TIDE_WIND_KTS;

    // Warn on a measured stream, or on an inferred one — the latter covers the
    // common case of strong opposed wind over a running tide with no current
    // feed. 'unknown' does not raise the flag, but the label says so rather
    // than rendering as though conditions were benign.
    const windOverTide =
        relation === 'against' && windStrong && (confidence === 'measured' || confidence === 'inferred');

    let label: string;
    if (relation === 'with') {
        label = 'Wind with the stream — easier going';
    } else if (relation === 'cross') {
        label = 'Wind across the stream';
    } else if (windOverTide) {
        label =
            confidence === 'measured'
                ? 'Wind over tide — expect short, steep chop'
                : 'Wind over tide likely — expect short, steep chop';
    } else if (confidence === 'unknown' && windStrong) {
        label = 'Wind against the stream — stream strength unknown';
    } else {
        label = 'Wind against the stream';
    }

    return { relation, angle, windOverTide, confidence, streamFromSetting, label };
}
