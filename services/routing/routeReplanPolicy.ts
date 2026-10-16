import { progressAlongRoute } from '../routeProgress';
import { haversineNm, initialBearing, projectPosition } from '../isochrone/geodesy';
import { routeSampleFractions } from '../isochrone/routeSampling';
import { sampleWindGrid } from '../weather/importedGribSample';
import type { IsochroneResult } from '../isochrone/types';
import type { WindGrid } from '../weather/windGridEncoding';
import type { VoyagePlan } from '../../types';

export type ReplanPoint = { lat: number; lon: number };
export function replanAuthoritySnapshot(settings: {
    routeAuthority?: unknown;
    skipperDevice?: { deviceId?: unknown; claimedAt?: unknown } | null;
}) {
    return {
        mode: settings.routeAuthority === 'skipper' ? 'skipper' : 'confirm',
        deviceId: typeof settings.skipperDevice?.deviceId === 'string' ? settings.skipperDevice.deviceId : null,
        claimedAt: typeof settings.skipperDevice?.claimedAt === 'string' ? settings.skipperDevice.claimedAt : null,
    };
}
const validPoint = (p: ReplanPoint) =>
    p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
export function replanFixUsable(
    fix: (ReplanPoint & { timestamp: number; relay?: { reportedAt: number } }) | null,
    now: number,
): boolean {
    if (!fix || !validPoint(fix)) return false;
    const sampleAt = fix.relay?.reportedAt ?? fix.timestamp;
    return Number.isFinite(sampleAt) && now - sampleAt >= -5000 && now - sampleAt <= 60000;
}
/** Never infer that a waypoint on a different stretch of an out-and-back was passed. */
export function remainingReplanVias(
    plan: VoyagePlan,
    route: readonly ReplanPoint[],
    fix: ReplanPoint & { cog?: number },
): { remaining: Array<ReplanPoint & { name: string }>; remainingNm: number } | null {
    if (
        route.length < 2 ||
        route.length > 8192 ||
        !route.every(validPoint) ||
        !plan.destinationCoordinates ||
        !validPoint(plan.destinationCoordinates)
    )
        return null;
    const end = route.at(-1)!;
    if (haversineNm(end.lat, end.lon, plan.destinationCoordinates.lat, plan.destinationCoordinates.lon) > 0.01)
        return null;
    const progress = progressAlongRoute(route, fix, Number.isFinite(fix.cog) ? { headingDeg: fix.cog } : undefined);
    if (!progress) return null;
    const source = plan.routeGeoJSON?.properties?._source;
    if (
        typeof source === 'string' &&
        ['route-tracer', 'saved-logbook-route', 'explicit-follow-route'].includes(source) &&
        !plan.waypoints.length
    ) {
        // A saved curve without an explicit constraint list may encode manual
        // pins or leave-side decisions. Do not silently replace those choices.
        for (const point of route.slice(progress.legIndex + 1)) {
            const tail = progressAlongRoute([progress.abeam, end], point);
            if (!tail || tail.offTrackNm > 0.01) return null;
        }
    }
    let last = -1;
    const remaining: Array<ReplanPoint & { name: string }> = [];
    if (plan.waypoints.length > 256) return null;
    for (const waypoint of plan.waypoints) {
        const p = waypoint.coordinates;
        if (!p || !validPoint(p)) return null;
        const matches = route.flatMap((point, index) =>
            Math.abs(point.lat - p.lat) < 1e-6 && Math.abs(point.lon - p.lon) < 1e-6 ? [index] : [],
        );
        // Several separated visits need an explicit via-index contract (138-08).
        if (!matches.length || matches.some((n, i) => i > 0 && n > matches[i - 1] + 1)) return null;
        const index = matches.find((n) => n > last);
        if (index === undefined) return null;
        last = index;
        if (index > progress.legIndex && index < route.length - 1) remaining.push({ ...p, name: waypoint.name });
    }
    return { remaining, remainingNm: progress.toGoNm };
}
export function replanSuggestionReasons(input: {
    previousRun?: string | null;
    currentRun?: string | null;
    baselineEtaMs?: number | null;
    currentEtaMs?: number | null;
    xteNm?: number | null;
    xteLimitNm?: number | null;
}): string[] {
    const reasons: string[] = [];
    if (input.previousRun && input.currentRun && input.previousRun !== input.currentRun)
        reasons.push('A new forecast run is available');
    if (
        Number.isFinite(input.baselineEtaMs) &&
        Number.isFinite(input.currentEtaMs) &&
        input.currentEtaMs! - input.baselineEtaMs! >= 1800000
    )
        reasons.push('ETA has slipped by at least 30 minutes');
    if (
        Number.isFinite(input.xteNm) &&
        Number.isFinite(input.xteLimitNm) &&
        input.xteLimitNm! > 0 &&
        input.xteNm! >= input.xteLimitNm!
    )
        reasons.push('The boat is off the followed route');
    return reasons;
}
/** Complete final geometry/time sampling, including forecast knots, without clamping missing wind. */
export function replanWindCovered(result: IsochroneResult, grid: WindGrid, departureMs: number): boolean {
    const route = result.route;
    if (route.length < 2 || route.length > 4096 || route.length !== result.routeCoordinates.length || !grid.refTime)
        return false;
    const reference = Date.parse(grid.refTime);
    if (!Number.isFinite(reference) || !Number.isFinite(departureMs)) return false;
    const hours = (grid.stepHours ?? grid.hourOffsets ?? Array.from({ length: grid.totalHours }, (_, i) => i)).map(
        (h) => (reference - departureMs) / 3600000 + h,
    );
    let samples = 0;
    for (let i = 0; i < route.length; i++) {
        const p = route[i],
            c = result.routeCoordinates[i];
        if (!validPoint(p) || !Number.isFinite(p.timeHours) || c[0] !== p.lon || c[1] !== p.lat) return false;
        if (i === 0) {
            if (!sampleWindGrid(grid, p.lat, p.lon, departureMs + p.timeHours * 3600000)) return false;
            continue;
        }
        const a = route[i - 1],
            distance = haversineNm(a.lat, a.lon, p.lat, p.lon);
        const fractions = routeSampleFractions(a.timeHours, p.timeHours, distance, hours, 2049 - samples);
        if (!fractions) return false;
        const bearing = initialBearing(a.lat, a.lon, p.lat, p.lon);
        for (const fraction of fractions.slice(1)) {
            const point = fraction === 1 ? p : projectPosition(a.lat, a.lon, bearing, distance * fraction);
            const at = departureMs + (a.timeHours + (p.timeHours - a.timeHours) * fraction) * 3600000;
            if (!sampleWindGrid(grid, point.lat, point.lon, at)) return false;
            samples++;
        }
    }
    return true;
}
