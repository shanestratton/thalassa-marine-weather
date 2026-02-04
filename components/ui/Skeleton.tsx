import React from 'react';

/**
 * Skeleton loader components for shimmer loading states
 * Uses CSS animation for smooth pulse effect
 */

interface SkeletonProps {
    className?: string;
}

// Base skeleton with shimmer animation
export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
    <div className={`animate-pulse bg-white/10 rounded ${className}`} />
);

// Skeleton for text lines
export const SkeletonText: React.FC<{ lines?: number; className?: string }> = ({
    lines = 1,
    className = ''
}) => (
    <div className={`space-y-2 ${className}`}>
        {Array.from({ length: lines }).map((_, i) => (
            <Skeleton
                key={i}
                className={`h-3 ${i === lines - 1 ? 'w-3/4' : 'w-full'}`}
            />
        ))}
    </div>
);

// Skeleton for the CurrentConditionsCard
export const CurrentConditionsCardSkeleton: React.FC = () => (
    <div className="w-full h-[140px]">
        <div className="bg-white/5 backdrop-blur-md rounded-xl border border-white/10 p-4 h-full flex flex-col justify-between">
            {/* Top row: icon + text */}
            <div className="flex items-center gap-3">
                <Skeleton className="w-6 h-6 rounded-full" />
                <Skeleton className="h-5 w-32" />
            </div>

            {/* Bottom row: 5 stat columns */}
            <div className="flex items-end justify-between mt-3">
                {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex flex-col items-center flex-1 gap-1">
                        <Skeleton className="w-4 h-4 rounded-full" />
                        <Skeleton className="h-5 w-8" />
                        <Skeleton className="h-2 w-6" />
                    </div>
                ))}
            </div>
        </div>
    </div>
);

// Skeleton for the HeroWidgets grid (5x2)
export const HeroWidgetsSkeleton: React.FC = () => (
    <div className="space-y-2">
        {/* Two rows */}
        {[1, 2].map((row) => (
            <div key={row} className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 4, 5].map((col) => (
                    <div
                        key={col}
                        className="bg-white/5 rounded-lg p-2 flex flex-col items-center justify-center h-[60px]"
                    >
                        <Skeleton className="w-4 h-4 rounded-full mb-1" />
                        <Skeleton className="h-4 w-10" />
                        <Skeleton className="h-2 w-6 mt-1" />
                    </div>
                ))}
            </div>
        ))}
    </div>
);

// Skeleton for the HeroHeader
export const HeroHeaderSkeleton: React.FC = () => (
    <div className="flex justify-between items-start">
        <div className="flex-1">
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="h-10 w-20" />
        </div>
        <div className="flex flex-col items-end">
            <Skeleton className="h-3 w-16 mb-1" />
            <SkeletonText lines={2} className="w-40" />
        </div>
    </div>
);

// Full dashboard skeleton
export const DashboardSkeleton: React.FC = () => (
    <div className="p-4 space-y-4">
        <HeroHeaderSkeleton />
        <HeroWidgetsSkeleton />
        <Skeleton className="h-48 w-full rounded-xl" /> {/* Tide graph */}
    </div>
);
