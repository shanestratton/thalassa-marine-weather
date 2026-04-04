/**
 * OceanCurrentsCard — Surface current briefing for passage planning.
 *
 * Shows OSCAR current data along the planned route.
 * Segments rated: favourable ↗️ / adverse ↙️ / cross ↔️.
 * "Enhance" button downloads near-real-time data from NOAA ERDDAP.
 * Red → Green when skipper acknowledges the briefing.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { OceanCurrentService, type CurrentBriefing } from '../../services/OceanCurrentService';
import { VesselProfileService } from '../../services/VesselProfileService';
import { type Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';

interface OceanCurrentsCardProps {
    voyageId?: string;
    departure?: { lat: number; lon: number };
    destination?: { lat: number; lon: number };
    distanceNM?: number;
    activeVoyage?: Voyage | null;
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_currents_ack';

export const OceanCurrentsCard: React.FC<OceanCurrentsCardProps> = ({
    voyageId,
    departure,
    destination,
    distanceNM,
    activeVoyage,
    onReviewedChange,
}) => {
    const [briefing, setBriefing] = useState<CurrentBriefing | null>(null);
    const [loading, setLoading] = useState(false);
    const [enhancing, setEnhancing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [acknowledged, setAcknowledged] = useState(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                return data.voyageId === voyageId;
            }
        } catch {
            /* ignore */
        }
        return false;
    });

    // Coordinates
    const depLat = departure?.lat ?? null;
    const depLon = departure?.lon ?? null;
    const destLat = destination?.lat ?? null;
    const destLon = destination?.lon ?? null;

    const hasCoords = depLat != null && depLon != null && destLat != null && destLon != null;

    // Course bearing
    let courseBearing = 0;
    if (hasCoords) {
        const dLon = ((destLon! - depLon!) * Math.PI) / 180;
        const lat1 = (depLat! * Math.PI) / 180;
        const lat2 = (destLat! * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        courseBearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    // Route distance
    const dist = distanceNM ?? 100;
    const vessel = VesselProfileService.load();
    const speed = vessel.cruisingSpeedKts || 6;

    useEffect(() => {
        onReviewedChange?.(acknowledged);
    }, [acknowledged, onReviewedChange]);

    const fetchCurrents = useCallback(
        async (enhance = false) => {
            if (!hasCoords) return;
            enhance ? setEnhancing(true) : setLoading(true);
            setError(null);

            try {
                const bbox = {
                    south: Math.min(depLat!, destLat!),
                    north: Math.max(depLat!, destLat!),
                    west: Math.min(depLon!, destLon!),
                    east: Math.max(depLon!, destLon!),
                };
                const data = await OceanCurrentService.fetchCurrents(bbox, courseBearing, dist, speed, enhance);
                setBriefing(data);
            } catch {
                setError('Failed to fetch current data');
            }
            setLoading(false);
            setEnhancing(false);
        },
        [hasCoords, depLat, depLon, destLat, destLon, courseBearing, dist, speed],
    );

    // Auto-fetch on mount
    useEffect(() => {
        if (hasCoords) fetchCurrents(false);
    }, [hasCoords]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleAcknowledge = useCallback(() => {
        setAcknowledged(true);
        triggerHaptic('medium');
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ voyageId, time: Date.now() }));
        } catch {
            /* ignore */
        }
    }, [voyageId]);

    const segmentIcon = (type: string) => {
        switch (type) {
            case 'favourable':
                return '↗️';
            case 'adverse':
                return '↙️';
            default:
                return '↔️';
        }
    };

    const segmentColor = (type: string) => {
        switch (type) {
            case 'favourable':
                return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
            case 'adverse':
                return 'text-red-400 bg-red-500/10 border-red-500/20';
            default:
                return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        }
    };

    return (
        <div className="space-y-4">
            {/* No coordinates */}
            {!hasCoords && (
                <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-xl p-4 text-center">
                    <p className="text-2xl mb-2">🌀</p>
                    <p className="text-xs text-gray-400">
                        Plan a route first to analyse ocean currents along your passage.
                    </p>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                    <div className="w-8 h-8 border-2 border-cyan-400/20 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-gray-400">Fetching OSCAR surface currents...</p>
                </div>
            )}

            {/* Error */}
            {error && !loading && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
                    <span className="text-lg">⚠️</span>
                    <div className="flex-1">
                        <p className="text-xs text-red-400">{error}</p>
                    </div>
                    <button onClick={() => fetchCurrents(false)} className="text-[10px] font-bold text-cyan-400">
                        Retry
                    </button>
                </div>
            )}

            {/* Results */}
            {briefing && !loading && (
                <>
                    {/* Overview */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                        <div className="flex items-center gap-3 mb-3">
                            <span className="text-xl">🌊</span>
                            <div className="flex-1">
                                <h4 className="text-xs font-bold text-white uppercase tracking-widest">
                                    Surface Currents — {briefing.source === 'nrt' ? 'Near Real-Time' : 'Climatology'}
                                </h4>
                                <p className="text-[10px] text-gray-500 mt-0.5">
                                    NOAA OSCAR · {briefing.vectors.length} data points ·{' '}
                                    {new Date(briefing.fetchedAt).toLocaleDateString()}
                                </p>
                            </div>
                        </div>

                        {/* Stats grid */}
                        <div className="grid grid-cols-3 gap-2 text-center">
                            <div className="bg-white/[0.03] rounded-lg p-2">
                                <p className="text-[10px] text-gray-500 uppercase font-bold">Avg</p>
                                <p className="text-sm font-bold text-cyan-400">{briefing.avgSpeedKts}kt</p>
                            </div>
                            <div className="bg-white/[0.03] rounded-lg p-2">
                                <p className="text-[10px] text-gray-500 uppercase font-bold">Max</p>
                                <p className="text-sm font-bold text-amber-400">{briefing.maxSpeedKts}kt</p>
                            </div>
                            <div className="bg-white/[0.03] rounded-lg p-2">
                                <p className="text-[10px] text-gray-500 uppercase font-bold">Net Effect</p>
                                <p
                                    className={`text-sm font-bold ${
                                        briefing.netEffectHours < 0
                                            ? 'text-emerald-400'
                                            : briefing.netEffectHours > 0
                                              ? 'text-red-400'
                                              : 'text-gray-400'
                                    }`}
                                >
                                    {briefing.netEffectHours > 0 ? '+' : ''}
                                    {briefing.netEffectHours}h
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Segments */}
                    {briefing.segments.length > 0 && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                            <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3">
                                🧭 Route Segments
                            </h4>
                            <div className="space-y-2">
                                {briefing.segments.map((seg, i) => (
                                    <div
                                        key={i}
                                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${segmentColor(seg.type)}`}
                                    >
                                        <span className="text-lg">{segmentIcon(seg.type)}</span>
                                        <div className="flex-1">
                                            <p className="text-xs font-bold capitalize">{seg.type} Current</p>
                                            <p className="text-[10px] opacity-70">{seg.avgSpeedKts}kt average</p>
                                        </div>
                                        <span className="text-xs font-bold opacity-70">Leg {i + 1}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* No significant currents */}
                    {briefing.vectors.length === 0 && (
                        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-center">
                            <p className="text-xs text-gray-400">
                                No significant surface currents detected in this area.
                            </p>
                        </div>
                    )}

                    {/* Enhance button (NRT) */}
                    {briefing.source === 'climatology' && (
                        <button
                            onClick={() => fetchCurrents(true)}
                            disabled={enhancing}
                            className="w-full py-2.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs font-bold rounded-xl hover:bg-cyan-500/20 transition-all active:scale-[0.98] disabled:opacity-50"
                        >
                            {enhancing ? (
                                <span className="flex items-center justify-center gap-2">
                                    <span className="w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                                    Downloading real-time data...
                                </span>
                            ) : (
                                '🛰️ Enhance — Download Real-Time Currents'
                            )}
                        </button>
                    )}
                </>
            )}

            {/* Acknowledge */}
            <div
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                    acknowledged ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/[0.03] border-white/[0.06]'
                }`}
            >
                {acknowledged ? (
                    <>
                        <span className="text-lg">✅</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-emerald-400">Current briefing acknowledged</p>
                            <p className="text-[11px] text-emerald-400/60 mt-0.5">
                                {briefing
                                    ? `${briefing.avgSpeedKts}kt avg · ${briefing.segments.length} segments analysed`
                                    : 'Briefing completed'}
                            </p>
                        </div>
                    </>
                ) : (
                    <button
                        onClick={handleAcknowledge}
                        disabled={!briefing}
                        className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-bold text-sm rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Acknowledge Current Briefing
                    </button>
                )}
            </div>
        </div>
    );
};
