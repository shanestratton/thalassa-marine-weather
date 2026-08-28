/**
 * SereneWindRose — a faithful port of the Serene Summer dashboard rose.
 *
 * The reference implementation, its CSS and a target screenshot were handed
 * over in ~/Desktop/wind-rose-for-thalassa. That README is explicit that the
 * PNG is the specification: "if your port looks different from
 * wind-rose.png, the port is wrong." So this is a transcription, not an
 * interpretation — the geometry constants, the gradient stops, the label
 * ranks and the wording are carried across verbatim, and the three warnings
 * it calls out are honoured below.
 *
 * 1. `gaugeKey` is not decoration. Every gradient id is namespaced with it
 *    because `url(#id)` resolves document-wide: two roses sharing a key means
 *    the second paints with the first one's needle gradient, which on
 *    opposite tacks shows THE WRONG SIDE. Two roses are on screen here, so
 *    this matters in practice, not in theory.
 *
 * 2. Red is port, green is starboard, decided by angle alone (>180 = port).
 *    On a boat these two colours are read without thinking and getting them
 *    backwards is worse than drawing nothing.
 *
 * 3. The no-data state draws bezel, arcs and a dash — never a needle at zero.
 *    A needle at the bow when the masthead is silent is a lie, and this
 *    boat's instruments are dark often enough for that to be the common case
 *    rather than the edge one.
 *
 * The palette is pinned locally rather than read from Thalassa's tokens. The
 * handoff ships its own `:root` block, the rose's shading depends on the
 * whole contrast ladder agreeing (surface → grid → axis), and wiring it to
 * app tokens that move independently is how a faithful port stops being one.
 */
import React from 'react';

/** The handoff's dark palette, verbatim. Scoped to the SVG, so nothing here
 *  leaks into the app and no app-level token change can drift the rose. */
const PALETTE: React.CSSProperties = {
    ['--surface-1' as string]: '#1a1a19',
    ['--ink-1' as string]: '#ffffff',
    ['--ink-2' as string]: '#c3c2b7',
    ['--ink-muted' as string]: '#898781',
    ['--grid' as string]: '#2c2c2a',
    ['--axis' as string]: '#383835',
    ['--hairline' as string]: 'rgba(255,255,255,0.10)',
    ['--s2' as string]: '#d95926',
    ['--port' as string]: '#ef5350',
    ['--stbd' as string]: '#25b167',
};

/* Geometry. Everything derives from W and these radii; the box is 380 rather
   than 340 specifically so the degree numerals get a lane of their own
   instead of being wedged between the letters and the arcs. Rescaling means
   scaling all of them together — the spacing is the whole point. */
const W = 380;
const CX = W / 2;
const CY = W / 2;
const RC = 176; // bezel
const RD = 152; // degree numerals
const RL = 126; // point letters
const RI = 112; // inner circle
const RS = 104; // side arcs
const RN = 95; // needle
const RH = 64; // hub

const COMPASS_POINTS = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
];

function compassPoint(bearing: number): string {
    return COMPASS_POINTS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}

const fmt = (v: number | null | undefined, d = 1): string =>
    v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);

const rad = (a: number): number => ((a - 90) * Math.PI) / 180;
const pt = (a: number, r: number): [number, number] => [CX + r * Math.cos(rad(a)), CY + r * Math.sin(rad(a))];

export interface SereneWindRoseProps {
    /** Degrees 0–360, 0 = bow. Null renders the no-data state. */
    angle: number | null;
    speed: number | null;
    unit?: string;
    /** Given, the rose also draws the compass ring and bearing. */
    heading?: number | null;
    /** REQUIRED when more than one rose is on the page — namespaces gradients. */
    gaugeKey: string;
    /**
     * False when the metrics are present but stale. The rose keeps showing
     * the last real numbers — they were true once and a sailor can still use
     * them — but dims, so a frozen reading is never mistaken for a live one.
     * This is distinct from the no-data state, which is for absent values.
     */
    isLive?: boolean;
    className?: string;
    /** Merged over the pinned palette — callers size the rose, never recolour
     *  it: the shading depends on the whole token ladder agreeing. */
    style?: React.CSSProperties;
}

