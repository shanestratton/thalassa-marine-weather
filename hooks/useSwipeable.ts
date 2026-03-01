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
    const startX = useRef(0);

    const onTouchStart = useCallback((e: React.TouchEvent) => {
        startX.current = e.touches[0].clientX;
        setIsSwiping(true);
    }, []);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isSwiping) return;
        const diff = startX.current - e.touches[0].clientX;
        setSwipeOffset(Math.max(0, Math.min(diff, max)));
    }, [isSwiping, max]);

    const onTouchEnd = useCallback(() => {
        setIsSwiping(false);
        if (swipeOffset >= threshold) {
            setSwipeOffset(threshold);
            onSwipeComplete?.();
        } else {
            setSwipeOffset(0);
        }
    }, [swipeOffset, threshold, onSwipeComplete]);

    const resetSwipe = useCallback(() => setSwipeOffset(0), []);

    return {
        swipeOffset,
        isSwiping,
        resetSwipe,
        handlers: { onTouchStart, onTouchMove, onTouchEnd },
    };
}
