/**
 * GpsTrackingIndicator — Global pulsing badge showing GPS fetch interval.
 * Visible on ALL screens when tracking is active. Fixed position top-right.
 *
 * Shows the current GPS capture interval (speed-adaptive):
 *   Stationary (<1 kt) →  "60s"
 *   Slow (1-6 kts)     →  "15s"
 *   Cruising (6-60 kts) → "5s"
 *   Fast (60+ kts)     →  "15s"
 *   Rapid mode (manual) → "5s"
 *
 * Pulse dot indicates motion state:
 *   Green pulse — vessel is moving (new positions being recorded)
 *   Red pulse   — no movement detected (position unchanged / deduped)
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
    const [isMoving, setIsMoving] = useState(false);

    // Poll tracking status every 1 second so it reacts quickly to mode changes
    useEffect(() => {
        const id = setInterval(() => {
            if (document.hidden) return; // Battery: skip when backgrounded
            const s = ShipLogService.getTrackingStatus();
            setStatus(s);

            // Use GPS speed (SOG) for reliable motion detection
            // SOG > 0.5 kts = moving, otherwise stationary
            const nav = ShipLogService.getGpsNavData();
            setIsMoving(nav.sogKts !== null && nav.sogKts > 0.5);
        }, 1000);
        return () => clearInterval(id);
    }, []);

    // Don't render if not tracking
    if (!status.isTracking) return null;

    const intervalMs = status.isRapidMode ? 5_000 : status.currentIntervalMs || 900_000;

    const label = formatIntervalLabel(intervalMs);
    const gpsStatus = ShipLogService.getGpsStatus();

    // GPS health dot (inner solid dot)
    const healthDotColor =
        gpsStatus === 'locked'
            ? isMoving
                ? 'bg-emerald-400'
                : 'bg-red-400'
            : gpsStatus === 'stale'
              ? 'bg-amber-400'
              : 'bg-red-500';

    // Badge background — green when moving, slate when stationary, red border in rapid mode
    const bgColor = isMoving
        ? status.isRapidMode
            ? 'bg-emerald-600/90 border-red-400/40'
            : 'bg-emerald-600/90 border-emerald-400/30'
        : status.isRapidMode
          ? 'bg-slate-700/90 border-red-400/40'
          : 'bg-slate-700/90 border-slate-500/30';

    // Pulse ring color: green = moving, red = stationary
    const pulseColor = isMoving ? 'bg-emerald-500' : 'bg-red-400';

    return (
        <div className="pointer-events-none">
            <div
                className={`relative flex items-center gap-1 px-2 py-1 rounded-full justify-center ${bgColor} border shadow-lg transition-colors duration-500`}
            >
                {/* Pulse ring — green when moving, red when stationary */}
                <span className="relative flex h-2 w-2">
                    <span
                        className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`}
                    />
                    <span
                        className={`relative inline-flex rounded-full h-2 w-2 ${healthDotColor} transition-colors duration-500`}
                    />
                </span>

                {/* GPS icon */}
                <svg
                    className="w-3 h-3 text-white/90"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <circle cx="12" cy="12" r="3" />
                    <path strokeLinecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                </svg>

                {/* Interval label */}
                <span className="text-white font-bold text-[11px] tracking-wide leading-none">{label}</span>
            </div>
        </div>
    );
};
