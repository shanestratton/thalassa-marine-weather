import React from 'react';
import { t } from '../../theme';

/**
 * Skeleton loader for HeroSlide cards
 * Shows animated placeholder while data loads
 */
export const HeroSlideSkeleton: React.FC<{ count?: number }> = ({ count = 1 }) => {
    return (
        <>
            {Array.from({ length: count }).map((_, i) => (
                <div
                    key={i}
                    className="w-full shrink-0 snap-center px-2"
                >
                    <div className={`bg-gradient-to-br from-slate-800/80 to-slate-900/80 rounded-2xl p-4 ${t.border.default} animate-pulse`}>
                        {/* Header skeleton */}
                        <div className="flex justify-between items-start mb-4">
                            <div className="space-y-2">
                                <div className="h-6 w-32 bg-white/10 rounded" />
                                <div className="h-4 w-24 bg-white/5 rounded" />
                            </div>
                            <div className="h-12 w-20 bg-white/10 rounded" />
                        </div>

                        {/* Widget grid skeleton */}
                        <div className="grid grid-cols-5 gap-2 mb-4">
                            {Array.from({ length: 10 }).map((_, j) => (
                                <div
                                    key={j}
                                    className="h-16 bg-white/5 rounded-lg"
                                />
                            ))}
                        </div>

                        {/* Tide graph skeleton */}
                        <div className="h-24 bg-white/5 rounded-lg mb-4" />

                        {/* Cards skeleton */}
                        <div className="flex gap-2 overflow-hidden">
                            {Array.from({ length: 6 }).map((_, j) => (
                                <div
                                    key={j}
                                    className="w-20 h-32 shrink-0 bg-white/5 rounded-lg"
                                />
                            ))}
                        </div>
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
    <div className={`w-20 h-32 shrink-0 bg-gradient-to-b from-white/5 to-white/[0.02] rounded-lg ${t.border.subtle} animate-pulse flex flex-col items-center justify-center gap-2 p-2`}>
        <div className="h-3 w-8 bg-white/10 rounded" />
        <div className="h-6 w-6 bg-white/10 rounded-full" />
        <div className="h-4 w-10 bg-white/10 rounded" />
        <div className="h-3 w-8 bg-white/5 rounded" />
    </div>
);

/**
 * Skeleton for widget grid
 */
export const WidgetGridSkeleton: React.FC<{ rows?: number; cols?: number }> = ({
    rows = 2,
    cols = 5
}) => (
    <div className={`grid grid-cols-${cols} gap-2`}>
        {Array.from({ length: rows * cols }).map((_, i) => (
            <div
                key={i}
                className="h-14 bg-white/5 rounded-lg animate-pulse"
            />
        ))}
    </div>
);

export default HeroSlideSkeleton;
