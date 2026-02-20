/**
 * PolarChart — SVG radar/spider chart for polar performance visualization.
 * Renders concentric speed rings, angular grid lines, and colored curves per TWS.
 * Mirrored on port side for traditional symmetric polar plot.
 */
import React, { useMemo } from 'react';
import type { PolarData } from '../../types';

interface PolarChartProps {
    data: PolarData;
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

export const PolarChart: React.FC<PolarChartProps> = ({ data, width = 400, height = 440 }) => {
    const cx = width / 2;
    const cy = width / 2 + 10; // Slight offset for label space
    const radius = width / 2 - 40;

    const maxBoatSpeed = useMemo(() => {
        let max = 0;
        for (const row of data.matrix) {
            for (const v of row) {
                if (v > max) max = v;
            }
        }
        return Math.max(max, 1);
    }, [data]);

    // Determine ring intervals (2kts steps, or 5 if max > 15)
    const ringStep = maxBoatSpeed > 15 ? 5 : 2;
    const ringCount = Math.ceil(maxBoatSpeed / ringStep);
    const scaledRadius = radius; // Full radius = max ring

    const speedToRadius = (speed: number) => (speed / (ringCount * ringStep)) * scaledRadius;

    // Convert polar coordinates (angle in degrees from north, radius) to SVG x,y
    // In sailing polars, 0° is the bow (upwind), angles increase clockwise
    const polarToXY = (angleDeg: number, r: number): [number, number] => {
        const rad = ((angleDeg - 90) * Math.PI) / 180; // -90 to orient 0° up
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };

    // Build path for each wind speed curve
    const curves = useMemo(() => {
        return data.windSpeeds.map((tws, wIdx) => {
            const points: [number, number][] = [];
            const mirrorPoints: [number, number][] = [];
            const anomalies: { x: number; y: number; speed: number; angle: number }[] = [];

            for (let aIdx = 0; aIdx < data.angles.length; aIdx++) {
                const speed = data.matrix[aIdx]?.[wIdx] ?? 0;
                if (speed <= 0) continue;

                const r = speedToRadius(speed);
                const [x, y] = polarToXY(data.angles[aIdx], r);
                points.push([x, y]);

                // Mirror on port side (negative angle)
                const [mx, my] = polarToXY(-data.angles[aIdx], r);
                mirrorPoints.push([mx, my]);

                // Check for anomalies (>50% deviation from neighbors)
                const neighbors: number[] = [];
                if (aIdx > 0) neighbors.push(data.matrix[aIdx - 1]?.[wIdx] ?? 0);
                if (aIdx < data.angles.length - 1) neighbors.push(data.matrix[aIdx + 1]?.[wIdx] ?? 0);
                if (neighbors.length > 0) {
                    const avgNeighbor = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
                    if (avgNeighbor > 0 && Math.abs(speed - avgNeighbor) / avgNeighbor > 0.5) {
                        anomalies.push({ x, y, speed, angle: data.angles[aIdx] });
                    }
                }
            }

            // Create smooth path
            const pathStarboard = points.length > 0
                ? `M ${points[0][0]},${points[0][1]} ` + points.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ')
                : '';
            const pathPort = mirrorPoints.length > 0
                ? `M ${mirrorPoints[0][0]},${mirrorPoints[0][1]} ` + mirrorPoints.slice(1).map(p => `L ${p[0]},${p[1]}`).join(' ')
                : '';

            return { tws, wIdx, pathStarboard, pathPort, anomalies, color: WIND_COLORS[wIdx % WIND_COLORS.length] };
        });
    }, [data, cx, cy, scaledRadius]);

    const hasData = data.matrix.some(row => row.some(v => v > 0));

    return (
        <div className="relative">
            <svg
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="mx-auto"
            >
                {/* Background */}
                <rect x="0" y="0" width={width} height={height} fill="transparent" />

                {/* Concentric speed rings */}
                {Array.from({ length: ringCount }, (_, i) => {
                    const r = speedToRadius((i + 1) * ringStep);
                    return (
                        <g key={`ring-${i}`}>
                            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                            <text
                                x={cx + 4}
                                y={cy - r - 2}
                                fill="rgba(255,255,255,0.3)"
                                fontSize="9"
                                fontFamily="monospace"
                                fontWeight="bold"
                            >
                                {(i + 1) * ringStep}kts
                            </text>
                        </g>
                    );
                })}

                {/* Angular grid lines */}
                {data.angles.map(angle => {
                    const [x, y] = polarToXY(angle, radius + 15);
                    const [mx, my] = polarToXY(-angle, radius + 15);
                    const [lx, ly] = polarToXY(angle, scaledRadius);
                    const [mlx, mly] = polarToXY(-angle, scaledRadius);
                    return (
                        <g key={`grid-${angle}`}>
                            {/* Starboard grid line */}
                            <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                            {/* Port grid line (mirror) */}
                            <line x1={cx} y1={cy} x2={mlx} y2={mly} stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
                            {/* Angle labels */}
                            <text x={x} y={y} fill="rgba(255,255,255,0.25)" fontSize="8" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                                {angle}°
                            </text>
                            <text x={mx} y={my} fill="rgba(255,255,255,0.25)" fontSize="8" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                                {angle}°
                            </text>
                        </g>
                    );
                })}

                {/* Center dot */}
                <circle cx={cx} cy={cy} r="3" fill="rgba(255,255,255,0.3)" />

                {/* "WIND" label at top */}
                <text x={cx} y={12} fill="rgba(255,255,255,0.3)" fontSize="9" fontWeight="bold" textAnchor="middle" letterSpacing="2">
                    ▼ WIND
                </text>

                {/* Polar curves */}
                {hasData && curves.map(curve => (
                    <g key={`curve-${curve.wIdx}`}>
                        {/* Starboard (right) side */}
                        <path
                            d={curve.pathStarboard}
                            fill="none"
                            stroke={curve.color}
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.85"
                        />
                        {/* Port (left) side — mirror */}
                        <path
                            d={curve.pathPort}
                            fill="none"
                            stroke={curve.color}
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.85"
                        />
                        {/* Anomaly markers */}
                        {curve.anomalies.map((a, i) => (
                            <g key={`anomaly-${curve.wIdx}-${i}`}>
                                <circle cx={a.x} cy={a.y} r="5" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.8" />
                                <circle cx={a.x} cy={a.y} r="2" fill="#ef4444" opacity="0.8" />
                            </g>
                        ))}
                    </g>
                ))}

                {/* Empty state */}
                {!hasData && (
                    <text x={cx} y={cy} fill="rgba(255,255,255,0.2)" fontSize="12" textAnchor="middle" dominantBaseline="middle">
                        Enter polar data to see chart
                    </text>
                )}
            </svg>

            {/* Legend */}
            {hasData && (
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-1 px-2">
                    {data.windSpeeds.map((tws, i) => (
                        <div key={tws} className="flex items-center gap-1.5">
                            <div className="w-3 h-0.5 rounded-full" style={{ backgroundColor: WIND_COLORS[i % WIND_COLORS.length] }} />
                            <span className="text-[9px] font-mono font-bold text-gray-400">{tws}kts</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
