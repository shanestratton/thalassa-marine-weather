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
 * Pulse dot indicates motion state:
 *   Green pulse — vessel is moving (new positions being recorded)
 *   Red pulse   — no movement detected (position unchanged / deduped)
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
    const [isStationary, setIsStationary] = useState(false);
    const lastCheckRef = useRef<number | undefined>(undefined);

    // Poll tracking status every 1 second so it reacts quickly to mode changes
    useEffect(() => {
        const id = setInterval(() => {
            if (document.hidden) return; // Battery: skip when backgrounded
            const s = ShipLogService.getTrackingStatus();
            setStatus(s);

            // Detect motion state from dedup events
            if (s.lastCheckTime && s.lastCheckTime !== lastCheckRef.current) {
                lastCheckRef.current = s.lastCheckTime;
                setIsStationary(!!s.lastCheckDeduped);
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

    // GPS health dot (inner solid dot)
    const healthDotColor = gpsStatus === 'locked'
        ? (isStationary ? 'bg-red-400' : 'bg-emerald-400')
        : gpsStatus === 'stale'
            ? 'bg-amber-400'
            : 'bg-red-500';

    // Badge background
    const bgColor = status.isRapidMode
        ? 'bg-red-500/90 border-red-400/40'
        : isStationary
            ? 'bg-slate-700/90 border-slate-500/30'
            : 'bg-emerald-600/90 border-emerald-400/30';

    // Pulse ring color: green = moving, red = stationary
    const pulseColor = status.isRapidMode
        ? 'bg-red-500'
        : isStationary
            ? 'bg-red-400'
            : 'bg-emerald-500';

    return (
        <div className="pointer-events-none">
            <div className={`relative flex items-center gap-1 px-2 py-1 rounded-full justify-center ${bgColor} border backdrop-blur-md shadow-lg transition-colors duration-500`}>
                {/* Pulse ring — green when moving, red when stationary */}
                <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`} />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${healthDotColor} transition-colors duration-500`} />
                </span>

                {/* GPS icon */}
                <svg className="w-3 h-3 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
