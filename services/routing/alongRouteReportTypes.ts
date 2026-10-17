import type { AuthIdentityScope } from '../authIdentityScope';
import type { AlongPlaceVisit } from './alongRoutePlaces';
import type { RouteWeatherSample } from '../routeMeteogram';

export interface AlongRouteRow extends AlongPlaceVisit {
    weather: RouteWeatherSample;
}
export interface AlongRouteSource {
    name: string;
    sourceAt: string | null;
    coverage: string;
    partial: boolean;
}
/** Only independent primitive summaries. Never pass this to persistence,
 * exports, telemetry, cloud services or a worker. */
export interface AlongRouteReport {
    ownerScope: AuthIdentityScope;
    boatId: string | null;
    identity: string;
    routeIdentity: string;
    departureMs: number | null;
    speedKts: number | null;
    loadedAtMs: number;
    totalNm: number;
    chartVersion: number;
    rows: AlongRouteRow[];
    limited: boolean;
    cachedOnly: boolean;
    sources: AlongRouteSource[];
    weatherSource: string;
    weatherCredit: string;
    weatherRun: string | null;
    weatherNote: string | null;
}
