import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { satelliteModeActive } from '../networkPolicy';
import { fetchNearbyTideStations, normaliseTideStationDetails, tideProxy, type TideStation } from './stationDetails';
import {
    saveTideTable,
    tableFromStationDetails,
    tideDistanceKm,
    tidePosition,
    type SavedTideTable,
} from './offlineTideStore';
type Point = { lat: number; lon: number };
const DAY = 86_400_000;
export const TIDE_DISCOVERY_LIMIT = 12;
/** Great-circle points, including route ends/corners. A bounded partial plan
 * explicitly reports the unsearched remainder instead of claiming coverage. */
export function tideDiscoveryPlan(points: readonly Point[]): { points: Point[]; partial: boolean } {
    if (!points.length || points.length > 50_000 || points.some((p) => !tidePosition(p)))
        return { points: [], partial: true };
    const result: Point[] = [points[0]];
    const add = (p: Point) => {
        if (!result.some((q) => tideDistanceKm(p, q) < 40)) result.push(p);
    };
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
            b = points[i],
            distance = tideDistanceKm(a, b),
            n = Math.max(1, Math.ceil(distance / 120));
        if (n > 1000) return { points: result.slice(0, TIDE_DISCOVERY_LIMIT), partial: true };
        const rad = Math.PI / 180;
        const va = [
            Math.cos(a.lat * rad) * Math.cos(a.lon * rad),
            Math.cos(a.lat * rad) * Math.sin(a.lon * rad),
            Math.sin(a.lat * rad),
        ];
        const vb = [
            Math.cos(b.lat * rad) * Math.cos(b.lon * rad),
            Math.cos(b.lat * rad) * Math.sin(b.lon * rad),
            Math.sin(b.lat * rad),
        ];
        const angle = distance / 6371;
        if (Math.abs(Math.sin(angle)) < 1e-8 && distance > 100)
            return { points: result.slice(0, TIDE_DISCOVERY_LIMIT), partial: true };
        for (let j = 1; j <= n; j++) {
            const t = j / n,
                A = angle < 1e-8 ? 1 - t : Math.sin((1 - t) * angle) / Math.sin(angle),
                B = angle < 1e-8 ? t : Math.sin(t * angle) / Math.sin(angle);
            const v = va.map((x, k) => x * A + vb[k] * B);
            add({ lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) / rad, lon: Math.atan2(v[1], v[0]) / rad });
            if (result.length > TIDE_DISCOVERY_LIMIT)
                return { points: result.slice(0, TIDE_DISCOVERY_LIMIT), partial: true };
        }
    }
    // Keep an end close to the last search covered by that search, rather than
    // spend another discovery credit for a few kilometres.
    return { points: result, partial: false };
}
function wanAllowed(): boolean {
    return !satelliteModeActive() && (typeof navigator === 'undefined' || navigator.onLine !== false);
}
export async function discoverTideStations(
    points: readonly Point[],
    signal?: AbortSignal,
): Promise<{ stations: TideStation[]; partial: boolean; searched: number }> {
    const scope = getAuthIdentityScope(),
        plan = tideDiscoveryPlan(points),
        stations = new Map<string, TideStation>();
    let searched = 0;
    if (!wanAllowed()) return { stations: [], partial: true, searched };
    let partial = plan.partial;
    for (const p of plan.points) {
        if (signal?.aborted || !isAuthIdentityScopeCurrent(scope) || !wanAllowed())
            return { stations: [], partial: true, searched };
        const found = await fetchNearbyTideStations(p.lat, p.lon, { signal });
        if (signal?.aborted || !isAuthIdentityScopeCurrent(scope) || !wanAllowed())
            return { stations: [], partial: true, searched };
        searched++;
        if (found === null) {
            partial = true;
            continue;
        }
        for (const station of found)
            if (tideDistanceKm(p, station) <= 101) stations.set(`${station.id}:${station.lat},${station.lon}`, station);
    }
    if (stations.size > 48) partial = true;
    return { stations: [...stations.values()].slice(0, 48), partial, searched };
}
export type PrefetchResult = { table: SavedTideTable } | { error: string };
export async function prefetchTideTable(
    station: TideStation,
    days: 14 | 30,
    signal?: AbortSignal,
): Promise<PrefetchResult> {
    const scope = getAuthIdentityScope();
    if (!tidePosition(station) || !station.id || !wanAllowed() || signal?.aborted)
        return { error: 'Use a normal internet connection to save tide tables.' };
    const capability = await tideProxy({ capabilities: true }, signal);
    const c = capability?.offlineTides as Record<string, unknown> | undefined;
    if (c?.schema !== 1 || c.minDays !== 14 || c.maxDays !== 30)
        return { error: 'The tide service has not enabled 14–30 day offline tables yet. Nothing was purchased.' };
    if (!isAuthIdentityScopeCurrent(scope) || signal?.aborted || !wanAllowed()) return { error: 'Download cancelled.' };
    const raw = await tideProxy({ lat: station.lat, lon: station.lon, offlineDays: days, stationDistance: 1 }, signal);
    const w = raw?.thalassaWindow as Record<string, unknown> | undefined;
    const now = Date.now();
    if (
        w?.schema !== 1 ||
        w.requestedDays !== days ||
        typeof w.start !== 'number' ||
        typeof w.end !== 'number' ||
        w.end - w.start !== (days + 2) * 86400 ||
        w.start * 1000 > now ||
        w.start * 1000 < now - 2 * DAY ||
        w.end * 1000 < now + days * DAY
    )
        return { error: 'The tide service did not prove the requested period. No offline table was saved.' };
    // Explicit offline mode raises only the event cap; dense heights are
    // neither requested nor accepted here. Metadata uses the same parser.
    if (raw?.heights !== undefined) return { error: 'An unexpected dense tide grid was returned.' };
    const detail = normaliseTideStationDetails(station, raw, now, { offlineTable: true });
    if (!detail) return { error: 'No valid tide events were returned.' };
    const table = tableFromStationDetails(detail, now);
    if (!table || table.coverageStartMs > now || table.coverageEndMs < now + days * DAY)
        return { error: 'Actual tide events do not cover the requested period. No offline table was saved.' };
    if (!isAuthIdentityScopeCurrent(scope) || signal?.aborted || !wanAllowed()) return { error: 'Download cancelled.' };
    return (await saveTideTable(table)) ? { table } : { error: 'The table could not be verified in offline storage.' };
}
