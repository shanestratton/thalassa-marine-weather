/**
 * TachGauge — Full radial tachometer gauge for engine RPM.
 *
 * Features:
 *   - 270° sweep with redline zone (typically 3000+ RPM)
 *   - Bold RPM markers at 500 intervals
 *   - Animated needle with pivot and shadow
 *   - Redline glow effect above threshold
 *   - Digital RPM display
 */
import React, { useMemo } from 'react';

interface TachGaugeProps {
    value: number | null;
    maxRpm?: number;
    redline?: number;
    freshness?: 'live' | 'stale' | 'dead';
}

const CX = 150,
    CY = 155;
const RADIUS = 115;
const START_ANGLE = 135; // Bottom-left
const END_ANGLE = 405; // Bottom-right (135 + 270)
const SWEEP = 270;

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

export const TachGauge: React.FC<TachGaugeProps> = ({ value, maxRpm = 4000, redline = 3200, freshness = 'dead' }) => {
    const isDead = freshness === 'dead' || value === null;
    const isStale = freshness === 'stale';
    const opacity = isDead ? 0.3 : isStale ? 0.6 : 1;

    const clamped = value !== null ? Math.max(0, Math.min(maxRpm, value)) : 0;
    const fraction = clamped / maxRpm;
    const needleAngle = START_ANGLE + fraction * SWEEP;
    const isRedline = value !== null && value >= redline;

    // RPM markers every 500
    const markers = useMemo(() => {
        const items: { rpm: number; isMajor: boolean }[] = [];
        for (let r = 0; r <= maxRpm; r += 100) {
            items.push({ rpm: r, isMajor: r % 500 === 0 });
        }
        return items;
    }, [maxRpm]);

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-4">
            <div className="relative" style={{ width: '85vw', maxWidth: '360px', aspectRatio: '1' }}>
                <svg viewBox="0 0 300 300" className="w-full h-full">
                    <defs>
                        <filter id="tach-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feFlood floodColor={isRedline ? '#ef4444' : '#22c55e'} floodOpacity="0.5" />
                            <feComposite in2="blur" operator="in" />
                            <feMerge>
                                <feMergeNode />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                        <filter id="redline-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="6" />
                        </filter>
                    </defs>

                    {/* Background track */}
                    <path
                        d={describeArc(CX, CY, RADIUS, START_ANGLE, END_ANGLE)}
                        fill="none"
                        stroke="rgba(255,255,255,0.06)"
                        strokeWidth="16"
                        strokeLinecap="round"
                        opacity={opacity}
                    />

                    {/* Green zone (0 to redline) */}
                    <path
                        d={describeArc(CX, CY, RADIUS, START_ANGLE, START_ANGLE + (redline / maxRpm) * SWEEP)}
                        fill="none"
                        stroke="rgba(34,197,94,0.12)"
                        strokeWidth="16"
                        strokeLinecap="butt"
                        opacity={opacity}
                    />

                    {/* Redline zone */}
                    <path
                        d={describeArc(CX, CY, RADIUS, START_ANGLE + (redline / maxRpm) * SWEEP, END_ANGLE)}
                        fill="none"
                        stroke="rgba(239,68,68,0.2)"
                        strokeWidth="16"
                        strokeLinecap="butt"
                        opacity={opacity}
                    />

                    {/* Redline glow pulse */}
                    {isRedline && (
                        <path
                            d={describeArc(CX, CY, RADIUS, START_ANGLE + (redline / maxRpm) * SWEEP, END_ANGLE)}
                            fill="none"
                            stroke="rgba(239,68,68,0.4)"
                            strokeWidth="20"
                            strokeLinecap="butt"
                            filter="url(#redline-glow)"
                            className="animate-pulse"
                        />
                    )}

                    {/* Value fill arc */}
                    {value !== null && fraction > 0.005 && (
                        <path
                            d={describeArc(CX, CY, RADIUS, START_ANGLE, needleAngle)}
                            fill="none"
                            stroke={isRedline ? '#ef4444' : '#22c55e'}
                            strokeWidth="16"
                            strokeLinecap="round"
                            opacity={opacity * 0.7}
                            style={{ transition: 'all 0.3s ease-out' }}
                        />
                    )}

                    {/* Tick marks */}
                    <g opacity={opacity}>
                        {markers.map(({ rpm, isMajor }) => {
                            const frac = rpm / maxRpm;
                            const angle = START_ANGLE + frac * SWEEP;
                            const inRedzone = rpm >= redline;
                            const outerR = RADIUS + 14;
                            const innerR = isMajor ? RADIUS + 4 : RADIUS + 8;
                            const outer = polarToCart(CX, CY, outerR, angle);
                            const inner = polarToCart(CX, CY, innerR, angle);
                            return (
                                <g key={rpm}>
                                    <line
                                        x1={inner.x}
                                        y1={inner.y}
                                        x2={outer.x}
                                        y2={outer.y}
                                        stroke={
                                            inRedzone
                                                ? isMajor
                                                    ? 'rgba(239,68,68,0.8)'
                                                    : 'rgba(239,68,68,0.3)'
                                                : isMajor
                                                  ? 'rgba(255,255,255,0.5)'
                                                  : 'rgba(255,255,255,0.15)'
                                        }
                                        strokeWidth={isMajor ? 2 : 0.8}
                                        strokeLinecap="round"
                                    />
                                    {isMajor && (
                                        <text
                                            x={polarToCart(CX, CY, outerR + 13, angle).x}
                                            y={polarToCart(CX, CY, outerR + 13, angle).y}
                                            textAnchor="middle"
                                            dominantBaseline="central"
                                            fill={inRedzone ? 'rgba(239,68,68,0.8)' : 'rgba(148,163,184,0.7)'}
                                            fontSize="10"
                                            fontWeight="700"
                                            fontFamily="system-ui, -apple-system, sans-serif"
                                        >
                                            {rpm / 1000}
                                        </text>
                                    )}
                                </g>
                            );
                        })}
                    </g>

                    {/* Needle */}
                    {clamped !== null && (
                        <g
                            style={{ transition: 'transform 0.3s ease-out' }}
                            transform={`rotate(${needleAngle} ${CX} ${CY})`}
                            opacity={opacity}
                        >
                            {/* Counterweight */}
                            <line
                                x1={CX}
                                y1={CY}
                                x2={CX}
                                y2={CY + 20}
                                stroke="rgba(255,255,255,0.2)"
                                strokeWidth="4"
                                strokeLinecap="round"
                            />
                            {/* Needle body */}
                            <line
                                x1={CX}
                                y1={CY}
                                x2={CX}
                                y2={CY - RADIUS + 12}
                                stroke={isRedline ? '#ef4444' : '#e2e8f0'}
                                strokeWidth="3"
                                strokeLinecap="round"
                                filter="url(#tach-glow)"
                            />
                            {/* Needle tip */}
                            <circle cx={CX} cy={CY - RADIUS + 12} r="3" fill={isRedline ? '#ef4444' : '#e2e8f0'} />
                        </g>
                    )}

                    {/* Center hub */}
                    <circle
                        cx={CX}
                        cy={CY}
                        r="12"
                        fill="rgba(15,23,42,0.95)"
                        stroke="rgba(255,255,255,0.2)"
                        strokeWidth="2"
                        opacity={opacity}
                    />
                    <circle
                        cx={CX}
                        cy={CY}
                        r="4"
                        fill={isRedline ? '#ef4444' : 'rgba(148,163,184,0.6)'}
                        opacity={opacity}
                    />

                    {/* ×1000 label */}
                    <text
                        x={CX}
                        y={CY + 45}
                        textAnchor="middle"
                        fill="rgba(148,163,184,0.4)"
                        fontSize="10"
                        fontWeight="700"
                        fontFamily="system-ui"
                        letterSpacing="0.1em"
                        opacity={opacity}
                    >
                        ×1000 RPM
                    </text>
                </svg>
            </div>

            {/* Digital readout */}
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-1.5" style={{ opacity }}>
                    <span
                        className={`text-6xl font-black tracking-tighter font-mono tabular-nums ${isRedline ? 'text-red-400' : 'text-white'}`}
                    >
                        {value !== null ? Math.round(value) : '----'}
                    </span>
                    <span className="text-2xl font-bold text-gray-400">RPM</span>
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.25em] text-gray-400">Engine Speed</span>
            </div>
        </div>
    );
};
