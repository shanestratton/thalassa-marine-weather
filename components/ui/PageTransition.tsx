/**
 * PageTransition — iOS-style spring-physics page transitions.
 *
 * Wraps child pages in AnimatePresence + motion.div to produce:
 *   PUSH  → new page slides in from right, old slides left
 *   POP   → old page slides right, new appears from left
 *   TAB   → instant fade (for bottom nav tab switches)
 *
 * Uses framer-motion spring physics for natural deceleration.
 */
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type TransitionDirection = 'push' | 'pop' | 'tab';

interface PageTransitionProps {
    pageKey: string;
    direction: TransitionDirection;
    children: React.ReactNode;
}

// iOS-style spring configuration
const SPRING = {
    type: 'spring' as const,
    stiffness: 300,
    damping: 30,
    mass: 0.8,
};

const variants = {
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
}) => {
    const variant = variants[direction];

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
                className="absolute inset-0 will-change-transform"
            >
                {children}
            </motion.div>
        </AnimatePresence>
    );
};
