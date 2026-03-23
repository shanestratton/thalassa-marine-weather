/**
 * Network Mode Store — Zustand replacement for NetworkModeContext.
 *
 * Tracks whether the app is on standard or satellite (Iridium GO) network.
 * Satellite mode enforces download area limits and enables retry logic.
 */

import { create } from 'zustand';

export type NetworkMode = 'standard' | 'satellite';

interface NetworkModeState {
    mode: NetworkMode;
    isSatelliteMode: boolean;
    maxSatelliteAreaDeg2: number;
    setMode: (mode: NetworkMode) => void;
    toggleMode: () => void;
}

export const useNetworkModeStore = create<NetworkModeState>()((set) => ({
    mode: 'standard',
    isSatelliteMode: false,
    maxSatelliteAreaDeg2: 400,
    setMode: (mode) => set({ mode, isSatelliteMode: mode === 'satellite' }),
    toggleMode: () =>
        set((state) => {
            const next = state.mode === 'standard' ? 'satellite' : 'standard';
            return { mode: next, isSatelliteMode: next === 'satellite' };
        }),
}));
