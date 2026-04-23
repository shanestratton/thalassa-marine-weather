/**
 * ModelComparisonMatrix — offshore NWP model convergence viewer.
 *
 * Opens when the user taps anywhere on the offshore 5×2 metrics grid.
 * Instead of a colored heatmap table (which looked like building
 * blocks), this version renders an SVG line chart with each model as
 * an overlapping sparkline — the shape of convergence / divergence
 * reads visually at a glance.
 *
 * Parameter tabs at the top let the user switch between Wind, Gust,
 * Waves and Pressure — all four come from the same parallel fetch so
 * there's no bandwidth cost for the richer view.
 *
 * Selected model gets a thicker line + glow; others plot with muted
 * strokes so the user can still see consensus.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OffshoreModel } from '../../types';
import {
    queryMultiModel,
    type MultiModelResult,
    type ModelForecastPoint,
} from '../../services/weather/MultiModelWeatherService';
import { useLocationCoords } from '../../stores/LocationStore';

// ── Parameter definitions ──

type Param = 'wind' | 'gust' | 'wave' | 'pressure';

interface ParamSpec {
    id: Param;
    label: string;
    short: string;
    unit: string;
    /** How to read a value out of a ModelForecastPoint. */
    read: (p: ModelForecastPoint) => number;
    /** Fallback Y range when data is sparse — keeps the chart from
     *  collapsing to a flat line when all models agree at one value. */
    padMin: number;
    padMax: number;
    /** Nicely-round "ticks" for the Y-axis grid labels. */
    tickStep: number;
    decimals: number;
}

const PARAMS: ParamSpec[] = [
    {
        id: 'wind',
        label: 'Wind',
        short: 'WIND',
        unit: 'kts',
        read: (p) => p.windSpeed,
        padMin: 0,
        padMax: 30,
        tickStep: 10,
        decimals: 0,
    },
    {
        id: 'gust',
        label: 'Gust',
        short: 'GUST',
        unit: 'kts',
        read: (p) => p.windGust,
        padMin: 0,
        padMax: 40,
        tickStep: 10,
        decimals: 0,
    },
    {
        id: 'wave',
        label: 'Waves',
        short: 'WAVE',
        unit: 'm',
        read: (p) => p.waveHeight,
        padMin: 0,
        padMax: 4,
        tickStep: 1,
        decimals: 1,
    },
    {
        id: 'pressure',
        label: 'Pressure',
        short: 'HPA',
        unit: 'hPa',
        read: (p) => p.pressure,
        padMin: 1000,
        padMax: 1030,
        tickStep: 10,
        decimals: 0,
    },
];

// ── Time axis ──

interface TimeColumn {
    label: string;
    offsetHours: number;
}

const TIME_COLS: TimeColumn[] = [
    { label: 'Now', offsetHours: 0 },
    { label: '+12h', offsetHours: 12 },
    { label: '+24h', offsetHours: 24 },
    { label: '+36h', offsetHours: 36 },
    { label: '+48h', offsetHours: 48 },
    { label: '+72h', offsetHours: 72 },
];

// ── Model styling ──

interface ModelStyle {
    code: OffshoreModel | 'unknown';
    label: string;
    stroke: string;
    fill: string;
    hex: string;
}

const MODEL_STYLES: Record<string, ModelStyle> = {
    sg: {
        code: 'sg',
        label: 'Stormglass AI',
        stroke: 'rgb(52, 211, 153)',
        fill: 'rgba(52,211,153,0.12)',
        hex: '#34d399',
    },
    ecmwf: {
        code: 'ecmwf',
        label: 'ECMWF',
        stroke: 'rgb(56, 189, 248)',
        fill: 'rgba(56,189,248,0.12)',
        hex: '#38bdf8',
    },
    gfs: { code: 'gfs', label: 'GFS', stroke: 'rgb(251, 191, 36)', fill: 'rgba(251,191,36,0.12)', hex: '#fbbf24' },
    icon: {
        code: 'icon',
        label: 'ICON',
        stroke: 'rgb(167, 139, 250)',
        fill: 'rgba(167,139,250,0.12)',
        hex: '#a78bfa',
    },
};

// ── Types ──

