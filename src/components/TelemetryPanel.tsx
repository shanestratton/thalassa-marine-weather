import React from 'react';
import type { VoyageLogTelemetry } from '../voyageLogApi';

interface TelemetryPanelProps {
    telemetry: VoyageLogTelemetry;
}

const trendArrow = (t: VoyageLogTelemetry['baro_trend']): string =>
    t === 'rising' ? '↑' : t === 'falling' ? '↓' : '→';

const relativeTime = (iso: string): string => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
};

const Stat: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
    <div className="flex flex-col">
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.15em]">{label}</span>
        <span className={`text-sm font-bold font-mono leading-tight ${tone}`}>{value}</span>
    </div>
);

/** Floating glass instrument cluster — the live telemetry over the map. */
export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({ telemetry: t }) => {
    const stats: { label: string; value: string; tone: string }[] = [];

    // The formatter only runs when the value is present — avoids the
    // eager-evaluation trap of computing `value.toFixed()` on a null.
    const stat = (label: string, value: number | null, format: (v: number) => string, tone: string): void => {
        if (value != null) stats.push({ label, value: format(value), tone });
    };

    stat('SOG', t.sog, (v) => `${v.toFixed(1)} kt`, 'text-emerald-400');
    stat('COG', t.cog, (v) => `${Math.round(v)}°`, 'text-amber-400');
    stat('HDG', t.heading, (v) => `${Math.round(v)}°`, 'text-amber-300');
    stat('AWS', t.aws, (v) => `${v.toFixed(1)} kt`, 'text-sky-300');
    stat('AWA', t.awa, (v) => `${Math.abs(v)}° ${v < 0 ? 'P' : 'S'}`, 'text-sky-300');
    stat('TWS', t.tws, (v) => `${v.toFixed(1)} kt`, 'text-sky-400');
    stat('TWD', t.twd, (v) => `${Math.round(v)}°`, 'text-sky-400');
    stat('Baro', t.baro, (v) => `${Math.round(v)} ${trendArrow(t.baro_trend)}`, 'text-blue-300');
    stat('Depth', t.depth, (v) => `${v.toFixed(1)} m`, 'text-teal-300');
    stat('Seas', t.wave_height, (v) => `${v.toFixed(1)} m`, 'text-cyan-300');
    stat('Air', t.air_temp, (v) => `${Math.round(v)}°C`, 'text-slate-100');
    stat('Sea', t.water_temp, (v) => `${Math.round(v)}°C`, 'text-sky-200');

    if (stats.length === 0) return null;

    return (
        <div className="shrink-0 border-b border-slate-700 bg-slate-900/40">
            <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                </span>
                <span className="text-[10px] font-mono text-slate-500">{relativeTime(t.updated_at)}</span>
            </div>
            <div className="grid grid-cols-4 gap-x-3 gap-y-2.5 px-4 pb-3">
                {stats.map((s) => (
                    <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} />
                ))}
            </div>
        </div>
    );
};
