/**
 * ModelComparisonMatrix — Drill-down heatmap comparing offshore NWP models.
 *
 * Opens when the user taps the WIND cell in the top row while offshore.
 * Shows wind speed forecasts across 4 models × 6 time slots, with
 * convergence/divergence confidence indicators per column.
 *
 * Uses the app's existing Beaufort-inspired wind color scale.
 */
import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { OffshoreModel } from '../../types';

// ── Wind Color Scale (same breakpoints as useWindHeatMap) ──

const WIND_COLORS: [number, [number, number, number]][] = [
    [0, [40, 80, 160]],
    [5, [30, 140, 200]],
    [10, [50, 190, 160]],
    [15, [80, 200, 80]],
    [20, [180, 200, 40]],
    [25, [240, 200, 0]],
    [30, [240, 140, 0]],
    [35, [220, 60, 20]],
    [40, [180, 20, 40]],
    [50, [140, 0, 80]],
    [65, [100, 0, 120]],
];

function windColor(kts: number): string {
    if (kts <= WIND_COLORS[0][0]) {
        const [r, g, b] = WIND_COLORS[0][1];
        return `rgb(${r},${g},${b})`;
    }
    if (kts >= WIND_COLORS[WIND_COLORS.length - 1][0]) {
        const [r, g, b] = WIND_COLORS[WIND_COLORS.length - 1][1];
        return `rgb(${r},${g},${b})`;
    }
    for (let i = 0; i < WIND_COLORS.length - 1; i++) {
        const [s0, c0] = WIND_COLORS[i];
        const [s1, c1] = WIND_COLORS[i + 1];
        if (kts >= s0 && kts <= s1) {
            const t = (kts - s0) / (s1 - s0);
            const r = Math.round(c0[0] + t * (c1[0] - c0[0]));
            const g = Math.round(c0[1] + t * (c1[1] - c0[1]));
            const b = Math.round(c0[2] + t * (c1[2] - c0[2]));
            return `rgb(${r},${g},${b})`;
        }
    }
    return 'rgb(40,80,160)';
}

/** Cell text should be white on dark backgrounds, black on bright ones */
function textColor(kts: number): string {
    return kts >= 18 && kts <= 28 ? 'text-black/80' : 'text-white';
}

// ── Types ──

interface ModelRow {
    code: OffshoreModel;
    label: string;
    values: number[]; // One per time column (knots)
}

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

// ── Mock Data ──
// Strong convergence 0-24h, moderate at 36h, severe divergence at 48-72h

const MOCK_MODELS: ModelRow[] = [
    { code: 'sg', label: 'Stormglass AI', values: [14, 16, 18, 20, 24, 28] },
    { code: 'ecmwf', label: 'ECMWF', values: [13, 15, 17, 22, 30, 35] },
    { code: 'gfs', label: 'GFS / NOAA', values: [14, 17, 19, 18, 19, 22] },
    { code: 'icon', label: 'ICON', values: [13, 15, 18, 21, 27, 32] },
];

// ── Convergence Engine ──

interface ColumnConfidence {
    variance: number; // max - min across models
    level: 'high' | 'moderate' | 'low';
}

function calcConfidence(models: ModelRow[]): ColumnConfidence[] {
    return TIME_COLS.map((_, colIdx) => {
        const vals = models.map((m) => m.values[colIdx]);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const variance = max - min;
        const level = variance <= 4 ? 'high' : variance <= 7 ? 'moderate' : 'low';
        return { variance, level };
    });
}

// ── Component ──

interface Props {
    visible: boolean;
    onClose: () => void;
    selectedModel: OffshoreModel;
}

