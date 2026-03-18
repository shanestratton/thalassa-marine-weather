/**
 * useFocusTrap — Trap keyboard focus within a container element
 *
 * When active, Tab and Shift+Tab cycle through focusable elements
 * within the container instead of escaping to the page behind.
 * Critical for modal accessibility (WCAG 2.4.3).
 *
 * Usage:
 *   const trapRef = useFocusTrap(isOpen);
 *   return <div ref={trapRef}>...modal content...</div>;
 */

import { useEffect, useRef, useCallback } from 'react';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
    isActive: boolean,
): React.RefObject<T | null> {
    const containerRef = useRef<T | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;

        const container = containerRef.current;
        if (!container) return;

        const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
            // Shift+Tab: wrap from first to last
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            // Tab: wrap from last to first
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }, []);

    useEffect(() => {
        if (!isActive) return;

        const container = containerRef.current;
        if (!container) return;

        // Save current focus to restore later
        previousFocusRef.current = document.activeElement as HTMLElement;

        // Focus the first focusable element in the container
        const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
            // Small delay to ensure DOM is rendered
            requestAnimationFrame(() => focusable[0].focus());
        }

        // Trap keyboard events
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            // Restore previous focus
            if (previousFocusRef.current && previousFocusRef.current.focus) {
                previousFocusRef.current.focus();
            }
        };
    }, [isActive, handleKeyDown]);

    return containerRef;
}
