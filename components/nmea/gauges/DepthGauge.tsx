/**
 * DepthGauge — Vertical water-fill bar for depth below transducer.
 *
 * Features:
 *   - Tall vertical bar with water-fill animation from bottom
 *   - Blue gradient getting darker with depth
 *   - Danger zone highlight for shallow water (<5m)
 *   - Depth markers on the side
 *   - Sonar-style ring animation
 */
import React, { useMemo } from 'react';

interface DepthGaugeProps {
    value: number | null; // Depth in meters
    maxDepth?: number; // Maximum gauge range (default 100m)
    unit?: string;
    freshness?: 'live' | 'stale' | 'dead';
}

export const DepthGauge: React.FC<DepthGaugeProps> = ({ value, maxDepth = 100, unit = 'm', freshness = 'dead' }) => {
    const isDead = freshness === 'dead' || value === null;
    const isStale = freshness === 'stale';
    const opacity = isDead ? 0.3 : isStale ? 0.6 : 1;

    // Auto-scale: pick a sensible max based on current value
    const effectiveMax = useMemo(() => {
        if (value === null) return maxDepth;
        if (value < 10) return 20;
        if (value < 25) return 50;
        if (value < 50) return 100;
        if (value < 100) return 200;
        return Math.ceil(value / 100) * 100 + 50;
    }, [value, maxDepth]);

    const clamped = value !== null ? Math.max(0, Math.min(effectiveMax, value)) : 0;
    const fraction = clamped / effectiveMax;

    // Danger zone: below 5m is shallow water danger
    const isShallow = value !== null && value < 5;

    // Generate depth markers
    const markers = useMemo(() => {
        const interval = effectiveMax <= 20 ? 2 : effectiveMax <= 50 ? 5 : effectiveMax <= 100 ? 10 : 25;
        const items: number[] = [];
        for (let d = 0; d <= effectiveMax; d += interval) items.push(d);
        return items;
    }, [effectiveMax]);

    // Bar dimensions
    const BAR_X = 100,
        BAR_Y = 30,
        BAR_W = 60,
        BAR_H = 240;
    const fillH = fraction * BAR_H;

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-6">
            <div className="relative" style={{ width: '75vw', maxWidth: '320px', aspectRatio: '0.8' }}>
                <svg viewBox="0 0 260 310" className="w-full h-full">
                    <defs>
                        {/* Water gradient — lighter at surface, darker at depth */}
                        <linearGradient id="depth-water" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
                            <stop offset="30%" stopColor="#0ea5e9" stopOpacity="0.7" />
                            <stop offset="70%" stopColor="#0369a1" stopOpacity="0.85" />
                            <stop offset="100%" stopColor="#1e3a5f" stopOpacity="0.95" />
                        </linearGradient>
                        {/* Danger gradient for shallow */}
                        <linearGradient id="depth-danger" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.6" />
                        </linearGradient>
                        {/* Glass edge glow */}
                        <linearGradient id="depth-glass" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="rgba(255,255,255,0.1)" />
                            <stop offset="50%" stopColor="rgba(255,255,255,0.02)" />
                            <stop offset="100%" stopColor="rgba(255,255,255,0.08)" />
                        </linearGradient>
                        {/* Sonar pulse */}
                        <filter id="sonar-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="3" />
                        </filter>
                    </defs>

                    {/* Bar background with rounded corners */}
                    <rect
                        x={BAR_X}
                        y={BAR_Y}
                        width={BAR_W}
                        height={BAR_H}
                        rx="8"
                        ry="8"
                        fill="rgba(15,23,42,0.6)"
                        stroke="rgba(255,255,255,0.1)"
                        strokeWidth="1"
                        opacity={opacity}
                    />

                    {/* Water fill — fills from bottom */}
                    {value !== null && fraction > 0.01 && (
                        <g opacity={opacity}>
                            <clipPath id="depth-clip">
                                <rect x={BAR_X + 1} y={BAR_Y + 1} width={BAR_W - 2} height={BAR_H - 2} rx="7" ry="7" />
                            </clipPath>
                            <rect
                                x={BAR_X + 1}
                                y={BAR_Y + BAR_H - fillH}
                                width={BAR_W - 2}
                                height={fillH}
                                fill={isShallow ? 'url(#depth-danger)' : 'url(#depth-water)'}
                                clipPath="url(#depth-clip)"
                                style={{ transition: 'y 0.6s ease, height 0.6s ease' }}
                            />
                            {/* Water surface line */}
                            <line
                                x1={BAR_X + 4}
                                y1={BAR_Y + BAR_H - fillH}
                                x2={BAR_X + BAR_W - 4}
                                y2={BAR_Y + BAR_H - fillH}
                                stroke={isShallow ? '#ef4444' : '#38bdf8'}
                                strokeWidth="2"
                                strokeLinecap="round"
                                opacity={0.8}
                                style={{ transition: 'y1 0.6s ease, y2 0.6s ease' }}
                            />
                        </g>
                    )}

                    {/* Glass overlay */}
                    <rect
                        x={BAR_X}
                        y={BAR_Y}
                        width={BAR_W}
                        height={BAR_H}
                        rx="8"
                        ry="8"
                        fill="url(#depth-glass)"
                        opacity={opacity * 0.5}
                    />

                    {/* Depth markers — left side */}
                    <g opacity={opacity}>
                        {markers.map((d) => {
                            const yPos = BAR_Y + (d / effectiveMax) * BAR_H;
                            const isMajor = d % (effectiveMax <= 20 ? 5 : effectiveMax <= 50 ? 10 : 25) === 0;
                            return (
                                <g key={d}>
                                    <line
                                        x1={BAR_X - (isMajor ? 12 : 6)}
                                        y1={yPos}
                                        x2={BAR_X - 2}
                                        y2={yPos}
                                        stroke={isMajor ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}
                                        strokeWidth={isMajor ? 1.5 : 0.8}
                                    />
                                    {isMajor && (
                                        <text
                                            x={BAR_X - 18}
                                            y={yPos}
                                            textAnchor="end"
                                            dominantBaseline="central"
                                            fill="rgba(148,163,184,0.7)"
                                            fontSize="11"
                                            fontWeight="600"
                                            fontFamily="system-ui, -apple-system, sans-serif"
                                        >
                                            {d}
                                        </text>
                                    )}
                                </g>
                            );
                        })}
                    </g>

                    {/* Current depth indicator — right side arrow */}
                    {value !== null && (
                        <g opacity={opacity} style={{ transition: 'transform 0.6s ease' }}>
                            <polygon
                                points={`${BAR_X + BAR_W + 4},${BAR_Y + fraction * BAR_H} ${BAR_X + BAR_W + 14},${BAR_Y + fraction * BAR_H - 6} ${BAR_X + BAR_W + 14},${BAR_Y + fraction * BAR_H + 6}`}
                                fill={isShallow ? '#ef4444' : '#38bdf8'}
                                style={{ transition: 'all 0.6s ease' }}
                            />
                            <rect
                                x={BAR_X + BAR_W + 14}
                                y={BAR_Y + fraction * BAR_H - 14}
                                width="52"
                                height="28"
                                rx="6"
                                fill={isShallow ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.15)'}
                                stroke={isShallow ? 'rgba(239,68,68,0.3)' : 'rgba(56,189,248,0.2)'}
                                strokeWidth="1"
                                style={{ transition: 'all 0.6s ease' }}
                            />
                            <text
                                x={BAR_X + BAR_W + 40}
                                y={BAR_Y + fraction * BAR_H}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fill={isShallow ? '#fca5a5' : '#7dd3fc'}
                                fontSize="13"
                                fontWeight="800"
                                fontFamily="system-ui, -apple-system, monospace"
                                style={{ transition: 'all 0.6s ease' }}
                            >
                                {clamped.toFixed(1)}
                            </text>
                        </g>
                    )}

                    {/* "Surface" label at top */}
                    <text
                        x={BAR_X + BAR_W / 2}
                        y={BAR_Y - 10}
                        textAnchor="middle"
                        fill="rgba(148,163,184,0.4)"
                        fontSize="9"
                        fontWeight="700"
                        fontFamily="system-ui"
                        letterSpacing="0.15em"
                        opacity={opacity}
                    >
                        SURFACE
                    </text>

                    {/* Shallow danger zone overlay — top 5m band */}
                    {effectiveMax > 5 && (
                        <rect
                            x={BAR_X + 1}
                            y={BAR_Y + 1}
                            width={BAR_W - 2}
                            height={(5 / effectiveMax) * BAR_H}
                            fill="rgba(239,68,68,0.06)"
                            rx="7"
                            ry="0"
                            opacity={opacity}
                        />
                    )}
                </svg>
            </div>

            {/* Digital readout */}
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-1.5" style={{ opacity }}>
                    <span
                        className={`text-6xl font-black tracking-tighter font-mono tabular-nums ${isShallow ? 'text-red-400' : 'text-white'}`}
                    >
                        {value !== null ? value.toFixed(1) : '--.-'}
                    </span>
                    <span className="text-2xl font-bold text-gray-400">{unit}</span>
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.25em] text-gray-500">
                    Depth Below Transducer
                </span>
                {isShallow && (
                    <span className="text-xs font-black uppercase tracking-widest text-red-400 animate-pulse mt-1">
                        ⚠ Shallow Water
                    </span>
                )}
            </div>
        </div>
    );
};
