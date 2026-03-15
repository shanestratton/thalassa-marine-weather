/**
 * ModelComparisonCard — Multi-Model Weather Ensemble Comparison Panel.
 *
 * Shows side-by-side weather model forecasts (GFS, ECMWF, ICON, ACCESS-G, GEM)
 * for route waypoints, with consensus metrics and confidence indicators.
 *
 * Designed to give sailors a GO/NO-GO signal based on model agreement.
 */

import React, { useMemo } from 'react';
import type { MultiModelResult, WaypointComparison } from '../../services/weather/MultiModelWeatherService';

interface ModelComparisonCardProps {
    data: MultiModelResult;
}

const CONFIDENCE_STYLES = {
    high: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
        label: 'HIGH CONFIDENCE',
        icon: '✅',
        desc: 'Models agree — forecast is reliable',
    },
    medium: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        text: 'text-amber-400',
        label: 'MODERATE CONFIDENCE',
        icon: '⚠️',
        desc: 'Some disagreement — monitor updates',
    },
    low: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/30',
        text: 'text-red-400',
        label: 'LOW CONFIDENCE',
        icon: '🔴',
        desc: 'Models diverge significantly — exercise caution',
    },
};

const MODEL_COLORS: Record<string, string> = {
    GFS: 'text-sky-400',
    'ECMWF IFS': 'text-emerald-400',
    ICON: 'text-amber-400',
    'ACCESS-G': 'text-purple-400',
    GEM: 'text-cyan-400',
};

export const ModelComparisonCard: React.FC<ModelComparisonCardProps> = ({ data }) => {
    // Overall confidence — worst confidence across all waypoints
    const overallConfidence = useMemo(() => {
        const confidences = data.waypoints.map((wp) => wp.consensus.confidence);
        if (confidences.includes('low')) return 'low';
        if (confidences.includes('medium')) return 'medium';
        return 'high';
    }, [data]);

    const style = CONFIDENCE_STYLES[overallConfidence];

    return (
        <div className="space-y-4">
            {/* Overall Confidence Banner */}
            <div className={`${style.bg} ${style.border} border rounded-xl px-4 py-3 flex items-center gap-3`}>
                <span className="text-2xl">{style.icon}</span>
                <div className="flex-1">
                    <div className={`text-sm font-black uppercase tracking-widest ${style.text}`}>{style.label}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{style.desc}</div>
                </div>
                <div className="text-right shrink-0">
                    <div className="text-[11px] text-gray-500 uppercase tracking-widest font-bold">Models</div>
                    <div className="text-xs text-white font-bold">{data.models.length} compared</div>
                </div>
            </div>

            {/* Model Legend */}
            <div className="flex flex-wrap gap-2">
                {data.models.map((m) => (
                    <div
                        key={m.id}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/5"
                    >
                        <div
                            className={`w-2 h-2 rounded-full ${MODEL_COLORS[m.name]?.replace('text-', 'bg-') || 'bg-gray-400'}`}
                        />
                        <span className={`text-[11px] font-bold ${MODEL_COLORS[m.name] || 'text-gray-400'}`}>
                            {m.name}
                        </span>
                        <span className="text-[10px] text-gray-500">{m.resolution}</span>
                    </div>
                ))}
            </div>

            {/* Waypoint Comparison Grid */}
            <div className="space-y-3">
                {data.waypoints.map((wp, idx) => (
                    <WaypointRow key={idx} wp={wp} models={data.models.map((m) => m.name)} />
                ))}
            </div>

            {/* Query metadata */}
            <div className="text-[10px] text-gray-600 text-right font-mono">
                Queried {data.models.length} models in {data.elapsed_ms}ms •{' '}
                {new Date(data.queryTime).toLocaleTimeString()}
            </div>
        </div>
    );
};

// ── Waypoint Comparison Row ──────────────────────────────────────

const WaypointRow: React.FC<{ wp: WaypointComparison; models: string[] }> = ({ wp, models }) => {
    const confStyle = CONFIDENCE_STYLES[wp.consensus.confidence];

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden">
            {/* Waypoint header */}
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02]">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${confStyle.text.replace('text-', 'bg-')}`} />
                    <span className="text-xs font-bold text-white truncate max-w-[200px]">
                        {wp.name || `${wp.lat.toFixed(2)}°, ${wp.lon.toFixed(2)}°`}
                    </span>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-widest ${confStyle.text}`}>
                    {wp.consensus.confidence}
                </span>
            </div>

            {/* Consensus summary */}
            <div className="px-4 py-3 grid grid-cols-4 gap-3">
                <MetricCell
                    label="Wind"
                    value={`${wp.consensus.windSpeedMean}kt`}
                    spread={wp.consensus.windSpeedSpread}
                    spreadLabel="kt spread"
                />
                <MetricCell
                    label="Direction"
                    value={`${wp.consensus.windDirectionMean}°`}
                    spread={wp.consensus.windDirectionSpread}
                    spreadLabel="° spread"
                />
                <MetricCell
                    label="Waves"
                    value={`${wp.consensus.waveHeightMean}m`}
                    spread={wp.consensus.waveHeightSpread}
                    spreadLabel="m spread"
                />
                <MetricCell label="Pressure" value={`${wp.consensus.pressureMean}hPa`} />
            </div>

            {/* Per-model breakdown (compact) */}
            <div className="px-4 pb-3 flex gap-2 overflow-x-auto">
                {wp.forecasts.map((f, i) => {
                    // Get sample point at ~24h
                    const sample = f.points[Math.min(24, f.points.length - 1)];
                    if (!sample) return null;
                    const color = MODEL_COLORS[f.model.name] || 'text-gray-400';

                    return (
                        <div
                            key={i}
                            className="shrink-0 bg-black/30 rounded-lg px-3 py-2 border border-white/[0.04] min-w-[90px]"
                        >
                            <div className={`text-[10px] font-bold ${color} mb-1`}>{f.model.name}</div>
                            <div className="text-[11px] text-white font-mono">{sample.windSpeed}kt</div>
                            <div className="text-[10px] text-gray-500">
                                {sample.windDirection}° • {sample.waveHeight}m
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ── Metric Cell ──────────────────────────────────────────────────

const MetricCell: React.FC<{
    label: string;
    value: string;
    spread?: number;
    spreadLabel?: string;
}> = ({ label, value, spread, spreadLabel }) => (
    <div className="text-center">
        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">{label}</div>
        <div className="text-sm font-bold text-white">{value}</div>
        {spread !== undefined && (
            <div
                className={`text-[10px] font-mono mt-0.5 ${
                    spread > 15 ? 'text-red-400' : spread > 8 ? 'text-amber-400' : 'text-emerald-400'
                }`}
            >
                ±{spread} {spreadLabel}
            </div>
        )}
    </div>
);
