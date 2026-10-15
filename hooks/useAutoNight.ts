/**
 * useAutoNight — the clock behind 'Auto with night' (131-03).
 *
 * Off, it reads nothing and returns null, so 'auto' and the fixed modes are
 * exactly as they were. On, it reads nightWindow for the forecast location
 * at once (no lit frame at 2 am while it catches up), again every minute,
 * and again the moment the app comes back to the screen: a phone that slept
 * through dusk must not wake up bright. Each read carries the last answer so
 * the window's hysteresis can hold at dusk and dawn, and an unchanged answer
 * keeps the same object, so App only re-renders when the answer changes.
 *
 * The last read is also kept for Settings, which says what the mode can see
 * from here (a polar summer, or no position yet) — the same answer the app
 * acts on, without Settings reaching into the weather.
 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { nightWindow, type NightWindow } from '../utils/nightWindow';

let shown: NightWindow | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};
const publish = (read: NightWindow | null) => {
    if (read === shown) return;
    shown = read;
    for (const fn of listeners) fn();
};

/** The read 'Auto with night' is acting on now; null while it is off or has no position. */
export const useAutoNightShown = (): NightWindow | null =>
    useSyncExternalStore(
        subscribe,
        () => shown,
        () => null,
    );

type Place = { lat: number; lon: number } | undefined;

function readNight(place: Place, tz: string | undefined, last: NightWindow | null): NightWindow | null {
    // (0,0) is the cold-start stub, not a real position.
    if (!place || (place.lat === 0 && place.lon === 0)) return null;
    const next = nightWindow(Date.now(), place.lat, place.lon, tz, last?.night ?? null);
    return last && last.night === next.night && last.state === next.state ? last : next;
}

export function useAutoNight(enabled: boolean, place: Place, tz?: string): NightWindow | null {
    const at = enabled && place ? place : undefined;
    const key = at ? `${at.lat},${at.lon},${tz}` : '';
    const [held, setHeld] = useState(() => ({ key, read: readNight(at, tz, null) }));
    let read = held.read;
    if (held.key !== key) {
        // A new place or the mode just chosen: read it in this render.
        read = readNight(at, tz, held.read);
        setHeld({ key, read });
    }
    const lat = at?.lat;
    const lon = at?.lon;
    useEffect(() => {
        if (lat === undefined || lon === undefined) return;
        const reread = () =>
            setHeld((h) => {
                const next = readNight({ lat, lon }, tz, h.read);
                return next === h.read ? h : { key: h.key, read: next };
            });
        const onVisible = () => {
            if (document.visibilityState === 'visible') reread();
        };
        const iv = window.setInterval(reread, 60_000);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearInterval(iv);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [lat, lon, tz]);
    // Layout effect: Settings' line updates before the frame is painted.
    useLayoutEffect(() => publish(read), [read]);
    useLayoutEffect(() => () => publish(null), []);
    return read;
}
