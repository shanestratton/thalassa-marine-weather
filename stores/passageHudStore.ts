/**
 * passageHudStore — is the Obs chart's passage pane open?
 *
 * Shane, 2026-09-17, three days under way to Gladstone: "the only real issue
 * i have is i dont really know which screen to look at, so i am thinking we
 * need a new layer on the obs page. this layer will show cog, sog, wind speed,
 * direction and true and apparent … most of the info needs to be on a pane
 * that can be hidden to one side (left i am thinking)."
 *
 * This is the one switch for that pane. Remembered on this device so the
 * skipper who opened it at the start of a passage finds it open on the next
 * glance. Same shape as chartPassageOverlay: a module value, a listener set,
 * and useSyncExternalStore for the components — no zustand, nothing to hydrate.
 *
 * Phase 2 adds the time axis (`t`, playing, speed) beside this flag; keep them
 * in this module so the pane and the scrubber read one store.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'thalassa_passage_hud_open_v1';
/** Off until the skipper asks for it in Settings → Preferences (Shane's home for toggles). */
const ENABLED_KEY = 'thalassa_passage_hud_enabled_v1';

function readFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === '1';
    } catch {
        return false;
    }
}
const read = (): boolean => readFlag(KEY);

let open = read();
let enabled = readFlag(ENABLED_KEY);
const listeners = new Set<() => void>();

export function isPassageHudOpen(): boolean {
    return open;
}

export function setPassageHudOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    try {
        if (next) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    listeners.forEach((fn) => fn());
}

export function togglePassageHud(): void {
    setPassageHudOpen(!open);
}

export function subscribePassageHud(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function usePassageHudOpen(): boolean {
    return useSyncExternalStore(subscribePassageHud, isPassageHudOpen, isPassageHudOpen);
}

/**
 * Whether the strip exists on the chart at all. OFF by default: three review
 * rounds measured it against the chart's furniture and each found something
 * new in its column, so it reaches a punter only when the skipper turns it on.
 */
export function isPassageHudEnabled(): boolean {
    return enabled;
}

export function setPassageHudEnabled(next: boolean): void {
    if (next === enabled) return;
    enabled = next;
    try {
        if (next) localStorage.setItem(ENABLED_KEY, '1');
        else localStorage.removeItem(ENABLED_KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    // Switching it off must not leave the chart's furniture stepped aside for
    // a strip that is no longer there.
    if (!next && open) {
        open = false;
        try {
            localStorage.removeItem(KEY);
        } catch {
            /* as above */
        }
    }
    listeners.forEach((fn) => fn());
}

export function usePassageHudEnabled(): boolean {
    return useSyncExternalStore(subscribePassageHud, isPassageHudEnabled, isPassageHudEnabled);
}

/** Test seam. */
export function __resetPassageHudForTests(): void {
    open = read();
    enabled = readFlag(ENABLED_KEY);
}
