/**
 * NmeaGpsIndicator — Global badge showing when external GPS is active.
 *
 * Visible on ALL screens when the app is receiving GPS position data
 * from an external source (NMEA backbone, Bad Elf, chartplotter, etc.).
 *
 * Positioned below the GPS tracking indicator when both are visible.
 * Shows satellite count and fix quality (GPS / DGPS / RTK).
 */

import React, { useState, useEffect } from 'react';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { NmeaStore } from '../services/NmeaStore';

export const NmeaGpsIndicator: React.FC = () => {
    const [active, setActive] = useState(false);
    const [satellites, setSatellites] = useState<number | null>(null);
    const [qualityLabel, setQualityLabel] = useState('GPS');
    const [hdop, setHdop] = useState<number | null>(null);

    useEffect(() => {
        // Poll NmeaStore every second (aligned with the watchdog tick)
        const id = setInterval(() => {
            const isActive = NmeaGpsProvider.isActive();
            setActive(isActive);

            if (isActive) {
                const state = NmeaStore.getState();
                setSatellites(state.satellites.value !== null ? Math.round(state.satellites.value) : null);
                setHdop(state.hdop.value);
                setQualityLabel(NmeaGpsProvider.getQualityLabel());
            }
        }, 1000);

        return () => clearInterval(id);
    }, []);

    if (!active) return null;

    // Accuracy color based on HDOP
    // HDOP < 1 = Excellent, < 2 = Good, < 5 = Moderate, > 5 = Poor
    const dotColor = hdop !== null
        ? hdop < 1.5 ? 'bg-emerald-400' : hdop < 3 ? 'bg-sky-400' : hdop < 5 ? 'bg-amber-400' : 'bg-red-400'
        : 'bg-sky-400';

    return (
        <div className="pointer-events-none">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full justify-center bg-sky-600/90 border border-sky-400/30 backdrop-blur-md shadow-lg">
                {/* Pulse ring */}
                <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
                </span>

                {/* Satellite icon */}
                <svg className="w-3 h-3 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.652a3.75 3.75 0 010-5.304m5.304 0a3.75 3.75 0 010 5.304m-7.425 2.121a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.788m13.788 0c3.808 3.808 3.808 9.98 0 13.788" />
                </svg>

                {/* Label */}
                <span className="text-white font-bold text-[10px] tracking-wide leading-none whitespace-nowrap">
                    EXT {qualityLabel}
                </span>

                {/* Satellite count */}
                {satellites !== null && (
                    <span className="text-sky-200/70 text-[9px] font-medium leading-none">
                        {satellites}sat
                    </span>
                )}
            </div>
        </div>
    );
};
