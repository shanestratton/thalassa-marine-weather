import React, { useId } from 'react';
import { polarToCart } from './gaugeGeometry';

/** A signed attitude indicator. Positive roll is starboard; positive pitch is bow up. */
export const AttitudeGauge: React.FC<{ angle: number | null; axis: 'heel' | 'pitch' }> = ({ angle, axis }) => {
    const id = useId().replace(/:/g, '');
    const dead = angle === null || !Number.isFinite(angle);
    const value = dead ? 0 : angle;
    const side =
        Math.abs(value) < 0.3
            ? 'LEVEL'
            : axis === 'heel'
              ? value < 0
                  ? 'PORT'
                  : 'STARBOARD'
              : value < 0
                ? 'BOW DOWN'
                : 'BOW UP';
    const color = dead ? '#64748b' : axis === 'heel' && value < -0.3 ? '#fb7185' : '#22d3ee';
    const tilt = Math.max(-60, Math.min(60, value)) * (axis === 'pitch' ? -1 : 1);
    return (
        <div className="relative mx-auto w-full" style={{ maxWidth: 300, aspectRatio: '1' }}>
            <svg
                viewBox="0 0 300 300"
                role="img"
                aria-label={axis === 'heel' ? 'Heel / roll' : 'Pitch'}
                className="h-full w-full"
            >
                <defs>
                    <radialGradient id={`${id}-face`} cx="50%" cy="42%" r="72%">
                        <stop offset="0%" stopColor="#1e293b" />
                        <stop offset="70%" stopColor="#0f172a" />
                        <stop offset="100%" stopColor="#020617" />
                    </radialGradient>
                </defs>
                <circle cx="150" cy="150" r="138" fill="#0b1220" stroke="rgba(255,255,255,.10)" strokeWidth="2" />
                <circle cx="150" cy="150" r="130" fill={`url(#${id}-face)`} stroke="rgba(255,255,255,.06)" />
                {Array.from({ length: 25 }, (_, i) => (i - 12) * 5).map((deg) => {
                    const a = polarToCart(150, 150, 115, deg);
                    const b = polarToCart(150, 150, deg % 15 === 0 ? 101 : 109, deg);
                    const p = polarToCart(150, 150, 89, deg);
                    return (
                        <g key={deg} opacity={dead ? 0.3 : 1}>
                            <line
                                x1={a.x}
                                y1={a.y}
                                x2={b.x}
                                y2={b.y}
                                stroke={deg === 0 ? '#f8fafc' : '#94a3b8'}
                                strokeWidth={deg % 15 === 0 ? 2 : 0.8}
                            />
                            {deg % 15 === 0 && (
                                <text
                                    x={p.x}
                                    y={p.y}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fontSize="11"
                                    fill="#cbd5e1"
                                    fontFamily="monospace"
                                >
                                    {Math.abs(deg)}
                                </text>
                            )}
                        </g>
                    );
                })}
                <line x1="54" y1="150" x2="246" y2="150" stroke="#64748b" strokeDasharray="4 5" />
                <g transform={`rotate(${tilt} 150 150)`} opacity={dead ? 0.25 : 1}>
                    <path
                        d="M 72 147 L 130 147 L 150 157 L 170 147 L 228 147"
                        fill="none"
                        stroke={color}
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <line x1="150" y1="121" x2="150" y2="141" stroke={color} strokeWidth="3" strokeLinecap="round" />
                </g>
                <text
                    x="150"
                    y="212"
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize="32"
                    fontWeight="900"
                    fontFamily="monospace"
                >
                    {dead ? '—' : `${Math.abs(value).toFixed(1)}°`}
                </text>
                <text x="150" y="233" textAnchor="middle" fill={color} fontSize="11" fontWeight="800" letterSpacing="2">
                    {dead ? 'NO DATA' : side}
                </text>
            </svg>
        </div>
    );
};
