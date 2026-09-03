/**
 * HeadingGauge — the compass, in the same language as the barometer and the
 * rudder (Shane 2026-09-02: "can we make the heading guage as nice as all the
 * others. the color scheme is flawless").
 *
 * THE CARD TURNS, NOT THE NEEDLE. That is not a style choice — it is what a
 * steering compass does, and it is why a helmsman can steer off one: the
 * lubber line is the boat, fixed at the top, and the world rotates behind it.
 * Swapping to a rotating needle would look tidier and read backwards.
 *
 * Two behaviours carried over from the card this replaces, both load-bearing:
 *
 *   THE SHORT WAY ACROSS NORTH. The rotation is unwrapped, so a bow wandering
 *   over 000 nudges one degree instead of spinning 358 the wrong way. This
 *   boat sits at anchor precisely there, so the naive version was visible
 *   every few seconds.
 *
 *   LABELS STAY UPRIGHT. Each numeral counter-rotates by the card's own
 *   angle, so N is readable at every heading rather than only northbound.
 */
import React, { useMemo } from 'react';
import { polarToCart } from './gaugeGeometry';
import { useUnwrappedAngle } from './useUnwrappedAngle';

interface HeadingGaugeProps {
    /** Degrees true/magnetic as the instrument reports them. Null = no data. */
    value: number | null;
    isLive: boolean;
    accentColor?: string;
}

const CX = 150;
const CY = 150;
const RADIUS = 122;

/** Marine convention: the trailing zero is dropped, so 030 reads as 3. */
const NUMERALS: Record<number, string> = {
    30: '3',
    60: '6',
    120: '12',
    150: '15',
    210: '21',
    240: '24',
    300: '30',
    330: '33',
};
const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

