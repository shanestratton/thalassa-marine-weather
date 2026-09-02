/**
 * SailPartsDiagram — the names, on the sails, once.
 *
 * The trim advice talks about leech telltales, the luff breathing, the clew
 * rising, the roach and the battens that hold it. Those words are only useful
 * if you can point at them, and a list of definitions is the one format that
 * guarantees you cannot (Shane 2026-08-28: "can we have a parts of a sail
 * diagram in there as well").
 *
 * TWO SAILS, because the whole point is that the names travel (Shane
 * 2026-09-02, with a reference drawing). Head, tack, clew, luff, leech and
 * foot mean the same thing on the main as on the yankee — showing only the
 * main invites the reader to assume a headsail has its own vocabulary. The
 * differences that ARE real get called out instead: the main's roach and the
 * battens holding it, the yankee's high-cut foot.
 *
 * Deliberately static and unlabelled by data: this is a reference, not an
 * instrument. Nothing here reads the boat, so nothing here can be wrong about
 * the boat — which is why it can sit safely beside a live diagram without the
 * two being confused for one another.
 */
import React from 'react';

const W = 640;
const H = 320;

const INK = '#f8fafc';
const EDGE = '#60a5fa'; // edge names — one colour, so LUFF reads as a kind of word
const CORNER = '#fb923c'; // corners, and the battens that share their orange
const SPAR = '#d4d4d8'; // mast, boom, forestay, deck — the hardware, not the sail
const NOTE = '#a1a1aa';
const SHEET = '#34d399';
const MAIN_FILL = 'rgba(51,65,85,0.55)';
const JIB_FILL = 'rgba(120,90,40,0.45)';

/** Mainsail — mast up the left, boom along the foot. */
const M_HEAD: [number, number] = [88, 40];
const M_TACK: [number, number] = [88, 222];
const M_CLEW: [number, number] = [246, 222];

/** Yankee — hanked to a raked forestay, foot cut high above the deck. */
const Y_HEAD: [number, number] = [430, 36];
const Y_TACK: [number, number] = [396, 226];
const Y_CLEW: [number, number] = [576, 152];

/** Label with a dashed leader back to the thing it names. */
const Leader: React.FC<{
    from: [number, number];
    to: [number, number];
    label: string;
    fill: string;
    anchor?: 'start' | 'middle' | 'end';
    size?: number;
}> = ({ from, to, label, fill, anchor = 'middle', size = 11 }) => (
    <g>
        <line
            x1={from[0]}
            y1={from[1]}
            x2={to[0]}
            y2={to[1]}
            stroke={NOTE}
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.7}
        />
        <text
            x={from[0]}
            y={from[1]}
            textAnchor={anchor}
            fill={fill}
            fontSize={size}
            fontWeight={900}
            style={{ letterSpacing: '.12em' }}
        >
            {label}
        </text>
    </g>
);

const Corner: React.FC<{ at: [number, number]; label: string; dx: number; dy: number }> = ({ at, label, dx, dy }) => (
    <g>
        <circle cx={at[0]} cy={at[1]} r={4} fill={CORNER} />
        <text
            x={at[0] + dx}
            y={at[1] + dy}
            textAnchor="middle"
            fill={INK}
            fontSize={12}
            fontWeight={900}
            style={{ letterSpacing: '.1em' }}
        >
            {label}
        </text>
    </g>
);

