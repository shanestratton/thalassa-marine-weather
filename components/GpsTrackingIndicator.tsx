/**
 * GpsTrackingIndicator — Global pulsing badge showing GPS fetch interval.
 * Visible on ALL screens when tracking is active. Fixed position top-right.
 *
 * Shows the current GPS capture interval:
 *   Rapid mode  →  "5s"
 *   Nearshore   →  "30s"
 *   Coastal     →  "2m"
 *   Offshore    →  "15m"
 */

import React, { useState, useEffect } from 'react';
import { ShipLogService } from '../services/ShipLogService';

/** Convert milliseconds to a human-readable short label */
function formatIntervalLabel(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

export const GpsTrackingIndicator: React.FC = () => {
    const [status, setStatus] = useState(() => ShipLogService.getTrackingStatus());

    // Poll tracking status every 1 second so it reacts quickly to mode changes
    useEffect(() => {
        const id = setInterval(() => {
            setStatus(ShipLogService.getTrackingStatus());
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
        </div>
    );
};
