/**
 * ArcGauge — Semi-circular arc gauge for speed and wind metrics.
 *
 * Used for: TWS, STW, SOG, TWA, Water Temperature
 * Features:
 *   - 240° sweep arc with configurable range
 *   - Gradient fill from min to current value
 *   - Animated needle with glow tip
 *   - Configurable color zones (green/amber/red)
 *   - Tick marks with labels at major intervals
 *   - Digital readout
 */
import React, { useMemo } from 'react';

interface Zone {
    from: number;
    to: number;
    color: string;
}

interface ArcGaugeProps {
    value: number | null;
    min: number;
    max: number;
    unit: string;
    label: string;
    decimals?: number;
    zones?: Zone[];
    accentColor?: string;
    majorTick?: number;    // Major tick interval
    minorTick?: number;    // Minor tick interval
    freshness?: 'live' | 'stale' | 'dead';
}

// Arc geometry constants
const CX = 150, CY = 160;       // Center point (slightly below center for visual weight)
const RADIUS = 120;               // Arc radius
const START_ANGLE = 150;           // Start at bottom-left (degrees)
const END_ANGLE = 390;             // End at bottom-right (150 + 240 = 390)
const SWEEP = END_ANGLE - START_ANGLE; // 240°

function polarToCart(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
    const s = polarToCart(cx, cy, r, startDeg);
    const e = polarToCart(cx, cy, r, endDeg);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

export const ArcGauge: React.FC<ArcGaugeProps> = ({
    value,
    min,
    max,
    unit,
    label,
    decimals = 1,
    zones,
    accentColor = '#22d3ee',
    majorTick,
    minorTick,
    freshness = 'dead'
}) => {
    const range = max - min;
    const clampedValue = value !== null ? Math.max(min, Math.min(max, value)) : null;
    const fraction = clampedValue !== null ? (clampedValue - min) / range : 0;
    const needleAngle = START_ANGLE + fraction * SWEEP;

    const isDead = freshness === 'dead' || value === null;
    const isStale = freshness === 'stale';
    const opacity = isDead ? 0.3 : isStale ? 0.6 : 1;

    // Default zones if not provided
    const defaultZones: Zone[] = zones || [
        { from: min, to: min + range * 0.6, color: '#22c55e' },
        { from: min + range * 0.6, to: min + range * 0.8, color: '#eab308' },
        { from: min + range * 0.8, to: max, color: '#ef4444' },
    ];

    // Default tick intervals
    const majorTickInterval = majorTick || (range <= 20 ? 5 : range <= 60 ? 10 : range <= 200 ? 50 : 500);
    const minorTickInterval = minorTick || (majorTickInterval / 5);

    // Generate ticks
    const ticks = useMemo(() => {
        const items: { val: number; isMajor: boolean }[] = [];
        for (let v = min; v <= max; v += minorTickInterval) {
            // Round to avoid float precision issues
            const rounded = Math.round(v * 100) / 100;
            items.push({ val: rounded, isMajor: rounded % majorTickInterval === 0 });
        }
        return items;
    }, [min, max, majorTickInterval, minorTickInterval]);

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-4">
            <div className="relative" style={{ width: '85vw', maxWidth: '360px', aspectRatio: '1' }}>
                <svg viewBox="0 0 300 300" className="w-full h-full">
                    <defs>
                        {/* Needle glow */}
                        <filter id={`arc-glow-${label}`} x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feFlood floodColor={accentColor} floodOpacity="0.5" />
                            <feComposite in2="blur" operator="in" />
                            <feMerge>
                                <feMergeNode />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                        {/* Value arc gradient */}
                        <linearGradient id={`arc-grad-${label}`} x1="0" y1="0" x2="1" y2="0">
                            {defaultZones.map((z, i) => {
                                const startPct = ((z.from - min) / range) * 100;
                                const endPct = ((z.to - min) / range) * 100;
                                return (
                                    <React.Fragment key={i}>
                                        <stop offset={`${startPct}%`} stopColor={z.color} />
                                        <stop offset={`${endPct}%`} stopColor={z.color} />
                                    </React.Fragment>
                                );
                            })}
                        </linearGradient>
                    </defs>

                    {/* Background track arc */}
                    <path
                        d={describeArc(CX, CY, RADIUS, START_ANGLE, END_ANGLE)}
                        fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="14"
                        strokeLinecap="round" opacity={opacity}
                    />

                    {/* Zone arcs */}
                    {defaultZones.map((zone, i) => {
                        const zStart = START_ANGLE + ((zone.from - min) / range) * SWEEP;
                        const zEnd = START_ANGLE + ((zone.to - min) / range) * SWEEP;
                        return (
                            <path key={i}
                                d={describeArc(CX, CY, RADIUS, zStart, zEnd)}
                                fill="none" stroke={zone.color} strokeWidth="14"
                                strokeLinecap="butt" opacity={opacity * 0.15}
                            />
                        );
                    })}

                    {/* Value fill arc */}
                    {clampedValue !== null && fraction > 0.005 && (
                        <path
                            d={describeArc(CX, CY, RADIUS, START_ANGLE, needleAngle)}
                            fill="none" stroke={accentColor} strokeWidth="14"
                            strokeLinecap="round" opacity={opacity * 0.8}
                            style={{ transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                        />
                    )}

                    {/* Tick marks */}
                    <g opacity={opacity}>
                        {ticks.map(({ val, isMajor }) => {
                            const frac = (val - min) / range;
                            const angle = START_ANGLE + frac * SWEEP;
                            const outerR = RADIUS + 12;
                            const innerR = isMajor ? RADIUS + 4 : RADIUS + 7;
                            const outer = polarToCart(CX, CY, outerR, angle);
                            const inner = polarToCart(CX, CY, innerR, angle);
                            return (
                                <g key={val}>
                                    <line
                                        x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
                                        stroke={isMajor ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)'}
                                        strokeWidth={isMajor ? 2 : 0.8}
                                        strokeLinecap="round"
                                    />
                                    {isMajor && (
                                        <text
                                            x={polarToCart(CX, CY, outerR + 14, angle).x}
                                            y={polarToCart(CX, CY, outerR + 14, angle).y}
                                            textAnchor="middle" dominantBaseline="central"
                                            fill="rgba(148,163,184,0.7)"
                                            fontSize="11" fontWeight="600"
                                            fontFamily="system-ui, -apple-system, sans-serif"
                                        >
                                            {val}
                                        </text>
                                    )}
                                </g>
                            );
                        })}
                    </g>

                    {/* Needle */}
                    {clampedValue !== null && (
                        <g style={{ transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                            transform={`rotate(${needleAngle} ${CX} ${CY})`}
                            opacity={opacity}
                        >
                            {/* Needle body */}
                            <line x1={CX} y1={CY} x2={CX} y2={CY - RADIUS + 8}
                                stroke={accentColor} strokeWidth="2.5" strokeLinecap="round"
                                filter={`url(#arc-glow-${label})`}
                            />
                            {/* Needle tip dot */}
                            <circle cx={CX} cy={CY - RADIUS + 8} r="4"
                                fill={accentColor} opacity={0.9} />
                        </g>
                    )}

                    {/* Center hub */}
                    <circle cx={CX} cy={CY} r="8" fill="rgba(15,23,42,0.9)"
                        stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" opacity={opacity} />
                    <circle cx={CX} cy={CY} r="3" fill={accentColor} opacity={opacity * 0.8} />
                </svg>
            </div>

            {/* Digital readout */}
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-1.5" style={{ opacity }}>
                    <span className="text-6xl font-black text-white tracking-tighter font-mono tabular-nums">
                        {value !== null ? value.toFixed(decimals) : '--.-'}
                    </span>
                    <span className="text-2xl font-bold text-gray-400">{unit}</span>
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.25em] text-gray-500">{label}</span>
            </div>
        </div>
    );
};