export const SereneWindRose: React.FC<SereneWindRoseProps> = ({
    angle,
    speed,
    unit = 'kn',
    heading = null,
    gaugeKey,
    isLive = true,
    className = '',
    style,
}) => {
    const has = angle !== null && Number.isFinite(angle);
    const hdg = heading !== null && heading !== undefined && Number.isFinite(heading) ? heading : null;
    const ang = has ? (((angle as number) % 360) + 360) % 360 : null;
    const col = !has ? 'var(--ink-muted)' : (ang as number) > 180 ? 'var(--port)' : 'var(--stbd)';
    const U = gaugeKey;
    const id = (name: string) => `${U}-${name}`;

    /* Every ramp steps along the token contrast ladder — surface to grid to
       axis — never toward black or white, so it holds in every theme even
       though the luminance direction flips. One light source, upper left,
       and every gradient agrees with it: that agreement is what makes the
       dial read as one moulded object rather than separately shaded parts. */
    const sideStops = (tok: string) => (
        <>
            <stop offset="0" stopColor={`var(${tok})`} stopOpacity={0.85} />
            <stop offset="0.5" stopColor={`var(${tok})`} stopOpacity={1} />
            <stop offset="1" stopColor={`var(${tok})`} stopOpacity={0.85} />
        </>
    );

    const ticks: React.ReactNode[] = [];
    for (let a = 0; a < 360; a += 15) {
        const major = a % 45 === 0;
        const [x0, y0] = pt(a, RC);
        const [x1, y1] = pt(a, RC - (major ? 14 : 8));
        ticks.push(
            <line
                key={`tick-${a}`}
                x1={x0.toFixed(1)}
                y1={y0.toFixed(1)}
                x2={x1.toFixed(1)}
                y2={y1.toFixed(1)}
                stroke={major ? 'var(--ink-2)' : 'var(--axis)'}
                strokeWidth={major ? 2.5 : 1}
                opacity={major ? 0.95 : 0.55}
            />,
        );
    }

    /* With no heading there is no north to point at, so the ring is labelled
       in degrees off the bow. Compass letters here would put N at the
       masthead and quietly claim she is heading north. */
    const PTS: Array<[number, string, number]> =
        hdg !== null
            ? [
                  [0, 'N', 1],
                  [22.5, 'NNE', 3],
                  [45, 'NE', 2],
                  [67.5, 'ENE', 3],
                  [90, 'E', 1],
                  [112.5, 'ESE', 3],
                  [135, 'SE', 2],
                  [157.5, 'SSE', 3],
                  [180, 'S', 1],
                  [202.5, 'SSW', 3],
                  [225, 'SW', 2],
                  [247.5, 'WSW', 3],
                  [270, 'W', 1],
                  [292.5, 'WNW', 3],
                  [315, 'NW', 2],
                  [337.5, 'NNW', 3],
              ]
            : [
                  [0, 'BOW', 2],
                  [45, '45', 3],
                  [90, '90', 2],
                  [135, '135', 3],
                  [180, '180', 2],
                  [225, '135', 3],
                  [270, '90', 2],
                  [315, '45', 3],
              ];

    const arcPath = (a0: number, a1: number, r: number): string => {
        const [x0, y0] = pt(a0, r);
        const [x1, y1] = pt(a1, r);
        return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    };

    // Needle geometry — only computed when there is an angle to draw.
    let needle: React.ReactNode = null;
    if (has) {
        const a = ang as number;
        const [tx, ty] = pt(a, RN);
        const [b1x, b1y] = pt(a + 150, 26);
        const [b2x, b2y] = pt(a - 150, 26);
        const [wx, wy] = pt(a + 180, 34);
        const [g1x, g1y] = pt(a - 90, 22);
        const [g2x, g2y] = pt(a + 90, 22);
        const tok = a > 180 ? '--port' : '--stbd';
        needle = (
            <>
                <defs>
                    {/* Across the blade, not along it: the spine is bright and
                        both edges ease — a rounded vane rather than a flat
                        kite — and the tip, which carries the angle, never
                        dims. */}
                    <linearGradient
                        id={id('ndl')}
                        gradientUnits="userSpaceOnUse"
                        x1={g1x.toFixed(1)}
                        y1={g1y.toFixed(1)}
                        x2={g2x.toFixed(1)}
                        y2={g2y.toFixed(1)}
                    >
                        <stop offset="0" stopColor={`var(${tok})`} stopOpacity={0.85} />
                        <stop offset="0.36" stopColor={`var(${tok})`} stopOpacity={1} />
                        <stop offset="0.64" stopColor={`var(${tok})`} stopOpacity={1} />
                        <stop offset="1" stopColor={`var(${tok})`} stopOpacity={0.85} />
                    </linearGradient>
                </defs>
                {/* Outlined in --grid, one step off the face: --surface-1
                    would vanish against the face's flat middle. */}
                <path
                    d={`M ${tx.toFixed(1)} ${ty.toFixed(1)} L ${b1x.toFixed(1)} ${b1y.toFixed(1)} L ${wx.toFixed(1)} ${wy.toFixed(1)} L ${b2x.toFixed(1)} ${b2y.toFixed(1)} Z`}
                    fill={`url(#${id('ndl')})`}
                    stroke="var(--grid)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                />
            </>
        );
    }

    const rel = has ? ((ang as number) > 180 ? 360 - (ang as number) : (ang as number)) : null;
    /* Spelled out, not P/S: the ring beside this says S for South, and one
       letter meaning two things on an instrument is how you end up on the
       wrong tack. */
    const side = !has || (ang as number) < 1 || (ang as number) > 359 ? '' : (ang as number) > 180 ? ' PORT' : ' STBD';

    return (
        <svg
            viewBox={`0 0 ${W} ${W}`}
            className={className}
            style={{ ...PALETTE, ...(isLive ? null : { opacity: 0.45 }), ...style }}
            role="img"
            aria-label={
                has
                    ? `Wind ${fmt(rel, 0)} degrees ${(ang as number) > 180 ? 'port' : 'starboard'}, ${fmt(speed, 1)} ${unit}`
                    : 'Wind rose — no data'
            }
        >
            <defs>
                <radialGradient id={id('face')} fx="42%" fy="30%">
                    <stop offset="0" stopColor="var(--surface-1)" stopOpacity={1} />
                    <stop offset="0.58" stopColor="var(--surface-1)" stopOpacity={1} />
                    <stop offset="0.82" stopColor="var(--grid)" stopOpacity={0.55} />
                    <stop offset="0.95" stopColor="var(--axis)" stopOpacity={0.8} />
                    <stop offset="1" stopColor="var(--axis)" stopOpacity={0.3} />
                </radialGradient>
                <linearGradient
                    id={id('bezel')}
                    gradientUnits="userSpaceOnUse"
                    x1={(CX - RC * 0.7).toFixed(1)}
                    y1={(CY - RC * 0.7).toFixed(1)}
                    x2={(CX + RC * 0.7).toFixed(1)}
                    y2={(CY + RC * 0.7).toFixed(1)}
                >
                    <stop offset="0" stopColor="var(--ink-muted)" stopOpacity={0.85} />
                    <stop offset="0.45" stopColor="var(--ink-muted)" stopOpacity={0.45} />
                    <stop offset="1" stopColor="var(--grid)" stopOpacity={0.25} />
                </linearGradient>
                {/* The ramp bottoms out at 0.85, not lower. Night mode tells
                    port from starboard by brightness alone, and at a 0.55
                    floor a port arc's dim end composites darker than a
                    starboard arc's bright end — the gauge contradicting
                    itself about the tack. */}
                <linearGradient
                    id={id('stbd')}
                    gradientUnits="userSpaceOnUse"
                    x1={CX}
                    y1={CY - RS}
                    x2={CX}
                    y2={CY + RS}
                >
                    {sideStops('--stbd')}
                </linearGradient>
                <linearGradient
                    id={id('port')}
                    gradientUnits="userSpaceOnUse"
                    x1={CX}
                    y1={CY - RS}
                    x2={CX}
                    y2={CY + RS}
                >
                    {sideStops('--port')}
                </linearGradient>
                {/* Flat out to 74% so the speed number never sits on a ramp,
                    then a short fall so the boss stands proud of the face. */}
                <radialGradient id={id('hub')} fx="42%" fy="30%">
                    <stop offset="0" stopColor="var(--surface-1)" stopOpacity={1} />
                    <stop offset="0.74" stopColor="var(--surface-1)" stopOpacity={1} />
                    <stop offset="1" stopColor="var(--grid)" stopOpacity={0.45} />
                </radialGradient>
            </defs>

            <circle cx={CX} cy={CY} r={RC - 0.5} fill={`url(#${id('face')})`} />
            <circle cx={CX} cy={CY} r={RC} fill="none" stroke="var(--grid)" strokeWidth={1} />
            <circle cx={CX} cy={CY} r={RC} fill="none" stroke={`url(#${id('bezel')})`} strokeWidth={2.5} />

            {/* The boat stays bow-up and the compass turns underneath her —
                how every MFD and every steering compass does it: what changes
                when you alter course is the world, not the boat. */}
            <g transform={hdg !== null ? `rotate(${(-hdg).toFixed(1)} ${CX} ${CY})` : undefined}>
                <circle cx={CX} cy={CY} r={RI} fill="none" stroke="var(--grid)" strokeWidth={1} opacity={0.6} />
                {ticks}
                {PTS.map(([a, lab, rank]) => {
                    const [x, y] = pt(a, RL);
                    const size = rank === 1 ? 19 : rank === 2 ? 13 : 10;
                    const fill =
                        rank === 1
                            ? lab === 'N'
                                ? 'var(--s2)'
                                : 'var(--ink-1)'
                            : rank === 2
                              ? 'var(--ink-2)'
                              : 'var(--ink-muted)';
                    return (
                        <text
                            key={`pt-${a}-${lab}`}
                            x={x.toFixed(1)}
                            y={(y + size * 0.35).toFixed(1)}
                            textAnchor="middle"
                            fill={fill}
                            fontSize={size}
                            fontWeight={rank === 1 ? 700 : rank === 2 ? 600 : 500}
                            /* Counter-rotated so the letters stay upright
                               while the ring turns — a compass you have to
                               tilt your head to read is a toy. */
                            transform={
                                hdg !== null ? `rotate(${hdg.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})` : undefined
                            }
                            style={{ letterSpacing: '.02em' }}
                        >
                            {lab}
                        </text>
                    );
                })}
                {/* Degree graduations only with a heading: on a bow-relative
                    ring a three-digit number reads as a bearing, and that is
                    how you end up on the wrong tack. */}
                {hdg !== null &&
                    Array.from({ length: 12 }, (_, i) => i * 30).map((a) => {
                        const [x, y] = pt(a, RD);
                        return (
                            <text
                                key={`deg-${a}`}
                                x={x.toFixed(1)}
                                y={(y + 3.9).toFixed(1)}
                                textAnchor="middle"
                                fill="var(--ink-muted)"
                                fontSize={11}
                                fontWeight={600}
                                opacity={0.9}
                                transform={`rotate(${hdg.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`}
                                style={{ letterSpacing: '.06em', fontVariantNumeric: 'tabular-nums' }}
                            >
                                {String(a).padStart(3, '0')}
                            </text>
                        );
                    })}
            </g>

            {/* Boat-fixed layer: port red to the left, starboard green to the
                right, exactly as she sits. These never move — they are the boat. */}
            <path
                d={arcPath(4, 176, RS)}
                fill="none"
                stroke={`url(#${id('stbd')})`}
                strokeWidth={10}
                strokeLinecap="round"
                opacity={0.9}
            />
            <path
                d={arcPath(184, 356, RS)}
                fill="none"
                stroke={`url(#${id('port')})`}
                strokeWidth={10}
                strokeLinecap="round"
                opacity={0.9}
            />
            <path d={`M ${CX} ${CY - RS - 13} l 8 15 l -16 0 Z`} fill="var(--ink-1)" />

            {needle}

            <circle cx={CX} cy={CY} r={RH} fill={`url(#${id('hub')})`} stroke="var(--hairline)" strokeWidth={1} />

            {/* Baselines reasoned in cap heights, not eyeballed: a 46px
                numeral has a cap of ~33, so a baseline at cy+11 puts its top
                at cy-22 — a clear eleven pixels under the angle's baseline at
                cy-34. */}
            <text
                x={CX}
                y={CY + 11}
                textAnchor="middle"
                fill="var(--ink-1)"
                fontSize={46}
                fontWeight={650}
                style={{ letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}
            >
                {speed !== null && speed !== undefined && Number.isFinite(speed) ? fmt(speed, 1) : '—'}
            </text>
            <text x={CX} y={CY + 31} textAnchor="middle" fill="var(--ink-2)" fontSize={14}>
                {unit}
            </text>
            <text
                x={CX}
                y={CY - 34}
                textAnchor="middle"
                fill={col}
                fontSize={17}
                fontWeight={650}
                style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.03em' }}
            >
                {has ? `${fmt(rel, 0)}°${side}` : 'no data'}
            </text>

            {/* Zero-padded, matching the ring scale it is read against — three
                digits always means a compass bearing, two an angle off the
                bow. You can tell which you are looking at from across the
                cabin without reading either. */}
            {has && hdg !== null ? (
                <text
                    x={CX}
                    y={CY + 50}
                    textAnchor="middle"
                    fill="var(--ink-2)"
                    fontSize={12}
                    fontWeight={600}
                    style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.04em' }}
                >
                    {`${fmt(((((ang as number) + hdg) % 360) + 360) % 360, 0).padStart(3, '0')}° ${compassPoint(((((ang as number) + hdg) % 360) + 360) % 360)}`}
                </text>
            ) : has ? (
                <text x={CX} y={CY + 50} textAnchor="middle" fill="var(--ink-muted)" fontSize={12}>
                    no heading
                </text>
            ) : null}
        </svg>
    );
};
