/**
 * PageTransition — Lightweight CSS-only page transitions.
 *
 * Replaces framer-motion springs with GPU-composited CSS transitions.
 * Uses only transform + opacity (composite-only properties) so
 * the transition runs on the GPU compositor thread — zero JS per frame.
 *
 * Mode:
 *   PUSH  → new page slides in from right
 *   POP   → new page slides in from left
 *   TAB   → instant swap (fade, no slide)
 */
import React, { useRef, useLayoutEffect, useState, useCallback } from 'react';

export type TransitionDirection = 'push' | 'pop' | 'tab';

interface PageTransitionProps {
    pageKey: string;
    direction: TransitionDirection;
    children: React.ReactNode;
    canSwipeBack?: boolean;
    onSwipeBack?: () => void;
}

// Durations (ms)
const SLIDE_DURATION = 280;
const TAB_DURATION = 120;

// Swipe-back thresholds
const SWIPE_EDGE_WIDTH = 24;
const SWIPE_DISMISS_FRACTION = 0.3;
const _SWIPE_VELOCITY_THRESHOLD = 400;

export const PageTransition: React.FC<PageTransitionProps> = ({
    pageKey,
    direction,
    children,
    canSwipeBack = false,
    onSwipeBack,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [phase, setPhase] = useState<'idle' | 'entering' | 'animating'>('idle');
    const prevKeyRef = useRef(pageKey);

    // Layout timing prevents the newly keyed page from painting once at its
    // final position before we move it to the slide-in start position.
    useLayoutEffect(() => {
        if (pageKey === prevKeyRef.current) return;
        prevKeyRef.current = pageKey;

        if (direction === 'tab') {
            // Tab changes are intentionally immediate.
            setPhase('idle');
            return;
        }

        // Keep the compositor hint only for the actual transition. A
        // permanent transform/will-change creates a containing block and
        // stacking context, trapping every fixed descendant below global app
        // chrome even after the animation has finished.
        setPhase('entering');
        let secondFrame = 0;
        let settleTimer = 0;
        const firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => {
                setPhase('animating');
                settleTimer = window.setTimeout(() => setPhase('idle'), SLIDE_DURATION);
            });
        });

        return () => {
            cancelAnimationFrame(firstFrame);
            if (secondFrame) cancelAnimationFrame(secondFrame);
            if (settleTimer) window.clearTimeout(settleTimer);
        };
    }, [pageKey, direction]);

    // Compute inline transform for enter state
    const getEntryTransform = (): React.CSSProperties => {
        if (phase === 'idle') {
            return {
                transform: 'none',
                opacity: 1,
                transition: direction === 'tab' ? `opacity ${TAB_DURATION}ms ease-out` : 'none',
                willChange: 'auto',
            };
        }

        // Starting position — off-screen
        if (phase === 'entering' && direction === 'push') {
            return {
                transform: 'translate3d(100%, 0, 0)',
                opacity: 0.9,
                transition: 'none',
                willChange: 'transform, opacity',
            };
        } else if (phase === 'entering' && direction === 'pop') {
            return {
                transform: 'translate3d(-30%, 0, 0)',
                opacity: 0.9,
                transition: 'none',
                willChange: 'transform, opacity',
            };
        }

        return {
            transform: 'translate3d(0, 0, 0)',
            opacity: 1,
            transition: `transform ${SLIDE_DURATION}ms cubic-bezier(0.32, 0.72, 0, 1), opacity ${SLIDE_DURATION}ms ease-out`,
            willChange: 'transform, opacity',
        };
    };

    // Edge swipe-back gesture
    const touchStartRef = useRef({ x: 0, y: 0, started: false });

    const handleTouchStart = useCallback(
        (e: React.TouchEvent) => {
            const touch = e.touches[0];
            if (touch.clientX <= SWIPE_EDGE_WIDTH && canSwipeBack && onSwipeBack) {
                touchStartRef.current = { x: touch.clientX, y: touch.clientY, started: true };
            }
        },
        [canSwipeBack, onSwipeBack],
    );

    const handleTouchEnd = useCallback(
        (e: React.TouchEvent) => {
            if (!touchStartRef.current.started || !onSwipeBack) return;
            touchStartRef.current.started = false;

            const touch = e.changedTouches[0];
            const dx = touch.clientX - touchStartRef.current.x;
            const screenWidth = window.innerWidth;

            if (dx / screenWidth > SWIPE_DISMISS_FRACTION || dx > 100) {
                onSwipeBack();
            }
        },
        [onSwipeBack],
    );

    return (
        <div
            ref={containerRef}
            key={pageKey}
            className="absolute inset-0 bg-slate-950"
            data-transition-phase={phase}
            style={getEntryTransform()}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
        >
            {children}
        </div>
    );
};