/** The point of the compass a heading falls in, for the word under the number. */
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(deg: number): string {
    return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export const HeadingGauge: React.FC<HeadingGaugeProps> = ({ value, isLive, accentColor = '#22d3ee' }) => {
    const rotation = useUnwrappedAngle(value === null ? null : -value);
    const dead = value === null;
    const opacity = dead ? 0.25 : isLive ? 1 : 0.45;

    // Geometry lives in the memo with the tick, not in the render body: the
    // card is 72 ticks and the endpoints never move, so recomputing 144 trig
    // calls on every heading update bought nothing.
    const ticks = useMemo(() => {
        const items: Array<{
            deg: number;
            kind: 'cardinal' | 'major' | 'medium' | 'minor';
            x1: number;
            y1: number;
            x2: number;
            y2: number;
        }> = [];
        for (let d = 0; d < 360; d += 5) {
            const kind = d % 90 === 0 ? 'cardinal' : d % 30 === 0 ? 'major' : d % 10 === 0 ? 'medium' : 'minor';
            const len = kind === 'cardinal' ? 20 : kind === 'major' ? 16 : kind === 'medium' ? 11 : 6;
            const outer = polarToCart(CX, CY, RADIUS - 6, d);
            const inner = polarToCart(CX, CY, RADIUS - 6 - len, d);
            items.push({ deg: d, kind, x1: outer.x, y1: outer.y, x2: inner.x, y2: inner.y });
        }
        return items;
    }, []);

    return (
        <div className="relative mx-auto w-full" style={{ maxWidth: 300, aspectRatio: '1' }}>
            <svg viewBox="0 0 300 300" className="w-full h-full" role="img" aria-label="Heading compass">
                <defs>
                    <radialGradient id="heading-face" cx="50%" cy="42%" r="72%">
                        <stop offset="0%" stopColor="#1e293b" />
                        <stop offset="70%" stopColor="#0f172a" />
                        <stop offset="100%" stopColor="#020617" />
                    </radialGradient>
                    <filter id="heading-lubber-glow" x="-60%" y="-60%" width="220%" height="220%">
                        <feDropShadow dx="0" dy="0" stdDeviation="2.5" floodColor={accentColor} floodOpacity="0.85" />
                    </filter>
                </defs>

                {/* Bezel and face — the same two circles the other dials wear. */}
                <circle
                    cx={CX}
                    cy={CY}
                    r={RADIUS + 16}
                    fill="#0b1220"
                    stroke="rgba(255,255,255,0.10)"
                    strokeWidth="2"
                />
                <circle cx={CX} cy={CY} r={RADIUS + 8} fill="url(#heading-face)" stroke="rgba(255,255,255,0.06)" />

                {/* The card. Rotated via the transform PROPERTY, not the SVG
                    attribute — a CSS transition on the attribute is a no-op and
                    the card snaps instead of swinging. */}
                <g
                    style={{
                        transform: `rotate(${rotation}deg)`,
                        transformOrigin: `${CX}px ${CY}px`,
                        transition: 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                    opacity={opacity}
                >
                    {ticks.map(({ deg, kind, x1, y1, x2, y2 }) => {
                        return (
                            <line
                                key={deg}
                                x1={x1}
                                y1={y1}
                                x2={x2}
                                y2={y2}
                                stroke={kind === 'cardinal' ? '#f8fafc' : 'rgba(255,255,255,0.5)'}
                                strokeWidth={kind === 'cardinal' ? 2.4 : kind === 'major' ? 1.6 : 0.8}
                                strokeLinecap="round"
                            />
                        );
                    })}

                    {/* Cardinals, with north in red the way every card marks it. */}
                    {Object.entries(CARDINALS).map(([degStr, letter]) => {
                        const deg = Number(degStr);
                        const p = polarToCart(CX, CY, RADIUS - 42, deg);
                        return (
                            <text
                                key={letter}
                                x={p.x}
                                y={p.y}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fill={letter === 'N' ? '#fb7185' : '#f8fafc'}
                                fontSize="19"
                                fontWeight="900"
                                transform={`rotate(${-rotation} ${p.x} ${p.y})`}
                            >
                                {letter}
                            </text>
                        );
                    })}

                    {Object.entries(NUMERALS).map(([degStr, text]) => {
                        const deg = Number(degStr);
                        const p = polarToCart(CX, CY, RADIUS - 40, deg);
                        return (
                            <text
                                key={text}
                                x={p.x}
                                y={p.y}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fill="#cbd5e1"
                                fontSize="12"
                                fontWeight="800"
                                fontFamily="ui-monospace, monospace"
                                transform={`rotate(${-rotation} ${p.x} ${p.y})`}
                            >
                                {text}
                            </text>
                        );
                    })}
                </g>

                {/* THE LUBBER LINE — the boat. Fixed at the top while the world
                    turns behind it, which is the whole idea of a card compass. */}
                <g filter="url(#heading-lubber-glow)" opacity={dead ? 0.3 : 1}>
                    <path
                        d={`M ${CX} ${CY - RADIUS - 2} L ${CX - 9} ${CY - RADIUS + 16} L ${CX + 9} ${CY - RADIUS + 16} Z`}
                        fill={accentColor}
                    />
                    {/* No tail below the triangle: it ran straight through the
                        N on the card at northerly headings, which is the one
                        heading where the mark and the letter must both be
                        readable. The arrowhead alone is the lubber line. */}
                </g>

                {/* Reading. Three digits always — 007 is a heading, 7 is a typo. */}
                <text
                    x={CX}
                    y={CY + 4}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="#f8fafc"
                    fontSize="46"
                    fontWeight="900"
                    fontFamily="ui-monospace, monospace"
                    opacity={dead ? 0.35 : 1}
                >
                    {dead
                        ? '---'
                        : Math.round(value as number)
                              .toString()
                              .padStart(3, '0')}
                </text>
                <text
                    x={CX}
                    y={CY + 34}
                    textAnchor="middle"
                    fill={dead ? '#64748b' : accentColor}
                    fontSize="12"
                    fontWeight="900"
                    letterSpacing="3"
                >
                    {dead ? 'NO DATA' : compassPoint(value as number)}
                </text>
            </svg>
        </div>
    );
};
