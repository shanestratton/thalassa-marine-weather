import { useCallback, useRef } from 'react';

/**
 * Custom hook for managing scroll synchronization between containers
 * Useful for keeping header and content in sync during horizontal scrolling
 */
export const useScrollSync = () => {
    const scrollTimeoutRef = useRef<NodeJS.Timeout>();
    const isScrollingRef = useRef(false);

    const handleScrollStart = useCallback(() => {
        isScrollingRef.current = true;
    }, []);

    const handleScrollEnd = useCallback((callback?: () => void) => {
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
        }

        scrollTimeoutRef.current = setTimeout(() => {
            isScrollingRef.current = false;
            callback?.();
        }, 150); // Debounce scroll end detection
    }, []);

    const syncScroll = useCallback((sourceElement: HTMLElement, targetElement: HTMLElement) => {
        targetElement.scrollLeft = sourceElement.scrollLeft;
    }, []);

    return {
        handleScrollStart,
        handleScrollEnd,
        syncScroll,
        isScrolling: isScrollingRef.current
    };
};
