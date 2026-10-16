import { getAuthIdentityScope } from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ShipLogEntry } from '../../types/navigation';
import type { TrackRoutingPrior } from '../engine/trackPriors';
import {
    buildTrackRouteDraft,
    validTrackCoordinate,
    TRACK_ROUTE_MAX_GAP_MS,
    type TrackRoutePoint,
    type TrackRouteSample,
} from './trackRouteDraft';

let vesselRevision = 0;
useSettingsStore.subscribe((next, previous) => {
    if ((next.activeVesselId ?? null) !== (previous.activeVesselId ?? null)) vesselRevision++;
});
export function trackPriorContextKey(): string {
    const scope = getAuthIdentityScope();
    return JSON.stringify([
        scope.key,
        scope.generation,
        useSettingsStore.getState().activeVesselId ?? null,
        vesselRevision,
    ]);
}
export function ownTrackPriorFragments(entries: readonly ShipLogEntry[], owner: string): TrackRoutingPrior[] {
    if (!owner || entries.length > 12_000) return [];
    const byVoyage = new Map<string, ShipLogEntry[]>();
    for (const entry of entries) {
        if (entry.userId !== owner || !entry.voyageId || entry.voyageId.startsWith('planned_')) continue;
        const rows = byVoyage.get(entry.voyageId) ?? [];
        rows.push(entry);
        byVoyage.set(entry.voyageId, rows);
    }
    const result: TrackRoutingPrior[] = [];
    for (const rows of byVoyage.values()) {
        let fragment: TrackRouteSample[] = [];
        const finish = () => {
            if (fragment.length >= 2 && result.length < 8)
                try {
                    result.push({ source: 'own-track', points: buildTrackRouteDraft(fragment).points });
                } catch {
                    /* optional hint: keep ordinary routing */
                }
            fragment = [];
        };
        for (const entry of [...new Map(rows.map((e) => [e.clientOperationId ?? e.id, e])).values()].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        )) {
            if (
                entry.entryType === 'manual' ||
                ['Voyage Start', 'Voyage End'].includes(entry.waypointName ?? '') ||
                (entry.waypointName ?? '').startsWith('COG ') ||
                (entry.notes ?? '').startsWith('Auto: COG')
            )
                continue;
            const point = { lat: entry.latitude, lon: entry.longitude, at: Date.parse(entry.timestamp) },
                previous = fragment.at(-1);
            if (
                (entry.source ?? 'device') !== 'device' ||
                entry.isOnWater !== true ||
                !validTrackCoordinate(point) ||
                !Number.isSafeInteger(point.at)
            ) {
                finish();
                continue;
            }
            if (
                previous &&
                (point.at <= previous.at ||
                    point.at - previous.at > TRACK_ROUTE_MAX_GAP_MS ||
                    Math.abs(point.lon - previous.lon) > 180 ||
                    fragment.length >= 512)
            )
                finish();
            fragment.push(point);
        }
        finish();
        if (result.length >= 8) break;
    }
    return result;
}
/** Optional bounded priors. Only the existing APPROVED-only RPC may contribute community geometry. */
export async function collectTrackRoutingPriors(
    from: TrackRoutePoint,
    to: TrackRoutePoint,
    signal: AbortSignal,
    expectedContext: string,
): Promise<TrackRoutingPrior[]> {
    const scope = getAuthIdentityScope(),
        current = () => !signal.aborted && trackPriorContextKey() === expectedContext;
    if (!current() || !validTrackCoordinate(from) || !validTrackCoordinate(to) || Math.abs(from.lon - to.lon) > 180)
        return [];
    const bbox: [number, number, number, number] = [
        Math.max(-180, Math.min(from.lon, to.lon) - 0.02),
        Math.max(-85, Math.min(from.lat, to.lat) - 0.02),
        Math.min(180, Math.max(from.lon, to.lon) + 0.02),
        Math.min(85, Math.max(from.lat, to.lat) + 0.02),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retire: (() => void) | undefined;
    const unavailable = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
        retire = () => resolve(null);
        signal.addEventListener('abort', retire, { once: true });
    });
    try {
        const read = (async () => {
            const [{ getLogEntries }, { getOfflineEntries }, { communityLanesNear }] = await Promise.all([
                import('../shiplog/EntryCrud'),
                import('../shiplog/OfflineQueue'),
                import('../communityRoutes'),
            ]);
            if (!current()) return null;
            return Promise.allSettled([
                scope.userId ? getLogEntries(2000) : Promise.resolve([]),
                scope.userId ? getOfflineEntries() : Promise.resolve([]),
                communityLanesNear(bbox, { fresh: true }),
            ]);
        })();
        const replies = await Promise.race([read, unavailable]);
        if (!replies || !current()) return [];
        const own = ownTrackPriorFragments(
            [
                ...(replies[0].status === 'fulfilled' ? replies[0].value : []),
                ...(replies[1].status === 'fulfilled' ? replies[1].value : []),
            ],
            scope.userId ?? '',
        );
        const community: TrackRoutingPrior[] = (replies[2].status === 'fulfilled' ? replies[2].value : [])
            .filter((l) => l.points.length <= 512 && l.points.every(validTrackCoordinate))
            .slice(0, 4)
            .map((l) => ({
                source: 'approved-community',
                approval: 'approved',
                points: l.points.map((p) => ({ lat: p.lat, lon: p.lon })),
            }));
        return [...own, ...community].filter((p) =>
            p.points.some((q) => q.lon >= bbox[0] && q.lat >= bbox[1] && q.lon <= bbox[2] && q.lat <= bbox[3]),
        );
    } finally {
        if (timer) clearTimeout(timer);
        if (retire) signal.removeEventListener('abort', retire);
    }
}