export const ModelComparisonMatrix: React.FC<Props> = React.memo(({ visible, onClose, selectedModel }) => {
    const confidence = useMemo(() => calcConfidence(MOCK_MODELS), []);

    if (!visible) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Model comparison heatmap"
            style={{
                paddingTop: 'calc(env(safe-area-inset-top, 0px) + 48px)',
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)',
            }}
        >
            <div
                className="w-full max-w-lg mx-4 bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Accent glow bar */}
                <div className="h-[2px] bg-gradient-to-r from-transparent via-sky-500/60 to-transparent" />

                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <div>
                        <h2 className="text-sm font-black text-white uppercase tracking-wider">Model Convergence</h2>
                        <p className="text-[11px] text-gray-500 mt-0.5">Wind speed (kts) — tap outside to close</p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close matrix"
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

                {/* Matrix */}
                <div className="px-4 pb-2 overflow-x-auto">
                    <table className="w-full border-collapse">
                        {/* Time header row */}
                        <thead>
                            <tr>
                                <th className="text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider pb-2 pr-2 w-[90px]">
                                    Model
                                </th>
                                {TIME_COLS.map((col) => (
                                    <th
                                        key={col.label}
                                        className="text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider pb-2 px-1"
                                    >
                                        {col.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>

                        <tbody>
                            {MOCK_MODELS.map((model) => {
                                const isSelected = model.code === selectedModel;
                                return (
                                    <tr key={model.code}>
                                        {/* Model label */}
                                        <td
                                            className={`text-[11px] font-bold pr-2 py-1 whitespace-nowrap ${
                                                isSelected ? 'text-sky-400' : 'text-gray-400'
                                            }`}
                                        >
                                            <div className="flex items-center gap-1.5">
                                                {isSelected && (
                                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                                                )}
                                                {model.label}
                                            </div>
                                        </td>

                                        {/* Value cells */}
                                        {model.values.map((kts, colIdx) => {
                                            const bg = windColor(kts);
                                            return (
                                                <td key={colIdx} className="px-0.5 py-1">
                                                    <div
                                                        className={`rounded-lg text-center py-2 text-sm font-mono font-bold transition-all ${textColor(kts)} ${
                                                            isSelected
                                                                ? 'ring-1 ring-sky-400/40 shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                                                                : ''
                                                        }`}
                                                        style={{ backgroundColor: bg }}
                                                    >
                                                        {Math.round(kts)}
                                                    </div>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Confidence row */}
                <div className="px-4 pb-4 pt-1">
                    <div className="flex items-center">
                        {/* Spacer for model label column */}
                        <div className="w-[90px] shrink-0 text-[10px] font-bold text-gray-500 uppercase tracking-wider pr-2">
                            Confidence
                        </div>
                        <div
                            className="flex-1 grid"
                            style={{ gridTemplateColumns: `repeat(${TIME_COLS.length}, 1fr)` }}
                        >
                            {confidence.map((col, i) => (
                                <div key={i} className="flex flex-col items-center gap-1 px-0.5">
                                    {/* Icon */}
                                    {col.level === 'high' ? (
                                        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                                            <svg
                                                className="w-3 h-3 text-emerald-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={3}
                                            >
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                            </svg>
                                        </div>
                                    ) : col.level === 'moderate' ? (
                                        <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center">
                                            <svg
                                                className="w-3 h-3 text-amber-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={3}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M12 9v2m0 4h.01"
                                                />
                                            </svg>
                                        </div>
                                    ) : (
                                        <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center">
                                            <svg
                                                className="w-3 h-3 text-red-400"
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
                                        </div>
                                    )}
                                    {/* Variance label */}
                                    <span
                                        className={`text-[9px] font-bold uppercase tracking-wider ${
                                            col.level === 'high'
                                                ? 'text-emerald-400'
                                                : col.level === 'moderate'
                                                  ? 'text-amber-400'
                                                  : 'text-red-400'
                                        }`}
                                    >
                                        ±{col.variance}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Legend */}
                    <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-white/5">
                        <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-emerald-400" />
                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                High (&lt;4 kts)
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-amber-400" />
                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                Moderate (4-7)
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-red-400" />
                            <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                Low (&gt;7 kts)
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
});

ModelComparisonMatrix.displayName = 'ModelComparisonMatrix';
