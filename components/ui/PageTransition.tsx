/**
 * PageTransition — iOS-style spring-physics page transitions with swipe-back.
 *
 * Wraps child pages in AnimatePresence + motion.div to produce:
 *   PUSH  → new page slides in from right, old slides left
 *   POP   → old page slides right, new appears from left
 *   TAB   → instant swap (for bottom nav tab switches)
 *
 * Swipe-back:
 *   On "pushed" pages, a thin invisible strip on the left edge
 *   captures horizontal drag gestures and triggers a pop when the
 *   drag crosses the dismiss threshold.
 *
 *   The gesture is isolated to the edge strip so it doesn't conflict
 *   with CTA slide buttons, carousels, or other horizontal scrollers.
 *
 * Uses framer-motion spring physics for natural deceleration.
 */
import React, { useCallback } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';

export type TransitionDirection = 'push' | 'pop' | 'tab';

interface PageTransitionProps {
    pageKey: string;
    direction: TransitionDirection;
    children: React.ReactNode;
    /** Whether this page can be swiped back (push pages only) */
    canSwipeBack?: boolean;
    /** Callback when swipe-back completes */
    onSwipeBack?: () => void;
}

// iOS-style spring configuration
const SPRING = {
    type: 'spring' as const,
    stiffness: 300,
    damping: 30,
    mass: 0.8,
};

// Swipe-back thresholds
const SWIPE_EDGE_WIDTH = 24;       // px — edge zone strip width
const SWIPE_DISMISS_THRESHOLD = 0.30; // fraction of screen width
const SWIPE_VELOCITY_THRESHOLD = 400; // px/s — quick flick dismisses

const animationVariants = {
    push: {
        initial: { x: '100%', opacity: 1 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '-30%', opacity: 0.5 },
    },
    pop: {
        initial: { x: '-30%', opacity: 1 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '100%', opacity: 0.7 },
    },
    tab: {
        // Instant swap — no crossfade to prevent bleed-through
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
    },
};

export const PageTransition: React.FC<PageTransitionProps> = ({
    pageKey,
    direction,
    children,
    canSwipeBack = false,
    onSwipeBack,
}) => {
    const variant = animationVariants[direction];

    const handleEdgeDragEnd = useCallback((_: unknown, info: PanInfo) => {
        if (!onSwipeBack) return;

        const screenWidth = window.innerWidth;
        const draggedFraction = info.offset.x / screenWidth;
        const velocity = info.velocity.x;

        // Dismiss if dragged far enough OR flicked fast enough
        if (draggedFraction > SWIPE_DISMISS_THRESHOLD || velocity > SWIPE_VELOCITY_THRESHOLD) {
            onSwipeBack();
        }
    }, [onSwipeBack]);

    return (
        <AnimatePresence mode="wait" initial={false}>
            <motion.div
                key={pageKey}
                initial={variant.initial}
                animate={variant.animate}
                exit={variant.exit}
                transition={direction === 'tab'
                    ? { duration: 0.15, ease: 'easeInOut' }
                    : SPRING
                }
                className="absolute inset-0 will-change-transform bg-slate-950"
            >
                {children}

                {/* Invisible edge-zone strip for swipe-back gesture.
                    Only captures drags that start in this 24px-wide strip.
                    Does NOT interfere with CTA buttons, carousels, etc. */}
                {canSwipeBack && onSwipeBack && (
                    <motion.div
                        className="absolute left-0 top-0 h-full z-[60]"
                        style={{ width: SWIPE_EDGE_WIDTH }}
                        drag="x"
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={{ left: 0, right: 0.9 }}
                        dragDirectionLock
                        onDragEnd={handleEdgeDragEnd}
                    />
                )}
            </motion.div>
        </AnimatePresence>
    );
};
