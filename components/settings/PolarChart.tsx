/**
 * PolarChart — SVG radar/spider chart for polar performance visualization.
 * Renders concentric speed rings, angular grid lines, and colored curves per TWS.
 * Mirrored on port side for traditional symmetric polar plot.
 * Supports optional overlay (Smart Polars) as dashed green curves.
 */
import React, { useMemo } from 'react';
import type { PolarData } from '../../types';

interface PolarChartProps {
    data: PolarData;
    overlayData?: PolarData | null; // Smart Polars overlay (green dashed)
    width?: number;
    height?: number;
}

// Color palette for wind speed curves (cool→warm gradient)
const WIND_COLORS = [
    '#7dd3fc', // 6kts - light sky
    '#38bdf8', // 8kts - sky
    '#0ea5e9', // 10kts - blue
    '#2563eb', // 12kts - indigo
    '#7c3aed', // 15kts - violet
    '#db2777', // 20kts - pink
    '#dc2626', // 25kts - red
];

// Green palette for overlay (Smart Polars)
const OVERLAY_COLORS = [
    '#86efac', // light green
    '#4ade80',
    '#22c55e',
    '#16a34a',
    '#15803d',
    '#166534',
    '#14532d',
];

interface CurveData {
    tws: number;
    wIdx: number;
    pathStarboard: string;
    pathPort: string;
    anomalies: { x: number; y: number; speed: number; angle: number }[];
    color: string;
}

