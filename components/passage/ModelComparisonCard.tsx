/**
 * ModelComparisonCard — Multi-Model Weather Ensemble Heat Map.
 *
 * Premium visual comparison of weather model forecasts across route waypoints.
 * Uses colour-coded heat map rows per model with a consensus band,
 * sparkline-style visualisations, and mobile-first responsive layout.
 */

import React, { useMemo, useState } from 'react';
import type {
    MultiModelResult,
    WaypointComparison as _WaypointComparison,
    ModelForecastPoint,
} from '../../services/weather/MultiModelWeatherService';

interface ModelComparisonCardProps {
    data: MultiModelResult;
}

/* ── Model brand colours ────────────────────────────────────── */
const MODEL_PALETTE: Record<string, { bg: string; text: string; glow: string; bar: string }> = {
    GFS: { bg: 'bg-sky-500/15', text: 'text-sky-400', glow: 'shadow-sky-500/20', bar: '#38bdf8' },
    'ECMWF IFS': { bg: 'bg-emerald-500/15', text: 'text-emerald-400', glow: 'shadow-emerald-500/20', bar: '#34d399' },
    ICON: { bg: 'bg-amber-500/15', text: 'text-amber-400', glow: 'shadow-amber-500/20', bar: '#fbbf24' },
    'ACCESS-G': { bg: 'bg-purple-500/15', text: 'text-purple-400', glow: 'shadow-purple-500/20', bar: '#a78bfa' },
    GEM: { bg: 'bg-cyan-500/15', text: 'text-cyan-400', glow: 'shadow-cyan-500/20', bar: '#22d3ee' },
};
const DEFAULT_PAL = { bg: 'bg-gray-500/15', text: 'text-gray-400', glow: 'shadow-gray-500/20', bar: '#9ca3af' };

/* ── Confidence (relaxed thresholds — 2 models naturally differ) ── */
const getConfidence = (windSpread: number, dirSpread: number): 'high' | 'medium' | 'low' => {
    if (windSpread > 20 || dirSpread > 90) return 'low';
    if (windSpread > 12 || dirSpread > 45) return 'medium';
    return 'high';
};

const CONFIDENCE_STYLES = {
    high: {
        bg: 'from-emerald-500/10 to-emerald-600/5',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
        icon: '🟢',
        label: 'HIGH CONFIDENCE',
        desc: 'Models agree — forecast is reliable',
    },
    medium: {
        bg: 'from-amber-500/10 to-amber-600/5',
        border: 'border-amber-500/30',
        text: 'text-amber-400',
        icon: '🟡',
        label: 'MODERATE',
        desc: 'Some disagreement — monitor updates',
    },
    low: {
        bg: 'from-red-500/10 to-red-600/5',
        border: 'border-red-500/30',
        text: 'text-red-400',
        icon: '🔴',
        label: 'LOW CONFIDENCE',
        desc: 'Models diverge — exercise caution',
    },
};

/* ── Wind speed → heat colour ─────────────────────────────── */
const windHeatColor = (kts: number): string => {
    if (kts < 5) return 'bg-sky-900/40';
    if (kts < 10) return 'bg-sky-700/50';
    if (kts < 15) return 'bg-sky-500/50';
    if (kts < 20) return 'bg-emerald-500/40';
    if (kts < 25) return 'bg-amber-500/40';
    if (kts < 30) return 'bg-orange-500/50';
    if (kts < 35) return 'bg-red-500/50';
    return 'bg-red-600/60';
};

const windTextColor = (kts: number): string => {
    if (kts < 15) return 'text-sky-300';
    if (kts < 20) return 'text-emerald-300';
    if (kts < 25) return 'text-amber-300';
    if (kts < 30) return 'text-orange-300';
    return 'text-red-300';
};

const waveHeatColor = (m: number): string => {
    if (m < 0.5) return 'bg-sky-900/40';
    if (m < 1.0) return 'bg-sky-600/40';
    if (m < 1.5) return 'bg-emerald-500/40';
    if (m < 2.0) return 'bg-amber-500/40';
    if (m < 3.0) return 'bg-orange-500/50';
    return 'bg-red-500/50';
};

