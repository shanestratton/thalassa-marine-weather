/**
 * CrewCountContext — React Context for shared crew count state.
 *
 * Replaces the localStorage + custom event pattern with a proper
 * React Context so all consumers re-render automatically.
 * Still persists to localStorage for offline survivability.
 */
import React, { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const CREW_COUNT_KEY = 'thalassa_crew_count';

function readCrewCount(scope: AuthIdentityScope = getAuthIdentityScope()): number {
    try {
        const stored = localStorage.getItem(authScopedStorageKey(CREW_COUNT_KEY, scope));
        if (!stored) return 2;
        return Math.max(1, Math.min(20, parseInt(stored, 10) || 2));
    } catch (error) {
        console.warn('Failed to read crew count from localStorage:', error);
        return 2;
    }
}

interface CrewCountContextValue {
    crewCount: number;
    setCrewCount: (n: number) => void;
}

const CrewCountContext = createContext<CrewCountContextValue>({
    crewCount: 2,
    setCrewCount: () => {},
});

export const useCrewCount = () => useContext(CrewCountContext);

interface CrewCountProviderProps {
    children: ReactNode;
}

export const CrewCountProvider: React.FC<CrewCountProviderProps> = ({ children }) => {
    const [crewCount, setCrewCountRaw] = useState(readCrewCount);

    const setCrewCount = useCallback((n: number) => {
        const clamped = Math.max(1, Math.min(20, n));
        setCrewCountRaw(clamped);
        try {
            localStorage.setItem(authScopedStorageKey(CREW_COUNT_KEY), String(clamped));
        } catch (e) {
            console.warn('Failed to persist crew count:', e);
        }
        // Still dispatch event for any non-React consumers (e.g. services)
        window.dispatchEvent(new CustomEvent('thalassa:crew-changed', { detail: clamped }));
    }, []);

    // The provider outlives sign-out/sign-in transitions. Switch its in-memory
    // value synchronously with the auth fence so account A's vessel size never
    // flashes or seeds calculations for account B.
    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                setCrewCountRaw(readCrewCount(next));
            }),
        [],
    );

    // Listen for external crew-changed events (e.g. from settings or onboarding)
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (typeof detail === 'number' && detail !== crewCount) {
                setCrewCountRaw(Math.max(1, Math.min(20, detail)));
            }
        };
        window.addEventListener('thalassa:crew-changed', handler);
        return () => window.removeEventListener('thalassa:crew-changed', handler);
    }, [crewCount]);

    return <CrewCountContext.Provider value={{ crewCount, setCrewCount }}>{children}</CrewCountContext.Provider>;
};
