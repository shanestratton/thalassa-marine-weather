import { useEffect, useRef } from 'react';

/**
 * Traps keyboard focus within a container element when active.
 * Implements WAI-ARIA dialog focus management best practices:
 * - Focus moves to container on mount
 * - Tab/Shift+Tab cycle through focusable elements
 * - Focus returns to trigger element on unmount
 */
export function useFocusTrap(isActive: boolean) {
    const containerRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!isActive) return;

        // Save the previously focused element so we can restore it
        previousFocusRef.current = document.activeElement as HTMLElement;

        const container = containerRef.current;
        if (!container) return;

        // Focus the container or the first focusable element
        const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        const focusables = container.querySelectorAll<HTMLElement>(focusableSelector);
        if (focusables.length > 0) {
            // Small delay to ensure the DOM is painted
            requestAnimationFrame(() => focusables[0].focus());
        } else {
            container.focus();
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;

            const currentFocusables = container.querySelectorAll<HTMLElement>(focusableSelector);
            if (currentFocusables.length === 0) return;

            const first = currentFocusables[0];
            const last = currentFocusables[currentFocusables.length - 1];

            if (e.shiftKey) {
                // Shift+Tab: if focus is on first element, wrap to last
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                // Tab: if focus is on last element, wrap to first
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        container.addEventListener('keydown', handleKeyDown);

        return () => {
            container.removeEventListener('keydown', handleKeyDown);
            // Restore focus to the previously focused element
            if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
                previousFocusRef.current.focus();
            }
        };
    }, [isActive]);

    return containerRef;
}

/**
 * Hook to detect user's prefers-reduced-motion setting.
 * Returns true if the user prefers reduced motion.
 */
export function useReducedMotion(): boolean {
    const query = typeof window !== 'undefined'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    // Use a simple check — no need for state since this rarely changes mid-session
    return query?.matches ?? false;
}
