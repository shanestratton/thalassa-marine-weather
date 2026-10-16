/** Route weather stays in memory; precise planned positions never enter provider queries. */
import { createPolarSpeedLookup } from './isochrone/polar';
import type { ResolvedRoutingPolar } from './routingPolar';
import { closeHauledDegFor, offBowFrom, pointOfSail } from './sailing/pointOfSail';
import type { VesselProfile } from '../types/vessel';
import type { AuthIdentityScope } from './authIdentityScope';

export const ROUTE_WEATHER_HOURS = 16 * 24;
export const ROUTE_WEATHER_QUERY_LIMIT = 48;
export const HOUR = 3_600_000;
export interface RouteWeatherPosition {
    lat: number;
    lon: number;
    atMs: number;
    distanceNM: number;
    courseDeg: number | null;
    /** A long passage retains its actual arrival, with an explicit unsampled middle. */
    gapBeforeHours: number;
}
export interface RouteClock {
    positions: RouteWeatherPosition[];
    totalDistanceNM: number;
    arrivalMs: number;
    departureMs: number;
    speedKts: number;
    limited: boolean;
}
export interface RouteWeatherSample {
    windKts: number | null;
    windDeg: number | null;
    gustKts: number | null;
    pressureHpa: number | null;
}
export interface RouteWeatherRow extends RouteWeatherPosition, RouteWeatherSample {
    twaDeg: number | null;
    pointOfSail: string | null;
    polarSpeedKts: number | null;
}
export interface RouteWeatherReport extends Omit<RouteClock, 'positions'> {
    ownerScope: AuthIdentityScope;
    identity: string;
    rows: RouteWeatherRow[];
    source: string;
    credit: string;
    sourceRun: string | null;
    polarLabel: string | null;
    loadedAtMs: number;
    note: string | null;
}
const rad = Math.PI / 180;
export const wrapRouteLongitude = (lon: number): number =>
    lon >= -180 && lon < 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
const pointOK = (p: { lat: number; lon: number }) =>
    Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 540;
