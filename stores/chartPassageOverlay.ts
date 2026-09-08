/**
 * chartPassageOverlay — does the Obs chart show the passage under way?
 *
 * Shane 2026-09-09: "i would prefer not to have the current route showing on
 * the obs page by default as the punter can add it in when he wants from the
 * layer fab. also, that part needs a little hardening because they persist
 * when you try to turn them off."
 *
 * Until today Active Voyage Mode forced the active voyage's planned route,
 * its sailed track and the followed route's destination flag onto the chart
 * whenever a voyage was active — and re-applied them on every routes change
 * and every 60 s trail refresh, so clearing one in the picker undid itself.
 *
 * This is the one switch behind all three: OFF by default, flipped from the
 * layer FAB's "Passage" entry, remembered on this device. The Routes and
 * Tracks pickers stay independent — a punter can pull up any route to read
 * the weather along it whether this is on or off.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'thalassa_chart_passage_overlay_v1';

function read(): boolean {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
}

let value = read();
const listeners = new Set<() => void>();

export function isPassageOverlayOn(): boolean {
    return value;
}

export function setPassageOverlay(on: boolean): void {
    value = on;
    try {
        if (on) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    listeners.forEach((fn) => fn());
}

export function subscribePassageOverlay(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function usePassageOverlay(): boolean {
    return useSyncExternalStore(subscribePassageOverlay, isPassageOverlayOn, isPassageOverlayOn);
}

/** Test seam. */
export function __resetPassageOverlayForTests(): void {
    value = read();
}
