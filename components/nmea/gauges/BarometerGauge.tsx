/**
 * BarometerGauge — an aneroid barometer face, the way one looks on a bulkhead.
 *
 * Shane 2026-09-02: "couldnt we have an actual barometer looking barometer".
 * Quite right: a pressure trace is correct and nobody has ever looked lovingly
 * at a line chart. This is the instrument as it is actually read.
 *
 * THE SET HAND IS THE POINT. A real barometer carries a second, paler pointer
 * that the skipper winds by hand onto the current reading, so that hours later
 * the GAP between the two hands tells the story — that is what a barometer is
 * for, and the number alone never was. Ours sets itself to the reading three
 * hours ago, which is the same gesture done honestly and on time. Wide gap
 * opening anticlockwise: it is falling, and how fast is written in the gap.
 *
 * The weather legend (STORMY / RAIN / CHANGE / FAIR / DRY) is the traditional
 * one, and it is drawn as coloured arc segments rather than words alone so the
 * needle's position reads at a glance from across the cockpit. It is a rough
 * guide by construction — pressure alone cannot forecast, which is precisely
 * why the tendency, not the band, carries the advice elsewhere on the page.
 */
import React, { useMemo } from 'react';

interface BarometerGaugeProps {
    /** Current pressure, hPa. Null renders a dead face rather than a lie. */
    hpa: number | null;
    /** Pressure three hours ago — the self-setting "set hand". */
    setHandHpa?: number | null;
    /** Drives the needle colour so a warning is visible without reading. */
    severity?: 'calm' | 'watch' | 'warn';
    /** Shown small under the pivot; the caller owns the unit conversion. */
    readout?: string;
    readoutUnit?: string;
}

const CX = 150;
const CY = 150;
const RADIUS = 122;
/** Marine range. Below 960 or above 1050 is off the dial for good reason:
 *  either is a once-in-a-career reading, and stretching the scale to hold it
 *  would cost resolution in the 20 hPa where a passage is actually decided. */
const MIN_HPA = 960;
const MAX_HPA = 1050;
/** Bottom-left, sweeping 270 clockwise to bottom-right — so low pressure sits
 *  on the left, rises over the top, and the 90 gap falls symmetrically at the
 *  bottom. That is where every real aneroid puts it; starting at 135 instead
 *  threw the gap onto the right-hand side and the face read lopsided. */
const START_ANGLE = 225;
const SWEEP = 270;

/** The traditional weather-glass legend, as arc segments. */
const BANDS: Array<{ from: number; to: number; label: string; color: string }> = [
    { from: 960, to: 985, label: 'Stormy', color: '#f87171' },
    { from: 985, to: 1000, label: 'Rain', color: '#fbbf24' },
    { from: 1000, to: 1015, label: 'Change', color: '#5eead4' },
    { from: 1015, to: 1030, label: 'Fair', color: '#4ade80' },
    { from: 1030, to: 1050, label: 'Dry', color: '#38bdf8' },
];

const NEEDLE_COLOR: Record<NonNullable<BarometerGaugeProps['severity']>, string> = {
    calm: '#f8fafc',
    watch: '#fbbf24',
    warn: '#f87171',
};

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

/** hPa → dial angle, clamped so an off-scale reading pins at the stop
 *  instead of spinning the needle somewhere meaningless. */
function angleFor(hpa: number): number {
    const clamped = Math.max(MIN_HPA, Math.min(MAX_HPA, hpa));
    return START_ANGLE + ((clamped - MIN_HPA) / (MAX_HPA - MIN_HPA)) * SWEEP;
}

/**
 * Tangential text rotation that never reads upside down. Dial angles run past
 * 360 once the sweep starts at 225, so the lower-half test has to be made on a
 * normalised angle — otherwise every label past the top silently flips back.
 */
function uprightRotation(angleDeg: number): number {
    const a = ((angleDeg % 360) + 360) % 360;
    return a > 90 && a < 270 ? a + 180 : a;
}

