import {
    INSTRUMENT_LIVE_AGE_MS,
    simultaneous,
    speedVector,
    TRUE,
    usableReading,
    wrapDegrees,
    type InstrumentEvidence,
} from './measurements';

export type CurrentRefusal =
    | 'no-instruments'
    | 'true-heading-required'
    | 'ground-vector-required'
    | 'water-speed-required'
    | 'not-simultaneous'
    | 'too-slow'
    | 'leeway-unusable'
    | 'implausible-current';
export interface MeasuredCurrent {
    kind: 'available';
    provenance: 'instrument-derived';
    identity: string;
    via: InstrumentEvidence['via'];
    eastKts: number;
    northKts: number;
    driftKts: number;
    /** Set is where the water moves TO, true north; near-zero drift has no direction. */
    setTrueDeg: number | null;
    observedAt: number;
    computedAt: number;
    freshness: 'live' | 'stale';
    leewayDeg: number | null;
    leewaySource: string | null;
    sources: readonly string[];
}
export type MeasuredCurrentResult = MeasuredCurrent | { kind: 'unavailable'; reason: CurrentRefusal };
export const CURRENT_MIN_STW_KTS = 1.5;
export const CURRENT_MIN_SOG_KTS = 1;
export const CURRENT_MAX_DRIFT_KTS = 20;
export const CURRENT_DIRECTION_FLOOR_KTS = 0.05;

/** Ground motion minus water motion. Leeway is an optional measured/explicit signed angle, never a hull guess. */
export function measuredCurrent(evidence: InstrumentEvidence | null | undefined, now: number): MeasuredCurrentResult {
    const no = (reason: CurrentRefusal): MeasuredCurrentResult => ({ kind: 'unavailable', reason });
    if (!evidence || !evidence.identity || !Number.isFinite(now) || now <= 0) return no('no-instruments');
    const { sog, cogTrue, stw, headingTrue, leeway } = evidence.readings;
    if (!usableReading(headingTrue, 'degrees', now, 0, 360, 'true')) return no('true-heading-required');
    if (!usableReading(sog, 'knots', now, 0, 100, 'ground') || !usableReading(cogTrue, 'degrees', now, 0, 360, 'true'))
        return no('ground-vector-required');
    if (!usableReading(stw, 'knots', now, 0, 100, 'water')) return no('water-speed-required');
    const readings = [sog, cogTrue, stw, headingTrue];
    if (leeway) {
        if (!usableReading(leeway, 'degrees', now, -20, 20, 'relative')) return no('leeway-unusable');
        readings.push(leeway);
    }
    if (!simultaneous(readings)) return no('not-simultaneous');
    if (stw.value < CURRENT_MIN_STW_KTS || sog.value < CURRENT_MIN_SOG_KTS) return no('too-slow');
    const ground = speedVector(sog.value, cogTrue.value);
    const water = speedVector(stw.value, headingTrue.value + (leeway?.value ?? 0));
    const eastKts = ground.east - water.east,
        northKts = ground.north - water.north;
    const driftKts = Math.hypot(eastKts, northKts);
    if (!Number.isFinite(driftKts) || driftKts > CURRENT_MAX_DRIFT_KTS) return no('implausible-current');
    const observedAt = Math.min(...readings.map((reading) => reading.at));
    return {
        kind: 'available',
        provenance: 'instrument-derived',
        identity: evidence.identity,
        via: evidence.via,
        eastKts,
        northKts,
        driftKts,
        setTrueDeg: driftKts < CURRENT_DIRECTION_FLOOR_KTS ? null : wrapDegrees(Math.atan2(eastKts, northKts) / TRUE),
        observedAt,
        computedAt: now,
        freshness: now - observedAt <= INSTRUMENT_LIVE_AGE_MS ? 'live' : 'stale',
        leewayDeg: leeway?.value ?? null,
        leewaySource: leeway?.source ?? null,
        sources: [...new Set(readings.map((reading) => reading.source))],
    };
}

export const CURRENT_REFUSAL_TEXT: Record<CurrentRefusal, string> = {
    'no-instruments': 'No qualified instrument samples',
    'true-heading-required': 'A fresh, qualified true heading is needed',
    'ground-vector-required': 'A fresh GPS speed and true course are needed',
    'water-speed-required': 'A fresh speed-log reading is needed',
    'not-simultaneous': 'The sensor readings are too far apart',
    'too-slow': 'Too little way on for a reliable current estimate',
    'leeway-unusable': 'The supplied leeway correction is not usable',
    'implausible-current': 'Current estimate exceeds the instrument quality limit',
};
