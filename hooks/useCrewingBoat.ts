/**
 * useCrewingBoat — the boat this account crews on, as The Glass names it.
 *
 * Shane 2026-10-05: "when a punter is invited to another yacht, in the location
 * box, instead of showing their yacht, can it instead show the yacht that they
 * are now invited to." The Vessel hub's naming (useCrewingVessel, then the crew
 * view's name, then the snapshot's), read from the cache only: The Glass never
 * waits on, or starts, a network read to name her. Kept free of UI and
 * realtime imports, since The Glass loads it at startup.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getAuthIdentityScope } from '../services/authIdentityScope';
import { crewVesselName, getCachedCrewVesselView, subscribeCrewVesselViews } from '../services/crew/crewVesselView';
import { SKIPPER_BOAT_FALLBACK } from '../components/vessel/skipperBoatFallback';
import { useCrewingVessel } from './useCrewingVessel';

export interface CrewingBoat {
    /** The skipper's user id: the boat's identity for the weather chain. */
    ownerId: string;
    /** Her name, or null while none is known. */
    name: string | null;
    /** Her name, or "Your skipper's boat" when none is known. */
    label: string;
    /** Her name for the middle of a sentence ("your skipper's boat" when unknown). */
    inSentence: string;
    /** The skipper shares the Instrument Panel; null when this device does not know yet. */
    instruments: boolean | null;
}

// Bumped whenever any crew view is stored or purged, so the cached name is re-read.
let cacheVersion = 0;
const subscribeCache = (listener: () => void) =>
    subscribeCrewVesselViews(() => {
        cacheVersion += 1;
        listener();
    });
const readCacheVersion = () => cacheVersion;

export function useCrewingBoat(): CrewingBoat | null {
    const { vessel } = useCrewingVessel();
    const version = useSyncExternalStore(subscribeCache, readCacheVersion, readCacheVersion);
    const scopeKey = getAuthIdentityScope().key;
    return useMemo(() => {
        if (!vessel) return null;
        const name = crewVesselName(vessel.vesselName, getCachedCrewVesselView(vessel.ownerId));
        return {
            ownerId: vessel.ownerId,
            name,
            label: name ?? SKIPPER_BOAT_FALLBACK.charAt(0).toUpperCase() + SKIPPER_BOAT_FALLBACK.slice(1),
            inSentence: name ?? SKIPPER_BOAT_FALLBACK,
            instruments: typeof vessel.instruments === 'boolean' ? vessel.instruments : null,
        };
        // version and scopeKey are the cache's change signals.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vessel, version, scopeKey]);
}