export const BarometerGauge: React.FC<BarometerGaugeProps> = ({
    hpa,
    setHandHpa = null,
    severity = 'calm',
    readout,
    readoutUnit = 'hPa',
}) => {
    const dead = hpa === null || !Number.isFinite(hpa);
    const needleAngle = angleFor(dead ? MIN_HPA : (hpa as number));
    const setAngle = setHandHpa !== null && Number.isFinite(setHandHpa) ? angleFor(setHandHpa) : null;

    // Ticks: every 1 hPa, taller every 5, labelled every 10.
    const ticks = useMemo(() => {
        const items: Array<{ angle: number; major: boolean; label: number | null }> = [];
        for (let p = MIN_HPA; p <= MAX_HPA; p += 1) {
            const major = p % 5 === 0;
            items.push({ angle: angleFor(p), major, label: p % 10 === 0 ? p : null });
        }
        return items;
    }, []);

    const needle = polarToCart(CX, CY, RADIUS - 26, needleAngle);
    const needleTail = polarToCart(CX, CY, 18, needleAngle + 180);

    return (
        <div className="relative mx-auto w-full" style={{ maxWidth: 300, aspectRatio: '1' }}>
            <svg viewBox="0 0 300 300" className="w-full h-full" role="img" aria-label="Barometer">
                <defs>
                    <radialGradient id="baro-face" cx="50%" cy="42%" r="72%">
                        <stop offset="0%" stopColor="#1e293b" />
                        <stop offset="70%" stopColor="#0f172a" />
                        <stop offset="100%" stopColor="#020617" />
                    </radialGradient>
                    <filter id="baro-needle-shadow" x="-40%" y="-40%" width="180%" height="180%">
                        <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000" floodOpacity="0.6" />
                    </filter>
                </defs>

                {/* Bezel and face */}
                <circle
                    cx={CX}
                    cy={CY}
                    r={RADIUS + 16}
                    fill="#0b1220"
                    stroke="rgba(255,255,255,0.10)"
                    strokeWidth="2"
                />
                <circle cx={CX} cy={CY} r={RADIUS + 8} fill="url(#baro-face)" stroke="rgba(255,255,255,0.06)" />

                {/* Weather bands — the legend, as colour */}
                {BANDS.map((band) => (
                    <path
                        key={band.label}
                        d={describeArc(CX, CY, RADIUS - 4, angleFor(band.from), angleFor(band.to))}
                        stroke={band.color}
                        strokeWidth="7"
                        strokeOpacity={dead ? 0.15 : 0.55}
                        fill="none"
                        strokeLinecap="butt"
                    />
                ))}

                {/* Band names, set inside their own arc */}
                {BANDS.map((band) => {
                    const mid = (angleFor(band.from) + angleFor(band.to)) / 2;
                    const p = polarToCart(CX, CY, RADIUS - 22, mid);
                    return (
                        <text
                            key={`${band.label}-label`}
                            x={p.x}
                            y={p.y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill={band.color}
                            fillOpacity={dead ? 0.25 : 0.75}
                            fontSize="8"
                            fontWeight="800"
                            letterSpacing="1.1"
                            /* Tangential, but flipped through the lower half —
                               a label rotated by its own dial angle reads
                               upside down anywhere past the horizontal, which
                               made STORMY and RAIN unreadable exactly where a
                               skipper most wants to read them. */
                            transform={`rotate(${uprightRotation(mid)}, ${p.x}, ${p.y})`}
                        >
                            {band.label.toUpperCase()}
                        </text>
                    );
                })}

                {/* Ticks and numerals */}
                {ticks.map((tick) => {
                    const outer = polarToCart(CX, CY, RADIUS - 32, tick.angle);
                    const inner = polarToCart(CX, CY, RADIUS - (tick.major ? 42 : 37), tick.angle);
                    return (
                        <line
                            key={`t-${tick.angle}`}
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
                {ticks
                    .filter((t) => t.label !== null)
                    .map((tick) => {
                        const p = polarToCart(CX, CY, RADIUS - 56, tick.angle);
                        return (
                            <text
                                key={`n-${tick.label}`}
                                x={p.x}
                                y={p.y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="#e2e8f0"
                                fillOpacity={dead ? 0.3 : 0.9}
                                fontSize="11"
                                fontWeight="800"
                                fontFamily="ui-monospace, monospace"
                            >
                                {tick.label}
                            </text>
                        );
                    })}

                {/* THE SET HAND — where the pressure stood three hours ago.
                    Deliberately thin, pale and hollow-tipped so it reads as a
                    reference mark rather than a second reading. */}
                {setAngle !== null && !dead && (
                    <g opacity="0.72">
                        <line
                            x1={CX}
                            y1={CY}
                            x2={polarToCart(CX, CY, RADIUS - 30, setAngle).x}
                            y2={polarToCart(CX, CY, RADIUS - 30, setAngle).y}
                            stroke="#94a3b8"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        />
                        <circle
                            cx={polarToCart(CX, CY, RADIUS - 30, setAngle).x}
                            cy={polarToCart(CX, CY, RADIUS - 30, setAngle).y}
                            r="3.2"
                            fill="none"
                            stroke="#94a3b8"
                            strokeWidth="1.6"
                        />
                    </g>
                )}

                {/* The reading itself */}
                <g filter="url(#baro-needle-shadow)" opacity={dead ? 0.25 : 1}>
                    <line
                        x1={needleTail.x}
                        y1={needleTail.y}
                        x2={needle.x}
                        y2={needle.y}
                        stroke={NEEDLE_COLOR[severity]}
                        strokeWidth="3.2"
                        strokeLinecap="round"
                    />
                    <circle cx={CX} cy={CY} r="8" fill="#0f172a" stroke={NEEDLE_COLOR[severity]} strokeWidth="2" />
                    <circle cx={CX} cy={CY} r="2.6" fill={NEEDLE_COLOR[severity]} />
                </g>

                {/* Digital readout, low on the face where a real one prints its maker */}
                {readout && (
                    <>
                        {/* Tucked INSIDE the numeral ring. The numerals sit at
                            radius 66, so the bottom of the dial reads at about
                            CY+66 — a readout at CY+52 in 26px collided with
                            960-990 and buried both. */}
                        <text
                            x={CX}
                            y={CY + 33}
                            textAnchor="middle"
                            fill="#f8fafc"
                            fontSize="19"
                            fontWeight="900"
                            fontFamily="ui-monospace, monospace"
                            opacity={dead ? 0.35 : 1}
                        >
                            {readout}
                        </text>
                        <text
                            x={CX}
                            y={CY + 46}
                            textAnchor="middle"
                            fill="#94a3b8"
                            fontSize="8"
                            fontWeight="800"
                            letterSpacing="2"
                        >
                            {readoutUnit.toUpperCase()}
                        </text>
                    </>
                )}
            </svg>
        </div>
    );
};
