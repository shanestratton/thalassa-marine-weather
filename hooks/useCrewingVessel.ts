/**
 * useCrewingVessel — the boat this account is crewing on, from the shared
 * binder snapshot (one selection for the binders, the Crew & Float Plan page
 * and Switch boat). `vessel` is null when the account is nobody's crew.
 */
import { useMemo, useSyncExternalStore } from 'react';
import {
    getCrewingVessel,
    getSharedBindersState,
    listCrewVessels,
    subscribeSharedBinders,
    type CrewVessel,
} from '../services/vessel/sharedBinders';

export interface CrewingVesselState {
    vessel: CrewVessel | null;
    vessels: CrewVessel[];
    /** Bumped on every snapshot change a viewer could see. */
    version: number;
}

export function useCrewingVessel(): CrewingVesselState {
    const state = useSyncExternalStore(subscribeSharedBinders, getSharedBindersState, getSharedBindersState);
    return useMemo(
        () => ({ vessel: getCrewingVessel(), vessels: listCrewVessels(), version: state.version }),
        // The state object is replaced on every visible change, account switch included.
        [state],
    );
}
