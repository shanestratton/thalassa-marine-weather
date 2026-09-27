import React from 'react';
import { haversineNm } from '../geo';
import type { VoyageLogDestination, VoyageLogTrackPoint } from '../voyageLogApi';

interface VoyageProgressBarProps {
    track: VoyageLogTrackPoint[];
    destination: VoyageLogDestination | null;
    compact?: boolean;
}

const formatDateTime = (d: Date): string => {
    const datePart = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
};

export const VoyageProgressBar: React.FC<VoyageProgressBarProps> = ({ track, destination, compact = false }) => {
    // The raw track carries thousands of points and this component re-renders
    // on the page's 30 s clock. Parse each timestamp once per payload instead
    // of allocating a Date per point per render.
    const stamped = React.useMemo(
        () => (destination ? track.map((p) => ({ t: Date.parse(p.timestamp), sog: p.speed_kts })) : []),
        [track, destination],
    );

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
    const recent = stamped.filter((p) => p.sog != null && p.t >= cutoff);
    const avgSog = recent.length > 0 ? recent.reduce((s, p) => s + (p.sog as number), 0) / recent.length : null;

    const etaDate = avgSog && avgSog > 0.1 ? new Date(Date.now() + (dtgNm / avgSog) * 3600 * 1000) : null;

    return (
        <div
            className={
                compact
                    ? 'pv-progress relative'
                    : 'pv-progress shrink-0 px-3 pb-3 z-20 relative lg:px-6 py-2 lg:py-2.5 bg-slate-900 border-b border-slate-700/80'
            }
        >
            <div
                className={`pv-progress__head mb-2 flex min-w-0 items-center justify-between gap-3 ${compact ? '' : 'lg:hidden'}`}
            >
                <span className="pv-progress__to truncate" title={destination.name ?? 'Destination'}>
                    To {destination.name ?? 'Destination'}
                </span>
                <span className="shrink-0">
                    <strong>{Math.round(dtgNm)} nm</strong> to go
                </span>
            </div>
            <div
                className={`${compact ? 'hidden' : 'hidden lg:flex'} mb-1.5 items-center justify-between text-xs font-bold uppercase tracking-[0.15em]`}
            >
                <span>Passage Progress</span>
                <span className="pv-num">{Math.round(pct)}%</span>
            </div>

            {/* The bar: teal, the colour of the sailed track */}
            <div
                className="pv-progress__track"
                role="progressbar"
                aria-label="Passage progress"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div className="pv-progress__fill" style={{ width: `${pct}%` }} />
                {/* Origin and destination ends */}
                <div className="pv-progress__end" style={{ left: 0 }} />
                <div className="pv-progress__end" style={{ left: '100%' }} />
                {/* Current-position pip */}
                <div className="pv-progress__pip" style={{ left: `${pct}%` }} />
            </div>

            {/* End labels + stats (wide non-compact layout only) */}
            <div
                className={`${compact ? 'hidden' : 'hidden lg:flex'} pv-num mt-1.5 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs`}
            >
                {/* Default text colour throughout; the bold figures carry the weight. */}
                <span>Departure</span>
                <div className="flex flex-wrap items-baseline gap-3">
                    <span>
                        <span>DTG</span> <span className="font-bold">{Math.round(dtgNm)} nm</span>
                    </span>
                    {avgSog != null && (
                        <span>
                            <span>SOG 24h</span> <span className="font-bold">{avgSog.toFixed(1)} kt</span>
                        </span>
                    )}
                    {etaDate && (
                        <span>
                            <span>ETA</span> <span className="font-bold">{formatDateTime(etaDate)}</span>
                        </span>
                    )}
                </div>
                <span>{destination.name ?? 'Destination'}</span>
            </div>
        </div>
    );
};
