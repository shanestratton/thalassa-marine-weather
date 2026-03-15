/**
 * usePullToRefresh — Native-feel pull-to-refresh for scrollable containers.
 *
 * Detects touch-drag from top of a scrollable element and triggers a
 * callback when the user pulls past a threshold. Shows a visual indicator.
 */
import { useRef, useCallback, useState } from 'react';

interface PullToRefreshResult {
    /** Attach to the scrollable container */
    containerRef: React.RefObject<HTMLDivElement>;
    /** Whether a refresh is in progress */
    isRefreshing: boolean;
    /** The current pull distance (for visual indicator) */
    pullDistance: number;
    /** Touch event handlers to spread on the container */
    handlers: {
        onTouchStart: (e: React.TouchEvent) => void;
        onTouchMove: (e: React.TouchEvent) => void;
        onTouchEnd: () => void;
    };
}

const THRESHOLD = 70; // pixels to trigger refresh

export function usePullToRefresh(onRefresh: () => Promise<void>): PullToRefreshResult {
    const containerRef = useRef<HTMLDivElement>(null);
    const startY = useRef(0);
    const [pullDistance, setPullDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const pulling = useRef(false);

    const onTouchStart = useCallback(
        (e: React.TouchEvent) => {
            const el = containerRef.current;
            if (!el || el.scrollTop > 0 || isRefreshing) return;
            startY.current = e.touches[0].clientY;
            pulling.current = true;
        },
        [isRefreshing],
    );

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        if (!pulling.current) return;
        const delta = e.touches[0].clientY - startY.current;
        if (delta > 0) {
            // Rubber-band resistance — diminishing returns past threshold
            const dampened = Math.min(delta * 0.4, 120);
            setPullDistance(dampened);
        } else {
            pulling.current = false;
            setPullDistance(0);
        }
    }, []);

    const onTouchEnd = useCallback(async () => {
        if (!pulling.current) return;
        pulling.current = false;
        if (pullDistance >= THRESHOLD * 0.4) {
            setIsRefreshing(true);
            setPullDistance(THRESHOLD * 0.4);
            try {
                await onRefresh();
            } finally {
                setIsRefreshing(false);
                setPullDistance(0);
            }
        } else {
            setPullDistance(0);
        }
    }, [pullDistance, onRefresh]);

    return {
        containerRef,
        isRefreshing,
        pullDistance,
        handlers: { onTouchStart, onTouchMove, onTouchEnd },
    };
}
