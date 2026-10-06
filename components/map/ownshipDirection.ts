import { NMEA_USABLE_MAX_AGE_MS } from '../../services/nmea/nmeaCadence';

interface DirectionMetric {
    value: number | null;
    lastUpdated: number;
    freshness: string;
}

export interface DirectionInstruments {
    headingTrue?: DirectionMetric;
    cog?: DirectionMetric;
    sog?: DirectionMetric;
}

export type OwnshipDirection = { degrees: number; source: 'heading' | 'course' } | { degrees: null; source: 'unknown' };

const MIN_COURSE_SPEED_KN = 1;
const freshTime = (at: number, now: number, maxAge: number) =>
    Number.isFinite(at) && at > 0 && at <= now + 5000 && now - at <= maxAge;
const angle = (value: number | null | undefined): value is number =>
    value != null && Number.isFinite(value) && value >= 0 && value < 360;
function freshMetric(
    metric: DirectionMetric | undefined,
    now: number,
    maxAge: number,
): metric is DirectionMetric & { value: number } {
    return (
        !!metric &&
        metric.value != null &&
        Number.isFinite(metric.value) &&
        metric.freshness !== 'dead' &&
        freshTime(metric.lastUpdated, now, maxAge)
    );
}

/**
 * GPS course is travel direction, not the bow. Never hold an old bearing at rest.
 *
 * `vesselMaxAgeMs`: how old the boat's readings may be, by the lane they came
 * down. The bus (and the Pi over the boat LAN) keeps the instruments' own
 * budget; her cloud row is up to a minute old by design, and its heading and
 * course are as old as its position (the marker's live gate for that lane).
 */
export function resolveOwnshipDirection(
    position: { timestamp: number; heading: number | null; speed: number | null },
    viaVessel: boolean,
    instruments: DirectionInstruments,
    now = Date.now(),
    vesselMaxAgeMs = NMEA_USABLE_MAX_AGE_MS,
): OwnshipDirection {
    const unknown = { degrees: null, source: 'unknown' } as const;
    if (!freshTime(position.timestamp, now, viaVessel ? vesselMaxAgeMs : 30_000)) return unknown;
    if (viaVessel) {
        const heading = instruments.headingTrue;
        if (freshMetric(heading, now, vesselMaxAgeMs) && angle(heading.value))
            return { degrees: heading.value, source: 'heading' };
        const { sog, cog } = instruments;
        if (
            freshMetric(sog, now, vesselMaxAgeMs) &&
            sog.value >= MIN_COURSE_SPEED_KN &&
            freshMetric(cog, now, vesselMaxAgeMs) &&
            angle(cog.value)
        ) {
            return { degrees: cog.value, source: 'course' };
        }
        return unknown;
    }
    // Phone geolocation's "heading" is COG. Never borrow a vessel compass
    // when the selected position has fallen back to the phone ashore.
    return position.speed != null &&
        Number.isFinite(position.speed) &&
        position.speed * 1.9438444924 >= MIN_COURSE_SPEED_KN &&
        angle(position.heading)
        ? { degrees: position.heading, source: 'course' }
        : unknown;
}
