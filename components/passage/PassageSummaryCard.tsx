/**
 * PassageSummaryCard — At-a-glance passage overview for the readiness dashboard.
 *
 * Shows departure time, distance, duration, max expected conditions,
 * and departure/arrival coordinates from the active passage plan.
 */

import React, { useState, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';

/* ────────────────────────────────────────────────────────────── */

interface PassageSummaryCardProps {
    departPort?: string;
    destPort?: string;
    departureTime?: string | null;
    eta?: string | null;
    /** From route planner if available */
    distanceNm?: number;
    maxWindKt?: number;
    maxWaveM?: number;
    departLat?: number;
    departLon?: number;
    arriveLat?: number;
    arriveLon?: number;
    onDepartureTimeChange?: (time: string) => void;
}

const STORAGE_KEY = 'thalassa_passage_departure_time';

const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
};

const formatDuration = (departureTime: string, eta: string): string => {
    const dept = new Date(departureTime);
    const arr = new Date(eta);
    const diffMs = arr.getTime() - dept.getTime();
    if (diffMs <= 0) return '—';
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days > 0) return `${days}d ${remainingHours}h`;
    return `${hours}h`;
};

export const PassageSummaryCard: React.FC<PassageSummaryCardProps> = ({
    departPort,
    destPort,
    departureTime,
    eta,
    distanceNm,
    maxWindKt,
    maxWaveM,
    departLat,
    departLon,
    arriveLat,
    arriveLon,
    onDepartureTimeChange,
}) => {
    const [localTime, setLocalTime] = useState<string>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored || '';
        } catch {
            return '';
        }
    });

    const effectiveTime = localTime || (departureTime ? departureTime.split('T')[1]?.slice(0, 5) : '');

    const handleTimeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value;
            setLocalTime(val);
            try {
                localStorage.setItem(STORAGE_KEY, val);
            } catch {
                /* ignore */
            }
            onDepartureTimeChange?.(val);
            triggerHaptic('light');
        },
        [onDepartureTimeChange],
    );

    const duration = departureTime && eta ? formatDuration(departureTime, eta) : null;

    return (
        <div className="space-y-3">
            {/* ── Route Header ── */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gradient-to-r from-sky-500/[0.06] to-indigo-500/[0.03] border border-sky-500/15">
                <div className="text-2xl">🧭</div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">
                        {departPort || '—'} → {destPort || '—'}
                    </p>
                    {departureTime && (
                        <p className="text-[11px] text-sky-400/70 mt-0.5">
                            {new Date(departureTime).toLocaleDateString('en-AU', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                            })}
                        </p>
                    )}
                </div>
            </div>

            {/* ── Key Stats Grid ── */}
            <div className="grid grid-cols-2 gap-2">
                {/* Optimal Departure Time */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        ⏰ Departure Time
                    </div>
                    <input
                        type="time"
                        value={effectiveTime}
                        onChange={handleTimeChange}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-lg font-bold text-white text-center font-mono focus:outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30 transition-all"
                        style={{ colorScheme: 'dark' }}
                    />
                </div>

                {/* Duration */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        ⏱️ Duration
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">{duration || '—'}</div>
                </div>

                {/* Distance */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        📏 Distance
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">
                        {distanceNm != null ? `${distanceNm.toFixed(1)} nm` : '—'}
                    </div>
                </div>

                {/* Max Conditions */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        🌊 Max Conditions
                    </div>
                    <div className="text-center py-2">
                        {maxWindKt != null || maxWaveM != null ? (
                            <div className="flex items-center justify-center gap-2">
                                {maxWindKt != null && (
                                    <span
                                        className={`text-sm font-bold font-mono ${
                                            maxWindKt > 30
                                                ? 'text-red-400'
                                                : maxWindKt > 20
                                                  ? 'text-amber-400'
                                                  : 'text-emerald-400'
                                        }`}
                                    >
                                        💨 {maxWindKt}kt
                                    </span>
                                )}
                                {maxWaveM != null && (
                                    <span
                                        className={`text-sm font-bold font-mono ${
                                            maxWaveM > 3
                                                ? 'text-red-400'
                                                : maxWaveM > 2
                                                  ? 'text-amber-400'
                                                  : 'text-sky-400'
                                        }`}
                                    >
                                        🌊 {maxWaveM.toFixed(1)}m
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-lg font-bold text-white font-mono">—</span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Coordinates ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-2">
                    📍 Passage Coordinates
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <div className="text-[10px] text-sky-400 uppercase tracking-widest font-bold mb-0.5">
                            Departure
                        </div>
                        <div className="text-xs text-white font-mono">
                            {departLat != null && departLon != null
                                ? formatCoord(departLat, departLon)
                                : departPort || '—'}
                        </div>
                    </div>
                    <div>
                        <div className="text-[10px] text-emerald-400 uppercase tracking-widest font-bold mb-0.5">
                            Arrival
                        </div>
                        <div className="text-xs text-white font-mono">
                            {arriveLat != null && arriveLon != null
                                ? formatCoord(arriveLat, arriveLon)
                                : destPort || '—'}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── ETA ── */}
            {eta && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15">
                    <span className="text-lg">🏁</span>
                    <div>
                        <p className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                            Estimated Arrival
                        </p>
                        <p className="text-sm font-bold text-emerald-400 font-mono">
                            {new Date(eta).toLocaleString('en-AU', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                            })}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
