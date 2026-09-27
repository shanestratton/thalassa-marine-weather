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
 *
 * The bells and the watch are SAID under the dial, in HTML, not printed on
 * it: on the face the hands swept across them ("One bel", UX scorecard run 6).
 * By night the face is deep parchment rather than ivory — a 355 px near-white
 * disc was the brightest thing on a dark bridge. The ivory palette is still
 * the drawn default, and daylight keeps it.
 */
import React, { useMemo } from 'react';
import '../instrumentDaylight.css';
import { CLOCK_MAX_WIDTH } from '../instrumentLayout';
import { polarToCart } from './gaugeGeometry';
import { bellsAt, bellsSpoken, watchAt } from '../../../utils/shipsBells';

interface ShipsBellClockProps {
    /** The moment to show, already in the chosen zone's wall-clock terms. */
    hour: number;
    minute: number;
    second: number;
    /** Shown under the pivot — the zone's short name, e.g. AEST. */
    zoneLabel?: string;
    /** Upper bound on the face's width. The Instrument Panel passes one that
     *  leaves room for the caption under the dial; defaults to CLOCK_MAX_WIDTH. */
    faceMaxWidth?: string;
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

/*
 * Night palette, applied by CSS when the app is NOT in daylight, so the drawn
 * attributes stay the ivory face (and a missing stylesheet falls back to it).
 * Deep parchment: the dial's luminance drops from ~0.6 to ~0.4; hour numerals
 * stay ≥ 5:1 and the engraved legend, darkened to #3d2d0e, ≥ 5.6:1. Literal
 * class strings, because Tailwind only generates what it can read.
 */
const NIGHT_FACE_CLASSES = [
    '[:root:not(.display-light)_&_.bell-face]:[fill:url(#bell-dial-night)]',
    '[:root:not(.display-light)_&_.bell-case]:[fill:url(#bell-bezel-night)]',
    '[:root:not(.display-light)_&_.bell-legend]:[fill:#3d2d0e]',
    '[:root:not(.display-light)_&_.bell-mark]:[stroke:#3d2d0e]',
    '[:root:not(.display-light)_&_.bell-mark-lit]:[fill:#3d2d0e]',
].join(' ');

export const ShipsBellClock: React.FC<ShipsBellClockProps> = ({
    hour,
    minute,
    second,
    zoneLabel,
    faceMaxWidth = CLOCK_MAX_WIDTH,
}) => {
    const bells = bellsAt(hour, minute);
    const watch = watchAt(hour, minute);

    // Hands. The hour hand creeps with the minutes, as a real one does — an
    // hour hand that jumps on the hour reads as a toy.
    const hourAngle = ((hour % 12) + minute / 60 + second / 3600) * 30;
    const minuteAngle = (minute + second / 60) * 6;
    const secondAngle = second * 6;

    // What a screen reader hears: the time, the zone, the bells and the watch,
    // in one sentence. The face's own text is aria-hidden so it is not read a
    // second time as twelve loose numerals and four captions. Minutes only —
    // the name must not churn every second.
    const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
    const spokenLabel = [
        "Ship's bell clock",
        `${pad2(hour)}:${pad2(minute)}${zoneLabel ? ` ${zoneLabel}` : ''}`,
        bellsSpoken(bells).toLowerCase(),
        watch.name.toLowerCase(),
    ].join(', ');

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

    // FILLS THE SCREEN IT IS GIVEN.
    //
    // This was capped at 300px, which left a bulkhead clock sitting as a
    // postage stamp in the middle of a phone. The face is vector, so it costs
    // nothing to draw it at any size (Shane 2026-09-04: "make the clock so that
    // it fits the entire width of the screen. shrink and grow depending on the
    // punters screen").
    //
    // Capping against 70% of the available height makes it behave on BOTH axes: on a phone, where
    // the section is taller than it is wide, 100% wins and the face spans the
    // screen; on a short or landscape screen the height wins, so a square that fills
    // the width can never run off the bottom.
    return (
        <div className="flex w-full flex-col items-center">
            <div
                className={`nmea-clock relative mx-auto w-full ${NIGHT_FACE_CLASSES}`}
                style={{ maxWidth: faceMaxWidth, aspectRatio: '1' }}
            >
                <svg viewBox="0 0 300 300" className="w-full h-full" role="img" aria-label={spokenLabel}>
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
                        <radialGradient id="bell-dial-night" cx="50%" cy="38%" r="70%">
                            <stop offset="0%" stopColor="#c9b68c" />
                            <stop offset="72%" stopColor="#bba77c" />
                            <stop offset="100%" stopColor="#a8956c" />
                        </radialGradient>
                        <linearGradient id="bell-bezel-night" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#b39556" />
                            <stop offset="45%" stopColor="#8a6c2f" />
                            <stop offset="100%" stopColor="#5a4417" />
                        </linearGradient>
                        <filter id="bell-hand-shadow" x="-40%" y="-40%" width="180%" height="180%">
                            <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.35" />
                        </filter>
                    </defs>

                    {/* Brass case */}
                    <circle className="bell-case" cx={CX} cy={CY} r={RADIUS + 22} fill="url(#bell-bezel)" />
                    <circle
                        cx={CX}
                        cy={CY}
                        r={RADIUS + 12}
                        fill="none"
                        stroke={BRASS_DARK}
                        strokeWidth="1.5"
                        opacity="0.7"
                    />
                    <circle
                        className="bell-face"
                        cx={CX}
                        cy={CY}
                        r={RADIUS + 6}
                        fill="url(#bell-dial)"
                        stroke={BRASS_DARK}
                        strokeWidth="1"
                    />

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
                                aria-hidden="true"
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

                    {/* fontSize 12, the floor itself: 11 still scanned as 11 px
                    (UX scorecard run 7). Below the pivot, above the bell dots
                    (CY + 60), clear of the 8 and the 4: in the upper half the
                    hands swept through it ('SI IP'S BELL' at 23:54). The zone
                    left the face for the same reason; the caption under the
                    dial and the spoken label keep it (UX scorecard run 9). */}
                    <text
                        className="bell-legend"
                        aria-hidden="true"
                        x={CX}
                        y={CY + 40}
                        textAnchor="middle"
                        fill={BRASS_DARK}
                        fontSize="12"
                        fontWeight="700"
                        letterSpacing="2"
                        fontFamily="Georgia, 'Times New Roman', serif"
                    >
                        SHIP&apos;S BELL
                    </text>

                    {/* The bell row, filled to the current count. At CY + 60, not
                        + 72: there the first dot touched the 7 and the last
                        the 5 (UX scorecard run 7). */}
                    {bellMarks.map((m) => {
                        const lit = m.index <= bells;
                        return (
                            <circle
                                key={`b-${m.index}`}
                                className={lit ? 'bell-mark bell-mark-lit' : 'bell-mark'}
                                cx={m.x}
                                cy={CY + 60}
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
            {/* What the bells mean, said the way it is said aloud, and the
                watch — under the dial where no hand crosses them. The img's
                name already speaks both, so this is not read twice. */}
            <p aria-hidden="true" className="mt-2 shrink-0 text-center leading-tight">
                <span className="block font-serif text-lg font-bold text-gray-200">{bellsSpoken(bells)}</span>
                <span className="mt-0.5 block text-xs font-bold uppercase tracking-[0.15em] text-amber-300">
                    {watch.name}
                    {zoneLabel ? ` · ${zoneLabel}` : ''}
                </span>
            </p>
        </div>
    );
};
