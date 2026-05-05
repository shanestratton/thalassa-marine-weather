/**
 * PassageSummaryCard — Full passage overview for the readiness dashboard.
 *
 * Shows route map, departure/arrival info, key stats, leg-by-leg
 * breakdown with difficulty ratings, and share controls.
 *
 * Route data comes from the global PassageStore (populated when
 * the passage planner computes a route on the Charts page).
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
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

/**
 * Module-scope stable empty-array reference. Used as the
 * "no waypoints" fallback for PassageRouteMap so we never hand it
 * a fresh `[]` (which would remount the Mapbox map every render).
 */
const EMPTY_WAYPOINTS: { id: string; name: string; lat: number; lon: number }[] = [];

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

// Difficulty styling — refreshed 2026-05-05 for higher legibility.
//
//   color       → wind-stat accent text (kept subtle so it doesn't
//                 fight the rest of the leg row)
//   bg / border → card surface (bumped to /20 + /35 from /10 + /20
//                 so the colour reads at a glance instead of looking
//                 like a near-empty outline)
//   pillBg / pillText → SOLID badge in the top-right of each leg row,
//                 so the difficulty rating reads as a proper traffic-
//                 light pill, not just colored text.
const DIFFICULTY_CONFIG = {
    easy: {
        color: 'text-emerald-300',
        bg: 'bg-emerald-500/20',
        border: 'border-emerald-500/35',
        pillBg: 'bg-emerald-500',
        pillText: 'text-emerald-50',
        label: 'Easy',
        icon: '🟢',
    },
    moderate: {
        color: 'text-sky-300',
        bg: 'bg-sky-500/20',
        border: 'border-sky-500/35',
        pillBg: 'bg-sky-500',
        pillText: 'text-sky-50',
        label: 'Moderate',
        icon: '🔵',
    },
    tough: {
        color: 'text-amber-300',
        bg: 'bg-amber-500/20',
        border: 'border-amber-500/35',
        pillBg: 'bg-amber-500',
        pillText: 'text-amber-950',
        label: 'Tough',
        icon: '🟡',
    },
    challenging: {
        color: 'text-red-300',
        bg: 'bg-red-500/20',
        border: 'border-red-500/35',
        pillBg: 'bg-red-500',
        pillText: 'text-red-50',
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
                <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm ${diff.pillBg} ${diff.pillText}`}
                >
                    {diff.label}
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

    // Listen for cross-component departure-time updates — fired by
    // WeatherWindowCard when the user accepts a recommended departure
    // window. Without this, the time we show stays stale until the
    // user reloads the page or unmounts/remounts the card. Keeps the
    // localStorage write + state both fresh.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { hhmm?: string } | undefined;
            if (detail?.hhmm) setLocalTime(detail.hhmm);
        };
        window.addEventListener('thalassa:departure-time-updated', handler);
        return () => window.removeEventListener('thalassa:departure-time-updated', handler);
    }, []);

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

    // ── Merge strategy (2026-05-05): props (voyage) win over PassageStore ──
    //
    // PassageStore is a global localStorage-backed singleton populated
    // by the inline-map passage planner. When the user calculates a
    // route via the form-based RoutePlanner, PassageStore is NOT
    // refreshed — but its previous-session data persists in
    // localStorage. So a fresh voyage with valid coords gets shown on
    // top of stale PassageStore data with bogus distance / coords / eta
    // (the source of "74d 11h" durations and globe-view maps with
    // (0,0) markers).
    //
    // Fix: prefer the voyage props (which are always derived from the
    // CURRENT active voyage's actual logbook entries) over PassageStore
    // data. Only fall back to PassageStore when the prop is missing.
    // Also reject PassageStore values that look like (0,0) or
    // unreasonably-large distances.
    const isValidLatLon = (lat: number | null | undefined, lon: number | null | undefined): boolean => {
        if (lat == null || lon == null) return false;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
        if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false;
        return true;
    };
    const effectiveDepartLat =
        departLat ?? (isValidLatLon(passage.departLat, passage.departLon) ? passage.departLat : null);
    const effectiveDepartLon =
        departLon ?? (isValidLatLon(passage.departLat, passage.departLon) ? passage.departLon : null);
    const effectiveArriveLat =
        arriveLat ?? (isValidLatLon(passage.arriveLat, passage.arriveLon) ? passage.arriveLat : null);
    const effectiveArriveLon =
        arriveLon ?? (isValidLatLon(passage.arriveLat, passage.arriveLon) ? passage.arriveLon : null);

    // Distance: compute the true great-circle from coords first, then
    // sanity-check the stored value against it. If the stored value
    // is missing OR more than 2× the great-circle (i.e. obviously
    // junk from a previous broken save), fall back to the great-
    // circle. Earlier check used a flat 12000 NM ceiling but
    // 8584 NM stale-data slipped under that — comparing relative to
    // the actual great-circle catches all magnitudes of staleness.
    const greatCircleNM = useMemo(() => {
        if (
            effectiveDepartLat == null ||
            effectiveDepartLon == null ||
            effectiveArriveLat == null ||
            effectiveArriveLon == null
        )
            return null;
        const R = 3440.065;
        const φ1 = (effectiveDepartLat * Math.PI) / 180;
        const φ2 = (effectiveArriveLat * Math.PI) / 180;
        const dφ = ((effectiveArriveLat - effectiveDepartLat) * Math.PI) / 180;
        const dλ = ((effectiveArriveLon - effectiveDepartLon) * Math.PI) / 180;
        const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }, [effectiveDepartLat, effectiveDepartLon, effectiveArriveLat, effectiveArriveLon]);

    let effectiveDistance = distanceNm ?? (passage.hasRoute ? passage.totalDistanceNM : undefined);
    if (
        greatCircleNM != null &&
        (effectiveDistance == null ||
            effectiveDistance <= 0 ||
            // Stored value > 2× great-circle = stale junk. Real
            // routes are usually 1.0-1.3× great-circle (small
            // detours for waypoints + weather routing).
            effectiveDistance > greatCircleNM * 2)
    ) {
        effectiveDistance = greatCircleNM;
    }

    // ── Map prop memoisation ──
    // PassageRouteMap's useEffect re-creates the entire Mapbox map
    // whenever its routeCoordinates / turnWaypoints prop reference
    // changes. Without memoising these here, every render of
    // PassageSummaryCard (which includes the time tick from the
    // briefing card etc) handed the map a fresh array → map.remove()
    // + new map() → flashing + heavy CPU + the "slow as a wet week"
    // performance the user reported.
    //
    // Memo key uses primitive coord values so the array is only
    // rebuilt when actual numbers change.
    const mapRouteCoords = useMemo<[number, number][]>(() => {
        if (
            effectiveDepartLat == null ||
            effectiveDepartLon == null ||
            effectiveArriveLat == null ||
            effectiveArriveLon == null
        )
            return [];
        const storeCoordsMatch =
            passage.hasRoute &&
            passage.routeCoordinates.length >= 2 &&
            passage.departLat != null &&
            passage.arriveLat != null &&
            Math.abs(passage.departLat - effectiveDepartLat) < 1 &&
            Math.abs((passage.departLon ?? 0) - effectiveDepartLon) < 1 &&
            Math.abs(passage.arriveLat - effectiveArriveLat) < 1 &&
            Math.abs((passage.arriveLon ?? 0) - effectiveArriveLon) < 1;
        if (storeCoordsMatch) return passage.routeCoordinates;
        return [
            [effectiveDepartLon, effectiveDepartLat],
            [effectiveArriveLon, effectiveArriveLat],
        ];
    }, [
        effectiveDepartLat,
        effectiveDepartLon,
        effectiveArriveLat,
        effectiveArriveLon,
        passage.hasRoute,
        passage.routeCoordinates,
        passage.departLat,
        passage.departLon,
        passage.arriveLat,
        passage.arriveLon,
    ]);

    const mapTurnWaypoints = useMemo(() => {
        // Only feed turnWaypoints when PassageStore.routeCoordinates
        // is fresh (we trust the same coords-match check). Empty array
        // is a stable-reference singleton for the "no waypoints" case.
        const storeCoordsMatch =
            passage.hasRoute &&
            effectiveDepartLat != null &&
            effectiveDepartLon != null &&
            effectiveArriveLat != null &&
            effectiveArriveLon != null &&
            passage.departLat != null &&
            passage.arriveLat != null &&
            Math.abs(passage.departLat - effectiveDepartLat) < 1 &&
            Math.abs((passage.departLon ?? 0) - effectiveDepartLon) < 1 &&
            Math.abs(passage.arriveLat - effectiveArriveLat) < 1 &&
            Math.abs((passage.arriveLon ?? 0) - effectiveArriveLon) < 1;
        return storeCoordsMatch ? passage.turnWaypoints : EMPTY_WAYPOINTS;
    }, [
        passage.hasRoute,
        passage.turnWaypoints,
        passage.departLat,
        passage.departLon,
        passage.arriveLat,
        passage.arriveLon,
        effectiveDepartLat,
        effectiveDepartLon,
        effectiveArriveLat,
        effectiveArriveLon,
    ]);

    const effectiveMaxWind = maxWindKt ?? (passage.hasRoute ? passage.maxWindKt : undefined);
    const effectiveMaxWave = maxWaveM ?? (passage.hasRoute ? passage.maxWaveM : undefined);
    const effectiveEta = eta ?? (passage.hasRoute ? passage.arrivalTime : undefined);

    // Duration: compute from departureTime + eta, but reject the
    // result if it's obviously stale-data nonsense (>30 days ≈ longest
    // realistic passage). Falls back to the great-circle estimate at
    // 6 kn cruising speed when eta is bad/missing.
    let duration: string | null = null;
    if (departureTime && effectiveEta) {
        const candidate = formatDuration(departureTime, effectiveEta);
        const dept = new Date(departureTime).getTime();
        const arr = new Date(effectiveEta).getTime();
        const diffH = (arr - dept) / 3600000;
        if (diffH > 0 && diffH < 30 * 24) {
            duration = candidate;
        }
    }
    if (!duration && effectiveDistance != null && effectiveDistance > 0) {
        const hrs = effectiveDistance / 6;
        if (hrs < 24) duration = `${Math.round(hrs)}h`;
        else duration = `${Math.floor(hrs / 24)}d ${Math.round(hrs % 24)}h`;
    }

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
            {effectiveDepartLat != null &&
                effectiveDepartLon != null &&
                effectiveArriveLat != null &&
                effectiveArriveLon != null && (
                    <PassageRouteMap
                        routeCoordinates={mapRouteCoords}
                        departLat={effectiveDepartLat}
                        departLon={effectiveDepartLon}
                        arriveLat={effectiveArriveLat}
                        arriveLon={effectiveArriveLon}
                        turnWaypoints={mapTurnWaypoints}
                        height={220}
                    />
                )}

            {/* ── Key Stats Grid ── */}
            <div className="grid grid-cols-2 gap-2">
                {/* Optimal Departure Time
                    The native iOS <input type="time"> imposes its own
                    min-width for the picker chrome (~140pt on iOS),
                    which on a narrow phone can ignore the parent's
                    width and bleed past the right edge of the stat
                    card. Wrapping in a flex container with
                    justify-center centers whatever natural width the
                    OS gives us, and overflow-hidden on the outer card
                    clips any final stragglers. The input itself drops
                    w-full so it sizes to its content rather than
                    stretching past the parent. */}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 min-w-0 overflow-hidden">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Departure Time
                    </div>
                    <div className="flex justify-center">
                        <input
                            type="time"
                            value={effectiveTime}
                            onChange={handleTimeChange}
                            className="bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-base font-bold text-white font-mono focus:outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30 transition-all max-w-full"
                            style={{ colorScheme: 'dark', boxSizing: 'border-box' }}
                        />
                    </div>
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
            {/* Only shown when the user has nothing — no passage selected */}
            {/* AND no route in the store. If they've already picked a draft */}
            {/* (departPort + destPort populated) they don't need a CTA */}
            {/* telling them to plan a route, that's exactly what they did. */}
            {!passage.hasRoute && !departPort && !destPort && (
                <div className="px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] text-center">
                    <p className="text-xs text-gray-500">
                        Plan a route on the Charts page to see the full passage breakdown here.
                    </p>
                </div>
            )}
        </div>
    );
};
