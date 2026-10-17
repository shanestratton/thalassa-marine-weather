import type { AuthIdentityScope } from '../authIdentityScope';
import { isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { getVoyageEntries } from '../shiplog/VoyageSummary';
import { isTrackworthyEntry } from '../shiplog/helpers';
import { getOfflineEntries } from '../shiplog/OfflineQueue';
import { buildTrackRouteDraft, TRACK_ROUTE_MAX_POINTS } from './trackRouteDraft';

/** Complete account-owned projection (including pending local truth), never a partial display cache. */
export async function readOwnTrackRoute(voyageId: string, scope: AuthIdentityScope, signal: AbortSignal) {
    const current = () => !!scope.userId && isAuthIdentityScopeCurrent(scope) && !signal.aborted;
    if (!current() || !voyageId.trim() || voyageId.startsWith('planned_'))
        throw Error('Choose one of your recorded voyages.');
    const [remote, pending] = await Promise.all([
        getVoyageEntries(voyageId, true, {
            signal,
            maxRows: TRACK_ROUTE_MAX_POINTS,
            requireComplete: true,
            throwOnIncomplete: true,
        }),
        getOfflineEntries(),
    ]);
    if (!current()) throw Error('Track read cancelled because the account or chart action changed.');
    const merged = new Map(remote.map((e) => [e.clientOperationId ?? e.id, e]));
    for (const entry of pending)
        if (entry.voyageId === voyageId) merged.set(entry.clientOperationId ?? entry.id, entry);
    const entries = [...merged.values()];
    if (
        !entries.length ||
        entries.some(
            (e) =>
                e.userId !== scope.userId ||
                e.voyageId !== voyageId ||
                e.source === 'planned_route' ||
                e.source === 'community_download',
        )
    )
        throw Error('Only your own recorded track can become this route.');
    const positions = entries.filter(
        (e) =>
            e.entryType !== 'manual' &&
            !['Voyage Start', 'Voyage End'].includes(e.waypointName ?? '') &&
            !(e.waypointName ?? '').startsWith('COG ') &&
            !(e.notes ?? '').startsWith('Auto: COG'),
    );
    if (positions.some((e) => !isTrackworthyEntry(e)))
        throw Error('This track has unreadable recorded positions. Plot it by hand.');
    if (positions.some((e) => e.isOnWater === false))
        throw Error('This track includes recorded land positions. Plot the water route by hand.');
    return buildTrackRouteDraft(
        positions
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
            .map((e) => ({ lat: e.latitude, lon: e.longitude, at: Date.parse(e.timestamp) })),
    );
}
