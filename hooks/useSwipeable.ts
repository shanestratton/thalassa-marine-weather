/**
 * useSwipeable — Shared swipe-to-delete gesture hook.
 *
 * Encapsulates touch handling for left-swipe-to-reveal-delete pattern.
 * Used by InventoryList, EquipmentList, MaintenanceHub, DocumentsHub.
 *
 * Usage:
 *   const { swipeOffset, isSwiping, handlers } = useSwipeable({ threshold: 80 });
 *   <div {...handlers} style={{ transform: `translateX(-${swipeOffset}px)` }}>
 */
import { useState, useRef, useCallback } from 'react';

interface UseSwipeableOptions {
    /** Pixel distance to lock into "delete revealed" state. Default: 80 */
    threshold?: number;
    /** Max swipe distance. Default: threshold + 20 */
    maxOffset?: number;
    /** Called when swipe passes threshold and finger lifts */
    onSwipeComplete?: () => void;
}

interface UseSwipeableReturn {
    swipeOffset: number;
    isSwiping: boolean;
    resetSwipe: () => void;
    handlers: {
        onTouchStart: (e: React.TouchEvent) => void;
        onTouchMove: (e: React.TouchEvent) => void;
        onTouchEnd: () => void;
    };
}

export function useSwipeable(options: UseSwipeableOptions = {}): UseSwipeableReturn {
    const { threshold = 80, maxOffset, onSwipeComplete } = options;
    const max = maxOffset ?? threshold + 20;

    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isSwiping, setIsSwiping] = useState(false);

    // Use refs for values read during rapid touch events to avoid stale closures
    const startX = useRef(0);
    const isDraggingRef = useRef(false);
    const offsetRef = useRef(0);

    const onTouchStart = useCallback((e: React.TouchEvent) => {
        startX.current = e.touches[0].clientX;
        isDraggingRef.current = true;
        setIsSwiping(true);
    }, []);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isDraggingRef.current) return;
        const diff = startX.current - e.touches[0].clientX;
        const clamped = Math.max(0, Math.min(diff, max));
        offsetRef.current = clamped;
        setSwipeOffset(clamped);
    }, [max]);

    const onTouchEnd = useCallback(() => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        setIsSwiping(false);
        const final = offsetRef.current;
        if (final >= threshold) {
            setSwipeOffset(threshold);
            offsetRef.current = threshold;
            onSwipeComplete?.();
        } else {
            setSwipeOffset(0);
            offsetRef.current = 0;
        }
    }, [threshold, onSwipeComplete]);

    const resetSwipe = useCallback(() => {
        setSwipeOffset(0);
        offsetRef.current = 0;
    }, []);

    return {
        swipeOffset,
        isSwiping,
        resetSwipe,
        handlers: { onTouchStart, onTouchMove, onTouchEnd },
    };
}
