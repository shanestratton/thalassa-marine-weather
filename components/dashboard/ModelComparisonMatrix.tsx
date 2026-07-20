/**
 * ModelComparisonMatrix — NWP model convergence viewer.
 *
 * Opens from the Glass metrics grid: a tap anywhere on the grid when
 * offshore (legacy behaviour), or a LONG-PRESS on any individual metric
 * cell anywhere (inshore/coastal/offshore), which lands pre-tabbed on that
 * metric via `initialParam`.
 *
 * Renders an SVG line chart with each model as an overlapping sparkline —
 * the shape of convergence / divergence reads visually at a glance. One
 * tab per grid metric; every tab is served by the same two-request
 * multi-model fetch (ModelSpreadService), so switching tabs never refetches.
 *
 * Atmospheric tabs plot the six selectable forecast models; WAVE / PER.
 * plot the four wave models (the marine endpoint has its own model set).
 * The user's pinned forecast model gets a thicker line + glow.
 *
 * Where models don't publish a variable (e.g. UV on the wx server) their
 * series is dropped for that tab, and an honest empty state replaces the
 * chart when nothing publishes it. No mock data — if the fetch fails the
 * chart says so.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WeatherModel } from '../../types';
import {
    queryModelSpread,
    type ModelSpreadResult,
    type AtmosVar,
    type MarineVar,
} from '../../services/weather/ModelSpreadService';
import { MODEL_ATTRIBUTION_LINE } from '../../services/weather/forecastModels';
import { useLocationCoords } from '../../stores/LocationStore';

// ── Parameter definitions ──
// Ids match the Glass grid's metric ids so a long-pressed cell maps 1:1.

export type MatrixParam =
    | 'wind'
    | 'dir'
    | 'gust'
    | 'wave'
    | 'period'
    | 'uv'
    | 'vis'
    | 'pressure'
    | 'humidity'
    | 'rain'
    | 'temp';

interface ParamSpec {
    id: MatrixParam;
    short: string;
    unit: string;
    block: 'atmos' | 'marine';
    variable: AtmosVar | MarineVar;
    /** Convert a raw API value to display units. */
    convert?: (v: number) => number;
    /** Fallback Y range when data is sparse. */
    padMin: number;
    padMax: number;
    tickStep: number;
    decimals: number;
    /** Spread thresholds: below hi → high confidence, below mod → moderate. */
    hi: number;
    mod: number;
    /** Degrees — plot unwrapped, spread measured circularly. */
    circular?: boolean;
}

