/**
 * NetworkModeContext — Tracks whether the app is operating over
 * cellular/Wi-Fi or a constrained satellite link (Iridium GO, etc.).
 *
 * Satellite mode enforces download area limits and enables the
 * ResumableGribFetcher's retry logic with longer delays.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

export type NetworkMode = 'standard' | 'satellite';

interface NetworkModeContextValue {
    mode: NetworkMode;
    isSatelliteMode: boolean;
    setMode: (mode: NetworkMode) => void;
    toggleMode: () => void;
    /** Max bounding box area in square degrees for satellite downloads */
    maxSatelliteAreaDeg2: number;
}

const NetworkModeCtx = createContext<NetworkModeContextValue>({
    mode: 'standard',
    isSatelliteMode: false,
    setMode: () => { },
    toggleMode: () => { },
    maxSatelliteAreaDeg2: 400,
});

export const NetworkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [mode, setMode] = useState<NetworkMode>('standard');

    const toggleMode = useCallback(() => {
        setMode(prev => (prev === 'standard' ? 'satellite' : 'standard'));
    }, []);

    const value: NetworkModeContextValue = {
        mode,
        isSatelliteMode: mode === 'satellite',
        setMode,
        toggleMode,
        maxSatelliteAreaDeg2: 400,
    };

    return React.createElement(NetworkModeCtx.Provider, { value }, children);
};

export function useNetworkMode(): NetworkModeContextValue {
    return useContext(NetworkModeCtx);
}
