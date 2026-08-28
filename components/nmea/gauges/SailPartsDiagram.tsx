/**
 * SailPartsDiagram — the names, on the sail, once.
 *
 * The trim advice talks about leech telltales, luff breathing, the clew
 * rising, the roach and the battens that hold it. Those words are only
 * useful if you can point at them, and a list of definitions is the one
 * format that guarantees you cannot (Shane 2026-08-28: "can we have a parts
 * of a sail diagram in there as well").
 *
 * Deliberately static and unlabelled by data: this is a reference, not an
 * instrument. Nothing here reads the boat, so nothing here can be wrong
 * about the boat — which is why it can sit safely beside a live diagram
 * without the two being confused for one another.
 */
import React from 'react';

const W = 300;
const H = 260;

const INK = '#ffffff';
const INK_2 = '#c3c2b7';
const MUTED = '#898781';
const GRID = '#2c2c2a';
const ACCENT = '#38bdf8';

/** Mast at the left, boom along the bottom — a mainsail seen from abeam. */
const HEAD: [number, number] = [64, 26];
const TACK: [number, number] = [64, 196];
const CLEW: [number, number] = [232, 196];

export const SailPartsDiagram: React.FC<{ className?: string }> = ({ className = '' }) => (
    <svg
        viewBox={`0 0 ${W} ${H}`}
        className={className}
        role="img"
        aria-label="Parts of a mainsail: head, luff, tack, foot, clew, leech, roach, battens and telltales."
    >
        {/* Mast and boom — the spars the three corners attach to. */}
        <line x1={HEAD[0]} y1={16} x2={TACK[0]} y2={214} stroke={GRID} strokeWidth={6} strokeLinecap="round" />
        <line x1={54} y1={TACK[1]} x2={244} y2={CLEW[1]} stroke={GRID} strokeWidth={6} strokeLinecap="round" />

        {/* The sail. The leech is drawn convex because the roach is the point
            of the curve — a straight trailing edge would quietly deny the
            thing the battens exist to hold. */}
        <path
            d={`M ${HEAD[0]} ${HEAD[1]} L ${TACK[0]} ${TACK[1]} L ${CLEW[0]} ${CLEW[1]}
                Q ${CLEW[0] - 18} ${(HEAD[1] + CLEW[1]) / 2 - 22}, ${HEAD[0]} ${HEAD[1]} Z`}
            fill="rgba(255,255,255,0.07)"
            stroke={INK_2}
            strokeWidth={1.6}
        />

        {/* Battens — full-length, holding the roach out. */}
        {[0.3, 0.48, 0.66, 0.84].map((t, i) => {
            const y = HEAD[1] + (CLEW[1] - HEAD[1]) * t;
            const xEnd = CLEW[0] - 26 * (1 - t) - 6;
            return (
                <line
                    key={i}
                    x1={HEAD[0] + 4}
                    y1={y}
                    x2={xEnd}
                    y2={y}
                    stroke={MUTED}
                    strokeWidth={1.4}
                    opacity={0.75}
                />
            );
        })}

        {/* Telltales — what "streaming" refers to. Leech ones sit on the
            trailing edge, luff ones just aft of the mast. */}
        {[0.42, 0.62].map((t, i) => {
            const y = HEAD[1] + (CLEW[1] - HEAD[1]) * t;
            return (
                <line
                    key={`ll-${i}`}
                    x1={HEAD[0] + 12}
                    y1={y}
                    x2={HEAD[0] + 30}
                    y2={y - 4}
                    stroke={ACCENT}
                    strokeWidth={1.6}
                />
            );
        })}
        <line x1={CLEW[0] - 22} y1={96} x2={CLEW[0] - 4} y2={90} stroke={ACCENT} strokeWidth={1.6} />

        {/* Corners. */}
        {(
            [
                [HEAD, 'HEAD', 0, -9],
                [TACK, 'TACK', -4, 16],
                [CLEW, 'CLEW', 6, 16],
            ] as const
        ).map(([p, label, dx, dy]) => (
            <g key={label}>
                <circle cx={p[0]} cy={p[1]} r={3.5} fill={INK} />
                <text
                    x={p[0] + dx}
                    y={p[1] + dy}
                    textAnchor="middle"
                    fill={INK}
                    fontSize={9}
                    fontWeight={800}
                    style={{ letterSpacing: '.1em' }}
                >
                    {label}
                </text>
            </g>
        ))}

        {/* Edges. */}
        <text
            x={HEAD[0] - 10}
            y={112}
            textAnchor="middle"
            fill={INK_2}
            fontSize={9}
            fontWeight={700}
            transform={`rotate(-90 ${HEAD[0] - 10} 112)`}
            style={{ letterSpacing: '.1em' }}
        >
            LUFF
        </text>
        <text
            x={148}
            y={212}
            textAnchor="middle"
            fill={INK_2}
            fontSize={9}
            fontWeight={700}
            style={{ letterSpacing: '.1em' }}
        >
            FOOT
        </text>
        <text
            x={196}
            y={88}
            textAnchor="middle"
            fill={INK_2}
            fontSize={9}
            fontWeight={700}
            transform="rotate(58 196 88)"
            style={{ letterSpacing: '.1em' }}
        >
            LEECH
        </text>
        <text
            x={236}
            y={64}
            textAnchor="middle"
            fill={MUTED}
            fontSize={8}
            fontWeight={700}
            style={{ letterSpacing: '.08em' }}
        >
            ROACH
        </text>
        <text
            x={104}
            y={244}
            textAnchor="middle"
            fill={MUTED}
            fontSize={8}
            fontWeight={700}
            style={{ letterSpacing: '.08em' }}
        >
            BATTENS
        </text>
        <text
            x={236}
            y={110}
            textAnchor="middle"
            fill={ACCENT}
            fontSize={8}
            fontWeight={700}
            style={{ letterSpacing: '.08em' }}
        >
            TELLTALES
        </text>
    </svg>
);