interface ModelSeries {
    code: OffshoreModel | 'unknown';
    label: string;
    style: ModelStyle;
    /** One value per TIME_COL for each parameter. */
    values: Record<Param, number[]>;
}

interface Props {
    visible: boolean;
    onClose: () => void;
    selectedModel: OffshoreModel;
}

// ── Mock fallback ──
// Used only when the live OpenMeteo fetch fails (offline, no key). Keeps
// the UI honest-looking rather than collapsing to a single flat line.
const MOCK_SERIES: ModelSeries[] = [
    {
        code: 'sg',
        label: 'Stormglass AI',
        style: MODEL_STYLES.sg,
        values: {
            wind: [14, 16, 18, 20, 24, 28],
            gust: [18, 21, 24, 27, 32, 37],
            wave: [1.2, 1.4, 1.6, 1.9, 2.2, 2.7],
            pressure: [1015, 1014, 1012, 1010, 1008, 1006],
        },
    },
    {
        code: 'ecmwf',
        label: 'ECMWF',
        style: MODEL_STYLES.ecmwf,
        values: {
            wind: [13, 15, 17, 22, 30, 35],
            gust: [17, 20, 23, 29, 38, 44],
            wave: [1.1, 1.3, 1.7, 2.2, 3.0, 3.6],
            pressure: [1016, 1014, 1011, 1008, 1004, 1001],
        },
    },
    {
        code: 'gfs',
        label: 'GFS',
        style: MODEL_STYLES.gfs,
        values: {
            wind: [14, 17, 19, 18, 19, 22],
            gust: [18, 22, 25, 24, 25, 28],
            wave: [1.2, 1.5, 1.7, 1.6, 1.7, 1.9],
            pressure: [1015, 1013, 1012, 1012, 1011, 1010],
        },
    },
    {
        code: 'icon',
        label: 'ICON',
        style: MODEL_STYLES.icon,
        values: {
            wind: [13, 15, 18, 21, 27, 32],
            gust: [17, 20, 23, 27, 34, 40],
            wave: [1.1, 1.4, 1.7, 2.0, 2.5, 3.1],
            pressure: [1016, 1015, 1013, 1010, 1007, 1003],
        },
    },
];

/**
 * Sample a model's full forecast at the 6 canonical time offsets for
 * every parameter we want to display. Linear scan is fine — each model
 * has ~120 hourly points.
 */
function multiModelToSeries(result: MultiModelResult | null): ModelSeries[] | null {
    if (!result || result.waypoints.length === 0) return null;
    const wp = result.waypoints[0];
    if (wp.forecasts.length === 0) return null;

    const t0 = new Date(result.queryTime).getTime();
    const pickAt = (points: ModelForecastPoint[], offsetH: number, read: (p: ModelForecastPoint) => number): number => {
        const target = t0 + offsetH * 3600 * 1000;
        let closest = points[0];
        let closestDiff = Math.abs(new Date(closest.time).getTime() - target);
        for (const p of points) {
            const d = Math.abs(new Date(p.time).getTime() - target);
            if (d < closestDiff) {
                closest = p;
                closestDiff = d;
            }
        }
        return read(closest);
    };

    const styleFor = (id: string): ModelStyle =>
        MODEL_STYLES[id] || {
            code: 'unknown',
            label: id.toUpperCase(),
            stroke: 'rgb(148,163,184)',
            fill: 'rgba(148,163,184,0.12)',
            hex: '#94a3b8',
        };

    return wp.forecasts.map((f) => {
        const style = styleFor(f.model.id);
        return {
            code: style.code,
            label: style.label,
            style,
            values: {
                wind: TIME_COLS.map((col) => pickAt(f.points, col.offsetHours, PARAMS[0].read)),
                gust: TIME_COLS.map((col) => pickAt(f.points, col.offsetHours, PARAMS[1].read)),
                wave: TIME_COLS.map((col) => pickAt(f.points, col.offsetHours, PARAMS[2].read)),
                pressure: TIME_COLS.map((col) => pickAt(f.points, col.offsetHours, PARAMS[3].read)),
            },
        };
    });
}

// ── Chart helpers ──

