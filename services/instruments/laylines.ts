import { calculateBearing, calculateDistance, destinationPoint } from '../../utils/navigationCalculations';
import { speedVector, TRUE, wrapDegrees } from './measurements';
import type { MeasuredCurrent } from './measuredCurrent';
import type { SailingPerformance } from './performance';

export type LaylinePoint = { lat: number; lon: number };
export interface InstrumentLaylines {
    observedAt: number;
    correction: 'local-instrument-current' | 'uncorrected';
    note: string;
    mode: 'upwind' | 'downwind';
    lines: Array<{
        tack: 'port' | 'starboard';
        headingTrueDeg: number;
        groundCourseTrueDeg: number;
        points: [LaylinePoint, LaylinePoint];
    }>;
}
const valid = (p: LaylinePoint) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180;
export const LAYLINE_MAX_RANGE_NM = 5;

/** Local display guides from the actual next mark; they neither change a route nor issue steering commands. */
export function instrumentLaylines(args: {
    boat: LaylinePoint;
    mark: LaylinePoint;
    performance: SailingPerformance;
    current: MeasuredCurrent | null;
    now: number;
}): InstrumentLaylines | null {
    const { performance: p, boat, mark } = args;
    if (
        !valid(boat) ||
        !valid(mark) ||
        p.propulsion !== 'sail' ||
        p.windFromTrueDeg === null ||
        args.now - p.observedAt > 6_500 ||
        p.observedAt > args.now + 1_000
    )
        return null;
    const distance = calculateDistance(boat.lat, boat.lon, mark.lat, mark.lon);
    if (!Number.isFinite(distance) || distance < 0.02 || distance > LAYLINE_MAX_RANGE_NM) return null;
    const bearing = calculateBearing(boat.lat, boat.lon, mark.lat, mark.lon);
    const off = Math.abs(wrapDegrees(bearing - p.windFromTrueDeg + 180) - 180);
    const mode = off <= 90 ? 'upwind' : 'downwind';
    const target = mode === 'upwind' ? p.upwind : p.downwind;
    if (!target || !(target.speedKts > 0.1)) return null;
    const c = args.current;
    const corrected =
        c &&
        c.identity === p.identity &&
        (c.via === 'gateway' || c.via === 'lan') &&
        c.freshness === 'live' &&
        args.now - c.observedAt <= 6_500 &&
        c.observedAt <= args.now + 1_000 &&
        Math.abs(c.observedAt - p.observedAt) <= 6_000
            ? c
            : null;
    const lines: InstrumentLaylines['lines'] = [];
    for (const [tack, sign] of [
        ['port', 1],
        ['starboard', -1],
    ] as const) {
        const heading = wrapDegrees(p.windFromTrueDeg + sign * target.angleDeg);
        const water = speedVector(target.speedKts, heading);
        const east = water.east + (corrected?.eastKts ?? 0),
            north = water.north + (corrected?.northKts ?? 0);
        if (Math.hypot(east, north) < 0.1) return null;
        const ground = wrapDegrees(Math.atan2(east, north) / TRUE);
        const tail = destinationPoint(
            mark.lat,
            mark.lon,
            ground + 180,
            Math.min(LAYLINE_MAX_RANGE_NM, Math.max(0.2, distance * 1.25)),
        );
        // Keep dateline paths in one nearby world copy, rather than drawing a line around the globe.
        tail.lon += Math.round((mark.lon - tail.lon) / 360) * 360;
        lines.push({ tack, headingTrueDeg: heading, groundCourseTrueDeg: ground, points: [tail, mark] });
    }
    return {
        observedAt: Math.min(p.observedAt, corrected?.observedAt ?? p.observedAt),
        mode,
        correction: corrected ? 'local-instrument-current' : 'uncorrected',
        note: corrected
            ? 'Local instrument current assumed unchanged to the mark; no leeway prediction.'
            : 'Current uncorrected; no leeway prediction.',
        lines,
    };
}