type Point = { lat: number; lon: number };
const vector = (p: Point) => [
    Math.cos(p.lat * rad) * Math.cos(p.lon * rad),
    Math.cos(p.lat * rad) * Math.sin(p.lon * rad),
    Math.sin(p.lat * rad),
];
const angle = (a: Point, b: Point) => {
    const h =
        Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
        Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((wrapRouteLongitude(b.lon - a.lon) * rad) / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
};
function course(a: Point, b: Point): number {
    const d = wrapRouteLongitude(b.lon - a.lon) * rad;
    return (
        (Math.atan2(
            Math.sin(d) * Math.cos(b.lat * rad),
            Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(d),
        ) /
            rad +
            360) %
        360
    );
}
function interpolate(a: Point, b: Point, fraction: number, arc: number): Point {
    if (fraction <= 0) return { lat: a.lat, lon: wrapRouteLongitude(a.lon) };
    if (fraction >= 1) return { lat: b.lat, lon: wrapRouteLongitude(b.lon) };
    const av = vector(a),
        bv = vector(b),
        denominator = Math.sin(arc);
    const left = Math.sin((1 - fraction) * arc) / denominator,
        right = Math.sin(fraction * arc) / denominator;
    const v = av.map((value, i) => value * left + bv[i] * right);
    return {
        lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) / rad,
        lon: wrapRouteLongitude(Math.atan2(v[1], v[0]) / rad),
    };
}
/** Every input segment contributes to distance and timing, including dense curved lines. */
export function buildRouteClock(points: readonly Point[], departureMs: number, speedKts: number): RouteClock {
    if (
        points.length < 2 ||
        points.length > 10000 ||
        points.some((p) => !pointOK(p)) ||
        !Number.isFinite(departureMs) ||
        Math.abs(departureMs) > 8.64e15 ||
        !Number.isFinite(speedKts) ||
        speedKts <= 0 ||
        speedKts > 100
    )
        throw new Error('Set a valid planned speed and departure for a route with 2–10,000 points.');
    const legs: { a: Point; b: Point; arc: number; start: number; end: number }[] = [];
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
        const arc = angle(points[i - 1], points[i]);
        if (Math.PI - arc < 1e-7) throw new Error('Add an intermediate waypoint to the antipodal route segment.');
        if (arc < 1e-10) continue;
        const start = distance;
        distance += arc * 3440.065;
        legs.push({ a: points[i - 1], b: points[i], arc, start, end: distance });
    }
    const duration = distance / speedKts,
        arrivalMs = departureMs + duration * HOUR;
    if (!Number.isFinite(arrivalMs) || Math.abs(arrivalMs) > 8.64e15)
        throw new Error('Route timing is outside the supported clock.');
    const offsets = Array.from({ length: Math.floor(Math.min(duration, ROUTE_WEATHER_HOURS)) + 1 }, (_, i) => i);
    if (Math.abs((offsets.at(-1) ?? 0) - duration) > 1e-8) offsets.push(duration);
    let legIndex = 0;
    const positions = offsets.map((hour, index): RouteWeatherPosition => {
        const target = Math.min(distance, hour * speedKts);
        while (legIndex < legs.length - 1 && target >= legs[legIndex].end - 1e-8) legIndex++;
        const leg = legs[legIndex];
        const atEnd = index === offsets.length - 1;
        const p = atEnd
            ? { lat: points.at(-1)!.lat, lon: wrapRouteLongitude(points.at(-1)!.lon) }
            : leg
              ? interpolate(leg.a, leg.b, (target - leg.start) / (leg.end - leg.start), leg.arc)
              : { ...points[0], lon: wrapRouteLongitude(points[0].lon) };
        return {
            ...p,
            atMs: departureMs + hour * HOUR,
            distanceNM: target,
            courseDeg: leg ? (atEnd ? (course(leg.b, leg.a) + 180) % 360 : course(p, leg.b)) : null,
            gapBeforeHours: index > 0 ? Math.max(0, hour - offsets[index - 1] - 1) : 0,
        };
    });
    return {
        positions,
        totalDistanceNM: distance,
        departureMs,
        arrivalMs,
        speedKts,
        limited: duration > ROUTE_WEATHER_HOURS,
    };
}
/** The same public quarter-degree privacy buckets used for chart-derived tide requests. */
export function routeWeatherQueryPoint(p: Point): Point {
    return { lat: Math.round(p.lat * 4) / 4, lon: wrapRouteLongitude(Math.round(wrapRouteLongitude(p.lon) * 4) / 4) };
}
export const emptyRouteWeather = (): RouteWeatherSample => ({
    windKts: null,
    windDeg: null,
    gustKts: null,
    pressureHpa: null,
});
const inRange = (v: unknown, low: number, high: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high ? v : null;
/** Polar speed is a labelled model figure; it never changes the plan clock or invents motoring. */
export function routeWeatherRows(
    clock: RouteClock,
    samples: readonly RouteWeatherSample[],
    performance: { vessel: VesselProfile; polar: ResolvedRoutingPolar } | null,
): RouteWeatherRow[] {
    return clock.positions.map((p, i) => {
        const sample = samples[i] ?? emptyRouteWeather();
        const measuredWind = inRange(sample.windKts, 0, 250);
        const windKts = measuredWind !== null && measuredWind < 1e-8 ? 0 : measuredWind,
            windDeg = inRange(sample.windDeg, 0, 360);
        const gustKts = inRange(sample.gustKts, 0, 250),
            pressureHpa = inRange(sample.pressureHpa, 800, 1100);
        const twaDeg =
            windKts !== null && windKts > 0 && windDeg !== null && p.courseDeg !== null
                ? offBowFrom(windDeg - p.courseDeg)
                : null;
        const sailing = performance?.vessel.type === 'sail';
        const windAxis = performance?.polar.polar.windSpeeds;
        const speed =
            sailing &&
            windKts !== null &&
            twaDeg !== null &&
            windAxis?.length &&
            windKts >= windAxis[0] &&
            windKts <= windAxis[windAxis.length - 1]
                ? createPolarSpeedLookup(performance.polar.polar, windKts)(twaDeg)
                : null;
        return {
            ...p,
            windKts,
            windDeg: windKts === 0 ? null : windDeg,
            gustKts: gustKts !== null && (windKts === null || gustKts >= windKts) ? gustKts : null,
            pressureHpa,
            twaDeg,
            pointOfSail:
                sailing && twaDeg !== null
                    ? (pointOfSail({
                          windFromDeg: twaDeg,
                          sogKts: null,
                          closeHauledDeg: closeHauledDegFor(performance.vessel),
                      })?.label ?? null)
                    : null,
            polarSpeedKts: speed !== null && Number.isFinite(speed) && speed >= 0 ? speed : null,
        };
    });
}
