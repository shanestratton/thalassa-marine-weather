/**
 * CacheAgeBadge — Shows how stale cached data is.
 *
 * Displays a subtle "Updated X ago" badge on data cards,
 * so users know whether they're looking at fresh or cached data.
 *
 * Colors shift from green (fresh) → amber (stale) → red (very stale)
 * to give instant visual feedback on data freshness.
 *
 * Usage:
 *   <CacheAgeBadge timestamp="2026-04-04T10:00:00Z" />
 */
import React, { useState, useEffect } from 'react';

interface CacheAgeBadgeProps {
    /** ISO timestamp of last successful data fetch */
    timestamp: string | null;
    /** Custom label prefix (default: "Updated") */
    label?: string;
    /** Additional CSS classes */
    className?: string;
}

export const CacheAgeBadge: React.FC<CacheAgeBadgeProps> = ({ timestamp, label = 'Updated', className = '' }) => {
    const [, setTick] = useState(0);

    // Re-render every 30s to keep time display fresh
    useEffect(() => {
        const interval = setInterval(() => setTick((t) => t + 1), 30000);
        return () => clearInterval(interval);
    }, []);

    if (!timestamp) return null;

    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageMins = Math.floor(ageMs / 60000);

    // Format the age
    let ageText: string;
    if (ageMins < 1) ageText = 'just now';
    else if (ageMins < 60) ageText = `${ageMins}m ago`;
    else {
        const hrs = Math.floor(ageMins / 60);
        if (hrs < 24) ageText = `${hrs}h ago`;
        else {
            const days = Math.floor(hrs / 24);
            ageText = `${days}d ago`;
        }
    }

    // Color by freshness
    const dotColor =
        ageMins < 15
            ? 'bg-emerald-400'
            : ageMins < 60
              ? 'bg-emerald-400/60'
              : ageMins < 360
                ? 'bg-amber-400'
                : 'bg-red-400';

    const textColor = ageMins < 60 ? 'text-white/30' : ageMins < 360 ? 'text-amber-400/50' : 'text-red-400/50';

    return (
        <div className={`flex items-center gap-1.5 ${className}`}>
            <div className={`w-1 h-1 rounded-full ${dotColor}`} />
            <span className={`text-[10px] font-bold ${textColor} uppercase tracking-wider`}>
                {label} {ageText}
            </span>
        </div>
    );
};
