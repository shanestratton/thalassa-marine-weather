/**
 * CompassGauge — 360° compass rose SVG for COG and Heading.
 * 
 * Features:
 *   - Rotating compass card with N/S/E/W + intercardinals
 *   - Tick marks: fine (5°), medium (10°), bold (30°)
 *   - Fixed lubber line at top with glow
 *   - Smooth CSS rotation on value changes
 *   - Digital readout below compass
 */
import React, { useMemo } from 'react';

interface CompassGaugeProps {
    value: number | null;         // 0-360 degrees
    label: string;                // "COG" or "HDG"
    accentColor?: string;         // CSS color for glow/accent
    freshness?: 'live' | 'stale' | 'dead';
}

const CARDINAL: Record<number, string> = {
    0: 'N', 30: '30', 60: '60', 90: 'E', 120: '120', 150: '150',
    180: 'S', 210: '210', 240: '240', 270: 'W', 300: '300', 330: '330'
};

export const CompassGauge: React.FC<CompassGaugeProps> = ({
    value,
    label,
    accentColor = '#22d3ee',
    freshness = 'dead'
}) => {
    const displayValue = value !== null ? Math.round(value) : null;
    const rotation = value !== null ? -value : 0; // Card rotates opposite to heading

    // Pre-compute tick marks
    const ticks = useMemo(() => {
        const items: { deg: number; type: 'fine' | 'medium' | 'bold' | 'cardinal' }[] = [];
        for (let d = 0; d < 360; d += 5) {
            if (d % 30 === 0) {
                items.push({ deg: d, type: CARDINAL[d] ? 'cardinal' : 'bold' });
            } else if (d % 10 === 0) {
                items.push({ deg: d, type: 'medium' });
            } else {
                items.push({ deg: d, type: 'fine' });
            }
        }
        return items;
    }, []);

    const isDead = freshness === 'dead' || displayValue === null;
    const isStale = freshness === 'stale';
    const opacity = isDead ? 0.3 : isStale ? 0.6 : 1;

    return (
        <div className="flex flex-col items-center justify-center w-full h-full gap-6">
            {/* SVG Compass */}
            <div className="relative" style={{ width: '80vw', maxWidth: '340px', aspectRatio: '1' }}>
                <svg viewBox="0 0 300 300" className="w-full h-full">
                    <defs>
                        {/* Glow filter */}
                        <filter id="compass-glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="3" result="blur" />
                            <feFlood floodColor={accentColor} floodOpacity="0.6" />
                            <feComposite in2="blur" operator="in" />
                            <feMerge>
                                <feMergeNode />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                        {/* Outer ring gradient */}
                        <linearGradient id="compass-ring" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
                            <stop offset="100%" stopColor="rgba(255,255,255,0.04)" />
                        </linearGradient>
                        {/* Center gradient */}
                        <radialGradient id="compass-center" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor="rgba(15,23,42,0.9)" />
                            <stop offset="100%" stopColor="rgba(15,23,42,0.6)" />
                        </radialGradient>
                    </defs>

                    {/* Background ring */}
                    <circle cx="150" cy="150" r="140" fill="none" stroke="url(#compass-ring)" strokeWidth="1.5" opacity={opacity} />
                    <circle cx="150" cy="150" r="130" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" opacity={opacity} />

                    {/* Rotating compass card */}
                    <g
                        transform={`rotate(${rotation} 150 150)`}
                        style={{ transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                        opacity={opacity}
                    >
                        {/* Tick marks */}
                        {ticks.map(({ deg, type }) => {
                            const r1 = type === 'fine' ? 124 : type === 'medium' ? 120 : 115;
                            const r2 = 130;
                            const width = type === 'fine' ? 0.5 : type === 'medium' ? 1 : 1.5;
                            const color = type === 'cardinal' || type === 'bold'
                                ? 'rgba(255,255,255,0.7)'
                                : type === 'medium'
                                    ? 'rgba(255,255,255,0.3)'
                                    : 'rgba(255,255,255,0.15)';
                            const rad = (deg * Math.PI) / 180;
                            const x1 = 150 + r1 * Math.sin(rad);
                            const y1 = 150 - r1 * Math.cos(rad);
                            const x2 = 150 + r2 * Math.sin(rad);
                            const y2 = 150 - r2 * Math.cos(rad);
                            return (
                                <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2}
                                    stroke={color} strokeWidth={width} strokeLinecap="round" />
                            );
                        })}

                        {/* Cardinal & degree labels */}
                        {Object.entries(CARDINAL).map(([degStr, text]) => {
                            const deg = Number(degStr);
                            const rad = (deg * Math.PI) / 180;
                            const labelR = 106;
                            const x = 150 + labelR * Math.sin(rad);
                            const y = 150 - labelR * Math.cos(rad);
                            const isCardinal = ['N', 'S', 'E', 'W'].includes(text);
                            return (
                                <text key={deg} x={x} y={y}
                                    textAnchor="middle" dominantBaseline="central"
                                    fill={isCardinal
                                        ? text === 'N' ? '#f87171' : '#e2e8f0'
                                        : 'rgba(148,163,184,0.6)'}
                                    fontSize={isCardinal ? 16 : 11}
                                    fontWeight={isCardinal ? 800 : 500}
                                    fontFamily="system-ui, -apple-system, sans-serif"
                                    style={{ letterSpacing: '0.05em' }}
                                >
                                    {text}
                                </text>
                            );
                        })}

                        {/* North arrow marker on the card */}
                        <polygon
                            points="150,28 145,40 155,40"
                            fill="#f87171"
                            opacity={0.9}
                        />
                    </g>

                    {/* Fixed lubber line (top) — always points "up" */}
                    <line x1="150" y1="10" x2="150" y2="35" stroke={accentColor} strokeWidth="3" strokeLinecap="round"
                        filter="url(#compass-glow)" />
                    <polygon points="150,35 145,45 155,45" fill={accentColor} opacity={0.9} />

                    {/* Center dot */}
                    <circle cx="150" cy="150" r="6" fill="url(#compass-center)" stroke={accentColor} strokeWidth="1.5" opacity={opacity * 0.8} />
                    <circle cx="150" cy="150" r="2" fill={accentColor} opacity={opacity} />
                </svg>
            </div>

            {/* Digital readout */}
            <div className="flex flex-col items-center gap-1">
                <div className="flex items-baseline gap-1" style={{ opacity }}>
                    <span className="text-6xl font-black text-white tracking-tighter font-mono tabular-nums">
                        {displayValue !== null ? String(displayValue).padStart(3, '0') : '---'}
                    </span>
                    <span className="text-2xl font-bold text-gray-400">°</span>
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.25em] text-gray-500">{label}</span>
            </div>
        </div>
    );
};
