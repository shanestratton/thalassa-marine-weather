/**
 * PassageSummaryCard — Full passage overview for the readiness dashboard.
 *
 * Shows route map, departure/arrival info, key stats, leg-by-leg
 * breakdown with difficulty ratings, and share controls.
 *
 * Route data comes from the global PassageStore (populated when
 * the passage planner computes a route on the Charts page).
 */

import React, { useState, useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { usePassageStore, type PassageLeg } from '../../stores/PassageStore';
import { PassageRouteMap } from './PassageRouteMap';
import SharePassageButton from './SharePassageButton';
import type { PassageBriefData } from '../../services/PassageBriefService';

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
    const latDeg = Math.abs(lat);
    const latMin = (latDeg % 1) * 60;
    const lonDeg = Math.abs(lon);
    const lonMin = (lonDeg % 1) * 60;
    return `${Math.floor(latDeg)}°${latMin.toFixed(1)}'${latDir} ${Math.floor(lonDeg)}°${lonMin.toFixed(1)}'${lonDir}`;
};

const formatDuration = (departureTime: string, eta: string): string => {
    const dept = new Date(departureTime);
    const arr = new Date(eta);
    const diffMs = arr.getTime() - dept.getTime();
    if (diffMs <= 0) return '--';
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days > 0) return `${days}d ${remainingHours}h`;
    return `${hours}h`;
};

const formatHours = (h: number): string => {
    if (h < 1) return `${Math.round(h * 60)}min`;
    const days = Math.floor(h / 24);
    const hrs = Math.round(h % 24);
    if (days > 0) return `${days}d ${hrs}h`;
    return `${hrs}h`;
};

