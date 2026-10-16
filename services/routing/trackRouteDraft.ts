export interface TrackRoutePoint {
    lat: number;
    lon: number;
}

export const TRACK_ROUTE_MAX_POINTS = 20_000;
export const TRACK_ROUTE_MAX_PINS = 80;
export const TRACK_ROUTE_TOLERANCE_M = 30;
export const TRACK_ROUTE_MAX_GAP_MS = 15 * 60_000;
export interface TrackRouteSample extends TrackRoutePoint {
    at: number;
}
export interface TrackRouteDraft {
    points: TrackRoutePoint[];
    inputCount: number;
    toleranceM: number;
    requiresChartCheck: true;
}
/** Mercator metres overstate ground distance, keeping the displayed-line tolerance conservative. */
export function trackSegmentDistanceM(p: TrackRoutePoint, a: TrackRoutePoint, b: TrackRoutePoint): number {
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const ax = (a.lon * Math.PI) / 180,
        ay = y(a.lat),
        dx = ((b.lon - a.lon) * Math.PI) / 180,
        dy = y(b.lat) - ay;
    const px = (p.lon * Math.PI) / 180 - ax,
        py = y(p.lat) - ay,
        square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, (px * dx + py * dy) / square)) : 0;
    return Math.hypot(px - t * dx, py - t * dy) * 6_371_008.8;
}
export function validTrackCoordinate(p: TrackRoutePoint): boolean {
    return !!p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
}
/** User track only: never reuse names, constraints, chart verdicts or acknowledgements. */
export function buildTrackRouteDraft(input: readonly TrackRouteSample[], now = Date.now()): TrackRouteDraft {
    if (!Array.isArray(input) || input.length < 2 || input.length > TRACK_ROUTE_MAX_POINTS)
        throw Error(
            'Choose a complete track with 2–20,000 recorded positions. Plot a shorter section by hand otherwise.',
        );
    const points: TrackRoutePoint[] = [];
    for (let i = 0; i < input.length; i++) {
        const p = input[i],
            before = input[i - 1];
        if (!validTrackCoordinate(p) || !Number.isSafeInteger(p.at) || p.at <= 0 || !Number.isFinite(now) || p.at > now)
            throw Error('This track has an unreadable position or clock. Plot it by hand.');
        if (
            before &&
            (p.at <= before.at || p.at - before.at > TRACK_ROUTE_MAX_GAP_MS || Math.abs(p.lon - before.lon) > 180)
        )
            throw Error('This track has a time gap or discontinuity. Plot the missing section by hand.');
        if (before) {
            const dx = (p.lon - before.lon) * 111_320 * Math.cos(((p.lat + before.lat) * Math.PI) / 360);
            const dy = (p.lat - before.lat) * 111_320;
            if (Math.hypot(dx, dy) > 5 * 1852)
                throw Error('This track has a position gap. Plot the missing section by hand.');
        }
        const previous = points.at(-1);
        if (!previous || previous.lat !== p.lat || previous.lon !== p.lon) points.push({ lat: p.lat, lon: p.lon });
    }
    if (points.length < 2) throw Error('This track has no distinct route endpoints.');
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    let count = 2,
        work = 0;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length) {
        const [start, end] = stack.pop()!;
        let furthest = -1,
            distance = TRACK_ROUTE_TOLERANCE_M;
        for (let i = start + 1; i < end; i++) {
            if (++work > TRACK_ROUTE_MAX_POINTS * TRACK_ROUTE_MAX_PINS)
                throw Error(
                    'This track is too complex to simplify within the fixed route budget. Plot a shorter section by hand.',
                );
            const d = trackSegmentDistanceM(points[i], points[start], points[end]);
            if (d > distance) {
                distance = d;
                furthest = i;
            }
        }
        if (furthest !== -1) {
            if (++count > TRACK_ROUTE_MAX_PINS)
                throw Error(
                    'This track needs more than 80 pins at 30 m tolerance. Plot a shorter section by hand; its bends were not discarded.',
                );
            keep[furthest] = 1;
            stack.push([start, furthest], [furthest, end]);
        }
    }
    return {
        points: points.filter((_, i) => keep[i]),
        inputCount: input.length,
        toleranceM: TRACK_ROUTE_TOLERANCE_M,
        requiresChartCheck: true,
    };
}