export const SailPartsDiagram: React.FC<{ className?: string }> = ({ className = '' }) => (
    <svg
        viewBox={`0 0 ${W} ${H}`}
        className={className}
        role="img"
        aria-label="Parts of a mainsail, and of a yankee headsail — the same names on both. head at the top, tack at the bottom of the luff, clew at the aft lower corner; the luff is the leading edge, the leech the trailing edge, the foot the bottom. The mainsail's leech curves out into the roach, held by battens. A yankee is cut high so its foot clears the deck."
    >
        {/* ── MAINSAIL ─────────────────────────────────────────── */}
        {/* Mast and boom: the spars the three corners attach to. */}
        <line x1={M_HEAD[0]} y1={26} x2={M_TACK[0]} y2={246} stroke={SPAR} strokeWidth={5} strokeLinecap="round" />
        <line x1={74} y1={M_TACK[1]} x2={262} y2={M_CLEW[1]} stroke={SPAR} strokeWidth={5} strokeLinecap="round" />
        <text x={M_HEAD[0] - 6} y={20} textAnchor="middle" fill={NOTE} fontSize={9}>
            mast
        </text>

        {/* The sail. The leech is drawn convex on purpose — the roach IS that
            curve, and a straight trailing edge would quietly deny the thing
            the battens exist to hold. */}
        <path
            d={`M ${M_HEAD[0]} ${M_HEAD[1]} L ${M_TACK[0]} ${M_TACK[1]} L ${M_CLEW[0]} ${M_CLEW[1]}
                Q ${M_CLEW[0] + 6} ${(M_HEAD[1] + M_CLEW[1]) / 2 - 30}, ${M_HEAD[0]} ${M_HEAD[1]} Z`}
            fill={MAIN_FILL}
            stroke={SPAR}
            strokeWidth={1.6}
        />

        {/* Battens, in the corner colour so they read as structure. */}
        {[0.36, 0.62].map((t, i) => {
            const y = M_HEAD[1] + (M_CLEW[1] - M_HEAD[1]) * t;
            const xEnd = M_CLEW[0] - 30 * (1 - t) + 4;
            return (
                <line
                    key={i}
                    x1={M_HEAD[0] + 4}
                    y1={y}
                    x2={xEnd}
                    y2={y}
                    stroke={CORNER}
                    strokeWidth={2.4}
                    opacity={0.9}
                />
            );
        })}
        <text x={M_HEAD[0] + 18} y={92} fill={CORNER} fontSize={9} fontWeight={800}>
            BATTENS
        </text>
        <text x={M_HEAD[0] + 18} y={103} fill={NOTE} fontSize={9}>
            hold the roach out
        </text>
        <text x={M_HEAD[0] + 16} y={186} fill={CORNER} fontSize={9} fontWeight={800}>
            reef down to a batten
        </text>

        <Corner at={M_HEAD} label="HEAD" dx={26} dy={-6} />
        <Corner at={M_TACK} label="TACK" dx={-22} dy={18} />
        <Corner at={M_CLEW} label="CLEW" dx={24} dy={18} />

        <Leader from={[26, 128]} to={[M_HEAD[0] - 4, 128]} label="LUFF" fill={EDGE} anchor="start" />
        <Leader from={[150, 258]} to={[152, M_TACK[1] + 4]} label="FOOT" fill={EDGE} />
        {/* The leech label sits out in the clear and points back at the curve,
            because the curve is the part worth naming. */}
        <Leader from={[276, 108]} to={[M_CLEW[0] - 8, 132]} label="LEECH" fill={EDGE} anchor="start" />
        <text x={276} y={122} fill={NOTE} fontSize={9}>
            the curve is
        </text>
        <text x={276} y={133} fill={NOTE} fontSize={9}>
            the ROACH
        </text>

        <text x={165} y={300} textAnchor="middle" fill={INK} fontSize={11} fontWeight={800}>
            Mainsail
        </text>

        {/* ── YANKEE ───────────────────────────────────────────── */}
        {/* Forestay and deck. */}
        <line
            x1={Y_TACK[0] - 4}
            y1={238}
            x2={Y_HEAD[0] + 6}
            y2={24}
            stroke={SPAR}
            strokeWidth={5}
            strokeLinecap="round"
        />
        <line x1={378} y1={246} x2={604} y2={246} stroke={SPAR} strokeWidth={5} strokeLinecap="round" />
        <text x={352} y={96} fill={NOTE} fontSize={9}>
            forestay
        </text>
        {/* Clear of the line, not on it — the label was printing over the deck
            it names. */}
        <text x={608} y={240} fill={NOTE} fontSize={9} textAnchor="start">
            deck
        </text>

        <path
            d={`M ${Y_HEAD[0]} ${Y_HEAD[1]} L ${Y_TACK[0]} ${Y_TACK[1]} L ${Y_CLEW[0]} ${Y_CLEW[1]}
                Q ${Y_CLEW[0] - 40} ${(Y_HEAD[1] + Y_CLEW[1]) / 2 - 18}, ${Y_HEAD[0]} ${Y_HEAD[1]} Z`}
            fill={JIB_FILL}
            stroke={SPAR}
            strokeWidth={1.6}
        />

        {/* The sheet — the line that actually trims it. */}
        <line
            x1={Y_CLEW[0]}
            y1={Y_CLEW[1]}
            x2={Y_CLEW[0] + 20}
            y2={232}
            stroke={SHEET}
            strokeWidth={2}
            strokeLinecap="round"
        />
        <text x={Y_CLEW[0] + 26} y={228} fill={SHEET} fontSize={9} fontWeight={800}>
            sheet
        </text>

        {/* TELLTALES. Dropped in the redesign and put back: the trim advice
            leans on them ("leech telltale streaming", "luff telltale lifting"),
            and a vocabulary diagram missing a word the prose uses is worse
            than no diagram. They live on the headsail luff because that is
            where a trimmer actually watches them. */}
        {[0.34, 0.55].map((t, i) => {
            const x = Y_TACK[0] + (Y_HEAD[0] - Y_TACK[0]) * (1 - t) + 16;
            const y = Y_TACK[1] + (Y_HEAD[1] - Y_TACK[1]) * (1 - t);
            return (
                <line
                    key={`tt-${i}`}
                    x1={x}
                    y1={y}
                    x2={x + 20}
                    y2={y - 5}
                    stroke="#38bdf8"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                />
            );
        })}
        <text x={452} y={112} fill="#38bdf8" fontSize={9} fontWeight={800}>
            TELLTALES
        </text>

        <Corner at={Y_HEAD} label="HEAD" dx={30} dy={-4} />
        <Corner at={Y_TACK} label="TACK" dx={-20} dy={18} />
        <Corner at={Y_CLEW} label="CLEW" dx={22} dy={-10} />

        <Leader from={[330, 196]} to={[Y_TACK[0] + 8, 200]} label="LUFF" fill={EDGE} anchor="start" />
        <Leader from={[520, 60]} to={[Y_CLEW[0] - 30, 96]} label="LEECH" fill={EDGE} anchor="start" />
        <Leader from={[452, 218]} to={[460, 200]} label="FOOT" fill={EDGE} />
        {/* Lifted clear of the foot: at the old y the second line ran straight
            through the very edge it was explaining. */}
        <text x={420} y={148} fill={NOTE} fontSize={9}>
            a YANKEE is cut high,
        </text>
        <text x={420} y={159} fill={NOTE} fontSize={9}>
            so the foot clears the deck
        </text>

        <text x={480} y={300} textAnchor="middle" fill={INK} fontSize={11} fontWeight={800}>
            Yankee — the same names on any headsail
        </text>
    </svg>
);
