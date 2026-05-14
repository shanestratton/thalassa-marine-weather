import React from 'react';
import type { VoyageLogData, VoyageLogTelemetry } from '../voyageLogApi';

interface TopNavProps {
    vessel: VoyageLogData['vessel'];
    telemetry: VoyageLogTelemetry | null;
}

const VESSEL_TYPE_LABEL: Record<string, string> = {
    sail: 'Sailing vessel',
    power: 'Power vessel',
    observer: 'Vessel',
};

const trendArrow = (trend: VoyageLogTelemetry['baro_trend']): string =>
    trend === 'falling' ? '↓' : trend === 'rising' ? '↑' : '→';

const Stat: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
    <div className="flex flex-col items-center">
        <span className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</span>
        <span className={`text-sm font-semibold ${tone}`}>{value}</span>
    </div>
);

export default function TopNav({ vessel, telemetry }: TopNavProps) {
    const specs = [VESSEL_TYPE_LABEL[vessel.type] ?? 'Vessel', vessel.model].filter(Boolean).join(' · ');

    return (
        <header className="h-16 shrink-0 bg-slate-900 border-b border-slate-700 flex items-center justify-between px-4 sm:px-6 shadow-md z-20 relative">
            {/* Brand & vessel */}
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                <h1 className="text-lg sm:text-xl font-bold tracking-widest text-blue-500 uppercase shrink-0">
                    Thalassa
                </h1>
                <div className="h-6 w-px bg-slate-700 shrink-0" />
                <div className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-slate-100 truncate">{vessel.name}</span>
                    <span className="text-xs text-slate-400 truncate">{specs}</span>
                </div>
            </div>

            {/* Live telemetry */}
            {telemetry ? (
                <div className="flex gap-4 sm:gap-6 bg-slate-800 px-3 sm:px-4 py-2 rounded-lg border border-slate-700 font-mono shrink-0">
                    <Stat
                        label="SOG"
                        tone="text-emerald-400"
                        value={telemetry.sog != null ? `${telemetry.sog.toFixed(1)} kt` : '—'}
                    />
                    <Stat
                        label="COG"
                        tone="text-amber-400"
                        value={telemetry.cog != null ? `${Math.round(telemetry.cog)}°` : '—'}
                    />
                    <Stat
                        label="Baro"
                        tone="text-blue-300"
                        value={
                            telemetry.baro != null
                                ? `${Math.round(telemetry.baro)} ${trendArrow(telemetry.baro_trend)}`
                                : '—'
                        }
                    />
                </div>
            ) : (
                <span className="text-xs text-slate-500 font-mono shrink-0">No telemetry yet</span>
            )}
        </header>
    );
}
