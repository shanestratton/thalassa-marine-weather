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
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

// ── State ────────────────────────────────────────────────────

export interface WeatherState {
    /** Internal owner fence for the context → Zustand bridge. */
    readonly identityKey: string;
    /** Process-local generation; same user after logout/login is still a new scope. */
    readonly identityGeneration: number;
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
    /**
     * Bulk sync from context — used by the bridge hook. This is the ONLY
     * write path: WeatherContext owns the state and mirrors it here through
     * the identity fence. The per-field setters that used to sit beside it
     * had no callers and would have bypassed that fence.
     */
    _sync: (partial: Partial<WeatherState>, expectedScope: AuthIdentityScope) => void;
}

// ── Store ────────────────────────────────────────────────────

function blankWeatherState(scope: AuthIdentityScope): WeatherState {
    return {
        identityKey: scope.key,
        identityGeneration: scope.generation,
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
    };
}

function ownsScope(state: WeatherState, scope: AuthIdentityScope): boolean {
    return (
        isAuthIdentityScopeCurrent(scope) &&
        state.identityKey === scope.key &&
        state.identityGeneration === scope.generation
    );
}

const initialScope = getAuthIdentityScope();

export const useWeatherStore = create<WeatherState & WeatherActions>()(
    subscribeWithSelector((set) => ({
        ...blankWeatherState(initialScope),

        _sync: (partial, expectedScope) => set((state) => (ownsScope(state, expectedScope) ? partial : state)),
    })),
);

/**
 * The auth fence runs before React can re-render. Blank the external store in
 * that same synchronous turn so native/watch/voice consumers cannot observe
 * account A while the WeatherProvider is being rebuilt for account B.
 */
subscribeAuthIdentityScope((next) => {
    useWeatherStore.setState(blankWeatherState(next));
});
