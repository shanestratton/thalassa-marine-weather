import React from 'react';
import { t } from '../../theme';

/**
 * Skeleton loader components for shimmer loading states
 * Uses CSS animation for smooth pulse effect
 */

interface SkeletonProps {
    className?: string;
}

// Base skeleton with shimmer animation
export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
    <div className={`skeleton-shimmer ${className}`} />
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
        <div className={`bg-white/5 backdrop-blur-md rounded-xl ${t.border.default} p-4 h-full flex flex-col justify-between`}>
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

// Chat channel list skeleton
export const SkeletonChannelList: React.FC = () => (
    <div className="px-4 py-3 space-y-2 animate-in fade-in duration-300">
        <Skeleton className="h-2.5 w-20 mb-3" />
        {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-3.5 p-3.5 rounded-2xl bg-white/[0.02] border border-white/[0.03]">
                <Skeleton className="w-11 h-11 !rounded-xl" />
                <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                </div>
            </div>
        ))}
    </div>
);

// Logbook voyage list skeleton
export const SkeletonVoyageList: React.FC = () => (
    <div className="px-3 space-y-3 animate-in fade-in duration-300">
        {[0, 1, 2].map(i => (
            <div key={i} className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 space-y-3">
                <div className="flex justify-between">
                    <Skeleton className="h-3 w-2/5" />
                    <Skeleton className="h-5 w-16" />
                </div>
                <Skeleton className="h-5 w-3/4" />
                <div className="grid grid-cols-4 gap-2">
                    {[0, 1, 2, 3].map(j => (
                        <Skeleton key={j} className="h-8" />
                    ))}
                </div>
            </div>
        ))}
    </div>
);
