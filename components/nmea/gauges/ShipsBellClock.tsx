/**
 * ShipsBellClock — a Chelsea-pattern ship's bell clock.
 *
 * Shane 2026-09-03: "build a beautiful chelsea ships bell clock… the whole
 * works."
 *
 * WHY IT LOOKS NOTHING LIKE THE OTHER DIALS. The barometer, rudder and compass
 * are instruments: dark faces, thin needles, a number you read in a glance and
 * act on. A ship's bell clock is not an instrument, it is the object screwed to
 * the bulkhead — brass bezel, ivory dial, blued-steel hands — and pretending
 * otherwise would make it a worse clock and a duller thing to own. It sits in
 * the same panel and deliberately does not match it.
 *
 * The bell ring around the inside is the part a sailor actually reads: eight
 * markers, grouped in the PAIRS they are struck in, filled to the current
 * count. Five bells is two, two, one — and the ring shows exactly that, so the
 * gap between the pairs is the same gap you would hear.
 */
import React, { useMemo } from 'react';
import { polarToCart } from './gaugeGeometry';
import { bellsAt, bellsSpoken, watchAt } from '../../../utils/shipsBells';

interface ShipsBellClockProps {
    /** The moment to show, already in the chosen zone's wall-clock terms. */
    hour: number;
    minute: number;
    second: number;
    /** Shown under the pivot — the zone's short name, e.g. AEST. */
    zoneLabel?: string;
}

const CX = 150;
const CY = 150;
const RADIUS = 122;

const BRASS_LIGHT = '#e8c987';
const BRASS = '#b8923f';
const BRASS_DARK = '#7a5f26';
const DIAL = '#f4ecd8';
const INK = '#20242c';
const BLUED = '#2a3550';

