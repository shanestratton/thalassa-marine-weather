import { useEffect, useState, type RefObject } from 'react';

/**
 * Is this Log map's box on screen? A Log map is an extra WebGL context beside
 * Obs's (kept alive hidden), and each build is a billed Mapbox load, so it
 * should exist only while it is really being looked at:
 *
 *  - on screen at the observer's first report (the page opened on it, or the
 *    skipper just expanded it): true at once;
 *  - scrolled into view later: true once it has stayed in view for `dwellMs`,
 *    so a fling through the voyage list past an expanded card builds nothing;
 *  - out of view: false once it has stayed out for `graceMs`, so a scroll
 *    flick past it does not tear the map down and pay a second load for the
 *    same card.
 *
 * A hidden page (display:none) reads as out of view. Without
 * IntersectionObserver it is always on screen. Until the observer's first
 * report the answer is false: a browser always reports on observe(), so a
 * card mounted off screen never builds a map at all.
 */
export function useLogMapOnScreen(ref: RefObject<Element>, graceMs = 1_500, dwellMs = 250): boolean {
    const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === 'undefined');
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === 'undefined') {
            setOnScreen(true);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let firstReport = true;
        const observer = new IntersectionObserver(
            (entries) => {
                clearTimeout(timer);
                // One box per observer, and a busy main thread can be handed
                // several of its crossings at once (in, then out, in time
                // order): only the newest says where the box is now.
                const inView = entries[entries.length - 1]?.isIntersecting ?? false;
                if (inView && firstReport) setOnScreen(true);
                else if (inView) timer = setTimeout(() => setOnScreen(true), dwellMs);
                else timer = setTimeout(() => setOnScreen(false), graceMs);
                firstReport = false;
            },
            // A little early, so the map is drawing as the card scrolls in.
            { rootMargin: '64px' },
        );
        observer.observe(element);
        return () => {
            clearTimeout(timer);
            observer.disconnect();
        };
    }, [ref, graceMs, dwellMs]);
    return onScreen;
}
