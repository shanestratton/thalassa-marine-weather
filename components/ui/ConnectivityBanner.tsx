/**
 * ConnectivityBanner — Global offline/weak-signal awareness strip.
 *
 * Appears at the top of the app when the device loses connectivity.
 * Uses the existing useOnlineStatus hook and adds a "last seen" timer
 * so users know how long they've been offline.
 *
 * Maritime context: Essential at sea where connectivity is intermittent.
 * Shows:
 *   - Offline: amber strip with "No Signal" + elapsed time
 *   - Back online: green flash "Back Online" → auto-dismiss after 3s
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

export const ConnectivityBanner: React.FC = () => {
    const isOnline = useOnlineStatus();
    const [showReconnect, setShowReconnect] = useState(false);
    const [elapsedMinutes, setElapsedMinutes] = useState(0);
    const offlineSinceRef = useRef<number | null>(null);
    const wasOfflineRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Track offline duration
    useEffect(() => {
        if (!isOnline) {
            if (!offlineSinceRef.current) {
                offlineSinceRef.current = Date.now();
            }
            wasOfflineRef.current = true;
            setElapsedMinutes(0);

            // Update elapsed every 30s
            timerRef.current = setInterval(() => {
                if (offlineSinceRef.current) {
                    const mins = Math.floor((Date.now() - offlineSinceRef.current) / 60000);
                    setElapsedMinutes(mins);
                }
            }, 30000);
        } else {
            // Came back online
            if (timerRef.current) clearInterval(timerRef.current);
            offlineSinceRef.current = null;

            if (wasOfflineRef.current) {
                setShowReconnect(true);
                wasOfflineRef.current = false;
                setTimeout(() => setShowReconnect(false), 3000);
            }
        }

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isOnline]);

    const formatElapsed = useCallback((mins: number) => {
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        return `${hrs}h ${mins % 60}m`;
    }, []);

    // ── Reconnected flash ──
    if (showReconnect) {
        return (
            <div className="w-full flex items-center justify-center gap-2 px-4 py-1.5 bg-emerald-500/15 border-b border-emerald-500/20 animate-in fade-in slide-in-from-top duration-300">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">Back Online</span>
            </div>
        );
    }

    // ── Offline strip ──
    if (!isOnline) {
        return (
            <div className="w-full flex items-center justify-center gap-2 px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/15 animate-in fade-in slide-in-from-top duration-300">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-[11px] font-bold text-amber-400/80 uppercase tracking-wider">No Signal</span>
                {elapsedMinutes > 0 && (
                    <span className="text-[11px] text-amber-400/50 font-bold">· {formatElapsed(elapsedMinutes)}</span>
                )}
            </div>
        );
    }

    return null;
};
