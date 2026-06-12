import React from 'react';
import { t } from '../../theme';

/**
 * Skeleton loader for HeroSlide cards
 * Shows animated placeholder while data loads.
 *
 * Mirrors the real slide geometry (HeroSlide.tsx): a full-height flex
 * column with one dominant flex-[2] rounded-2xl card (tide graph / map /
 * instrument panel) — not the retired header + widget-grid + hourly-strip
 * layout.
 */
export const HeroSlideSkeleton: React.FC<{ count?: number }> = ({ count = 1 }) => {
    return (
        <>
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="w-full h-full shrink-0 snap-start pb-4 flex flex-col">
                    <div className="relative w-full h-full flex flex-col gap-2 animate-pulse">
                        {/* Dominant essential card — same box as the real flex-[2] card */}
                        <div className="relative flex-[2] min-h-0 w-full rounded-2xl border border-white/[0.08] bg-white/[0.04]" />
                    </div>
                </div>
            ))}
        </>
    );
};

/**
 * Skeleton for vertical hourly cards
 */
export const HourlyCardSkeleton: React.FC = () => (
    <div
        className={`w-20 h-32 shrink-0 bg-gradient-to-b from-white/5 to-white/[0.02] rounded-lg ${t.border.subtle} animate-pulse flex flex-col items-center justify-center gap-2 p-2`}
    >
        <div className="h-3 w-8 bg-white/10 rounded" />
        <div className="h-6 w-6 bg-white/10 rounded-full" />
        <div className="h-4 w-10 bg-white/10 rounded" />
        <div className="h-3 w-8 bg-white/5 rounded" />
    </div>
);

/**
 * Skeleton for widget grid
 */
export const WidgetGridSkeleton: React.FC<{ rows?: number; cols?: number }> = ({ rows = 2, cols = 5 }) => (
    <div className={`grid grid-cols-${cols} gap-2`}>
        {Array.from({ length: rows * cols }).map((_, i) => (
            <div key={i} className="h-14 bg-white/5 rounded-lg animate-pulse" />
        ))}
    </div>
);

export default HeroSlideSkeleton;
