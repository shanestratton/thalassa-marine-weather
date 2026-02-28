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
    useEffect(() => {
        if (!navigator.geolocation) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                if (pos.coords.accuracy > 0) {
                    GpsPrecision.feed(pos.coords.accuracy);
                }
            },
            () => { /* GPS error — ignore silently */ },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, []);

    useEffect(() => {
        // Poll both NMEA and precision tracker every second
        const id = setInterval(() => {
            const isNmea = NmeaGpsProvider.isActive();
            const isPrecision = GpsPrecision.isPrecision();
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

    const active = nmeaActive || precisionActive;
    if (!active) return null;

    // NMEA: color based on HDOP; Precision: always green
    const dotColor = nmeaActive
        ? (hdop !== null
            ? hdop < 1.5 ? 'bg-emerald-400' : hdop < 3 ? 'bg-sky-400' : hdop < 5 ? 'bg-amber-400' : 'bg-red-400'
            : 'bg-sky-400')
        : 'bg-emerald-400'; // Precision GPS = green dot

    // Badge color: NMEA = blue, Precision GPS = green
    const badgeBg = nmeaActive ? 'bg-sky-600/90 border-sky-400/30' : 'bg-emerald-600/90 border-emerald-400/30';

    return (
        <div className="pointer-events-none">
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full justify-center ${badgeBg} border backdrop-blur-md shadow-lg`}>
                {/* Pulse ring */}
                <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${nmeaActive ? 'bg-sky-400' : 'bg-emerald-400'} opacity-75`} />
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

                {/* Satellite count (NMEA only) */}
                {satellites !== null && (
                    <span className="text-sky-200/70 text-[9px] font-medium leading-none">
                        {satellites}sat
                    </span>
                )}

                {/* Average accuracy (Precision GPS / Bluetooth only) */}
                {!nmeaActive && avgAccuracy !== null && (
                    <span className="text-emerald-200/70 text-[9px] font-medium leading-none">
                        ±{avgAccuracy}m
                    </span>
                )}
            </div>
        </div>
    );
};
