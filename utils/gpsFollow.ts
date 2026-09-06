/**
 * GPS-follow decision logic — the pure core of the Glass page's
 * live-position follower (WeatherContext).
 *
 * While defaultLocation is 'Current Location' the app FOLLOWS the boat:
 *   - position checked every GPS_FOLLOW_POLL_MS,
 *   - the displayed name/coords update once you've moved NAME_UPDATE_NM
 *     from what's on screen,
 *   - the WEATHER refetches only once you're WEATHER_REFRESH_NM from the
 *     point the forecast was actually fetched for.
 *
 * The two distances use DIFFERENT baselines on purpose: display drift is
 * measured against the displayed coords (so the label keeps up), but the
 * weather threshold is measured against the last real fetch point — if it
 * were measured against the display, every 0.5 NM rename would reset the
 * baseline and a boat could sail 500 NM in 0.5 NM hops without ever
 * tripping a forecast refresh.
 */

import { calculateDistance } from './navigationCalculations';

export const GPS_FOLLOW_POLL_MS = 5_000;
/** Displayed name/coords update beyond this drift from what's on screen. */
export const NAME_UPDATE_NM = 0.5;
/** Weather refetches beyond this distance from the last real fetch point. */
export const WEATHER_REFRESH_NM = 30;

export interface LatLon {
    lat: number;
    lon: number;
}

/** Great-circle distance in nautical miles. Delegates to the canonical haversine. */
export function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return calculateDistance(lat1, lon1, lat2, lon2);
}

export type FollowAction = 'none' | 'rename' | 'refetch';

/**
 * Decide what a follow tick should do.
 *
 * @param weatherPoint  coords of the last REAL weather fetch (the 30 NM baseline)
 * @param displayed     coords currently shown on the Glass page
 * @param position      fresh GPS position
 * @param displayedNameIsPlaceholder  true when the on-screen name is the
 *        literal 'Current Location' string — forces a rename even at zero
 *        drift so the boot-time label gets prettified without leaving
 *        GPS mode.
 */
export function decideFollowAction(args: {
    weatherPoint: LatLon | null;
    displayed: LatLon | null;
    position: LatLon;
    displayedNameIsPlaceholder: boolean;
}): FollowAction {
    const { weatherPoint, displayed, position, displayedNameIsPlaceholder } = args;
    if (!weatherPoint || !displayed) return 'none';

    if (haversineNM(weatherPoint.lat, weatherPoint.lon, position.lat, position.lon) >= WEATHER_REFRESH_NM) {
        return 'refetch';
    }
    if (displayedNameIsPlaceholder) return 'rename';
    if (haversineNM(displayed.lat, displayed.lon, position.lat, position.lon) >= NAME_UPDATE_NM) {
        return 'rename';
    }
    return 'none';
}

/**
 * The tide station follows the boat sooner than the forecast does: stations
 * sit a few miles apart along a coast, and the label under the tide graph
 * kept the old one until the 30 NM refetch (Shane 2026-09-06).
 */
export const TIDE_REFRESH_NM = 3;

/** Refresh the tides once the boat is TIDE_REFRESH_NM from the point they were fetched for. */
export function tideNeedsRefresh(tidePoint: LatLon | null, position: LatLon): boolean {
    if (!tidePoint) return false;
    return haversineNM(tidePoint.lat, tidePoint.lon, position.lat, position.lon) >= TIDE_REFRESH_NM;
}
