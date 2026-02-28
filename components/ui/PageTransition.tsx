/**
 * PageTransition — iOS-style spring-physics page transitions with swipe-back.
 *
 * Wraps child pages in AnimatePresence + motion.div to produce:
 *   PUSH  → new page slides in from right, old slides left
 *   POP   → old page slides right, new appears from left
 *   TAB   → instant fade (for bottom nav tab switches)
 *
 * Swipe-back:
 *   On "pushed" pages, dragging from the left 40px edge triggers a pop.
 *   The gesture only activates horizontally (dy ≤ dx) to avoid conflict
 *   with vertical scroll. Uses a velocity threshold to feel natural.
 *
 * Uses framer-motion spring physics for natural deceleration.
 */
import React, { useCallback, useRef } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, PanInfo } from 'framer-motion';

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
const SWIPE_EDGE_WIDTH = 40;       // px — left edge zone to start swipe
const SWIPE_DISMISS_THRESHOLD = 0.35; // fraction of screen width
const SWIPE_VELOCITY_THRESHOLD = 500; // px/s — quick flick dismisses

const animationVariants = {
    push: {
        initial: { x: '100%', opacity: 0.7 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '-30%', opacity: 0.5 },
    },
    pop: {
        initial: { x: '-30%', opacity: 0.5 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '100%', opacity: 0.7 },
    },
    tab: {
        initial: { opacity: 0, scale: 0.98 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.98 },
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
    const dragX = useMotionValue(0);
    const dragOpacity = useTransform(dragX, [0, 300], [1, 0.6]);
    const dragStartedInEdge = useRef(false);

    const handleDragStart = useCallback((_: unknown, info: PanInfo) => {
        // Only start if touch began in left edge zone
        // info.point gives the cursor position
        const startX = info.point.x - info.offset.x;
        dragStartedInEdge.current = startX <= SWIPE_EDGE_WIDTH;
    }, []);

    const handleDragEnd = useCallback((_: unknown, info: PanInfo) => {
        if (!dragStartedInEdge.current || !onSwipeBack) return;

        const screenWidth = window.innerWidth;
        const draggedFraction = info.offset.x / screenWidth;
        const velocity = info.velocity.x;

        // Dismiss if dragged far enough OR flicked fast enough
        if (draggedFraction > SWIPE_DISMISS_THRESHOLD || velocity > SWIPE_VELOCITY_THRESHOLD) {
            onSwipeBack();
        }

        dragStartedInEdge.current = false;
    }, [onSwipeBack]);

    const dragProps = canSwipeBack && onSwipeBack ? {
        drag: 'x' as const,
        dragConstraints: { left: 0, right: 0 },
        dragElastic: { left: 0, right: 0.8 },
        dragDirectionLock: true,
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        style: { x: dragX, opacity: dragOpacity },
    } : {};

    return (
        <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
                key={pageKey}
                initial={variant.initial}
                animate={variant.animate}
                exit={variant.exit}
                transition={direction === 'tab'
                    ? { duration: 0.2, ease: 'easeInOut' }
                    : SPRING
                }
                className="absolute inset-0 will-change-transform bg-slate-950"
                {...dragProps}
            >
                {children}
            </motion.div>
        </AnimatePresence>
    );
};
