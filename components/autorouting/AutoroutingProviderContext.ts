/**
 * Which router Auto asks (2026-10-01). The default is Thalassa's own router on
 * the phone (services/autoroutingThalassa). The browser fixture swaps in a
 * stub that returns synthetic geometry, so layout tests need no charts and
 * make no network request; nothing in the app overrides it.
 */
import { createContext, useContext } from 'react';
import {
    calculateThalassaProposal,
    getThalassaAutorouteStatus,
    type AutoroutingTrialRequest,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
} from '../../services/autoroutingThalassa';

export interface AutoroutingProvider {
    /** Whether Auto is offered and can calculate, worked out on the phone. */
    status: () => AutoroutingTrialStatus;
    /** One passage; rejects with the plain reason, or an AbortError. */
    calculate: (
        request: AutoroutingTrialRequest,
        signal?: AbortSignal,
        onProgress?: (message: string) => void,
    ) => Promise<AutoroutingTrialRoute>;
}

export const thalassaAutoroutingProvider: AutoroutingProvider = {
    status: getThalassaAutorouteStatus,
    calculate: calculateThalassaProposal,
};

export const AutoroutingProviderContext = createContext<AutoroutingProvider>(thalassaAutoroutingProvider);

export function useAutoroutingProvider(): AutoroutingProvider {
    return useContext(AutoroutingProviderContext);
}