export const ShipsBellClock: React.FC<ShipsBellClockProps> = ({ hour, minute, second, zoneLabel }) => {
    const bells = bellsAt(hour, minute);
    const watch = watchAt(hour, minute);

    // Hands. The hour hand creeps with the minutes, as a real one does — an
    // hour hand that jumps on the hour reads as a toy.
    const hourAngle = ((hour % 12) + minute / 60 + second / 3600) * 30;
    const minuteAngle = (minute + second / 60) * 6;
    const secondAngle = second * 6;

    /**
     * Eight markers in a row, grouped in the PAIRS they are struck in.
     *
     * A row, not a ring: the first attempt arced them across the lower dial
     * and they collided with the watch name and the hour numerals, which is
     * exactly the part of a clock face that must stay clean. Down here they sit
     * in the empty band between the legend and the 6, and the wider gaps
     * between groups are the same gaps you would hear.
     */
    const bellMarks = useMemo(() => {
        const marks: Array<{ x: number; index: number }> = [];
        const withinPair = 9;
        const betweenPairs = 16;
        const width = 4 * withinPair + 3 * betweenPairs;
        let x = CX - width / 2;
        let index = 0;
        for (let g = 0; g < 4; g++) {
            for (let inPair = 0; inPair < 2; inPair++) {
                index += 1;
                marks.push({ x, index });
                if (inPair === 0) x += withinPair;
            }
            x += betweenPairs;
        }
        return marks;
    }, []);

    return (
        <div className="relative mx-auto w-full" style={{ maxWidth: 300, aspectRatio: '1' }}>
            <svg viewBox="0 0 300 300" className="w-full h-full" role="img" aria-label="Ship's bell clock">
                <defs>
                    <linearGradient id="bell-bezel" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={BRASS_LIGHT} />
                        <stop offset="45%" stopColor={BRASS} />
                        <stop offset="100%" stopColor={BRASS_DARK} />
                    </linearGradient>
                    <radialGradient id="bell-dial" cx="50%" cy="38%" r="70%">
                        <stop offset="0%" stopColor="#fffaf0" />
                        <stop offset="72%" stopColor={DIAL} />
                        <stop offset="100%" stopColor="#e2d6bb" />
                    </radialGradient>
                    <filter id="bell-hand-shadow" x="-40%" y="-40%" width="180%" height="180%">
                        <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.35" />
                    </filter>
                </defs>

                {/* Brass case */}
                <circle cx={CX} cy={CY} r={RADIUS + 22} fill="url(#bell-bezel)" />
                <circle
                    cx={CX}
                    cy={CY}
                    r={RADIUS + 12}
                    fill="none"
                    stroke={BRASS_DARK}
                    strokeWidth="1.5"
                    opacity="0.7"
                />
                <circle cx={CX} cy={CY} r={RADIUS + 6} fill="url(#bell-dial)" stroke={BRASS_DARK} strokeWidth="1" />

                {/* Minute track: a tick a minute, longer every five. */}
                {Array.from({ length: 60 }, (_, i) => {
                    const five = i % 5 === 0;
                    const outer = polarToCart(CX, CY, RADIUS - 2, i * 6);
                    const inner = polarToCart(CX, CY, RADIUS - (five ? 12 : 7), i * 6);
                    return (
                        <line
                            key={`m-${i}`}
                            x1={outer.x}
                            y1={outer.y}
                            x2={inner.x}
                            y2={inner.y}
                            stroke={INK}
                            strokeWidth={five ? 1.8 : 0.7}
                            strokeOpacity={five ? 0.85 : 0.5}
                        />
                    );
                })}

                {/* Hours, in the serif a Chelsea dial wears. */}
                {Array.from({ length: 12 }, (_, i) => {
                    const n = i === 0 ? 12 : i;
                    const p = polarToCart(CX, CY, RADIUS - 30, i * 30);
                    return (
                        <text
                            key={`h-${n}`}
                            x={p.x}
                            y={p.y}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill={INK}
                            fontSize="20"
                            fontWeight="700"
                            fontFamily="Georgia, 'Times New Roman', serif"
                        >
                            {n}
                        </text>
                    );
                })}

                <text
                    x={CX}
                    y={CY - 52}
                    textAnchor="middle"
                    fill={BRASS_DARK}
                    fontSize="9"
                    fontWeight="700"
                    letterSpacing="3"
                    fontFamily="Georgia, 'Times New Roman', serif"
                >
                    SHIP&apos;S BELL
                </text>

                {/* The zone this face is keeping. Lost in a layout edit and put
                    back: a clock showing a time without saying WHICH time is
                    the one thing a clock must never do. */}
                {zoneLabel && (
                    <text
                        x={CX}
                        y={CY - 36}
                        textAnchor="middle"
                        fill={BRASS_DARK}
                        fontSize="11"
                        fontWeight="700"
                        letterSpacing="1.2"
                    >
                        {zoneLabel}
                    </text>
                )}

                {/* What the bells mean, said the way it is said aloud. */}
                <text
                    x={CX}
                    y={CY + 42}
                    textAnchor="middle"
                    fill={INK}
                    fontSize="13"
                    fontWeight="700"
                    fontFamily="Georgia, 'Times New Roman', serif"
                >
                    {bellsSpoken(bells)}
                </text>
                <text
                    x={CX}
                    y={CY + 56}
                    textAnchor="middle"
                    fill={BRASS_DARK}
                    fontSize="9"
                    fontWeight="700"
                    letterSpacing="1.4"
                >
                    {watch.name.toUpperCase()}
                </text>

                {/* The bell row, filled to the current count. */}
                {bellMarks.map((m) => {
                    const lit = m.index <= bells;
                    return (
                        <circle
                            key={`b-${m.index}`}
                            cx={m.x}
                            cy={CY + 72}
                            r={lit ? 3.4 : 2.4}
                            fill={lit ? BRASS_DARK : 'none'}
                            stroke={BRASS_DARK}
                            strokeWidth="1.1"
                            opacity={lit ? 1 : 0.35}
                        />
                    );
                })}

                {/* Hands: blued steel, spade tips. */}
                <g filter="url(#bell-hand-shadow)">
                    <line
                        x1={polarToCart(CX, CY, 16, hourAngle + 180).x}
                        y1={polarToCart(CX, CY, 16, hourAngle + 180).y}
                        x2={polarToCart(CX, CY, RADIUS - 66, hourAngle).x}
                        y2={polarToCart(CX, CY, RADIUS - 66, hourAngle).y}
                        stroke={BLUED}
                        strokeWidth="6"
                        strokeLinecap="round"
                    />
                    <line
                        x1={polarToCart(CX, CY, 20, minuteAngle + 180).x}
                        y1={polarToCart(CX, CY, 20, minuteAngle + 180).y}
                        x2={polarToCart(CX, CY, RADIUS - 22, minuteAngle).x}
                        y2={polarToCart(CX, CY, RADIUS - 22, minuteAngle).y}
                        stroke={BLUED}
                        strokeWidth="4"
                        strokeLinecap="round"
                    />
                    <line
                        x1={polarToCart(CX, CY, 26, secondAngle + 180).x}
                        y1={polarToCart(CX, CY, 26, secondAngle + 180).y}
                        x2={polarToCart(CX, CY, RADIUS - 14, secondAngle).x}
                        y2={polarToCart(CX, CY, RADIUS - 14, secondAngle).y}
                        stroke="#8c2f24"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                    />
                    <circle cx={CX} cy={CY} r="6" fill={BRASS_DARK} />
                    <circle cx={CX} cy={CY} r="2.4" fill={DIAL} />
                </g>
            </svg>
        </div>
    );
};
