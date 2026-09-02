/**
 * RudderGauge — a rudder angle indicator, round, in the barometer's language.
 *
 * Shane 2026-09-02: "can we have a round guage that literally shows you where
 * the rudder is like 0 is middle etc… the same style as the barometer."
 *
 * WHY A DIAL BEATS THE BAR IT REPLACES: rudder angle is the one instrument
 * whose reading IS a physical position. A bar asks you to convert a length
 * into an angle; a needle at two o'clock simply is the rudder, sitting where
 * the blade sits. Amidships is dead ahead at the top, so "centred" is a
 * glance rather than a measurement.
 *
 * PORT RED, STARBOARD GREEN — nav-light convention, and the same colours the
 * bar used, so the meaning does not change with the shape. The needle takes
 * the side's colour: at a hard-over reading, the whole instrument says which
 * way without a word being read.
 */
import React, { useMemo } from 'react';
import { polarToCart, describeArc } from './gaugeGeometry';

interface RudderGaugeProps {
    /** Degrees. Negative = port, positive = starboard, 0 = amidships. */
    angle: number | null;
    /** Hard-over limit; the dial ends here and readings clamp to it. */
    maxAngle?: number;
    /** Dimmed when the reading is stale or the sensor is quiet. */
    freshness?: 'live' | 'stale' | 'dead';
}

const CX = 150;
const CY = 150;
const RADIUS = 122;
/** The dial spans 140 — enough to be read as an angle, tight enough that
 *  every degree of it is legible. Amidships is at 0 (straight up). */
const HALF_SWEEP = 70;

const PORT = '#fb7185';
const STBD = '#34d399';
const MID = '#e2e8f0';

