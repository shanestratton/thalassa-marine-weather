import React from 'react';
import { haversineNm } from '../geo';
import type { VoyageLogDestination, VoyageLogTrackPoint } from '../voyageLogApi';

interface VoyageProgressBarProps {
    track: VoyageLogTrackPoint[];
    destination: VoyageLogDestination | null;
}

const formatDateTime = (d: Date): string => {
    const datePart = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
};

export const VoyageProgressBar: React.FC<VoyageProgressBarProps> = ({ track, destination }) => {
    if (!destination || track.length === 0) return null;

    const origin = track[0];
    const current = track[track.length - 1];

    const totalNm = haversineNm(origin.lat, origin.lon, destination.lat, destination.lon);
    if (totalNm < 1) return null; // origin and destination on top of each other — nothing to draw

    const traveledNm = haversineNm(origin.lat, origin.lon, current.lat, current.lon);
    const dtgNm = haversineNm(current.lat, current.lon, destination.lat, destination.lon);
    const pct = Math.max(0, Math.min(100, (traveledNm / totalNm) * 100));

    // 24-hour rolling mean of SOG, for the ETA projection.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = track.filter((p) => p.speed_kts != null && new Date(p.timestamp).getTime() >= cutoff);
    const avgSog = recent.length > 0 ? recent.reduce((s, p) => s + (p.speed_kts as number), 0) / recent.length : null;

    const etaDate = avgSog && avgSog > 0.1 ? new Date(Date.now() + (dtgNm / avgSog) * 3600 * 1000) : null;

    return (
        <div className="shrink-0 px-4 sm:px-6 py-2.5 bg-slate-900 border-b border-slate-700/80 z-20 relative">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-1.5">
                <span>Passage Progress</span>
                <span className="text-sky-400">{Math.round(pct)}%</span>
            </div>

            {/* The bar */}
            <div className="relative h-1.5 rounded-full bg-slate-800 overflow-visible">
                {/* Fill */}
                <div
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-sky-500 to-emerald-400"
                    style={{ width: `${pct}%` }}
                />
                {/* Origin dot */}
                <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-sky-500 border-2 border-slate-900" />
                {/* Destination dot */}
                <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900" />
                {/* Current-position pip */}
                <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-sky-500 shadow-lg shadow-sky-500/40"
                    style={{ left: `${pct}%` }}
                    aria-label="Current position"
                />
            </div>

            {/* End labels + stats */}
            <div className="flex items-baseline justify-between mt-1.5 text-[10px] font-mono">
                <span className="text-slate-500">Departure</span>
                <div className="flex items-baseline gap-3 text-slate-400">
                    <span>
                        <span className="text-slate-500">DTG</span>{' '}
                        <span className="text-white font-bold">{Math.round(dtgNm)} nm</span>
                    </span>
                    {avgSog != null && (
                        <span>
                            <span className="text-slate-500">SOG 24h</span>{' '}
                            <span className="text-emerald-400 font-bold">{avgSog.toFixed(1)} kt</span>
                        </span>
                    )}
                    {etaDate && (
                        <span>
                            <span className="text-slate-500">ETA</span>{' '}
                            <span className="text-amber-300 font-bold">{formatDateTime(etaDate)}</span>
                        </span>
                    )}
                </div>
                <span className="text-emerald-300">{destination.name ?? 'Destination'}</span>
            </div>
        </div>
    );
};
