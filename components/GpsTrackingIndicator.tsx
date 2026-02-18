/**
 * GpsTrackingIndicator — Global pulsing badge showing GPS fetch interval.
 * Visible on ALL screens when tracking is active. Fixed position top-right.
 *
 * Shows the current GPS capture interval:
 *   Rapid mode  →  "5s"
 *   Nearshore   →  "5s"
 *   Coastal     →  "5s"
 *   Offshore    →  "30s"
 *
 * Also shows a brief flash when a position check is deduped ("✓ No movement"),
 * confirming the system is alive even when the vessel is stationary.
 */

import React, { useState, useEffect, useRef } from 'react';
import { ShipLogService } from '../services/ShipLogService';

/** Convert milliseconds to a human-readable short label */
function formatIntervalLabel(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

export const GpsTrackingIndicator: React.FC = () => {
    const [status, setStatus] = useState(() => ShipLogService.getTrackingStatus());
    const [showDedup, setShowDedup] = useState(false);
    const lastCheckRef = useRef<number | undefined>(undefined);

    // Poll tracking status every 1 second so it reacts quickly to mode changes
    useEffect(() => {
        const id = setInterval(() => {
            const s = ShipLogService.getTrackingStatus();
            setStatus(s);

            // Detect new dedup event: lastCheckTime changed AND it was deduped
            if (s.lastCheckTime && s.lastCheckTime !== lastCheckRef.current) {
                lastCheckRef.current = s.lastCheckTime;
                if (s.lastCheckDeduped) {
                    setShowDedup(true);
                    // Auto-hide after 2.5 seconds
                    setTimeout(() => setShowDedup(false), 2500);
                }
            }
        }, 1000);
        return () => clearInterval(id);
    }, []);

    // Don't render if not tracking
    if (!status.isTracking) return null;

    const intervalMs = status.isRapidMode
        ? 5_000
        : (status.currentIntervalMs || 900_000);

    const label = formatIntervalLabel(intervalMs);
    const gpsStatus = ShipLogService.getGpsStatus();

    // Color based on GPS health
    const dotColor = gpsStatus === 'locked'
        ? 'bg-emerald-400'
        : gpsStatus === 'stale'
            ? 'bg-amber-400'
            : 'bg-red-500';

    const bgColor = status.isRapidMode
        ? 'bg-red-500/90 border-red-400/40'
        : 'bg-emerald-600/90 border-emerald-400/30';

    const pulseColor = status.isRapidMode
        ? 'bg-red-500'
        : 'bg-emerald-500';

    return (
        <div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-[950] pointer-events-none">
            {/* Main badge */}
            <div className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-full ${bgColor} border backdrop-blur-md shadow-lg`}>
                {/* Pulse ring */}
                <span className="relative flex h-2.5 w-2.5">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`} />
                    <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${dotColor}`} />
                </span>

                {/* GPS icon */}
                <svg className="w-3.5 h-3.5 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="3" />
                    <path strokeLinecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                </svg>

                {/* Interval label */}
                <span className="text-white font-bold text-[11px] tracking-wide leading-none">
                    {label}
                </span>
            </div>

            {/* Dedup feedback badge — flashes briefly when position is unchanged */}
            {showDedup && (
                <div
                    className="mt-1 flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-700/90 border border-slate-500/30 backdrop-blur-md shadow-sm"
                    style={{
                        animation: 'dedupFadeIn 0.3s ease-out, dedupFadeOut 0.5s ease-in 2s forwards',
                    }}
                >
                    <svg className="w-3 h-3 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-slate-300 text-[9px] font-medium tracking-wide whitespace-nowrap">
                        No movement
                    </span>
                </div>
            )}
        </div>
    );
};
