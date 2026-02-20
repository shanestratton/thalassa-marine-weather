/**
 * LocationStore — Global location state for the entire app.
 *
 * Pub/sub singleton that acts as the single source of truth for
 * the user's selected location. The Map tab writes to it via
 * long-press pin drops; WX tab, Passage Planner, and all other
 * consumers subscribe.
 *
 * Architecture: Zustand-like API without the dependency.
 *   useLocationStore() — React hook
 *   LocationStore.setState() — imperative update
 *   LocationStore.getState() — snapshot
 */

// ── Types ──────────────────────────────────────────────────────

export interface LocationState {
    lat: number;
    lon: number;
    name: string;
    source: 'gps' | 'map_pin' | 'search' | 'favorite' | 'initial';
    timestamp: number;
    isReversGeocoding: boolean;
}

type Listener = (state: LocationState) => void;

// ── Default ────────────────────────────────────────────────────

const DEFAULT_STATE: LocationState = {
    lat: -27.47,
    lon: 153.02,
    name: 'Brisbane, QLD',
    source: 'initial',
    timestamp: Date.now(),
    isReversGeocoding: false,
};

// ── Store Singleton ────────────────────────────────────────────

let state: LocationState = { ...DEFAULT_STATE };
const listeners = new Set<Listener>();

function notify() {
    listeners.forEach(fn => fn(state));
}

export const LocationStore = {
    getState(): LocationState {
        return state;
    },

    setState(partial: Partial<LocationState>) {
        state = { ...state, ...partial, timestamp: Date.now() };
        notify();
    },

    /**
     * Set location from a map long-press pin drop.
     * Triggers reverse geocoding for the name.
     */
    async setFromMapPin(lat: number, lon: number) {
        // Immediately update coords (UI feels instant)
        state = {
            ...state,
            lat,
            lon,
            name: `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`,
            source: 'map_pin',
            timestamp: Date.now(),
            isReversGeocoding: true,
        };
        notify();

        // Reverse geocode
        try {
            const name = await reverseGeocode(lat, lon);
            if (name) {
                state = { ...state, name, isReversGeocoding: false };
                notify();
            } else {
                state = { ...state, isReversGeocoding: false };
                notify();
            }
        } catch {
            state = { ...state, isReversGeocoding: false };
            notify();
        }
    },

    /**
     * Set location from GPS.
     */
    setFromGPS(lat: number, lon: number, name?: string) {
        state = {
            ...state,
            lat,
            lon,
            name: name || state.name,
            source: 'gps',
            timestamp: Date.now(),
            isReversGeocoding: false,
        };
        notify();
    },

    /**
     * Set location from search.
     */
    setFromSearch(lat: number, lon: number, name: string) {
        state = {
            ...state,
            lat,
            lon,
            name,
            source: 'search',
            timestamp: Date.now(),
            isReversGeocoding: false,
        };
        notify();
    },

    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
};

// ── React Hook ─────────────────────────────────────────────────

import { useState as useReactState, useEffect } from 'react';

export function useLocationStore(): LocationState {
    const [s, setS] = useReactState(LocationStore.getState());
    useEffect(() => LocationStore.subscribe(setS), []);
    return s;
}

export function useLocationCoords(): { lat: number; lon: number } {
    const { lat, lon } = useLocationStore();
    return { lat, lon };
}

// ── Reverse Geocoding ──────────────────────────────────────────

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
            { headers: { 'Accept-Language': 'en' } }
        );
        if (!res.ok) return null;
        const data = await res.json();

        // Build a clean name: City, State or Locality
        const addr = data.address;
        if (!addr) return data.display_name?.split(',').slice(0, 2).join(',').trim() || null;

        const parts = [
            addr.city || addr.town || addr.village || addr.hamlet || addr.suburb,
            addr.state || addr.county,
        ].filter(Boolean);

        return parts.length > 0 ? parts.join(', ') : null;
    } catch {
        return null;
    }
}