const PARAMS: ParamSpec[] = [
    {
        id: 'wind',
        short: 'WIND',
        unit: 'kts',
        block: 'atmos',
        variable: 'wind_speed_10m',
        padMin: 0,
        padMax: 30,
        tickStep: 10,
        decimals: 0,
        hi: 4,
        mod: 8,
    },
    {
        id: 'dir',
        short: 'DIR',
        unit: '°',
        block: 'atmos',
        variable: 'wind_direction_10m',
        padMin: 0,
        padMax: 360,
        tickStep: 45,
        decimals: 0,
        hi: 20,
        mod: 45,
        circular: true,
    },
    {
        id: 'gust',
        short: 'GUST',
        unit: 'kts',
        block: 'atmos',
        variable: 'wind_gusts_10m',
        padMin: 0,
        padMax: 40,
        tickStep: 10,
        decimals: 0,
        hi: 5,
        mod: 10,
    },
    {
        id: 'wave',
        short: 'WAVE',
        unit: 'm',
        block: 'marine',
        variable: 'wave_height',
        padMin: 0,
        padMax: 3,
        tickStep: 1,
        decimals: 1,
        hi: 0.3,
        mod: 0.8,
    },
    {
        id: 'period',
        short: 'PER.',
        unit: 's',
        block: 'marine',
        variable: 'wave_period',
        padMin: 0,
        padMax: 12,
        tickStep: 3,
        decimals: 1,
        hi: 1,
        mod: 2.5,
    },
    {
        id: 'pressure',
        short: 'HPA',
        unit: 'hPa',
        block: 'atmos',
        variable: 'pressure_msl',
        padMin: 1000,
        padMax: 1030,
        tickStep: 10,
        decimals: 0,
        hi: 2,
        mod: 5,
    },
    {
        id: 'temp',
        short: 'TEMP',
        unit: '°C',
        block: 'atmos',
        variable: 'temperature_2m',
        padMin: 10,
        padMax: 30,
        tickStep: 5,
        decimals: 1,
        hi: 1.5,
        mod: 3,
    },
    {
        id: 'humidity',
        short: 'HUM',
        unit: '%',
        block: 'atmos',
        variable: 'relative_humidity_2m',
        padMin: 0,
        padMax: 100,
        tickStep: 25,
        decimals: 0,
        hi: 8,
        mod: 15,
    },
    {
        id: 'rain',
        short: 'RAIN',
        unit: 'mm',
        block: 'atmos',
        variable: 'precipitation',
        padMin: 0,
        padMax: 2,
        tickStep: 1,
        decimals: 1,
        hi: 0.5,
        mod: 2,
    },
    {
        id: 'vis',
        short: 'VIS',
        unit: 'km',
        block: 'atmos',
        variable: 'visibility',
        convert: (v) => v / 1000,
        padMin: 0,
        padMax: 20,
        tickStep: 5,
        decimals: 0,
        hi: 2,
        mod: 5,
    },
    {
        id: 'uv',
        short: 'UV',
        unit: '',
        block: 'atmos',
        variable: 'uv_index',
        padMin: 0,
        padMax: 12,
        tickStep: 3,
        decimals: 1,
        hi: 1,
        mod: 2,
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

// ── Series shape after sampling ──

interface ModelSeries {
    id: string;
    label: string;
    provider: string;
    hex: string;
    /** One value per TIME_COL; null where the model has no data. */
    values: (number | null)[];
    /** For circular params: values unwrapped for plotting continuity. */
    plotValues: (number | null)[];
}

interface Props {
    visible: boolean;
    onClose: () => void;
    /** The pinned Glass forecast model — gets the emphasised line. */
    selectedModel: WeatherModel;
    /** Open on this tab (a long-pressed grid metric id). */
    initialParam?: MatrixParam;
    /** The Glass report's own coordinates. Preferred over LocationStore,
     *  whose Brisbane default is never synced on a cold boot with no cached
     *  report — charting the wrong point while the grid shows the right one. */
    coordinates?: { lat: number; lon: number };
}

// ── Sampling helpers (exported for tests) ──

/** Nearest-sample lookup by epoch ms. Returns null when the closest sample
 *  is more than 90 minutes away (off the end of a short series). */
export function sampleAt(times: number[], values: (number | null)[], targetMs: number): number | null {
    if (!times.length) return null;
    let best = 0;
    let bestDiff = Math.abs(times[0] - targetMs);
    for (let i = 1; i < times.length; i++) {
        const d = Math.abs(times[i] - targetMs);
        if (d < bestDiff) {
            best = i;
            bestDiff = d;
        }
    }
    if (bestDiff > 90 * 60 * 1000) return null;
    return values[best] ?? null;
}

/** Unwrap a degree series so lines don't jump 350°→10° across the chart.
 *  Each value is shifted by ±360 to sit within 180° of its predecessor.
 *  `anchor` (when given) seeds the first value's reference so SEPARATE
 *  series stay comparable — without it, models at 350° and 10° would plot
 *  340 apart despite being 20° apart circularly. */
export function unwrapDegrees(values: (number | null)[], anchor?: number | null): (number | null)[] {
    const out: (number | null)[] = [];
    let prev: number | null = anchor ?? null;
    for (const v of values) {
        if (v == null) {
            out.push(null);
            continue;
        }
        let adj = v;
        if (prev != null) {
            while (adj - prev > 180) adj -= 360;
            while (adj - prev < -180) adj += 360;
        }
        out.push(adj);
        prev = adj;
    }
    return out;
}

/** Max pairwise circular difference in degrees. */
export function circularSpread(vals: number[]): number {
    let max = 0;
    for (let i = 0; i < vals.length; i++) {
        for (let j = i + 1; j < vals.length; j++) {
            let d = Math.abs(vals[i] - vals[j]) % 360;
            if (d > 180) d = 360 - d;
            if (d > max) max = d;
        }
    }
    return max;
}

function buildSeries(spread: ModelSpreadResult | null, spec: ParamSpec, nowMs: number): ModelSeries[] {
    const block = spec.block === 'atmos' ? spread?.atmos : spread?.marine;
    if (!block) return [];
    const conv = spec.convert ?? ((v: number) => v);

    const series: ModelSeries[] = [];
    // Circular params share one unwrap anchor across models, so all series
    // plot in the same 360°-window and circular closeness reads as closeness.
    let circularAnchor: number | null = null;
    for (const m of block.models) {
        const raw = (m.values as Record<string, (number | null)[]>)[spec.variable];
        if (!raw) continue;
        const values = TIME_COLS.map((col) => {
            const v = sampleAt(block.times, raw, nowMs + col.offsetHours * 3600_000);
            return v == null ? null : conv(v);
        });
        if (values.every((v) => v == null)) continue;
        if (spec.circular && circularAnchor == null) {
            circularAnchor = values.find((v) => v != null) ?? null;
        }
        series.push({
            id: m.id,
            label: m.label,
            provider: m.provider,
            hex: m.hex,
            values,
            plotValues: spec.circular ? unwrapDegrees(values, circularAnchor) : values,
        });
    }
    return series;
}

// ── Chart geometry ──

const CHART_W = 320;
const CHART_H = 140;
const CHART_PAD_L = 32;
const CHART_PAD_R = 12;
const CHART_PAD_T = 12;
const CHART_PAD_B = 20;
const PLOT_W = CHART_W - CHART_PAD_L - CHART_PAD_R;
const PLOT_H = CHART_H - CHART_PAD_T - CHART_PAD_B;

/** SVG path through the non-null points, breaking the line across gaps. */
function makeLinePath(values: (number | null)[], minY: number, maxY: number): string {
    const span = maxY - minY || 1;
    const parts: string[] = [];
    let pen = false;
    values.forEach((v, i) => {
        if (v == null) {
            pen = false;
            return;
        }
        const x = CHART_PAD_L + (i / (values.length - 1)) * PLOT_W;
        const y = CHART_PAD_T + PLOT_H - ((v - minY) / span) * PLOT_H;
        parts.push(`${pen ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
        pen = true;
    });
    return parts.join(' ');
}

// ── Confidence ──

interface ColumnConfidence {
    variance: number | null;
    level: 'high' | 'moderate' | 'low' | 'none';
}

function calcConfidence(series: ModelSeries[], spec: ParamSpec): ColumnConfidence[] {
    return TIME_COLS.map((_, colIdx) => {
        const vals = series.map((s) => s.values[colIdx]).filter((v): v is number => v != null);
        if (vals.length < 2) return { variance: null, level: 'none' };
        const variance = spec.circular ? circularSpread(vals) : Math.max(...vals) - Math.min(...vals);
        const level = variance < spec.hi ? 'high' : variance < spec.mod ? 'moderate' : 'low';
        return { variance, level };
    });
}

// ── Component ──

export const ModelComparisonMatrix: React.FC<Props> = React.memo(
    ({ visible, onClose, selectedModel, initialParam, coordinates }) => {
        const storeCoords = useLocationCoords();
        const lat = coordinates?.lat ?? storeCoords.lat;
        const lon = coordinates?.lon ?? storeCoords.lon;
        const [spread, setSpread] = useState<ModelSpreadResult | null>(null);
        const [isLoading, setIsLoading] = useState(false);
        const [failed, setFailed] = useState(false);
        const [param, setParam] = useState<MatrixParam>('wind');
        // Sampling anchor — fixed per open so tab switches don't reflow columns.
        const [nowMs, setNowMs] = useState(() => Date.now());

        // Land on the long-pressed metric's tab each time the sheet opens.
        useEffect(() => {
            if (visible) {
                setParam(initialParam ?? 'wind');
                setNowMs(Date.now());
            }
        }, [visible, initialParam]);

        useEffect(() => {
            if (!visible) return;
            if (lat == null || lon == null) return;

            let cancelled = false;
            setIsLoading(true);
            setFailed(false);

            // 78h, not 72: forecast_hours=72 ends at t0+71h (t0 = start of the
            // current hour), which drifts outside sampleAt's 90-min tolerance
            // for the +72h column once the clock passes half-past — worse on
            // memo-served reopens. Six hours of headroom keeps it honest.
            queryModelSpread(lat, lon, 78)
                .then((result) => {
                    if (cancelled) return;
                    setSpread(result);
                    if (!result.atmos && !result.marine) setFailed(true);
                })
                .catch(() => {
                    if (!cancelled) setFailed(true);
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });

            return () => {
                cancelled = true;
            };
        }, [visible, lat, lon]);

        const spec = useMemo(() => PARAMS.find((p) => p.id === param)!, [param]);
        const series = useMemo(() => buildSeries(spread, spec, nowMs), [spread, spec, nowMs]);
        const confidence = useMemo(() => calcConfidence(series, spec), [series, spec]);

        // Y-axis range across all models' PLOT values (unwrapped for dir).
        const { minY, maxY, ticks } = useMemo(() => {
            const flat = series.flatMap((s) => s.plotValues).filter((v): v is number => v != null);
            const rawMin = flat.length ? Math.min(...flat) : spec.padMin;
            const rawMax = flat.length ? Math.max(...flat) : spec.padMax;
            // Pad degenerate ranges so a flat consensus doesn't collapse the chart
            const spanMin = spec.circular ? 45 : spec.tickStep;
            const mid = (rawMin + rawMax) / 2;
            const lo = Math.min(rawMin, mid - spanMin / 2);
            const hiV = Math.max(rawMax, mid + spanMin / 2);
            const min = Math.floor(lo / spec.tickStep) * spec.tickStep;
            const max = Math.ceil(hiV / spec.tickStep) * spec.tickStep;
            const tickCount = Math.min(5, Math.max(2, Math.round((max - min) / spec.tickStep) + 1));
            const step = (max - min) / (tickCount - 1);
            const tickArr = Array.from({ length: tickCount }, (_, i) => min + i * step);
            return { minY: min, maxY: max, ticks: tickArr };
        }, [series, spec]);

        if (!visible) return null;

        const isSelected = (s: ModelSeries) => s.id === selectedModel;
        const hasData = series.length > 0;

        // Overall convergence for the summary strip (columns with data only)
        const withData = confidence.filter((c) => c.variance != null);
        const avgVariance = withData.length ? withData.reduce((a, c) => a + (c.variance ?? 0), 0) / withData.length : 0;
        const overallLevel: 'high' | 'moderate' | 'low' = withData.every((c) => c.level === 'high')
            ? 'high'
            : withData.some((c) => c.level === 'low')
              ? 'low'
              : 'moderate';
        const overallColor =
            overallLevel === 'high'
                ? 'text-emerald-400'
                : overallLevel === 'moderate'
                  ? 'text-amber-400'
                  : 'text-red-400';
        const overallLabel =
            overallLevel === 'high'
                ? 'Strong agreement'
                : overallLevel === 'moderate'
                  ? 'Some divergence'
                  : 'Models disagree';

        /** Tick label — degrees fold back into 0-360. */
        const tickLabel = (t: number) =>
            spec.circular ? `${((Math.round(t) % 360) + 360) % 360}` : t.toFixed(spec.decimals);

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
                                {spread?.fromWxServer && !isLoading && (
                                    <span
                                        className="text-[10px] font-bold text-emerald-400 bg-emerald-500/20 px-1.5 py-0.5 rounded"
                                        title="Served by the boat's own weather server"
                                    >
                                        WX
                                    </span>
                                )}
                            </h2>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                                72-hour outlook ·{' '}
                                {spec.block === 'marine' ? 'wave models side-by-side' : 'global models side-by-side'}
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

                    {/* Parameter tabs — one per grid metric, horizontally scrollable */}
                    <div className="px-5 pb-3">
                        <div className="flex items-center gap-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-1 overflow-x-auto no-scrollbar">
                            {PARAMS.map((p) => {
                                const active = p.id === param;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => setParam(p.id)}
                                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${
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

                    {/* Chart / empty states */}
                    <div className="px-5 pb-3">
                        {hasData ? (
                            <svg
                                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                                className="w-full h-auto overflow-visible"
                                role="img"
                            >
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
                                                {tickLabel(t)}
                                            </text>
                                        </g>
                                    );
                                })}

                                {/* Model lines */}
                                {series.map((s) => (
                                    <path
                                        key={`line-${s.id}`}
                                        d={makeLinePath(s.plotValues, minY, maxY)}
                                        stroke={s.hex}
                                        strokeWidth={isSelected(s) ? 2.5 : 1.5}
                                        strokeOpacity={isSelected(s) ? 1 : 0.65}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        fill="none"
                                        style={isSelected(s) ? { filter: `drop-shadow(0 0 4px ${s.hex})` } : undefined}
                                    />
                                ))}

                                {/* Point markers on the selected model */}
                                {series.filter(isSelected).flatMap((s) =>
                                    s.plotValues.map((v, i) => {
                                        if (v == null) return null;
                                        const x = CHART_PAD_L + (i / (s.plotValues.length - 1)) * PLOT_W;
                                        const y = CHART_PAD_T + PLOT_H - ((v - minY) / (maxY - minY || 1)) * PLOT_H;
                                        return (
                                            <circle
                                                key={`m-${s.id}-${i}`}
                                                cx={x}
                                                cy={y}
                                                r={2.5}
                                                fill={s.hex}
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
                        ) : (
                            <div className="h-[120px] flex items-center justify-center text-center px-6">
                                <p className="text-[11px] text-gray-500 leading-relaxed">
                                    {isLoading
                                        ? 'Fetching model data…'
                                        : failed
                                          ? 'Model data unavailable — offline or the forecast servers are unreachable.'
                                          : `No model publishes ${spec.short} here.`}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Legend + current values */}
                    {hasData && (
                        <div className="px-5 pb-3">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                                {series.map((s) => {
                                    const current = s.values[0];
                                    return (
                                        <div
                                            key={s.id}
                                            className={`flex items-center gap-2 py-1 px-2 rounded-lg ${
                                                isSelected(s) ? 'bg-white/[0.05]' : ''
                                            }`}
                                        >
                                            <span
                                                className="w-3 h-0.5 rounded-full shrink-0"
                                                style={{ backgroundColor: s.hex }}
                                            />
                                            <span
                                                className={`text-[11px] font-bold ${
                                                    isSelected(s) ? 'text-white' : 'text-gray-400'
                                                }`}
                                            >
                                                {s.label}
                                            </span>
                                            <span className="ml-auto text-[11px] font-mono text-gray-300 tabular-nums">
                                                {current == null ? '—' : current.toFixed(spec.decimals)}
                                                <span className="text-gray-500 ml-0.5">{spec.unit}</span>
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Convergence summary */}
                    {hasData && (
                        <div className="mx-5 mb-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.05] flex items-center gap-3">
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
                                    Avg spread · {avgVariance.toFixed(spec.decimals)} {spec.unit || 'idx'}
                                </div>
                            </div>
                            <div className="flex items-center gap-1 text-[9px] font-mono text-gray-500">
                                {confidence.map((c, i) => (
                                    <span
                                        key={i}
                                        className={`w-1.5 h-4 rounded-sm ${
                                            c.level === 'none'
                                                ? 'bg-white/10'
                                                : c.level === 'high'
                                                  ? 'bg-emerald-400/60'
                                                  : c.level === 'moderate'
                                                    ? 'bg-amber-400/60'
                                                    : 'bg-red-400/60'
                                        }`}
                                        title={
                                            c.variance == null
                                                ? `${TIME_COLS[i].label}: no data`
                                                : `${TIME_COLS[i].label}: ±${c.variance.toFixed(spec.decimals)}`
                                        }
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Attribution — CC-BY-4.0 licence condition, not a courtesy */}
                    <div className="px-5 pb-4">
                        <p className="text-[9px] text-gray-600 text-center">{MODEL_ATTRIBUTION_LINE}</p>
                    </div>
                </div>
            </div>,
            document.body,
        );
    },
);

ModelComparisonMatrix.displayName = 'ModelComparisonMatrix';