const CHART_W = 320;
const CHART_H = 140;
const CHART_PAD_L = 32;
const CHART_PAD_R = 12;
const CHART_PAD_T = 12;
const CHART_PAD_B = 20;
const PLOT_W = CHART_W - CHART_PAD_L - CHART_PAD_R;
const PLOT_H = CHART_H - CHART_PAD_T - CHART_PAD_B;

/** Generate an SVG path "M x y L x y L x y" for a series of values. */
function makeLinePath(values: number[], minY: number, maxY: number): string {
    const span = maxY - minY || 1;
    return values
        .map((v, i) => {
            const x = CHART_PAD_L + (i / (values.length - 1)) * PLOT_W;
            const y = CHART_PAD_T + PLOT_H - ((v - minY) / span) * PLOT_H;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
}

/** Same but closed into an area (line + baseline fill). */
function makeAreaPath(values: number[], minY: number, maxY: number): string {
    const span = maxY - minY || 1;
    const first = values[0];
    const last = values[values.length - 1];
    const firstX = CHART_PAD_L;
    const lastX = CHART_PAD_L + PLOT_W;
    const firstY = CHART_PAD_T + PLOT_H - ((first - minY) / span) * PLOT_H;
    const _lastY = CHART_PAD_T + PLOT_H - ((last - minY) / span) * PLOT_H;
    const baseY = CHART_PAD_T + PLOT_H;
    const line = values
        .map((v, i) => {
            const x = CHART_PAD_L + (i / (values.length - 1)) * PLOT_W;
            const y = CHART_PAD_T + PLOT_H - ((v - minY) / span) * PLOT_H;
            return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    return `M ${firstX} ${baseY} L ${firstX} ${firstY.toFixed(1)} ${line} L ${lastX} ${baseY} Z`;
}

// ── Confidence ──

interface ColumnConfidence {
    variance: number;
    level: 'high' | 'moderate' | 'low';
}

function calcConfidence(series: ModelSeries[], param: Param): ColumnConfidence[] {
    return TIME_COLS.map((_, colIdx) => {
        const vals = series.map((s) => s.values[param][colIdx]);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const variance = max - min;
        // Different thresholds per parameter — wind and gust are in knots
        // (wide spread is normal), waves in metres (small absolute spread
        // = big % spread), pressure in hPa (whole numbers).
        let level: 'high' | 'moderate' | 'low' = 'high';
        if (param === 'wind' || param === 'gust') {
            level = variance < 4 ? 'high' : variance < 8 ? 'moderate' : 'low';
        } else if (param === 'wave') {
            level = variance < 0.3 ? 'high' : variance < 0.8 ? 'moderate' : 'low';
        } else {
            // pressure
            level = variance < 2 ? 'high' : variance < 5 ? 'moderate' : 'low';
        }
        return { variance, level };
    });
}

// ── Component ──

export const ModelComparisonMatrix: React.FC<Props> = React.memo(({ visible, onClose, selectedModel }) => {
    const { lat, lon } = useLocationCoords();
    const [liveSeries, setLiveSeries] = useState<ModelSeries[] | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isStale, setIsStale] = useState(false);
    const [param, setParam] = useState<Param>('wind');

    useEffect(() => {
        if (!visible) return;
        if (lat == null || lon == null) return;

        let cancelled = false;
        setIsLoading(true);
        setIsStale(false);

        queryMultiModel([{ lat, lon, name: 'here' }], ['gfs', 'ecmwf', 'icon'], 72)
            .then((result) => {
                if (cancelled) return;
                const s = multiModelToSeries(result);
                if (s && s.length > 0) {
                    setLiveSeries(s);
                } else {
                    setIsStale(true);
                }
            })
            .catch(() => {
                if (!cancelled) setIsStale(true);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [visible, lat, lon]);

    const series = liveSeries ?? MOCK_SERIES;
    const spec = useMemo(() => PARAMS.find((p) => p.id === param)!, [param]);
    const confidence = useMemo(() => calcConfidence(series, param), [series, param]);

    // Y-axis range for the current parameter across all models
    const { minY, maxY, ticks } = useMemo(() => {
        const flat = series.flatMap((s) => s.values[param]);
        const rawMin = Math.min(...flat, spec.padMin);
        const rawMax = Math.max(...flat, spec.padMax);
        // Round to nice numbers
        const min = Math.floor(rawMin / spec.tickStep) * spec.tickStep;
        const max = Math.ceil(rawMax / spec.tickStep) * spec.tickStep;
        const tickCount = Math.min(5, Math.max(2, Math.round((max - min) / spec.tickStep) + 1));
        const tickStep = (max - min) / (tickCount - 1);
        const tickArr = Array.from({ length: tickCount }, (_, i) => min + i * tickStep);
        return { minY: min, maxY: max, ticks: tickArr };
    }, [series, param, spec]);

    if (!visible) return null;

    // Overall convergence quality (for the summary strip)
    const avgVariance = confidence.reduce((a, c) => a + c.variance, 0) / confidence.length;
    const overallLevel: 'high' | 'moderate' | 'low' = confidence.every((c) => c.level === 'high')
        ? 'high'
        : confidence.some((c) => c.level === 'low')
          ? 'low'
          : 'moderate';
    const overallColor =
        overallLevel === 'high' ? 'text-emerald-400' : overallLevel === 'moderate' ? 'text-amber-400' : 'text-red-400';
    const overallLabel =
        overallLevel === 'high'
            ? 'Strong agreement'
            : overallLevel === 'moderate'
              ? 'Some divergence'
              : 'Models disagree';

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Model comparison"
            style={{
                paddingTop: 'calc(env(safe-area-inset-top, 0px) + 48px)',
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)',
            }}
        >
            <div
                className="w-full max-w-lg mx-4 bg-slate-900/95 border border-white/[0.08] rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Accent glow */}
                <div className="h-[2px] bg-gradient-to-r from-transparent via-sky-500/60 to-transparent" />

                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <div>
                        <h2 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
                            Model Convergence
                            {isLoading && (
                                <span className="w-3 h-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                            )}
                            {isStale && !isLoading && (
                                <span className="text-[10px] font-bold text-amber-400 bg-amber-500/20 px-1.5 py-0.5 rounded">
                                    SAMPLE
                                </span>
                            )}
                        </h2>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                            72-hour outlook · 3 global models side-by-side
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                {/* Parameter tabs — pick what to compare */}
                <div className="px-5 pb-3">
                    <div className="inline-flex items-center gap-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-1">
                        {PARAMS.map((p) => {
                            const active = p.id === param;
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => setParam(p.id)}
                                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                                        active
                                            ? 'bg-sky-500/20 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.2)]'
                                            : 'text-gray-500 hover:text-gray-300'
                                    }`}
                                >
                                    {p.short}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Chart */}
                <div className="px-5 pb-3">
                    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full h-auto overflow-visible" role="img">
                        {/* Y-axis ticks + horizontal grid */}
                        {ticks.map((t, i) => {
                            const y = CHART_PAD_T + PLOT_H - ((t - minY) / (maxY - minY || 1)) * PLOT_H;
                            return (
                                <g key={i}>
                                    <line
                                        x1={CHART_PAD_L}
                                        y1={y}
                                        x2={CHART_W - CHART_PAD_R}
                                        y2={y}
                                        stroke="rgba(255,255,255,0.06)"
                                        strokeDasharray="2 3"
                                    />
                                    <text
                                        x={CHART_PAD_L - 5}
                                        y={y + 3}
                                        textAnchor="end"
                                        className="fill-gray-500"
                                        style={{ fontSize: '9px', fontFamily: 'monospace' }}
                                    >
                                        {t.toFixed(spec.decimals)}
                                    </text>
                                </g>
                            );
                        })}

                        {/* Area fills — subtle; only for selected model so the
                            chart doesn't muddy up. */}
                        {series.map((s) =>
                            s.code === selectedModel ? (
                                <path
                                    key={`area-${s.code}`}
                                    d={makeAreaPath(s.values[param], minY, maxY)}
                                    fill={s.style.fill}
                                />
                            ) : null,
                        )}

                        {/* Model lines */}
                        {series.map((s) => {
                            const isSelected = s.code === selectedModel;
                            return (
                                <path
                                    key={`line-${s.code}`}
                                    d={makeLinePath(s.values[param], minY, maxY)}
                                    stroke={s.style.stroke}
                                    strokeWidth={isSelected ? 2.5 : 1.5}
                                    strokeOpacity={isSelected ? 1 : 0.65}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    fill="none"
                                    style={
                                        isSelected ? { filter: `drop-shadow(0 0 4px ${s.style.stroke})` } : undefined
                                    }
                                />
                            );
                        })}

                        {/* Point markers on the selected model */}
                        {series
                            .filter((s) => s.code === selectedModel)
                            .flatMap((s) =>
                                s.values[param].map((v, i) => {
                                    const x = CHART_PAD_L + (i / (s.values[param].length - 1)) * PLOT_W;
                                    const y = CHART_PAD_T + PLOT_H - ((v - minY) / (maxY - minY || 1)) * PLOT_H;
                                    return (
                                        <circle
                                            key={`m-${s.code}-${i}`}
                                            cx={x}
                                            cy={y}
                                            r={2.5}
                                            fill={s.style.stroke}
                                            stroke="rgba(15,23,42,0.95)"
                                            strokeWidth={1.5}
                                        />
                                    );
                                }),
                            )}

                        {/* X-axis labels */}
                        {TIME_COLS.map((col, i) => {
                            const x = CHART_PAD_L + (i / (TIME_COLS.length - 1)) * PLOT_W;
                            return (
                                <text
                                    key={col.label}
                                    x={x}
                                    y={CHART_H - 4}
                                    textAnchor="middle"
                                    className="fill-gray-500"
                                    style={{ fontSize: '9px', fontFamily: 'monospace', fontWeight: 700 }}
                                >
                                    {col.label}
                                </text>
                            );
                        })}
                    </svg>
                </div>

                {/* Legend + current values */}
                <div className="px-5 pb-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {series.map((s) => {
                            const current = s.values[param][0];
                            const isSelected = s.code === selectedModel;
                            return (
                                <div
                                    key={s.code}
                                    className={`flex items-center gap-2 py-1 px-2 rounded-lg ${
                                        isSelected ? 'bg-white/[0.05]' : ''
                                    }`}
                                >
                                    <span
                                        className="w-3 h-0.5 rounded-full shrink-0"
                                        style={{ backgroundColor: s.style.hex }}
                                    />
                                    <span
                                        className={`text-[11px] font-bold ${isSelected ? 'text-white' : 'text-gray-400'}`}
                                    >
                                        {s.label}
                                    </span>
                                    <span className="ml-auto text-[11px] font-mono text-gray-300 tabular-nums">
                                        {current.toFixed(spec.decimals)}
                                        <span className="text-gray-500 ml-0.5">{spec.unit}</span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Convergence summary */}
                <div className="mx-5 mb-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.05] flex items-center gap-3">
                    <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                            overallLevel === 'high'
                                ? 'bg-emerald-500/20'
                                : overallLevel === 'moderate'
                                  ? 'bg-amber-500/20'
                                  : 'bg-red-500/20'
                        }`}
                    >
                        {overallLevel === 'high' ? (
                            <svg
                                className={`w-4 h-4 ${overallColor}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        ) : overallLevel === 'moderate' ? (
                            <svg
                                className={`w-4 h-4 ${overallColor}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" />
                            </svg>
                        ) : (
                            <svg
                                className={`w-4 h-4 ${overallColor}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                />
                            </svg>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className={`text-[11px] font-black uppercase tracking-wider ${overallColor}`}>
                            {overallLabel}
                        </div>
                        <div className="text-[10px] text-gray-500">
                            Avg spread · {avgVariance.toFixed(spec.decimals)} {spec.unit}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 text-[9px] font-mono text-gray-500">
                        {confidence.map((c, i) => (
                            <span
                                key={i}
                                className={`w-1.5 h-4 rounded-sm ${
                                    c.level === 'high'
                                        ? 'bg-emerald-400/60'
                                        : c.level === 'moderate'
                                          ? 'bg-amber-400/60'
                                          : 'bg-red-400/60'
                                }`}
                                title={`${TIME_COLS[i].label}: ±${c.variance.toFixed(spec.decimals)}`}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
});

ModelComparisonMatrix.displayName = 'ModelComparisonMatrix';
