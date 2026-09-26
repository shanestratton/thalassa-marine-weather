/**
 * ScopeRadar — SVG scope ratio visualization for anchor setup.
 *
 * Renders a radar-style display showing:
 * - Safe zone, caution band, and danger halo
 * - Compass tick marks and cardinal labels
 * - Scope ratio and quality readout
 * - Swing radius preview
 */
import React, { useEffect, useRef, useState } from 'react';
import { formatDistance } from './anchorUtils';

/** Smallest on-screen size, in CSS px, for the letters drawn inside the dial. */
const MIN_DIAL_TEXT_PX = 12;

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

        const qualityWord =
            scopeQuality === 'excellent' ? 'EXCELLENT' : scopeQuality === 'adequate' ? 'ADEQUATE' : 'POOR';
        const qualityFill = `var(--day-ui-${scopeQuality === 'excellent' ? 'success' : scopeQuality === 'adequate' ? 'amber' : 'danger'}, ${scopeColor})`;

        // The dial is a 200-unit viewBox that shrinks with its box (144 px on a
        // 375×667 phone, ~160 px in landscape), so fixed SVG font sizes came out
        // at 8–10 px (UX scorecard run 6, the L cap). Measure the rendered size
        // and scale the letters inside the dial so they never drop below 12 px;
        // the quality word and swing radius live in HTML under the dial.
        const svgRef = useRef<SVGSVGElement>(null);
        const [pxPerUnit, setPxPerUnit] = useState(1);
        useEffect(() => {
            const el = svgRef.current;
            if (!el || typeof ResizeObserver === 'undefined') return;
            const measure = () => {
                const rect = el.getBoundingClientRect();
                const side = Math.min(rect.width, rect.height);
                if (side > 0) setPxPerUnit(side / 200);
            };
            measure();
            const observer = new ResizeObserver(measure);
            observer.observe(el);
            return () => observer.disconnect();
        }, []);
        const cardinalSize = Math.max(12, MIN_DIAL_TEXT_PX / pxPerUnit);
        const ratioSize = Math.max(18, 16 / pxPerUnit);

        // Radar ring sizes — normalized to a 200-unit viewbox. The range leaves
        // room outside the tick ring for cardinal letters at their scaled size.
        const maxRode = 100;
        const radarScale = Math.min(1, rodeLength / (maxRode * 0.6));
        const outerR = 54 + radarScale * 16; // 54–70 range
        const safeR = outerR * 0.85;
        const dangerR = outerR * 1.15;
        const cardinalR = outerR + 9 + cardinalSize / 2 + 2;

        return (
            <div className="flex h-full w-full min-h-0 flex-col items-center justify-center gap-1">
                <svg
                    ref={svgRef}
                    viewBox="0 0 200 200"
                    overflow="visible"
                    className="min-h-0 w-full flex-1 max-w-[320px] max-h-[320px]"
                    style={{ filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.3))' }}
                    role="img"
                    aria-label={`Scope radar: ${scopeRatio.toFixed(1)} to 1 ratio, ${scopeQuality}, ${formatDistance(swingRadiusPreview)} swing radius`}
                >
                    {/* Ocean depth background */}
                    <defs>
                        <radialGradient id="ocean-bg" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor="var(--day-ui-surface, rgba(8,47,73,0.3))" />
                            <stop offset="70%" stopColor="var(--day-ui-surface-soft, rgba(7,33,54,0.15))" />
                            <stop offset="100%" stopColor="var(--day-ui-surface-soft, rgba(2,6,23,0.05))" />
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
                                stroke={
                                    isMajor
                                        ? 'var(--day-ui-muted, rgba(148,163,184,0.5))'
                                        : 'var(--day-ui-grid, rgba(100,116,139,0.15))'
                                }
                                strokeWidth={isMajor ? 1 : 0.3}
                            />
                        );
                    })}

                    {/* Cardinal labels */}
                    {[
                        {
                            label: 'N',
                            x: 100,
                            y: 100 - cardinalR,
                            color: 'var(--day-ui-danger, rgba(248,113,113,0.85))',
                        },
                        {
                            label: 'E',
                            x: 100 + cardinalR,
                            y: 101,
                            color: 'var(--day-ui-muted, rgba(148,163,184,0.75))',
                        },
                        {
                            label: 'S',
                            x: 100,
                            y: 100 + cardinalR,
                            color: 'var(--day-ui-muted, rgba(148,163,184,0.75))',
                        },
                        {
                            label: 'W',
                            x: 100 - cardinalR,
                            y: 101,
                            color: 'var(--day-ui-muted, rgba(148,163,184,0.75))',
                        },
                    ].map(({ label, x, y, color }) => (
                        <text
                            key={label}
                            x={x}
                            y={y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill={color}
                            fontSize={cardinalSize}
                            fontWeight="bold"
                            fontFamily="system-ui"
                        >
                            {label}
                        </text>
                    ))}

                    {/* Anchor mark at center — a drawn glyph, not the ⚓ emoji */}
                    <g
                        transform={`translate(${100 - 7} ${100 - ratioSize / 2 - 18}) scale(${14 / 24})`}
                        fill="none"
                        stroke="rgba(245,158,11,0.85)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <circle cx="12" cy="5" r="3" />
                        <path d="M12 22V8" />
                        <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
                    </g>

                    {/* Scope ratio — large bold center text */}
                    <text
                        x="100"
                        y="104"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={ratioSize}
                        fontWeight="900"
                        fontFamily="ui-monospace, monospace"
                        fill="var(--day-ui-text, white)"
                        style={{ textShadow: '0 0 10px rgba(255,255,255,0.15)' }}
                    >
                        {scopeRatio.toFixed(1)}:1
                    </text>
                </svg>
                {/* Quality and swing radius in HTML so they stay 13 px at any dial size. */}
                <p className="shrink-0 text-center text-[13px] leading-tight" aria-hidden="true">
                    <span className="font-bold tracking-[0.08em]" style={{ color: qualityFill }}>
                        {qualityWord}
                    </span>
                    <span className="text-slate-300"> · {formatDistance(swingRadiusPreview)} swing radius</span>
                </p>
            </div>
        );
    },
);

ScopeRadar.displayName = 'ScopeRadar';
