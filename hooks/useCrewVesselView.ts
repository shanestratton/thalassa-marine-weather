/**
 * useCrewVesselView — the skipper's boat as its crew may see it (the crewing
 * view, 2026-10-03). Paints the account's cached view at once, so a crew
 * member offline at sea still sees the boat and its people, then asks the
 * server: on mount, whenever the snapshot changes, and (when `live`) on every
 * vessel_crew realtime event.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../services/authIdentityScope';
import {
    getCachedCrewVesselView,
    loadCrewVesselView,
    subscribeCrewVesselViews,
    type CrewVesselView,
} from '../services/crew/crewVesselView';
import { useRealtimeSync } from './useRealtimeSync';

export interface CrewVesselViewState {
    view: CrewVesselView | null;
    /** The server could not be asked; the view shown is the cached one. */
    stale: boolean;
    /** The first answer for this boat has not come back yet. */
    loading: boolean;
}

let cacheVersion = 0;
const bumpCacheVersion = (listener: () => void) =>
    subscribeCrewVesselViews(() => {
        cacheVersion += 1;
        listener();
    });
const readCacheVersion = () => cacheVersion;

export function useCrewVesselView(
    ownerId: string | null | undefined,
    refreshKey: number = 0,
    options: { live?: boolean } = {},
): CrewVesselViewState {
    const live = options.live !== false;
    const owner = ownerId || null;
    const scopeKey = getAuthIdentityScope().key;
    // Re-read the cache whenever any view is stored or purged.
    useSyncExternalStore(bumpCacheVersion, readCacheVersion, readCacheVersion);
    const cached = getCachedCrewVesselView(owner);
    const [status, setStatus] = useState<{ key: string; stale: boolean; settled: boolean }>({
        key: '',
        stale: false,
        settled: false,
    });
    const [tick, setTick] = useState(0);
    const key = `${scopeKey}|${owner ?? ''}`;

    useEffect(() => {
        if (!owner) return undefined;
        const scope = getAuthIdentityScope();
        let active = true;
        void loadCrewVesselView(owner).then((result) => {
            // A result for another account is never shown. For THIS account
            // every answer settles the panel, 'discarded' included (no usable
            // session here): the cached view, if any, then stands unverified.
            if (!active || !isAuthIdentityScopeCurrent(scope)) return;
            setStatus({
                key: `${scope.key}|${owner}`,
                stale: result.status === 'stale' || result.status === 'discarded',
                settled: true,
            });
        });
        return () => {
            active = false;
        };
    }, [owner, scopeKey, refreshKey, tick]);

    const refresh = useCallback(() => setTick((value) => value + 1), []);
    useRealtimeSync('vessel_crew', refresh, live && Boolean(owner));

    const current = status.key === key ? status : { stale: false, settled: false };
    return {
        view: owner ? cached : null,
        stale: Boolean(owner) && current.stale,
        loading: Boolean(owner) && !current.settled && !cached,
    };
}
