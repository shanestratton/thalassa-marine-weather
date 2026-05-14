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
    const add = (ok: boolean, label: string, value: string, tone: string) => {
        if (ok) stats.push({ label, value, tone });
    };

    add(t.sog != null, 'SOG', `${t.sog!.toFixed(1)} kt`, 'text-emerald-400');
    add(t.cog != null, 'COG', `${Math.round(t.cog!)}°`, 'text-amber-400');
    add(t.heading != null, 'HDG', `${Math.round(t.heading!)}°`, 'text-amber-300');
    add(t.aws != null, 'AWS', `${t.aws!.toFixed(1)} kt`, 'text-sky-300');
    add(t.awa != null, 'AWA', `${Math.abs(t.awa!)}° ${t.awa! < 0 ? 'P' : 'S'}`, 'text-sky-300');
    add(t.tws != null, 'TWS', `${t.tws!.toFixed(1)} kt`, 'text-sky-400');
    add(t.twd != null, 'TWD', `${Math.round(t.twd!)}°`, 'text-sky-400');
    add(t.baro != null, 'Baro', `${Math.round(t.baro!)} ${trendArrow(t.baro_trend)}`, 'text-blue-300');
    add(t.depth != null, 'Depth', `${t.depth!.toFixed(1)} m`, 'text-teal-300');
    add(t.wave_height != null, 'Seas', `${t.wave_height!.toFixed(1)} m`, 'text-cyan-300');
    add(t.air_temp != null, 'Air', `${Math.round(t.air_temp!)}°C`, 'text-slate-100');
    add(t.water_temp != null, 'Sea', `${Math.round(t.water_temp!)}°C`, 'text-sky-200');

    if (stats.length === 0) return null;

    return (
        <div className="pointer-events-auto w-[min(20rem,calc(100vw-2rem))] bg-slate-900/85 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06]">
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                </span>
                <span className="text-[10px] font-mono text-slate-500">{relativeTime(t.updated_at)}</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-4 gap-y-3 px-4 py-3">
                {stats.map((s) => (
                    <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} />
                ))}
            </div>
        </div>
    );
};
