/**
 * WindStore — Global wind state for the map wind layer.
 *
 * Pub/sub singleton following the same pattern as LocationStore.
 * Manages the toggle between online (global streaming) and offline
 * (downloaded GRIB) wind data modes.
 *
 * Architecture: Zustand-like API without the dependency.
 *   useWindStore() — React hook
 *   WindStore.setState() — imperative update
 *   WindStore.getState() — snapshot
 */

import { useState, useEffect } from 'react';
import type { WindGrid } from '../services/weather/windField';

// ── Types ──────────────────────────────────────────────────────

export interface WindState {
    /** true = online streaming from API, false = local GRIB file */
    isGlobalMode: boolean;
    /** Active wind grid (from either source) */
    grid: WindGrid | null;
    /** Currently loading data */
    loading: boolean;
    /** Error message if fetch/parse failed */
    error: string | null;
    /** Path to downloaded .wind.bin file (if available) */
    localGribPath: string | null;
    /** Current forecast hour within the grid */
    hour: number;
    /** Total forecast hours in current grid */
    totalHours: number;
}

type WindListener = (state: WindState) => void;

// ── Default ────────────────────────────────────────────────────

const DEFAULT_STATE: WindState = {
    isGlobalMode: true,
    grid: null,
    loading: false,
    error: null,
    localGribPath: null,
    hour: 0,
    totalHours: 0,
};

// ── Store Singleton ────────────────────────────────────────────

let state: WindState = { ...DEFAULT_STATE };
const listeners = new Set<WindListener>();

function notify() {
    listeners.forEach(fn => fn(state));
}

export const WindStore = {
    getState(): WindState {
        return state;
    },

    setState(partial: Partial<WindState>) {
        state = { ...state, ...partial };
        notify();
    },

    /** Toggle between global streaming and local GRIB mode */
    toggleMode() {
        state = { ...state, isGlobalMode: !state.isGlobalMode, grid: null, loading: false, error: null, hour: 0, totalHours: 0 };
        notify();
    },

    /** Set the active wind grid (from either pipeline) */
    setGrid(grid: WindGrid) {
        state = { ...state, grid, totalHours: grid.totalHours, loading: false, error: null };
        notify();
    },

    /** Set loading state */
    setLoading(loading: boolean) {
        state = { ...state, loading };
        notify();
    },

    /** Set error state */
    setError(error: string) {
        state = { ...state, error, loading: false };
        notify();
    },

    /** Set the local GRIB file path (when a download completes) */
    setLocalGribPath(path: string | null) {
        state = { ...state, localGribPath: path };
        notify();
    },

    /** Reset to defaults */
    reset() {
        state = { ...DEFAULT_STATE };
        notify();
    },

    subscribe(fn: WindListener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};

// ── React Hook ─────────────────────────────────────────────────

export function useWindStore(): WindState {
    const [s, setS] = useState(WindStore.getState());
    useEffect(() => WindStore.subscribe(setS), []);
    return s;
}

export function useWindMode(): { isGlobalMode: boolean; toggleMode: () => void } {
    const { isGlobalMode } = useWindStore();
    return { isGlobalMode, toggleMode: WindStore.toggleMode };
}