/* ── SVG Sparkline for model trend comparison ─────────────── */
const Sparkline: React.FC<{
    points: ModelForecastPoint[];
    color: string;
    metric: 'windSpeed' | 'waveHeight';
    maxVal: number;
    height?: number;
}> = ({ points, color, metric, maxVal, height = 32 }) => {
    const width = 120;
    const sampled = samplePoints(points, 20);
    if (sampled.length < 2) return null;

    const path = sampled
        .map((pt, i) => {
            const x = (i / (sampled.length - 1)) * width;
            const y = height - (pt[metric] / (maxVal || 1)) * (height - 4);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    return (
        <svg width={width} height={height} className="shrink-0" viewBox={`0 0 ${width} ${height}`}>
            <path
                d={path}
                stroke={color}
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.8"
            />
        </svg>
    );
};

function samplePoints(points: ModelForecastPoint[], max: number): ModelForecastPoint[] {
    if (points.length <= max) return points;
    const step = (points.length - 1) / (max - 1);
    const result: ModelForecastPoint[] = [];
    for (let i = 0; i < max; i++) result.push(points[Math.round(i * step)]);
    return result;
}

/* ── Direction arrow ──────────────────────────────────────── */
const DirArrow: React.FC<{ deg: number; size?: number }> = ({ deg, size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ transform: `rotate(${deg}deg)` }}>
        <path d="M10 2 L15 14 L10 11 L5 14 Z" fill="currentColor" opacity="0.7" />
    </svg>
);

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export const ModelComparisonCard: React.FC<ModelComparisonCardProps> = ({ data }) => {
    const [activeWp, setActiveWp] = useState(0);

    // Recalculate confidence with relaxed thresholds
    const overallConfidence = useMemo(() => {
        const confidences = data.waypoints.map((wp) => {
            return getConfidence(wp.consensus.windSpeedSpread, wp.consensus.windDirectionSpread);
        });
        if (confidences.includes('low')) return 'low';
        if (confidences.includes('medium')) return 'medium';
        return 'high';
    }, [data]);

    // Global max values for sparkline scaling
    const globalMaxWind = useMemo(() => {
        let max = 25;
        data.waypoints.forEach((wp) =>
            wp.forecasts.forEach((f) =>
                f.points.forEach((p) => {
                    if (p.windSpeed > max) max = p.windSpeed;
                }),
            ),
        );
        return max * 1.1;
    }, [data]);

    const globalMaxWave = useMemo(() => {
        let max = 2;
        data.waypoints.forEach((wp) =>
            wp.forecasts.forEach((f) =>
                f.points.forEach((p) => {
                    if (p.waveHeight > max) max = p.waveHeight;
                }),
            ),
        );
        return max * 1.1;
    }, [data]);

    const style = CONFIDENCE_STYLES[overallConfidence];
    const wpData = data.waypoints[activeWp];
    const wpConf = wpData
        ? getConfidence(wpData.consensus.windSpeedSpread, wpData.consensus.windDirectionSpread)
        : 'low';
    const wpStyle = CONFIDENCE_STYLES[wpConf];

    return (
        <div className="space-y-4">
            {/* ── Overall Confidence Banner ── */}
            <div
                className={`bg-gradient-to-r ${style.bg} ${style.border} border rounded-xl px-4 py-3 flex items-center gap-3`}
            >
                <span className="text-xl">{style.icon}</span>
                <div className="flex-1 min-w-0">
                    <div className={`text-xs font-black uppercase tracking-widest ${style.text}`}>{style.label}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">{style.desc}</div>
                </div>
                <div className="text-right shrink-0">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Ensemble</div>
                    <div className="text-xs text-white font-bold">{data.models.length} models</div>
                </div>
            </div>

            {/* ── Model Legend (compact pills) ── */}
            <div className="flex flex-wrap gap-1.5">
                {data.models.map((m) => {
                    const pal = MODEL_PALETTE[m.name] || DEFAULT_PAL;
                    return (
                        <div
                            key={m.id}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg ${pal.bg} border border-white/5`}
                        >
                            <div className={`w-2 h-2 rounded-full ${pal.text.replace('text-', 'bg-')}`} />
                            <span className={`text-[11px] font-bold ${pal.text}`}>{m.name}</span>
                            <span className="text-[11px] text-gray-400">{m.resolution}</span>
                        </div>
                    );
                })}
            </div>

            {/* ── Waypoint Selector (scrollable tabs) ── */}
            {data.waypoints.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
                    {data.waypoints.map((wp, idx) => {
                        const wConf = getConfidence(wp.consensus.windSpeedSpread, wp.consensus.windDirectionSpread);
                        const isActive = idx === activeWp;
                        return (
                            <button
                                aria-label="Active Wp"
                                key={idx}
                                onClick={() => setActiveWp(idx)}
                                className={`shrink-0 px-3 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border ${
                                    isActive
                                        ? 'bg-white/10 border-white/20 text-white shadow-lg'
                                        : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-300 hover:bg-white/[0.06]'
                                }`}
                            >
                                <div className="flex items-center gap-1.5">
                                    <div
                                        className={`w-1.5 h-1.5 rounded-full ${CONFIDENCE_STYLES[wConf].text.replace('text-', 'bg-')}`}
                                    />
                                    {wp.name || `WP-${idx + 1}`}
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* ── Active Waypoint Heat Map ── */}
            {wpData && (
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl overflow-hidden animate-in fade-in duration-200">
                    {/* Waypoint header */}
                    <div
                        className={`px-4 py-3 flex items-center justify-between border-b border-white/[0.06] bg-gradient-to-r ${wpStyle.bg}`}
                    >
                        <div className="flex items-center gap-2.5">
                            <span className="text-sm">{wpStyle.icon}</span>
                            <div>
                                <div className="text-sm font-bold text-white">
                                    {wpData.name || `Waypoint ${activeWp + 1}`}
                                </div>
                                <div className="text-[11px] text-gray-400 font-mono">
                                    {wpData.lat.toFixed(3)}°, {wpData.lon.toFixed(3)}°
                                </div>
                            </div>
                        </div>
                        <div className="text-right">
                            <div className={`text-[11px] font-black uppercase tracking-widest ${wpStyle.text}`}>
                                {wpConf}
                            </div>
                        </div>
                    </div>

                    {/* Consensus summary bar */}
                    <div className="px-4 py-3 grid grid-cols-4 gap-2 border-b border-white/[0.06] bg-white/[0.02]">
                        <div className="text-center">
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                Wind
                            </div>
                            <div className="text-sm font-bold text-white">{wpData.consensus.windSpeedMean}kt</div>
                            <div
                                className={`text-[11px] font-mono ${wpData.consensus.windSpeedSpread > 12 ? 'text-amber-400' : 'text-emerald-400'}`}
                            >
                                ±{wpData.consensus.windSpeedSpread}kt
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                Dir
                            </div>
                            <div className="text-sm font-bold text-white flex items-center justify-center gap-1">
                                <DirArrow deg={wpData.consensus.windDirectionMean} />
                                {wpData.consensus.windDirectionMean}°
                            </div>
                            <div
                                className={`text-[11px] font-mono ${wpData.consensus.windDirectionSpread > 45 ? 'text-amber-400' : 'text-emerald-400'}`}
                            >
                                ±{wpData.consensus.windDirectionSpread}°
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                Waves
                            </div>
                            <div className="text-sm font-bold text-white">{wpData.consensus.waveHeightMean}m</div>
                            <div
                                className={`text-[11px] font-mono ${wpData.consensus.waveHeightSpread > 1 ? 'text-amber-400' : 'text-emerald-400'}`}
                            >
                                ±{wpData.consensus.waveHeightSpread}m
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-0.5">
                                Pres
                            </div>
                            <div className="text-sm font-bold text-white">{wpData.consensus.pressureMean}</div>
                            <div className="text-[11px] font-mono text-gray-400">hPa</div>
                        </div>
                    </div>

                    {/* ── HEAT MAP ROWS — one per model ── */}
                    <div className="divide-y divide-white/[0.04]">
                        {wpData.forecasts.map((f, fIdx) => {
                            const pal = MODEL_PALETTE[f.model.name] || DEFAULT_PAL;
                            const sample24 = f.points[Math.min(24, f.points.length - 1)];
                            if (!sample24) return null;

                            // Sample 6-hourly points for the heat strip
                            const heatPoints: ModelForecastPoint[] = [];
                            for (let h = 0; h < f.points.length; h += 6) {
                                heatPoints.push(f.points[h]);
                            }

                            return (
                                <div key={fIdx} className="px-4 py-3">
                                    <div className="flex items-center gap-3 mb-2">
                                        {/* Model name */}
                                        <div className="flex items-center gap-1.5 min-w-[80px]">
                                            <div
                                                className={`w-2.5 h-2.5 rounded-full ${pal.text.replace('text-', 'bg-')} shadow-lg ${pal.glow}`}
                                            />
                                            <span className={`text-[11px] font-black ${pal.text}`}>{f.model.name}</span>
                                        </div>

                                        {/* 24h sample values */}
                                        <div className="flex items-center gap-3 text-[11px] font-mono">
                                            <span className={windTextColor(sample24.windSpeed)}>
                                                {sample24.windSpeed}kt
                                            </span>
                                            <span className="text-gray-400 flex items-center gap-0.5">
                                                <DirArrow deg={sample24.windDirection} size={10} />
                                                {sample24.windDirection}°
                                            </span>
                                            <span className="text-sky-300">{sample24.waveHeight}m</span>
                                        </div>
                                    </div>

                                    {/* Wind heat strip */}
                                    <div className="flex gap-[2px] rounded-lg overflow-hidden mb-1.5">
                                        {heatPoints.map((hp, hIdx) => (
                                            <div
                                                key={hIdx}
                                                className={`flex-1 h-5 ${windHeatColor(hp.windSpeed)} flex items-center justify-center transition-all hover:scale-y-[1.4] hover:z-10 relative group cursor-default`}
                                                title={`+${hIdx * 6}h: ${hp.windSpeed}kt ${hp.windDirection}° | ${hp.waveHeight}m`}
                                            >
                                                <span className="text-[8px] font-mono text-white/60 group-hover:text-white/90 transition-colors">
                                                    {Math.round(hp.windSpeed)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Wave heat strip */}
                                    <div className="flex gap-[2px] rounded-lg overflow-hidden">
                                        {heatPoints.map((hp, hIdx) => (
                                            <div
                                                key={hIdx}
                                                className={`flex-1 h-3 ${waveHeatColor(hp.waveHeight)} flex items-center justify-center transition-all hover:scale-y-[1.5] hover:z-10 relative group cursor-default`}
                                                title={`+${hIdx * 6}h: ${hp.waveHeight}m waves`}
                                            >
                                                <span className="text-[7px] font-mono text-white/40 group-hover:text-white/80 transition-colors">
                                                    {hp.waveHeight.toFixed(1)}
                                                </span>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Sparkline overlay */}
                                    <div className="flex items-center gap-3 mt-1.5 ml-[80px]">
                                        <div className="flex items-center gap-1">
                                            <span className="text-[8px] text-gray-600 uppercase">Wind</span>
                                            <Sparkline
                                                points={f.points}
                                                color={pal.bar}
                                                metric="windSpeed"
                                                maxVal={globalMaxWind}
                                            />
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-[8px] text-gray-600 uppercase">Wave</span>
                                            <Sparkline
                                                points={f.points}
                                                color={pal.bar}
                                                metric="waveHeight"
                                                maxVal={globalMaxWave}
                                                height={20}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Time axis label */}
                    <div className="px-4 py-2 flex justify-between text-[11px] text-gray-600 font-mono border-t border-white/[0.04]">
                        <span>Now</span>
                        <span>+{Math.round(data.forecastHours / 2)}h</span>
                        <span>+{data.forecastHours}h</span>
                    </div>
                </div>
            )}

            {/* ── Legend: Heat Scale ── */}
            <div className="flex items-center gap-1 px-1">
                <span className="text-[11px] text-gray-600 mr-1">Wind:</span>
                {[
                    { label: '<5', cls: 'bg-sky-900/60' },
                    { label: '10', cls: 'bg-sky-700/60' },
                    { label: '15', cls: 'bg-sky-500/60' },
                    { label: '20', cls: 'bg-emerald-500/60' },
                    { label: '25', cls: 'bg-amber-500/60' },
                    { label: '30', cls: 'bg-orange-500/60' },
                    { label: '35+', cls: 'bg-red-500/60' },
                ].map((s, i) => (
                    <div key={i} className="flex flex-col items-center gap-0.5">
                        <div className={`w-5 h-2.5 rounded-sm ${s.cls}`} />
                        <span className="text-[7px] text-gray-600 font-mono">{s.label}</span>
                    </div>
                ))}
                <span className="text-[11px] text-gray-600 ml-1">kt</span>
            </div>

            {/* Query metadata */}
            <div className="text-[11px] text-gray-600 text-right font-mono">
                {data.models.length} models queried in {data.elapsed_ms}ms •{' '}
                {new Date(data.queryTime).toLocaleTimeString()}
            </div>
        </div>
    );
};
