/** Exact isolated-build replacement for stores/authStore.ts. It imports no
 * production SDK, push, telemetry, storage, native identity or database module.
 * Controller metadata is not a Supabase User: ordinary App services remain in
 * browse mode even when the separate Research header reports native Auth.
 */
import { useSyncExternalStore } from 'react';
import type { User } from '@supabase/supabase-js';
import { fullAppAuthProjection } from './authProjection';

export interface FullAppResearchAuthState {
    readonly user: User | null;
    /** The isolated browse-mode decision is settled; not authenticated/readiness. */
    readonly authChecked: boolean;
    readonly logout: () => Promise<void>;
}

const MUTATION_UNAVAILABLE = 'Full App Research Auth mutation unavailable';
function refuseMutation(): never {
    throw new Error(MUTATION_UNAVAILABLE);
}
const logout = async (): Promise<void> => refuseMutation();
// No SDK User snapshot is exposed by ResearchAuthController. Do not invent one
// from native account IDs or allow an SDK/provisional event to open App services.
const state: FullAppResearchAuthState = Object.freeze({ user: null, authChecked: true, logout });
type Listener = (state: FullAppResearchAuthState, previous: FullAppResearchAuthState) => void;
const listeners = new Set<Listener>();
// Native metadata changes still wake the compatibility subscribers, but neither
// current nor previous compatibility state claims a Supabase identity.
fullAppAuthProjection.subscribe(() => {
    for (const listener of [...listeners]) {
        try {
            listener(state, state);
        } catch {
            // Presentation observers cannot interrupt isolated fencing.
        }
    }
});

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
function useResearchAuthStore<T = FullAppResearchAuthState>(
    selector: (snapshot: FullAppResearchAuthState) => T = (snapshot) => snapshot as T,
): T {
    const snapshot = useSyncExternalStore(
        subscribe,
        () => state,
        () => state,
    );
    return selector(snapshot);
}

export const useAuthStore = Object.assign(useResearchAuthStore, {
    getState: () => state,
    getInitialState: () => state,
    subscribe,
    /** Zustand-compatible entry point, always refusing writes in this build. */
    setState: (
        _partial:
            | FullAppResearchAuthState
            | Partial<FullAppResearchAuthState>
            | ((snapshot: FullAppResearchAuthState) => FullAppResearchAuthState | Partial<FullAppResearchAuthState>),
        _replace?: boolean,
    ): never => refuseMutation(),
});

/** Never acknowledge production Apple/Auth cleanup as successful in Research. */
export const handleNativeAppleCredentialRevocation = async (_appleUserId: string): Promise<void> => refuseMutation();

/** Exact upstream export, still unavailable here. No native fencing, identity
 * mutation or successful local/production sign-out is claimed by this leaf. */
export const fenceSignedOutOnThisDevice = async (): Promise<void> => refuseMutation();
