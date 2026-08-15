import { useEffect, useState } from 'react';

/**
 * The current viewport height in CSS pixels, for layout that must know how
 * tall the screen actually is.
 *
 * The Glass pins its cards at computed offsets and clips the remainder. That
 * is fine at 812pt and above; at 667 (iPhone SE / 8) the untrimmed stack left
 * twelve pixels for the hero, so the tide graph and instrument carousel were a
 * black sliver in an overflow-hidden box with no way to scroll to them. The
 * layout therefore needs the viewport height as an input rather than assuming
 * a tall phone — see components/dashboard/glassLayout.ts.
 *
 * Reads window.innerHeight, NOT visualViewport: this must describe the LAYOUT
 * viewport, which is stable. visualViewport shrinks when the on-screen
 * keyboard opens, and re-running the whole card geometry on every keystroke is
 * exactly the wrong behaviour. Keyboard avoidance is a separate concern owned
 * by utils/keyboardScroll.ts.
 *
 * Returns 0 during SSR and in non-DOM tests; callers treat a falsy value as
 * "assume a tall phone", preserving the original layout.
 */
export function useViewportHeight(): number {
    const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const read = () => setHeight(window.innerHeight);
        read();
        // orientationchange as well as resize: iOS fires resize late (and
        // sometimes with pre-rotation numbers) when the device turns.
        window.addEventListener('resize', read);
        window.addEventListener('orientationchange', read);
        return () => {
            window.removeEventListener('resize', read);
            window.removeEventListener('orientationchange', read);
        };
    }, []);

    return height;
}
