/**
 * useExitPresence: keep something on screen for a short CSS exit after it is
 * closed. This is the one job framer-motion's AnimatePresence did for the
 * layer menu and the storm picker; the build-126 bundle diet replaced the
 * library (about 126 KB of the app's JavaScript) with CSS keyframes.
 *
 * Pass the live value (null when closed). `shown` is what to render: the live
 * value, or the last one while it leaves. While `leaving`, the caller plays
 * its exit class and takes the element out of the accessibility tree and out
 * of pointer and focus reach, so nothing can act on something already going.
 * It unmounts after `exitMs`, or at once when the phone asks for reduced
 * motion (the CSS switches every entrance and exit off then too).
 */
import { useEffect, useState } from 'react';

export function prefersReducedMotion(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
    );
}

interface Presence<T> {
    shown: T | null;
    leaving: boolean;
}

export function useExitPresence<T>(value: T | null, exitMs: number): Presence<T> {
    const [state, setState] = useState<Presence<T>>({ shown: value, leaving: false });

    // Adjusted during render (React's "previous render" pattern), so an open
    // or a close never paints one stale frame first.
    let next = state;
    if (value !== null) {
        if (state.shown !== value || state.leaving) next = { shown: value, leaving: false };
    } else if (state.shown !== null && !state.leaving) {
        next =
            exitMs > 0 && !prefersReducedMotion()
                ? { shown: state.shown, leaving: true }
                : { shown: null, leaving: false };
    }
    if (next !== state) setState(next);

    useEffect(() => {
        if (!state.leaving) return;
        const timer = setTimeout(() => setState({ shown: null, leaving: false }), exitMs);
        return () => clearTimeout(timer);
    }, [state.leaving, exitMs]);

    return next;
}