export const RudderGauge: React.FC<RudderGaugeProps> = ({ angle, maxAngle = 40, freshness = 'live' }) => {
    const dead = angle === null || !Number.isFinite(angle) || freshness === 'dead';
    const opacity = dead ? 0.3 : freshness === 'stale' ? 0.65 : 1;
    const value = dead ? 0 : Math.max(-maxAngle, Math.min(maxAngle, angle as number));
    /** Rudder degrees → dial degrees. */
    const dialFor = (deg: number): number => (deg / maxAngle) * HALF_SWEEP;
    const needleAngle = dialFor(value);

    // A dead band either side of centre: a rudder is never perfectly still,
    // and calling 0.2 "port" would flicker the label on every wave.
    const side = dead ? 'mid' : value < -0.3 ? 'port' : value > 0.3 ? 'stbd' : 'mid';
    const needleColor = side === 'port' ? PORT : side === 'stbd' ? STBD : MID;

    const ticks = useMemo(() => {
        const items: Array<{ dial: number; major: boolean; label: number | null }> = [];
        for (let d = -maxAngle; d <= maxAngle; d += 2.5) {
            const major = Math.abs(d % 10) < 0.01;
            items.push({ dial: dialFor(d), major, label: major && d !== 0 ? Math.abs(d) : null });
        }
        return items;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maxAngle]);

    const tip = polarToCart(CX, CY, RADIUS - 34, needleAngle);
    const tail = polarToCart(CX, CY, 16, needleAngle + 180);

    return (
        <div className="relative mx-auto w-full" style={{ maxWidth: 300, aspectRatio: '1' }}>
            <svg viewBox="0 0 300 300" className="w-full h-full" role="img" aria-label="Rudder angle">
                <defs>
                    <radialGradient id="rudder-face" cx="50%" cy="42%" r="72%">
                        <stop offset="0%" stopColor="#1e293b" />
                        <stop offset="70%" stopColor="#0f172a" />
                        <stop offset="100%" stopColor="#020617" />
                    </radialGradient>
                    <filter id="rudder-needle-shadow" x="-40%" y="-40%" width="180%" height="180%">
                        <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000" floodOpacity="0.6" />
                    </filter>
                </defs>

                <circle
                    cx={CX}
                    cy={CY}
                    r={RADIUS + 16}
                    fill="#0b1220"
                    stroke="rgba(255,255,255,0.10)"
                    strokeWidth="2"
                />
                <circle cx={CX} cy={CY} r={RADIUS + 8} fill="url(#rudder-face)" stroke="rgba(255,255,255,0.06)" />

                {/* Port and starboard halves */}
                <path
                    d={describeArc(CX, CY, RADIUS - 6, -HALF_SWEEP, 0)}
                    stroke={PORT}
                    strokeWidth="7"
                    strokeOpacity={dead ? 0.15 : 0.5}
                    fill="none"
                />
                <path
                    d={describeArc(CX, CY, RADIUS - 6, 0, HALF_SWEEP)}
                    stroke={STBD}
                    strokeWidth="7"
                    strokeOpacity={dead ? 0.15 : 0.5}
                    fill="none"
                />

                {/* No PORT / STBD wording on the arc. It collided with the
                    numerals, and it was saying what the face already says
                    three other ways: red to the left and green to the right by
                    nav-light convention, the needle taking that side's colour,
                    and the readout spelling the side out in full underneath —
                    which is also what keeps this readable without relying on
                    colour alone. */}

                {/* Ticks, and the amidships mark that matters more than the rest */}
                {ticks.map((tick) => {
                    const outer = polarToCart(CX, CY, RADIUS - 16, tick.dial);
                    const inner = polarToCart(CX, CY, RADIUS - (tick.major ? 30 : 24), tick.dial);
                    return (
                        <line
                            key={`t-${tick.dial}`}
                            x1={outer.x}
                            y1={outer.y}
                            x2={inner.x}
                            y2={inner.y}
                            stroke="rgba(255,255,255,0.55)"
                            strokeWidth={tick.major ? 1.6 : 0.7}
                            strokeOpacity={dead ? 0.25 : 1}
                        />
                    );
                })}
                {/* AMIDSHIPS. The one reading a helmsman looks for, so it gets a
                    full-length white mark rather than another tick. */}
                <line
                    x1={polarToCart(CX, CY, RADIUS - 10, 0).x}
                    y1={polarToCart(CX, CY, RADIUS - 10, 0).y}
                    x2={polarToCart(CX, CY, RADIUS - 38, 0).x}
                    y2={polarToCart(CX, CY, RADIUS - 38, 0).y}
                    stroke="#f8fafc"
                    strokeWidth="2.4"
                    strokeOpacity={dead ? 0.3 : 0.95}
                />
                {ticks
                    .filter((t) => t.label !== null)
                    .map((tick) => {
                        const p = polarToCart(CX, CY, RADIUS - 46, tick.dial);
                        return (
                            <text
                                key={`n-${tick.dial}`}
                                x={p.x}
                                y={p.y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="#e2e8f0"
                                fillOpacity={dead ? 0.3 : 0.85}
                                fontSize="10"
                                fontWeight="800"
                                fontFamily="ui-monospace, monospace"
                            >
                                {tick.label}
                            </text>
                        );
                    })}

                {/* The blade */}
                <g filter="url(#rudder-needle-shadow)" opacity={opacity}>
                    <line
                        x1={tail.x}
                        y1={tail.y}
                        x2={tip.x}
                        y2={tip.y}
                        stroke={needleColor}
                        strokeWidth="3.4"
                        strokeLinecap="round"
                    />
                    <circle cx={CX} cy={CY} r="8" fill="#0f172a" stroke={needleColor} strokeWidth="2" />
                    <circle cx={CX} cy={CY} r="2.6" fill={needleColor} />
                </g>

                {/* Reading, below the pivot and inside the numerals */}
                <text
                    x={CX}
                    y={CY + 46}
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize="30"
                    fontWeight="900"
                    fontFamily="ui-monospace, monospace"
                    opacity={dead ? 0.35 : 1}
                >
                    {dead ? '--' : `${Math.abs(value).toFixed(1)}°`}
                </text>
                <text
                    x={CX}
                    y={CY + 64}
                    textAnchor="middle"
                    fill={dead ? '#64748b' : needleColor}
                    fontSize="10"
                    fontWeight="900"
                    letterSpacing="2.5"
                >
                    {dead ? 'NO DATA' : side === 'port' ? 'PORT' : side === 'stbd' ? 'STARBOARD' : 'AMIDSHIPS'}
                </text>
            </svg>
        </div>
    );
};
