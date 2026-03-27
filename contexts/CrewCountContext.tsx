/**
 * CrewCountContext — React Context for shared crew count state.
 *
 * Replaces the localStorage + custom event pattern with a proper
 * React Context so all consumers re-render automatically.
 * Still persists to localStorage for offline survivability.
 */
import React, { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

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
    const [crewCount, setCrewCountRaw] = useState(() => {
        try {
            const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
            if (raw) {
                const s = JSON.parse(raw);
                if (s?.vessel?.crewCount) return s.vessel.crewCount;
            }
        } catch {
            /* ignore */
        }
        try {
            const stored = localStorage.getItem('thalassa_crew_count');
            return stored ? parseInt(stored) || 2 : 2;
        } catch (e) {
            console.warn('Failed to read crew count from localStorage:', e);
            return 2;
        }
    });

    const setCrewCount = useCallback((n: number) => {
        const clamped = Math.max(1, Math.min(20, n));
        setCrewCountRaw(clamped);
        try {
            localStorage.setItem('thalassa_crew_count', String(clamped));
        } catch (e) {
            console.warn('Failed to persist crew count:', e);
        }
        // Still dispatch event for any non-React consumers (e.g. services)
        window.dispatchEvent(new CustomEvent('thalassa:crew-changed', { detail: clamped }));
    }, []);

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
