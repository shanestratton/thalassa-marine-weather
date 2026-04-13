/**
 * PassageStore — Global passage plan route state.
 *
 * Pub/sub singleton following the same pattern as WindStore.
 * Holds computed route data so it can be shared between the
 * Charts page (where routes are computed) and the Nav Station
 * page (where the passage summary card lives).
 *
 * State is persisted to localStorage so it survives page
 * navigations within the app.
 *
 * Architecture: Zustand-like API without the dependency.
 *   usePassageStore() — React hook
 *   PassageStore.setState() — imperative update
 *   PassageStore.getState() — snapshot
 *   PassageStore.setFromRoute() — build legs with auto difficulty
 */

import { useState, useEffect } from 'react';

// ── Types ──────────────────────────────────────────────────────

export interface PassageTurnWaypoint {
    id: string; // "DEP", "WP1", ..., "ARR"
    name: string; // Human label
    lat: number;
    lon: number;
    bearing: number; // degrees true
    distanceNM: number; // cumulative from start
    timeHours: number; // hours from departure
    eta: string; // ISO timestamp
    tws: number; // true wind speed knots
    twa: number; // true wind angle degrees
}

export interface PassageLeg {
    from: string; // waypoint name
    to: string; // waypoint name
    bearing: number; // degrees true
    distanceNM: number;
    durationHours: number;
    avgWindKt: number;
    maxWindKt: number;
    avgWaveM: number;
    maxWaveM: number;
    /** 'easy' | 'moderate' | 'tough' | 'challenging' */
    difficulty: 'easy' | 'moderate' | 'tough' | 'challenging';
    /** Description of why this leg has its difficulty rating */
    difficultyReason: string;
}

export interface PassageRouteState {
    /** Whether a computed route is available */
    hasRoute: boolean;
    /** Route name (e.g., "Moreton Bay → Hamilton Island") */
    routeName: string | null;
    /** Departure port */
    departPort: string | null;
    /** Destination port */
    destPort: string | null;
    /** Departure coordinates */
    departLat: number | null;
    departLon: number | null;
    /** Arrival coordinates */
    arriveLat: number | null;
    arriveLon: number | null;
    /** Route polyline [lon, lat][] for map rendering */
    routeCoordinates: [number, number][];
    /** Turn waypoints along route */
    turnWaypoints: PassageTurnWaypoint[];
    /** Route legs with weather/difficulty breakdown */
    legs: PassageLeg[];
    /** Total distance nautical miles */
    totalDistanceNM: number;
    /** Total estimated duration hours */
    totalDurationHours: number;
    /** Departure time ISO */
    departureTime: string | null;
    /** Arrival time ISO */
    arrivalTime: string | null;
    /** Max expected wind speed knots */
    maxWindKt: number | null;
    /** Max expected wave height meters */
    maxWaveM: number | null;
    /** Average speed knots */
    avgSpeedKts: number | null;
    /** Vessel name */
    vesselName: string | null;
}

type PassageListener = (state: PassageRouteState) => void;

// ── Difficulty Logic ──────────────────────────────────────────

function computeDifficulty(
    maxWindKt: number,
    maxWaveM: number,
): { difficulty: PassageLeg['difficulty']; difficultyReason: string } {
    if (maxWindKt < 15 && maxWaveM < 1.5) {
        return {
            difficulty: 'easy',
            difficultyReason: `Light winds (${maxWindKt}kt) and small waves (${maxWaveM}m)`,
        };
    }
    if (maxWindKt < 25 && maxWaveM < 2.5) {
        return {
            difficulty: 'moderate',
            difficultyReason: `Moderate winds (${maxWindKt}kt) and moderate seas (${maxWaveM}m)`,
        };
    }
    if (maxWindKt < 35 && maxWaveM < 4) {
        return {
            difficulty: 'tough',
            difficultyReason: `Strong winds (${maxWindKt}kt) and rough seas (${maxWaveM}m)`,
        };
    }
    return {
        difficulty: 'challenging',
        difficultyReason: `Very strong winds (${maxWindKt}kt) and heavy seas (${maxWaveM}m)`,
    };
}

// ── localStorage Persistence ──────────────────────────────────

const STORAGE_KEY = 'thalassa_passage_route';

function saveToStorage(s: PassageRouteState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
        // Storage full or unavailable — ignore silently
    }
}

function loadFromStorage(): PassageRouteState | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw) as PassageRouteState;
    } catch {
        // Corrupted data — ignore silently
    }
    return null;
}

// ── Default ────────────────────────────────────────────────────

const DEFAULT_STATE: PassageRouteState = {
    hasRoute: false,
    routeName: null,
    departPort: null,
    destPort: null,
    departLat: null,
    departLon: null,
    arriveLat: null,
    arriveLon: null,
    routeCoordinates: [],
    turnWaypoints: [],
    legs: [],
    totalDistanceNM: 0,
    totalDurationHours: 0,
    departureTime: null,
    arrivalTime: null,
    maxWindKt: null,
    maxWaveM: null,
    avgSpeedKts: null,
    vesselName: null,
};

// ── Store Singleton ────────────────────────────────────────────

let state: PassageRouteState = loadFromStorage() ?? { ...DEFAULT_STATE };
const listeners = new Set<PassageListener>();

function notify() {
    listeners.forEach((fn) => fn(state));
}

export const PassageStore = {
    getState(): PassageRouteState {
        return state;
    },

    setState(partial: Partial<PassageRouteState>) {
        state = { ...state, ...partial };
        saveToStorage(state);
        notify();
    },

    /**
     * Build a full route state from partial route data.
     * Automatically computes difficulty ratings for each leg
     * based on wind speed and wave height thresholds.
     */
    setFromRoute(data: Partial<PassageRouteState>) {
        const legs: PassageLeg[] = (data.legs ?? []).map((leg) => {
            const { difficulty, difficultyReason } = computeDifficulty(leg.maxWindKt, leg.maxWaveM);
            return { ...leg, difficulty, difficultyReason };
        });

        state = {
            ...state,
            ...data,
            legs,
            hasRoute: true,
        };
        saveToStorage(state);
        notify();
    },

    subscribe(fn: PassageListener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    /** Reset to defaults and clear persisted data */
    clear() {
        state = { ...DEFAULT_STATE };
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // Ignore
        }
        notify();
    },
};

// ── React Hook ─────────────────────────────────────────────────

export function usePassageStore(): PassageRouteState {
    const [s, setS] = useState(PassageStore.getState());
    useEffect(() => PassageStore.subscribe(setS), []);
    return s;
}
