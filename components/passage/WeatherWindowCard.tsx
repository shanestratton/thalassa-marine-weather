/**
 * WeatherWindowCard — Departure window analyser for cruisers.
 *
 * "When should I leave?"
 * Analyses 7 days of weather, scores 6h departure windows.
 * Shows Go / Marginal / Wait ratings.
 * Red → Green when skipper accepts a departure window.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    WeatherWindowService,
    type WeatherWindowResult,
    type DepartureWindow,
} from '../../services/WeatherWindowService';
import { type Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';

interface WeatherWindowCardProps {
    voyageId?: string;
    departure?: { lat: number; lon: number };
    destination?: { lat: number; lon: number };
    activeVoyage?: Voyage | null;
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_accepted_window';

const RATING_STYLES = {
    go: {
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/25',
        text: 'text-emerald-400',
        label: '✅ GO',
        dot: 'bg-emerald-400',
    },
    marginal: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        text: 'text-amber-400',
        label: '⚠️ MARGINAL',
        dot: 'bg-amber-400',
    },
    wait: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
        text: 'text-red-400',
        label: '❌ WAIT',
        dot: 'bg-red-400',
    },
};

export const WeatherWindowCard: React.FC<WeatherWindowCardProps> = ({
    voyageId,
    departure,
    destination,
    activeVoyage,
    onReviewedChange,
}) => {
    const [result, setResult] = useState<WeatherWindowResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [acceptedIndex, setAcceptedIndex] = useState<number | null>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                if (data.voyageId === voyageId) return data.index;
            }
        } catch {
            /* ignore */
        }
        return null;
    });
    const [showAll, setShowAll] = useState(false);

    // Determine departure coordinates
    const lat = departure?.lat ?? null;
    const lon = departure?.lon ?? null;

    // Calculate course bearing
    const destLat = destination?.lat ?? null;
    const destLon = destination?.lon ?? null;

    let courseBearing: number | undefined;
    if (lat != null && lon != null && destLat != null && destLon != null) {
        const dLon = ((destLon - lon) * Math.PI) / 180;
        const lat1 = (lat * Math.PI) / 180;
        const lat2 = (destLat * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        courseBearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    // Notify parent
    useEffect(() => {
        onReviewedChange?.(acceptedIndex !== null);
    }, [acceptedIndex, onReviewedChange]);

    const analyse = useCallback(async () => {
        if (lat == null || lon == null) {
            setError('No departure coordinates — plan a route first');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const data = await WeatherWindowService.analyse(lat, lon, voyageId, courseBearing);
            setResult(data);
        } catch (err) {
            setError('Failed to analyse weather windows');
        }
        setLoading(false);
    }, [lat, lon, voyageId, courseBearing]);

    // Auto-analyse on mount
    useEffect(() => {
        if (lat != null && lon != null) analyse();
    }, [lat, lon]); // eslint-disable-line react-hooks/exhaustive-deps

    const acceptWindow = useCallback(
        (index: number) => {
            setAcceptedIndex(index);
            triggerHaptic('medium');
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ voyageId, index }));
            } catch {
                /* ignore */
            }
        },
        [voyageId],
    );

    // Determine windows to show
    const displayWindows = result?.windows ?? [];
    const topWindows = showAll
        ? displayWindows
        : displayWindows.filter((w) => w.rating === 'go' || w.rating === 'marginal').slice(0, 6);
    const goCount = displayWindows.filter((w) => w.rating === 'go').length;

    return (
        <div className="space-y-4">
            {/* No coordinates */}
            {lat == null && (
                <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-xl p-4 text-center">
                    <p className="text-2xl mb-2">🧭</p>
                    <p className="text-xs text-gray-400">
                        Plan a route first to enable weather window analysis.
                        <br />
                        Departure coordinates are needed.
                    </p>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                    <div className="w-8 h-8 border-2 border-cyan-400/20 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-gray-400">Analysing 7-day forecast...</p>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
                    <span className="text-lg">⚠️</span>
                    <p className="text-xs text-red-400">{error}</p>
                </div>
            )}

            {/* Results */}
            {result && !loading && (
                <>
                    {/* Summary bar */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 flex items-center gap-3">
                        <span className="text-lg">{goCount > 0 ? '🌤️' : '⛈️'}</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-white">
                                {goCount > 0
                                    ? `${goCount} departure window${goCount !== 1 ? 's' : ''} open`
                                    : 'No ideal windows — proceed with caution'}
                            </p>
                            <p className="text-[10px] text-gray-500 mt-0.5">
                                {result.source === 'live' ? 'Live forecast' : 'Cached data'} ·{' '}
                                {new Date(result.analysisTime).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </p>
                        </div>
                        <button
                            onClick={analyse}
                            className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {/* Best window highlight */}
                    {result.bestWindowIndex >= 0 && displayWindows[result.bestWindowIndex] && (
                        <WindowCard
                            window={displayWindows[result.bestWindowIndex]}
                            index={result.bestWindowIndex}
                            isBest
                            isAccepted={acceptedIndex === result.bestWindowIndex}
                            onAccept={acceptWindow}
                        />
                    )}

                    {/* Other windows */}
                    {topWindows
                        .filter((_, i) => {
                            // Find the original index in displayWindows
                            const origIdx = displayWindows.indexOf(topWindows[i]);
                            return origIdx !== result.bestWindowIndex;
                        })
                        .map((w) => {
                            const origIdx = displayWindows.indexOf(w);
                            return (
                                <WindowCard
                                    key={w.time}
                                    window={w}
                                    index={origIdx}
                                    isAccepted={acceptedIndex === origIdx}
                                    onAccept={acceptWindow}
                                />
                            );
                        })}

                    {/* Show all toggle */}
                    {!showAll && displayWindows.length > topWindows.length + 1 && (
                        <button
                            onClick={() => setShowAll(true)}
                            className="w-full py-2 text-[11px] font-bold text-gray-400 hover:text-white transition-colors"
                        >
                            Show all {displayWindows.length} windows ▾
                        </button>
                    )}
                </>
            )}

            {/* Accepted summary */}
            {acceptedIndex !== null && result?.windows[acceptedIndex] && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border bg-emerald-500/10 border-emerald-500/20">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-xs font-bold text-emerald-400">
                            Window accepted: {result.windows[acceptedIndex].label}
                        </p>
                        <p className="text-[11px] text-emerald-400/60 mt-0.5">
                            {result.windows[acceptedIndex].description}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

/** Individual window card */
const WindowCard: React.FC<{
    window: DepartureWindow;
    index: number;
    isBest?: boolean;
    isAccepted?: boolean;
    onAccept: (index: number) => void;
}> = ({ window: w, index, isBest, isAccepted, onAccept }) => {
    const style = RATING_STYLES[w.rating];
    return (
        <div
            className={`${style.bg} border ${style.border} rounded-xl p-3 transition-all ${
                isAccepted ? 'ring-2 ring-emerald-400/40' : ''
            }`}
        >
            <div className="flex items-center gap-3 mb-2">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <span className={`text-sm font-black ${style.text}`}>{w.label}</span>
                        {isBest && (
                            <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-[9px] font-bold rounded-full border border-amber-500/20">
                                ⭐ BEST
                            </span>
                        )}
                    </div>
                    <p className="text-[10px] font-bold text-white/80 mt-0.5 uppercase tracking-wider">
                        {w.rating === 'go' ? '✅' : w.rating === 'marginal' ? '⚠️' : '❌'} {w.rating.toUpperCase()}
                    </p>
                </div>
                {/* Score bar */}
                <div className="w-14 text-right">
                    <div className={`text-lg font-black ${style.text}`}>{w.score}</div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                            className={`h-full ${style.dot} rounded-full transition-all`}
                            style={{ width: `${w.score}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-3 gap-2 text-center mb-2">
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold">Wind</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.dominantWindDir} {w.summary.avgWindKts}–{w.summary.maxWindKts}kt
                    </p>
                </div>
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold">Wave</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.avgWaveM}–{w.summary.maxWaveM}m
                    </p>
                </div>
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold">Rain</p>
                    <p className="text-xs font-bold text-white">{w.summary.rainProbability}%</p>
                </div>
            </div>

            {/* Accept button */}
            {!isAccepted ? (
                <button
                    onClick={() => onAccept(index)}
                    className={`w-full py-2 rounded-lg text-[11px] font-bold transition-all active:scale-[0.98] ${
                        w.rating === 'go'
                            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/20'
                            : w.rating === 'marginal'
                              ? 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/15'
                              : 'bg-red-500/10 text-red-300 hover:bg-red-500/20 border border-red-500/15'
                    }`}
                >
                    Accept This Window
                </button>
            ) : (
                <div className="text-center text-[11px] font-bold text-emerald-400 py-1">✅ Accepted</div>
            )}
        </div>
    );
};
