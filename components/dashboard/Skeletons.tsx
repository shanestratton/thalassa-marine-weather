import React from 'react';

/**
 * Skeleton loader for HeroSlide cards
 * Shows animated placeholder while data loads.
 *
 * Mirrors the real slide geometry (HeroSlide.tsx): a full-height flex
 * column with one dominant flex-2 rounded-2xl card (tide graph / map /
 * instrument panel) — not the retired header + widget-grid + hourly-strip
 * layout.
 */
export const HeroSlideSkeleton: React.FC<{ count?: number }> = ({ count = 1 }) => {
    return (
        <>
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="w-full h-full shrink-0 snap-start pb-4 flex flex-col">
                    <div className="relative w-full h-full flex flex-col gap-2 animate-pulse">
                        {/* Dominant essential card — same box as the real flex-2 card */}
                        <div className="relative flex-2 min-h-0 w-full rounded-2xl border border-white/8 bg-white/4" />
                    </div>
                </div>
            ))}
        </>
    );
};

export default HeroSlideSkeleton;