export const PolarChart: React.FC<PolarChartProps> = ({ data, overlayData, width = 400, height = 440 }) => {
    const cx = width / 2;
    const cy = width / 2 + 10;
    const radius = width / 2 - 40;

    // Compute max speed across both datasets for scale
    const maxBoatSpeed = useMemo(() => {
        let max = 0;
        for (const row of data.matrix) {
            for (const v of row) { if (v > max) max = v; }
        }
        if (overlayData) {
            for (const row of overlayData.matrix) {
                for (const v of row) { if (v > max) max = v; }
            }
        }
        return Math.max(max, 1);
    }, [data, overlayData]);

    const ringStep = maxBoatSpeed > 15 ? 5 : 2;
    const ringCount = Math.ceil(maxBoatSpeed / ringStep);
    const scaledRadius = radius;

    const speedToRadius = (speed: number) => (speed / (ringCount * ringStep)) * scaledRadius;

    const polarToXY = (angleDeg: number, r: number): [number, number] => {
        const rad = ((angleDeg - 90) * Math.PI) / 180;
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };

    // Build curves for a dataset
    const buildCurves = (dataset: PolarData, colors: string[]): CurveData[] => {
        return dataset.windSpeeds.map((tws, wIdx) => {
            const points: [number, number][] = [];
            const mirrorPoints: [number, number][] = [];
            const anomalies: { x: number; y: number; speed: number; angle: number }[] = [];

            for (let aIdx = 0; aIdx < dataset.angles.length; aIdx++) {
                const speed = dataset.matrix[aIdx]?.[wIdx] ?? 0;
                if (speed <= 0) continue;

                const r = speedToRadius(speed);
                const [x, y] = polarToXY(dataset.angles[aIdx], r);
                points.push([x, y]);

                const [mx, my] = polarToXY(-dataset.angles[aIdx], r);
                mirrorPoints.push([mx, my]);

                // Anomaly check
                const neighbors: number[] = [];
                if (aIdx > 0) neighbors.push(dataset.matrix[aIdx - 1]?.[wIdx] ?? 0);
                if (aIdx < dataset.angles.length - 1) neighbors.push(dataset.matrix[aIdx + 1]?.[wIdx] ?? 0);
                if (neighbors.length > 0) {
                    const avgN = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
                    if (avgN > 0 && Math.abs(speed - avgN) / avgN > 0.5) {
                        anomalies.push({ x, y, speed, angle: dataset.angles[aIdx] });
                    }
                }
            }

            const pathStarboard = points.length > 0
                ? `M ${points[0][0]},${points[0][1]} ` + points.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ')
                : '';
            const pathPort = mirrorPoints.length > 0
                ? `M ${mirrorPoints[0][0]},${mirrorPoints[0][1]} ` + mirrorPoints.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ')
                : '';

            return { tws, wIdx, pathStarboard, pathPort, anomalies, color: colors[wIdx % colors.length] };
        });
    };

    const factoryCurves = useMemo(() => buildCurves(data, WIND_COLORS), [data, cx, cy, scaledRadius]);
    const overlayCurves = useMemo(
        () => overlayData ? buildCurves(overlayData, OVERLAY_COLORS) : [],
        [overlayData, cx, cy, scaledRadius]
    );

    const hasData = data.matrix.some(row => row.some(v => v > 0));
    const hasOverlay = overlayData?.matrix.some(row => row.some(v => v > 0)) ?? false;

    // Use data.angles for grid lines (both datasets share same standard angles)
    const gridAngles = data.angles;

    return (
        <div className="relative">
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="mx-auto">
                <rect x="0" y="0" width={width} height={height} fill="transparent" />

                {/* Concentric speed rings */}
                {Array.from({ length: ringCount }, (_, i) => {
                    const r = speedToRadius((i + 1) * ringStep);
                    return (
                        <g key={`ring-${i}`}>
                            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                            <text x={cx + 4} y={cy - r - 2} fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily="monospace" fontWeight="bold">
                                {(i + 1) * ringStep}kts
                            </text>
                        </g>
                    );
                })}

                {/* Angular grid lines */}
                {gridAngles.map(angle => {
                    const [x, y] = polarToXY(angle, radius + 15);
                    const [mx, my] = polarToXY(-angle, radius + 15);
                    const [lx, ly] = polarToXY(angle, scaledRadius);
                    const [mlx, mly] = polarToXY(-angle, scaledRadius);
                    return (
                        <g key={`grid-${angle}`}>
                            <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                            <line x1={cx} y1={cy} x2={mlx} y2={mly} stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                            <text x={x} y={y} fill="rgba(255,255,255,0.25)" fontSize="8" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">{angle}°</text>
                            <text x={mx} y={my} fill="rgba(255,255,255,0.25)" fontSize="8" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">{angle}°</text>
                        </g>
                    );
                })}

                <circle cx={cx} cy={cy} r="3" fill="rgba(255,255,255,0.3)" />

                <text x={cx} y={12} fill="rgba(255,255,255,0.3)" fontSize="9" fontWeight="bold" textAnchor="middle" letterSpacing="2">
                    ▼ WIND
                </text>

                {/* Factory curves (solid) */}
                {hasData && factoryCurves.map(curve => (
                    <g key={`factory-${curve.wIdx}`}>
                        <path d={curve.pathStarboard} fill="none" stroke={curve.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
                        <path d={curve.pathPort} fill="none" stroke={curve.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
                        {curve.anomalies.map((a, i) => (
                            <g key={`anomaly-f-${curve.wIdx}-${i}`}>
                                <circle cx={a.x} cy={a.y} r="5" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.8" />
                                <circle cx={a.x} cy={a.y} r="2" fill="#ef4444" opacity="0.8" />
                            </g>
                        ))}
                    </g>
                ))}

                {/* Smart Polar overlay curves (dashed green) */}
                {hasOverlay && overlayCurves.map(curve => (
                    <g key={`smart-${curve.wIdx}`}>
                        <path d={curve.pathStarboard} fill="none" stroke={curve.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 4" opacity="0.9" />
                        <path d={curve.pathPort} fill="none" stroke={curve.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 4" opacity="0.9" />
                    </g>
                ))}

                {/* Empty state */}
                {!hasData && !hasOverlay && (
                    <text x={cx} y={cy} fill="rgba(255,255,255,0.2)" fontSize="12" textAnchor="middle" dominantBaseline="middle">
                        Enter polar data to see chart
                    </text>
                )}
            </svg>

            {/* Legend */}
            {(hasData || hasOverlay) && (
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-1 px-2">
                    {hasData && data.windSpeeds.map((tws, i) => (
                        <div key={`f-${tws}`} className="flex items-center gap-1.5">
                            <div className="w-3 h-0.5 rounded-full" style={{ backgroundColor: WIND_COLORS[i % WIND_COLORS.length] }} />
                            <span className="text-[9px] font-mono font-bold text-gray-400">{tws}kts</span>
                        </div>
                    ))}
                    {hasOverlay && (
                        <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-white/10">
                            <div className="w-4 h-0.5 rounded-full bg-emerald-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #4ade80 0 4px, transparent 4px 7px)' }} />
                            <span className="text-[9px] font-mono font-bold text-emerald-400">SMART</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
