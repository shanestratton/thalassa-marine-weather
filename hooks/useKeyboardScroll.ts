import { useEffect, useRef } from 'react';
import { scheduleKeyboardAvoidance } from '../utils/keyboardScroll';

/**
 * useKeyboardScroll — Ensures focused inputs scroll into view on iOS
 * where the virtual keyboard overlays the page without pushing content.
 *
 * Usage:
 *   const scrollRef = useKeyboardScroll<HTMLDivElement>();
 *   <div ref={scrollRef}>
 *     <input ... />      ← any input/textarea inside will be handled
 *   </div>
 *
 * The app-wide keyboard guard owns keyboard height and viewport geometry. This
 * hook remains for surfaces that want immediate, container-scoped focus
 * handling (for example an independently mounted Anchor Watch form), without
 * recreating a second, slightly different keyboard implementation.
 */
export function useKeyboardScroll<T extends HTMLElement>() {
    const containerRef = useRef<T>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleFocusIn = (e: Event) => {
            scheduleKeyboardAvoidance(e.target);
        };

        container.addEventListener('focusin', handleFocusIn);

        return () => {
            container.removeEventListener('focusin', handleFocusIn);
        };
    }, []);

    return containerRef;
}
