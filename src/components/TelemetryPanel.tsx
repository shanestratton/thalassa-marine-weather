import React from 'react';
import type { VoyageLogTelemetry } from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';
import { ArcDial, CompassDial, WindDial } from './dials';

interface TelemetryPanelProps {
    telemetry: VoyageLogTelemetry | null;
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
}

const trendArrow = (t: VoyageLogTelemetry['baro_trend']): string =>
    t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→';

const Stat: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
    <div className="flex flex-col">
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.13em]">{label}</span>
        <span className={`text-xs font-bold font-mono leading-tight ${tone}`}>{value}</span>
    </div>
);

/** Ashore card — what shows when the instruments have gone quiet. */
const ChampagneCard: React.FC<{ lastSeen: string | null }> = ({ lastSeen }) => (
    <div className="shrink-0 border-b border-slate-700 bg-slate-900/40 px-4 py-4">
        <div className="flex items-center gap-3">
            <span className="text-3xl" role="img" aria-label="champagne">
                🥂
            </span>
            <div className="min-w-0">
                <div className="text-sm font-bold text-amber-200">Champagne &amp; good times</div>
                <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                    The instruments are quiet — the crew must be living it up.
                    {lastSeen ? ` Last under way ${lastSeen}.` : ''}
                </div>
            </div>
        </div>
    </div>
);

const ConnectionLostCard: React.FC<{ lastUpdate: string }> = ({ lastUpdate }) => (
    <div
        role="status"
        aria-live="polite"
        className="shrink-0 border-b border-amber-500/25 bg-amber-500/[0.08] px-4 py-4"
    >
        <div className="text-sm font-bold text-amber-200">Connection lost</div>
        <div className="mt-0.5 text-xs leading-relaxed text-amber-100/75">
            Showing last-known voyage data · last update {lastUpdate}.
        </div>
    </div>
);

/** Live instrument cluster — dials + readouts, pinned atop the sidebar.
 *  When the feed is stale by the server's ten-minute live-voyage bound or absent, the boat isn't
 *  sailing — swap the dead dials for the champagne card (owner ask
 *  2026-07-04: "we must be living it up"). Also stops the pulsing LIVE
 *  badge from fibbing over hours-old data. */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
    telemetry: t,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
}) => {
    if (connectionLost) {
        return <ConnectionLostCard lastUpdate={formatPublicAge(lastSuccessfulAt, nowMs)} />;
    }
    const fresh = !!t && !t.is_last_known && isPublicPositionFresh(t.updated_at, nowMs);
    if (!t || !fresh) return <ChampagneCard lastSeen={t ? formatPublicAge(t.updated_at, nowMs) : null} />;

    // Secondary readouts — everything the three dials don't already show.
    const stats: { label: string; value: string; tone: string }[] = [];
    const stat = (label: string, value: number | null, format: (v: number) => string, tone: string): void => {
        if (value != null) stats.push({ label, value: format(value), tone });
    };

    stat('HDG', t.heading, (v) => `${Math.round(v)}°`, 'text-amber-300');
    stat('TWS', t.tws, (v) => `${v.toFixed(1)} kt`, 'text-sky-400');
    stat('TWD', t.twd, (v) => `${Math.round(v)}°`, 'text-sky-400');
    stat('Baro', t.baro, (v) => `${Math.round(v)} ${trendArrow(t.baro_trend)}`, 'text-blue-300');
    stat('Depth', t.depth, (v) => `${v.toFixed(1)} m`, 'text-teal-300');
    stat('Seas', t.wave_height, (v) => `${v.toFixed(1)} m`, 'text-cyan-300');
    stat('Air', t.air_temp, (v) => `${Math.round(v)}°C`, 'text-slate-100');
    stat('Sea', t.water_temp, (v) => `${Math.round(v)}°C`, 'text-sky-200');

    // "Sailing" = making way, not just having data. A parked boat still
    // reports a barometer, air/sea temp, even ambient wind — none of that is
    // sailing. So the ONLY thing that shows the live instrument cluster is
    // real speed over ground; anything under 0.5 kt (dock, anchor, becalmed)
    // is champagne & good times, however rich the weather snapshot is.
    const makingWay = t.sog != null && t.sog >= 0.5;
    if (!makingWay) {
        return <ChampagneCard lastSeen={formatPublicAge(t.updated_at, nowMs)} />;
    }

    return (
        <div className="shrink-0 border-b border-slate-700 bg-slate-900/40">
            <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                </span>
                <span className="text-[10px] font-mono text-slate-500">{formatPublicAge(t.updated_at, nowMs)}</span>
            </div>

            {/* Instrument dials */}
            <div className="flex items-start justify-around px-2 pb-1">
                <ArcDial value={t.sog} max={12} unit="kt" label="SOG" accent="#34d399" />
                <CompassDial value={t.cog} label="COG" accent="#fbbf24" />
                <WindDial awa={t.awa} aws={t.aws} label="Wind kt" accent="#38bdf8" />
            </div>

            {/* Secondary readouts */}
            {stats.length > 0 && (
                <div className="grid grid-cols-4 gap-x-3 gap-y-2 px-4 pt-1.5 pb-3 border-t border-white/[0.05]">
                    {stats.map((s) => (
                        <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} />
                    ))}
                </div>
            )}
        </div>
    );
};