const bearingToCardinal = (deg: number): string => {
    const cardinals = [
        'N',
        'NNE',
        'NE',
        'ENE',
        'E',
        'ESE',
        'SE',
        'SSE',
        'S',
        'SSW',
        'SW',
        'WSW',
        'W',
        'WNW',
        'NW',
        'NNW',
    ];
    return cardinals[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
};

const DIFFICULTY_CONFIG = {
    easy: {
        color: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
        label: 'Easy',
        icon: '🟢',
    },
    moderate: {
        color: 'text-sky-400',
        bg: 'bg-sky-500/10',
        border: 'border-sky-500/20',
        label: 'Moderate',
        icon: '🔵',
    },
    tough: {
        color: 'text-amber-400',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        label: 'Tough',
        icon: '🟡',
    },
    challenging: {
        color: 'text-red-400',
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
        label: 'Challenging',
        icon: '🔴',
    },
} as const;

/* ── Leg Row Component ────────────────────────────────────────── */

const LegRow: React.FC<{ leg: PassageLeg; index: number }> = ({ leg, index }) => {
    const diff = DIFFICULTY_CONFIG[leg.difficulty];
    return (
        <div className={`${diff.bg} border ${diff.border} rounded-lg p-3`}>
            <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-500">L{index + 1}</span>
                    <span className="text-xs font-bold text-white truncate max-w-[140px]">
                        {leg.from} → {leg.to}
                    </span>
                </div>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${diff.color}`}>
                    {diff.icon} {diff.label}
                </span>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[11px] font-mono">
                <div>
                    <span className="text-gray-500">Dist</span>
                    <div className="text-white">{leg.distanceNM.toFixed(1)}nm</div>
                </div>
                <div>
                    <span className="text-gray-500">Time</span>
                    <div className="text-white">{formatHours(leg.durationHours)}</div>
                </div>
                <div>
                    <span className="text-gray-500">Hdg</span>
                    <div className="text-white">
                        {Math.round(leg.bearing)}° {bearingToCardinal(leg.bearing)}
                    </div>
                </div>
                <div>
                    <span className="text-gray-500">Wind</span>
                    <div className={diff.color}>{Math.round(leg.maxWindKt)}kt</div>
                </div>
            </div>
            {leg.difficultyReason && <p className="text-[10px] text-gray-500 mt-1.5 italic">{leg.difficultyReason}</p>}
        </div>
    );
};

/* ── Main Component ───────────────────────────────────────────── */

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
    const passage = usePassageStore();

    const [localTime, setLocalTime] = useState<string>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored || '';
        } catch {
            return '';
        }
    });

    const [showLegs, setShowLegs] = useState(false);

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

    // Merge: prefer PassageStore data over voyage props
    const effectiveDistance = passage.hasRoute ? passage.totalDistanceNM : distanceNm;
    const effectiveMaxWind = passage.hasRoute ? (passage.maxWindKt ?? maxWindKt) : maxWindKt;
    const effectiveMaxWave = passage.hasRoute ? (passage.maxWaveM ?? maxWaveM) : maxWaveM;
    const effectiveDepartLat = passage.hasRoute ? (passage.departLat ?? departLat) : departLat;
    const effectiveDepartLon = passage.hasRoute ? (passage.departLon ?? departLon) : departLon;
    const effectiveArriveLat = passage.hasRoute ? (passage.arriveLat ?? arriveLat) : arriveLat;
    const effectiveArriveLon = passage.hasRoute ? (passage.arriveLon ?? arriveLon) : arriveLon;
    const effectiveEta = passage.hasRoute ? (passage.arrivalTime ?? eta) : eta;

    const duration = departureTime && effectiveEta ? formatDuration(departureTime, effectiveEta) : null;

    // Build brief data for sharing
    const briefData: PassageBriefData | null =
        passage.hasRoute &&
        effectiveDepartLat != null &&
        effectiveDepartLon != null &&
        effectiveArriveLat != null &&
        effectiveArriveLon != null
            ? {
                  routeName: `${departPort || 'Departure'} → ${destPort || 'Arrival'}`,
                  origin: { name: departPort || 'Departure', lat: effectiveDepartLat, lon: effectiveDepartLon },
                  destination: { name: destPort || 'Arrival', lat: effectiveArriveLat, lon: effectiveArriveLon },
                  departureTime: departureTime || passage.departureTime || new Date().toISOString(),
                  totalDistanceNM: passage.totalDistanceNM,
                  estimatedDuration: passage.totalDurationHours,
                  speed: passage.avgSpeedKts ?? 6,
                  vesselName: passage.vesselName ?? undefined,
                  turnWaypoints: passage.turnWaypoints.map((wp) => ({
                      name: wp.name,
                      lat: wp.lat,
                      lon: wp.lon,
                      tws: wp.tws,
                      bng: wp.bearing,
                  })),
              }
            : null;

    // Difficulty summary
    const difficultySummary =
        passage.hasRoute && passage.legs.length > 0
            ? (() => {
                  const counts = { easy: 0, moderate: 0, tough: 0, challenging: 0 };
                  passage.legs.forEach((l) => counts[l.difficulty]++);
                  return counts;
              })()
            : null;

    return (
        <div className="space-y-3">
            {/* ── Route Header ── */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gradient-to-r from-sky-500/[0.06] to-indigo-500/[0.03] border border-sky-500/15">
                <div className="text-2xl">&#x1F9ED;</div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">
                        {departPort || '--'} → {destPort || '--'}
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
                {/* Share button */}
                {briefData && <SharePassageButton briefData={briefData} className="shrink-0" />}
            </div>

            {/* ── Route Map ── */}
            {passage.hasRoute &&
                passage.routeCoordinates.length >= 2 &&
                effectiveDepartLat != null &&
                effectiveDepartLon != null &&
                effectiveArriveLat != null &&
                effectiveArriveLon != null && (
                    <PassageRouteMap
                        routeCoordinates={passage.routeCoordinates}
                        departLat={effectiveDepartLat}
                        departLon={effectiveDepartLon}
                        arriveLat={effectiveArriveLat}
                        arriveLon={effectiveArriveLon}
                        turnWaypoints={passage.turnWaypoints}
                        height={220}
                    />
                )}

            {/* ── Key Stats Grid ── */}
            <div className="grid grid-cols-2 gap-2">
                {/* Optimal Departure Time */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Departure Time
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
                        Duration
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">{duration || '--'}</div>
                </div>

                {/* Distance */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Distance
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">
                        {effectiveDistance != null ? `${effectiveDistance.toFixed(1)} nm` : '--'}
                    </div>
                </div>

                {/* Max Conditions */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Max Conditions
                    </div>
                    <div className="text-center py-2">
                        {effectiveMaxWind != null || effectiveMaxWave != null ? (
                            <div className="flex items-center justify-center gap-2">
                                {effectiveMaxWind != null && (
                                    <span
                                        className={`text-sm font-bold font-mono ${
                                            effectiveMaxWind > 30
                                                ? 'text-red-400'
                                                : effectiveMaxWind > 20
                                                  ? 'text-amber-400'
                                                  : 'text-emerald-400'
                                        }`}
                                    >
                                        {effectiveMaxWind}kt
                                    </span>
                                )}
                                {effectiveMaxWave != null && (
                                    <span
                                        className={`text-sm font-bold font-mono ${
                                            effectiveMaxWave > 3
                                                ? 'text-red-400'
                                                : effectiveMaxWave > 2
                                                  ? 'text-amber-400'
                                                  : 'text-sky-400'
                                        }`}
                                    >
                                        {effectiveMaxWave.toFixed(1)}m
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-lg font-bold text-white font-mono">--</span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Difficulty Overview ── */}
            {difficultySummary && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-2">
                        Passage Difficulty
                    </div>
                    <div className="flex items-center gap-1.5">
                        {passage.legs.map((leg, i) => {
                            const cfg = DIFFICULTY_CONFIG[leg.difficulty];
                            return (
                                <div
                                    key={i}
                                    className={`flex-1 h-2.5 rounded-full ${cfg.bg} border ${cfg.border}`}
                                    title={`L${i + 1}: ${leg.from} → ${leg.to} (${cfg.label})`}
                                />
                            );
                        })}
                    </div>
                    <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
                        <span>Departure</span>
                        <div className="flex items-center gap-3">
                            {difficultySummary.easy > 0 && (
                                <span className="text-emerald-400">{difficultySummary.easy} easy</span>
                            )}
                            {difficultySummary.moderate > 0 && (
                                <span className="text-sky-400">{difficultySummary.moderate} moderate</span>
                            )}
                            {difficultySummary.tough > 0 && (
                                <span className="text-amber-400">{difficultySummary.tough} tough</span>
                            )}
                            {difficultySummary.challenging > 0 && (
                                <span className="text-red-400">{difficultySummary.challenging} hard</span>
                            )}
                        </div>
                        <span>Arrival</span>
                    </div>
                </div>
            )}

            {/* ── Leg-by-Leg Breakdown ── */}
            {passage.hasRoute && passage.legs.length > 0 && (
                <div>
                    <button
                        onClick={() => {
                            setShowLegs((v) => !v);
                            triggerHaptic('light');
                        }}
                        className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] text-left"
                    >
                        <span className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                            Leg Breakdown ({passage.legs.length} legs)
                        </span>
                        <svg
                            className={`w-4 h-4 text-gray-500 transition-transform ${showLegs ? 'rotate-180' : ''}`}
                            viewBox="0 0 20 20"
                            fill="currentColor"
                        >
                            <path
                                fillRule="evenodd"
                                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                                clipRule="evenodd"
                            />
                        </svg>
                    </button>
                    {showLegs && (
                        <div className="mt-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
                            {passage.legs.map((leg, i) => (
                                <LegRow key={i} leg={leg} index={i} />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Coordinates ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-2">
                    Passage Coordinates
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <div className="text-[11px] text-emerald-400 uppercase tracking-widest font-bold mb-0.5">
                            Departure
                        </div>
                        <div className="text-xs text-white font-mono">
                            {effectiveDepartLat != null && effectiveDepartLon != null
                                ? formatCoord(effectiveDepartLat, effectiveDepartLon)
                                : departPort || '--'}
                        </div>
                    </div>
                    <div>
                        <div className="text-[11px] text-amber-400 uppercase tracking-widest font-bold mb-0.5">
                            Arrival
                        </div>
                        <div className="text-xs text-white font-mono">
                            {effectiveArriveLat != null && effectiveArriveLon != null
                                ? formatCoord(effectiveArriveLat, effectiveArriveLon)
                                : destPort || '--'}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── ETA ── */}
            {effectiveEta && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15">
                    <span className="text-lg">&#x1F3C1;</span>
                    <div>
                        <p className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                            Estimated Arrival
                        </p>
                        <p className="text-sm font-bold text-emerald-400 font-mono">
                            {new Date(effectiveEta).toLocaleString('en-AU', {
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

            {/* ── No Route Message ── */}
            {!passage.hasRoute && (
                <div className="px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] text-center">
                    <p className="text-xs text-gray-500">
                        Plan a route on the Charts page to see the full passage breakdown here.
                    </p>
                </div>
            )}
        </div>
    );
};
