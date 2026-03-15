/**
 * NmeaConnectionBadge — Tiny global badge showing NMEA backbone connection status.
 *
 * Only shows when FULLY CONNECTED — the NMEA page handles all
 * connecting/reconnecting/error feedback. This badge just confirms
 * an active live data connection to the vessel backbone.
 *
 * States:
 *   - Connected:    Green dot + "NMEA" label
 *   - Everything else: Hidden (no badge)
 */

import React, { useState, useEffect } from 'react';
import { NmeaListenerService } from '../services/NmeaListenerService';

export const NmeaConnectionBadge: React.FC = () => {
    const [status, setStatus] = useState(NmeaListenerService.getStatus());

    useEffect(() => {
        const unsub = NmeaListenerService.onStatusChange((s) => setStatus(s));
        // Sync on mount in case we missed the initial
        setStatus(NmeaListenerService.getStatus());
        return () => {
            unsub();
        };
    }, []);

    // Only show when fully connected — no confusing amber badge with no dismiss
    if (status !== 'connected') return null;

    return (
        <div className="pointer-events-none">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full justify-center bg-emerald-600/90 border-emerald-400/30 border shadow-lg">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />

                {/* Network icon (tiny antenna) */}
                <svg
                    className="w-3 h-3 text-white/90"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0"
                    />
                </svg>

                <span className="text-white font-bold text-[11px] tracking-wide leading-none whitespace-nowrap">
                    NMEA
                </span>
            </div>
        </div>
    );
};
