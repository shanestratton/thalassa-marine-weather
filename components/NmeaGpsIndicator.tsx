/**
 * NmeaGpsIndicator — Global badge showing when external GPS is active.
 *
 * Visible on ALL screens when the app is receiving GPS position data
 * from an external source (NMEA backbone, Bad Elf, chartplotter, etc.).
 *
 * Two detection paths:
 *   1. NMEA TCP: NmeaGpsProvider.isActive() — for Wi-Fi/wired NMEA feeds
 *   2. Bluetooth GPS: GpsPrecision.isPrecision() — for Bad Elf, Garmin GLO, etc.
 *      These devices feed through iOS Core Location (sub-3m accuracy detection)
 *
 * Positioned below the GPS tracking indicator when both are visible.
 * Shows satellite count and fix quality (GPS / DGPS / RTK / Precision).
 */

import React, { useState, useEffect } from 'react';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { NmeaStore } from '../services/NmeaStore';
import { GpsPrecision } from '../services/shiplog/GpsPrecisionTracker';
import { GpsService } from '../services/GpsService';

export const NmeaGpsIndicator: React.FC = () => {
    const [nmeaActive, setNmeaActive] = useState(false);
    const [precisionActive, setPrecisionActive] = useState(false);
    const [satellites, setSatellites] = useState<number | null>(null);
    const [qualityLabel, setQualityLabel] = useState('GPS');
    const [hdop, setHdop] = useState<number | null>(null);
    const [avgAccuracy, setAvgAccuracy] = useState<number | null>(null);

    // ── Passive GPS accuracy monitor ──
    // Feeds GpsPrecision even when no voyage/anchor is active,
    // so Bluetooth GPS devices (Bad Elf, Garmin GLO) are detected immediately.
    // Routes through GpsService → BgGeoManager (native) or web fallback.
    useEffect(() => {
        const unsub = GpsService.watchPosition((pos) => {
            // No document.hidden guard — feed accuracy even when backgrounded
            // so precision detection stays current and doesn't reset via staleness timeout.
            // ShipLogService already feeds in background; this ensures the indicator
            // also feeds when no voyage is active.
            if (pos.accuracy > 0) {
                GpsPrecision.feed(pos.accuracy);
            }
        });
        return unsub;
    }, []);

    useEffect(() => {
        // Poll both NMEA and precision tracker every second
        const id = setInterval(() => {
            // No document.hidden guard — keep badge state current so it
            // doesn't flash off/on when returning from background.
            const isNmea = NmeaGpsProvider.isActive();
            const isPrecision = GpsPrecision.isPrecision();
            GpsPrecision.checkStaleness(); // Reset badge if no fresh samples in 30s
            setNmeaActive(isNmea);
            setPrecisionActive(isPrecision);

            if (isNmea) {
                const state = NmeaStore.getState();
                setSatellites(state.satellites.value !== null ? Math.round(state.satellites.value) : null);
                setHdop(state.hdop.value);
                setQualityLabel(NmeaGpsProvider.getQualityLabel());
            } else if (isPrecision) {
                setAvgAccuracy(Math.round(GpsPrecision.getAverageAccuracy() * 10) / 10);
                setQualityLabel('Precision GPS');
                setSatellites(null);
                setHdop(null);
            }
        }, 1000);

        return () => clearInterval(id);
    }, []);

    // FIX: Show badge for EITHER NMEA TCP or Bluetooth precision GPS
    if (!nmeaActive && !precisionActive) return null;

    // Determine source for styling — NMEA takes priority if both connected
    const isNmeaSource = nmeaActive;

    // Dot color: NMEA = HDOP-based, Bluetooth = always green
    const dotColor = isNmeaSource
        ? (hdop !== null
            ? hdop < 1.5 ? 'bg-emerald-400' : hdop < 3 ? 'bg-sky-400' : hdop < 5 ? 'bg-amber-400' : 'bg-red-400'
            : 'bg-sky-400')
        : 'bg-emerald-400';

    // Badge background: NMEA = blue, Bluetooth = green
    const badgeBg = isNmeaSource ? 'bg-sky-600/90 border-sky-400/30' : 'bg-emerald-600/90 border-emerald-400/30';
    const pulseColor = isNmeaSource ? 'bg-sky-400' : 'bg-emerald-400';

    return (
        <div className="pointer-events-none">
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full justify-center ${badgeBg} border shadow-lg`}>
                {/* Pulse ring */}
                <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`} />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
                </span>

                {/* Satellite icon */}
                <svg className="w-3 h-3 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.652a3.75 3.75 0 010-5.304m5.304 0a3.75 3.75 0 010 5.304m-7.425 2.121a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.788m13.788 0c3.808 3.808 3.808 9.98 0 13.788" />
                </svg>

                <span className="text-white font-bold text-[11px] tracking-wide leading-none whitespace-nowrap">
                    Ext GPS
                </span>

                {/* NMEA: show satellite count */}
                {isNmeaSource && satellites !== null && (
                    <span className="text-sky-200/70 text-[11px] font-medium leading-none">
                        {satellites}sat
                    </span>
                )}

                {/* Bluetooth GPS: show average accuracy */}
                {!isNmeaSource && avgAccuracy !== null && (
                    <span className="text-emerald-200/70 text-[11px] font-medium leading-none">
                        ±{avgAccuracy}m
                    </span>
                )}
            </div>
        </div>
    );
};
