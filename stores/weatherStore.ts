/**
 * Weather Store — Zustand-based state management for weather data
 * ─────────────────────────────────────────────────────────────────
 * Extracts the weather state slice from WeatherContext into a Zustand store.
 * This enables fine-grained subscriptions — components only re-render when
 * the specific slice of state they use changes.
 *
 * Architecture:
 * - This store holds the READ state (weatherData, voyagePlan, loading, etc.)
 * - WeatherContext.tsx remains the WRITE orchestrator (timers, GPS, effects)
 * - The context provider syncs state to this store via `useWeatherStoreSync()`
 * - Components can use either `useWeather()` (context) or `useWeatherStore()` (zustand)
 *
 * Migration path:
 * 1. ✅ Create this store (current step)
 * 2. ✅ Add sync bridge in WeatherContext
 * 3. Components can incrementally adopt `useWeatherStore` selectors
 * 4. Eventually remove context entirely once all consumers are migrated
 *
 * @example
 * // Fine-grained subscription — only re-renders when weatherData changes
 * const weatherData = useWeatherStore((s) => s.weatherData);
 *
 * // Multiple slices — still only re-renders when these specific values change
 * const { loading, error } = useWeatherStore((s) => ({
 *     loading: s.loading,
 *     error: s.error,
 * }));
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';

// ── State ────────────────────────────────────────────────────

export interface WeatherState {
    /** Current weather report for the active location */
    weatherData: MarineWeatherReport | null;
    /** Active voyage plan */
    voyagePlan: VoyagePlan | null;
    /** Whether initial weather data is loading */
    loading: boolean;
    /** Human-readable loading status message */
    loadingMessage: string;
    /** Last error message, or null if healthy */
    error: string | null;
    /** Debug diagnostics (model info, fetch times, etc.) */
    debugInfo: DebugInfo | null;
    /** Number of API calls made this session */
    quotaUsed: number;
    /** Whether a background refresh is in progress */
    backgroundUpdating: boolean;
    /** Whether current data is stale and being refreshed */
    staleRefresh: boolean;
    /** Unix timestamp of next scheduled auto-refresh */
    nextUpdate: number | null;
    /** Cache of weather data for previously visited locations */
    historyCache: Record<string, MarineWeatherReport>;
}

// ── Actions ──────────────────────────────────────────────────

export interface WeatherActions {
    setWeatherData: (data: MarineWeatherReport | null) => void;
    setVoyagePlan: (plan: VoyagePlan | null) => void;
    setLoading: (loading: boolean) => void;
    setLoadingMessage: (msg: string) => void;
    setError: (error: string | null) => void;
    setQuotaUsed: (quota: number) => void;
    setBackgroundUpdating: (updating: boolean) => void;
    setStaleRefresh: (stale: boolean) => void;
    setNextUpdate: (next: number | null) => void;
    setHistoryCache: (cache: Record<string, MarineWeatherReport>) => void;
    incrementQuota: () => void;
    clearVoyagePlan: () => void;
    /** Bulk sync from context — used by the bridge hook */
    _sync: (partial: Partial<WeatherState>) => void;
}

// ── Store ────────────────────────────────────────────────────

export const useWeatherStore = create<WeatherState & WeatherActions>()(
    subscribeWithSelector((set) => ({
        // Initial state
        weatherData: null,
        voyagePlan: null,
        loading: true,
        loadingMessage: 'Initializing Weather Data...',
        error: null,
        debugInfo: null,
        quotaUsed: 0,
        backgroundUpdating: false,
        staleRefresh: false,
        nextUpdate: null,
        historyCache: {},

        // Actions
        setWeatherData: (data) => set({ weatherData: data }),
        setVoyagePlan: (plan) => set({ voyagePlan: plan }),
        setLoading: (loading) => set({ loading }),
        setLoadingMessage: (msg) => set({ loadingMessage: msg }),
        setError: (error) => set({ error }),
        setQuotaUsed: (quota) => set({ quotaUsed: quota }),
        setBackgroundUpdating: (updating) => set({ backgroundUpdating: updating }),
        setStaleRefresh: (stale) => set({ staleRefresh: stale }),
        setNextUpdate: (next) => set({ nextUpdate: next }),
        setHistoryCache: (cache) => set({ historyCache: cache }),
        incrementQuota: () => set((s) => ({ quotaUsed: s.quotaUsed + 1 })),
        clearVoyagePlan: () => set({ voyagePlan: null }),
        _sync: (partial) => set(partial),
    })),
);

// ── Selectors (convenience) ──────────────────────────────────

/** Select only the weather report — avoids re-render on loading/error changes */
export const selectWeatherData = (s: WeatherState & WeatherActions) => s.weatherData;

/** Select only the voyage plan */
export const selectVoyagePlan = (s: WeatherState & WeatherActions) => s.voyagePlan;

/** Select loading state */
export const selectLoading = (s: WeatherState & WeatherActions) => ({
    loading: s.loading,
    loadingMessage: s.loadingMessage,
    backgroundUpdating: s.backgroundUpdating,
    staleRefresh: s.staleRefresh,
});

/** Select error state */
export const selectError = (s: WeatherState & WeatherActions) => s.error;

/** Select next update timestamp */
export const selectNextUpdate = (s: WeatherState & WeatherActions) => s.nextUpdate;
