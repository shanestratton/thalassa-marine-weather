/**
 * ScopeRadar — SVG scope ratio visualization for anchor setup.
 *
 * Renders a radar-style display showing:
 * - Safe zone, caution band, and danger halo
 * - Compass tick marks and cardinal labels
 * - Scope ratio and quality readout
 * - Swing radius preview
 */
import React from 'react';
import { formatDistance } from './anchorUtils';

interface ScopeRadarProps {
    rodeLength: number;
    waterDepth: number;
    rodeType: 'chain' | 'rope' | 'mixed';
    safetyMargin: number;
}

export const ScopeRadar: React.FC<ScopeRadarProps> = React.memo(
    ({ rodeLength, waterDepth, rodeType, safetyMargin }) => {
        const scopeRatio = rodeLength / Math.max(waterDepth, 0.1);
        const swingRadiusPreview =
            Math.sqrt(Math.max(0, rodeLength * rodeLength - waterDepth * waterDepth)) *
                (rodeType === 'chain' ? 0.85 : rodeType === 'rope' ? 0.95 : 0.9) +
            safetyMargin;
        const scopeQuality: 'excellent' | 'adequate' | 'poor' =
            scopeRatio >= 7 ? 'excellent' : scopeRatio >= 5 ? 'adequate' : 'poor';
        const scopeColor =
            scopeQuality === 'excellent' ? '#34d399' : scopeQuality === 'adequate' ? '#fbbf24' : '#f87171';

        // Radar ring sizes — normalized to a 200-unit viewbox
        const maxRode = 100;
        const radarScale = Math.min(1, rodeLength / (maxRode * 0.6));
        const outerR = 60 + radarScale * 20; // 60–80 range
        const safeR = outerR * 0.85;
        const dangerR = outerR * 1.15;

        return (
            <svg
                viewBox="0 0 200 200"
                className="w-full h-full max-w-[320px] max-h-[320px]"
                style={{ filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.3))' }}
                role="img"
                aria-label={`Scope radar: ${scopeRatio.toFixed(1)} to 1 ratio, ${scopeQuality}`}
            >
                {/* Ocean depth background */}
                <defs>
                    <radialGradient id="ocean-bg" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="rgba(8,47,73,0.3)" />
                        <stop offset="70%" stopColor="rgba(7,33,54,0.15)" />
                        <stop offset="100%" stopColor="rgba(2,6,23,0.05)" />
                    </radialGradient>
                    <radialGradient id="safe-zone" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor={`${scopeColor}06`} />
                        <stop offset="70%" stopColor={`${scopeColor}12`} />
                        <stop offset="100%" stopColor={`${scopeColor}18`} />
                    </radialGradient>
                </defs>

                {/* Background fill */}
                <circle cx="100" cy="100" r="95" fill="url(#ocean-bg)" />

                {/* Danger zone halo (red, beyond swing radius) */}
                <circle
                    cx="100"
                    cy="100"
                    r={dangerR}
                    fill="none"
                    stroke="rgba(239,68,68,0.06)"
                    strokeWidth={dangerR - outerR}
                />

                {/* Amber caution band (85%–100%) */}
                <circle
                    cx="100"
                    cy="100"
                    r={(safeR + outerR) / 2}
                    fill="none"
                    stroke="rgba(245,158,11,0.08)"
                    strokeWidth={outerR - safeR}
                    style={{ transition: 'all 0.3s ease' }}
                />

                {/* Green/amber/red safe zone fill */}
                <circle cx="100" cy="100" r={safeR} fill="url(#safe-zone)" style={{ transition: 'r 0.3s ease' }} />

                {/* Safe zone border */}
                <circle
                    cx="100"
                    cy="100"
                    r={safeR}
                    fill="none"
                    stroke={`${scopeColor}33`}
                    strokeWidth="0.5"
                    style={{ transition: 'all 0.3s ease' }}
                />

                {/* Swing radius boundary ring */}
                <circle
                    cx="100"
                    cy="100"
                    r={outerR}
                    fill="none"
                    stroke={`${scopeColor}66`}
                    strokeWidth="1.5"
                    style={{ transition: 'all 0.3s ease' }}
                />

                {/* 50% reference ring */}
                <circle
                    cx="100"
                    cy="100"
                    r={outerR * 0.5}
                    fill="none"
                    stroke="rgba(71,85,105,0.15)"
                    strokeWidth="0.3"
                    strokeDasharray="1.5 3"
                    style={{ transition: 'r 0.3s ease' }}
                />

                {/* Compass tick marks */}
                {Array.from({ length: 36 }, (_, i) => {
                    const angle = ((i * 10 - 90) * Math.PI) / 180;
                    const isMajor = i % 9 === 0;
                    const isMinor = i % 3 === 0;
                    const inner = outerR + (isMajor ? 4 : isMinor ? 6 : 7);
                    const outer = outerR + 9;
                    return (
                        <line
                            key={i}
                            x1={100 + Math.cos(angle) * inner}
                            y1={100 + Math.sin(angle) * inner}
                            x2={100 + Math.cos(angle) * outer}
                            y2={100 + Math.sin(angle) * outer}
                            stroke={isMajor ? 'rgba(148,163,184,0.5)' : 'rgba(100,116,139,0.15)'}
                            strokeWidth={isMajor ? 1 : 0.3}
                        />
                    );
                })}

                {/* Cardinal labels */}
                {[
                    { label: 'N', x: 100, y: 100 - outerR - 14, color: 'rgba(248,113,113,0.8)' },
                    { label: 'E', x: 100 + outerR + 14, y: 101, color: 'rgba(148,163,184,0.5)' },
                    { label: 'S', x: 100, y: 100 + outerR + 16, color: 'rgba(148,163,184,0.5)' },
                    { label: 'W', x: 100 - outerR - 14, y: 101, color: 'rgba(148,163,184,0.5)' },
                ].map(({ label, x, y, color }) => (
                    <text
                        key={label}
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={color}
                        fontSize="7"
                        fontWeight="bold"
                        fontFamily="system-ui"
                    >
                        {label}
                    </text>
                ))}

                {/* Anchor icon at center */}
                <text
                    x="100"
                    y="88"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="14"
                    fill="rgba(245,158,11,0.85)"
                >
                    ⚓
                </text>

                {/* Scope ratio — large bold center text */}
                <text
                    x="100"
                    y="106"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="18"
                    fontWeight="900"
                    fontFamily="ui-monospace, monospace"
                    fill="white"
                    style={{ textShadow: '0 0 10px rgba(255,255,255,0.15)' }}
                >
                    {scopeRatio.toFixed(1)}:1
                </text>

                {/* Scope quality label below ratio */}
                <text
                    x="100"
                    y="118"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="6"
                    fontWeight="700"
                    fontFamily="system-ui"
                    fill={scopeColor}
                    letterSpacing="0.1em"
                >
                    {scopeQuality === 'excellent' ? 'EXCELLENT' : scopeQuality === 'adequate' ? 'ADEQUATE' : 'POOR'}
                </text>

                {/* Swing radius readout */}
                <text
                    x="100"
                    y="128"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="5"
                    fill="rgba(148,163,184,0.6)"
                    fontFamily="system-ui"
                >
                    {formatDistance(swingRadiusPreview)} swing radius
                </text>
            </svg>
        );
    },
);

ScopeRadar.displayName = 'ScopeRadar';
