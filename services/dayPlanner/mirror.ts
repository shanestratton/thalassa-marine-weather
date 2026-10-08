/**
 * mirror — the trip home, read off the one-way leg's own forecasts (Plan Your
 * Day, build 124).
 *
 * WHY NOT ASK FOR THE ROUND TRIP. routeStations spaces its stations evenly
 * along the whole route with both ends included and at least 10 NM apart
 * (routeForecastSampler.ts). A round trip [A, B, A] under 20 NM therefore gets
 * two stations, both at A, and the stop is never sampled: the day reads the
 * marina's wind for the whole passage. So the planner loads [A, B] once and
 * turns each series round for the way home: the station order is reversed and
 * every station's distance becomes totalNm − alongNm, so along 0 on the way
 * home is the stop.
 *
 * Pure and non-mutating. The shared samplers are not touched: a mirrored
 * series is an ordinary series for an ordinary route (the reversed one). The
 * hourly arrays are shared with the leg they came from, never copied or
 * altered, and the sea keeps each station's own snap verdict, so a berth the
 * wave model cannot see stays "inshore" at whichever end it now is.
 */
import type { RouteForecast } from '../routeForecastSampler';
import type { RouteSpread } from '../routeForecastSpread';
import type { RouteSea } from '../routeSeaSampler';

function reversed<S extends { alongNm: number }>(stations: readonly S[], totalNm: number): S[] {
    // A distance a hair past the end (float drift) must not go negative.
    return stations.map((s) => ({ ...s, alongNm: Math.max(0, totalNm - s.alongNm) })).reverse();
}

/** The one-way length: the series' own total, or its last station when that is missing. */
function lengthOf(totalNm: number, stations: readonly { alongNm: number }[]): number {
    return Number.isFinite(totalNm) && totalNm > 0 ? totalNm : (stations[stations.length - 1]?.alongNm ?? 0);
}

export function mirrorRouteForecast(forecast: RouteForecast): RouteForecast;
export function mirrorRouteForecast(forecast: RouteForecast | null): RouteForecast | null;
export function mirrorRouteForecast(forecast: RouteForecast | null): RouteForecast | null {
    if (!forecast) return null;
    const total = lengthOf(forecast.totalNm, forecast.stations);
    return { ...forecast, stations: reversed(forecast.stations, total) };
}

/** Every member turned round; who was asked and who is missing are unchanged. */
export function mirrorRouteSpread(spread: RouteSpread | null): RouteSpread | null {
    if (!spread) return null;
    const members: Record<string, RouteForecast> = {};
    for (const [model, member] of Object.entries(spread.members)) members[model] = mirrorRouteForecast(member);
    return { ...spread, members };
}

export function mirrorRouteSea(sea: RouteSea | null): RouteSea | null {
    if (!sea) return null;
    const total = lengthOf(sea.totalNm, sea.stations);
    return { ...sea, stations: reversed(sea.stations, total) };
}
