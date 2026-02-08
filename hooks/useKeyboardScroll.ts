import { useEffect, useRef, useCallback } from 'react';

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
 * How it works:
 * 1. Listens for 'focusin' on the container
 * 2. When an input/textarea/select gets focus, waits 350ms for the iOS
 *    keyboard animation to finish
 * 3. Scrolls the element into the visible viewport using scrollIntoView
 * 4. Also uses visualViewport resize events to re-scroll if the viewport
 *    shrinks (keyboard appearing/resizing)
 */
export function useKeyboardScroll<T extends HTMLElement>() {
    const containerRef = useRef<T>(null);

    const scrollFocusedInput = useCallback(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return;
        const tag = active.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            active.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Handle focusin — delay to allow iOS keyboard animation
        const handleFocusIn = (e: Event) => {
            const target = e.target as HTMLElement;
            const tag = target.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                // Wait for keyboard to fully appear before scrolling
                setTimeout(() => {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 350);
            }
        };

        container.addEventListener('focusin', handleFocusIn);

        // Also listen for visualViewport resize (keyboard showing/hiding)
        const vv = window.visualViewport;
        const handleResize = () => {
            // Re-scroll when viewport shrinks (keyboard appearing)
            setTimeout(scrollFocusedInput, 100);
        };

        if (vv) {
            vv.addEventListener('resize', handleResize);
        }

        return () => {
            container.removeEventListener('focusin', handleFocusIn);
            if (vv) {
                vv.removeEventListener('resize', handleResize);
            }
        };
    }, [scrollFocusedInput]);

    return containerRef;
}
