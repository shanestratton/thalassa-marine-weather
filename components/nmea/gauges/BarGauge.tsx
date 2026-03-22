/**
 * BarGauge — Horizontal linear bar gauge for Voltage.
 *
 * Features:
 *   - Horizontal bar with gradient fill
 *   - Tri-color zones (red/amber/green)
 *   - Voltage-specific scale markers
 *   - Current value marker with glow
 *   - Digital readout
 */
import React, { useMemo } from 'react';

interface BarGaugeProps {
    value: number | null;
    min: number;
    max: number;
    unit: string;
    label: string;
    decimals?: number;
    zones?: { from: number; to: number; color: string }[];
    accentColor?: string;
    freshness?: 'live' | 'stale' | 'dead';
}

export const BarGauge: React.FC<BarGaugeProps> = ({
    value,
    min,
    max,
    unit,
    label,
    decimals = 1,
    zones,
    accentColor = '#22c55e',
    freshness = 'dead',
}) => {
    const isDead = freshness === 'dead' || value === null;
    const isStale = freshness === 'stale';
    const opacity = isDead ? 0.3 : isStale ? 0.6 : 1;

    const range = max - min;
    const clamped = value !== null ? Math.max(min, Math.min(max, value)) : min;
    const fraction = (clamped - min) / range;

    // Default voltage zones
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const defaultZones = zones || [
        { from: min, to: 11.8, color: '#ef4444' },
        { from: 11.8, to: 12.4, color: '#eab308' },
        { from: 12.4, to: 13.8, color: '#22c55e' },
        { from: 13.8, to: max, color: '#eab308' },
    ];

    // Get color for current value
    const currentColor = useMemo(() => {
        if (value === null) return accentColor;
        for (const z of defaultZones) {
            if (value >= z.from && value <= z.to) return z.color;
        }
        return accentColor;
    }, [value, defaultZones, accentColor]);

    // Scale markers
    const markers = useMemo(() => {
        const step = range <= 5 ? 0.5 : range <= 10 ? 1 : 5;
        const items: { val: number; isMajor: boolean }[] = [];
        for (let v = min; v <= max; v += step / 5) {
            const rounded = Math.round(v * 10) / 10;
            items.push({ val: rounded, isMajor: Math.abs(rounded % step) < 0.01 });
        }
        return items;
    }, [min, max, range]);

    // Bar geometry
    const BAR_X = 30,
        BAR_Y = 120,
        BAR_W = 240,
        BAR_H = 24;

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-6">
            <div className="relative" style={{ width: '90vw', maxWidth: '380px' }}>
                <svg viewBox="0 0 300 200" className="w-full">
                    <defs>
                        <filter id="bar-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feFlood floodColor={currentColor} floodOpacity="0.5" />
                            <feComposite in2="blur" operator="in" />
                            <feMerge>
                                <feMergeNode />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* Zone backgrounds */}
                    <g opacity={opacity}>
                        {defaultZones.map((z, i) => {
                            const x1 = BAR_X + ((z.from - min) / range) * BAR_W;
                            const x2 = BAR_X + ((z.to - min) / range) * BAR_W;
                            return (
                                <rect
                                    key={i}
                                    x={x1}
                                    y={BAR_Y}
                                    width={x2 - x1}
                                    height={BAR_H}
                                    rx={i === 0 ? 6 : 0}
                                    ry={i === 0 ? 6 : 0}
                                    fill={z.color}
                                    opacity={0.1}
                                />
                            );
                        })}
                    </g>

                    {/* Background bar */}
                    <rect
                        x={BAR_X}
                        y={BAR_Y}
                        width={BAR_W}
                        height={BAR_H}
                        rx="6"
                        fill="rgba(255,255,255,0.04)"
                        stroke="rgba(255,255,255,0.08)"
                        strokeWidth="1"
                        opacity={opacity}
                    />

                    {/* Fill bar */}
                    {value !== null && fraction > 0.01 && (
                        <rect
                            x={BAR_X + 1}
                            y={BAR_Y + 1}
                            width={fraction * BAR_W - 2}
                            height={BAR_H - 2}
                            rx="5"
                            fill={currentColor}
                            opacity={opacity * 0.6}
                            style={{ transition: 'width 0.5s ease' }}
                        />
                    )}

                    {/* Current value indicator line */}
                    {value !== null && (
                        <g opacity={opacity}>
                            <line
                                x1={BAR_X + fraction * BAR_W}
                                y1={BAR_Y - 6}
                                x2={BAR_X + fraction * BAR_W}
                                y2={BAR_Y + BAR_H + 6}
                                stroke={currentColor}
                                strokeWidth="3"
                                strokeLinecap="round"
                                filter="url(#bar-glow)"
                                style={{ transition: 'all 0.5s ease' }}
                            />
                            {/* Value pip dot */}
                            <circle
                                cx={BAR_X + fraction * BAR_W}
                                cy={BAR_Y - 10}
                                r="4"
                                fill={currentColor}
                                style={{ transition: 'all 0.5s ease' }}
                            />
                        </g>
                    )}

                    {/* Scale markers below bar */}
                    <g opacity={opacity}>
                        {markers.map(({ val, isMajor }) => {
                            const x = BAR_X + ((val - min) / range) * BAR_W;
                            return (
                                <g key={val}>
                                    <line
                                        x1={x}
                                        y1={BAR_Y + BAR_H + 2}
                                        x2={x}
                                        y2={BAR_Y + BAR_H + (isMajor ? 12 : 6)}
                                        stroke={isMajor ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)'}
                                        strokeWidth={isMajor ? 1.5 : 0.6}
                                    />
                                    {isMajor && (
                                        <text
                                            x={x}
                                            y={BAR_Y + BAR_H + 24}
                                            textAnchor="middle"
                                            fill="rgba(148,163,184,0.6)"
                                            fontSize="10"
                                            fontWeight="600"
                                            fontFamily="system-ui, -apple-system, sans-serif"
                                        >
                                            {val.toFixed(val % 1 === 0 ? 0 : 1)}
                                        </text>
                                    )}
                                </g>
                            );
                        })}
                    </g>

                    {/* Zone labels above bar */}
                    <g opacity={opacity * 0.5}>
                        {defaultZones.map((z, i) => {
                            const x = BAR_X + (((z.from + z.to) / 2 - min) / range) * BAR_W;
                            const labels = zones ? undefined : ['LOW', 'CAUTION', 'NORMAL', 'HIGH'];
                            if (!labels) return null;
                            return (
                                <text
                                    key={i}
                                    x={x}
                                    y={BAR_Y - 12}
                                    textAnchor="middle"
                                    fill={z.color}
                                    fontSize="8"
                                    fontWeight="800"
                                    fontFamily="system-ui"
                                    letterSpacing="0.1em"
                                >
                                    {labels[i]}
                                </text>
                            );
                        })}
                    </g>
                </svg>
            </div>

            {/* Digital readout */}
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-1.5" style={{ opacity }}>
                    <span
                        className="text-6xl font-black text-white tracking-tighter font-mono tabular-nums"
                        style={{ color: value !== null ? currentColor : undefined }}
                    >
                        {value !== null ? value.toFixed(decimals) : '--.-'}
                    </span>
                    <span className="text-2xl font-bold text-gray-400">{unit}</span>
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.25em] text-gray-400">{label}</span>
            </div>
        </div>
    );
};
