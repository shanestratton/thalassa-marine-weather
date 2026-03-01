/**
 * ListSkeleton — Shimmer loading placeholder for list views.
 *
 * Shows animated placeholder cards while data is loading.
 * Used by InventoryList, EquipmentList, MaintenanceHub, DocumentsHub.
 */
import React from 'react';

interface ListSkeletonProps {
    /** Number of placeholder cards to show (default: 5) */
    count?: number;
    /** Optional header height for stat cards (default: false) */
    showHeader?: boolean;
}

const ShimmerCard: React.FC = () => (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 animate-pulse">
        <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/[0.06] rounded-xl shrink-0" />
            <div className="flex-1 space-y-2">
                <div className="h-4 bg-white/[0.06] rounded-lg w-3/4" />
                <div className="h-3 bg-white/[0.04] rounded-lg w-1/2" />
            </div>
            <div className="w-12 h-6 bg-white/[0.04] rounded-full" />
        </div>
    </div>
);

const StatCard: React.FC = () => (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 animate-pulse">
        <div className="flex items-center justify-between">
            <div className="space-y-2">
                <div className="h-3 bg-white/[0.06] rounded-lg w-20" />
                <div className="h-6 bg-white/[0.06] rounded-lg w-16" />
            </div>
            <div className="w-10 h-10 bg-white/[0.04] rounded-full" />
        </div>
    </div>
);

export const ListSkeleton: React.FC<ListSkeletonProps> = ({ count = 5, showHeader = false }) => (
    <div className="space-y-3 p-4">
        {showHeader && (
            <div className="grid grid-cols-3 gap-3 mb-4">
                <StatCard />
                <StatCard />
                <StatCard />
            </div>
        )}
        {Array.from({ length: count }, (_, i) => (
            <ShimmerCard key={i} />
        ))}
    </div>
);
