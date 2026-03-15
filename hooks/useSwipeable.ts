/**
 * useSwipeable — Shared swipe-to-delete gesture hook.
 *
 * Encapsulates touch handling for left-swipe-to-reveal-delete pattern.
 * Used by InventoryList, EquipmentList, MaintenanceHub, DocumentsHub, CrewManagement.
 *
 * iOS-safe: Uses native event listeners with { passive: false } so that
 * preventDefault() actually works in WKWebView / Capacitor. React's synthetic
 * onTouchMove is passive by default and cannot prevent scroll.
 *
 * Usage:
 *   const { swipeOffset, isSwiping, ref, resetSwipe } = useSwipeable();
 *   <div ref={ref} style={{ transform: `translateX(-${swipeOffset}px)`, touchAction: 'pan-y' }}>
 */
import { useState, useRef, useCallback, useEffect } from 'react';

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
    /** Attach to the swipeable element */
    ref: React.RefCallback<HTMLElement>;
    /** Legacy: React synthetic handlers (kept for backwards compat) */
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

    // Refs for touch tracking
    const startX = useRef(0);
    const startY = useRef(0);
    const isDraggingRef = useRef(false);
    const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
    const offsetRef = useRef(0);
    const elementRef = useRef<HTMLElement | null>(null);

    const LOCK_THRESHOLD = 6; // px before we decide direction

    // ── Native event handlers (non-passive for iOS) ──

    const handleTouchStart = useCallback((e: TouchEvent) => {
        const touch = e.touches[0];
        startX.current = touch.clientX;
        startY.current = touch.clientY;
        isDraggingRef.current = true;
        directionLocked.current = null;
    }, []);

    const handleTouchMove = useCallback(
        (e: TouchEvent) => {
            if (!isDraggingRef.current) return;

            const touch = e.touches[0];
            const dx = startX.current - touch.clientX;
            const dy = touch.clientY - startY.current;

            // Direction lock: decide on first significant movement
            if (!directionLocked.current) {
                const absDx = Math.abs(dx);
                const absDy = Math.abs(dy);

                if (absDx < LOCK_THRESHOLD && absDy < LOCK_THRESHOLD) return;

                if (absDx > absDy * 1.2) {
                    // Horizontal — we own this gesture
                    directionLocked.current = 'horizontal';
                    setIsSwiping(true);
                } else {
                    // Vertical — let the browser scroll
                    directionLocked.current = 'vertical';
                    isDraggingRef.current = false;
                    return;
                }
            }

            if (directionLocked.current === 'vertical') return;

            // ★ KEY FIX: This works because we register with { passive: false }
            e.preventDefault();
            e.stopPropagation();

            const clamped = Math.max(0, Math.min(dx, max));
            offsetRef.current = clamped;
            setSwipeOffset(clamped);
        },
        [max],
    );

    const handleTouchEnd = useCallback(() => {
        if (!isDraggingRef.current && directionLocked.current !== 'horizontal') {
            directionLocked.current = null;
            return;
        }

        isDraggingRef.current = false;
        directionLocked.current = null;
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

    // ── Attach native listeners via ref callback ──

    const refCallback = useCallback(
        (node: HTMLElement | null) => {
            // Clean up old element
            if (elementRef.current) {
                elementRef.current.removeEventListener('touchstart', handleTouchStart);
                elementRef.current.removeEventListener('touchmove', handleTouchMove as any);
                elementRef.current.removeEventListener('touchend', handleTouchEnd);
            }

            elementRef.current = node;

            // Attach to new element
            if (node) {
                node.addEventListener('touchstart', handleTouchStart, { passive: true });
                // ★ passive: false is the critical fix for iOS
                node.addEventListener('touchmove', handleTouchMove as any, { passive: false });
                node.addEventListener('touchend', handleTouchEnd, { passive: true });
            }
        },
        [handleTouchStart, handleTouchMove, handleTouchEnd],
    );

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (elementRef.current) {
                elementRef.current.removeEventListener('touchstart', handleTouchStart);
                elementRef.current.removeEventListener('touchmove', handleTouchMove as any);
                elementRef.current.removeEventListener('touchend', handleTouchEnd);
            }
        };
    }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

    const resetSwipe = useCallback(() => {
        setSwipeOffset(0);
        offsetRef.current = 0;
        directionLocked.current = null;
    }, []);

    // Legacy React handlers (no-ops if ref is used, fallback if not)
    const noopStart = useCallback((_e: React.TouchEvent) => {}, []);
    const noopMove = useCallback((_e: React.TouchEvent) => {}, []);
    const noopEnd = useCallback(() => {}, []);

    return {
        swipeOffset,
        isSwiping,
        resetSwipe,
        ref: refCallback,
        handlers: {
            onTouchStart: noopStart,
            onTouchMove: noopMove,
            onTouchEnd: noopEnd,
        },
    };
}
