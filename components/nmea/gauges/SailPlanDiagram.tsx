/**
 * SailPlanDiagram — "where everything goes", drawn instead of described.
 *
 * The trim advice was four paragraphs of prose (Shane 2026-08-28: "can we
 * actually have images. they are so much easier. with a wind direction
 * showing as well?"). Prose is the wrong medium for a spatial answer: where
 * the traveller sits, how far the boom is out and which side the wind is on
 * are all positions, and a picture states a position in one glance where a
 * sentence makes you build it in your head — on a moving deck, in the wet.
 *
 * Every mark here is derived from the plan the page already computed, never
 * invented. If the diagram and the words below it ever disagree, the diagram
 * is wrong and this file is the bug.
 *
 * Bow-up and boat-fixed, the same convention as the wind rose beside it: what
 * moves when she alters course is the wind, not the boat.
 */
import React from 'react';

export interface SailPlanDiagramProps {
    /** 'Beating' | 'Close reach' | 'Beam reach' | 'Broad reach' | 'Running' */
    band: string;
    /** Where the wind is FROM, degrees off the bow 0–360. Null = unknown. */
    windAngle: number | null;
    main: string;
    yankee: string;
    stay: boolean | string;
    runners?: boolean;
    prevent?: boolean;
    className?: string;
}

const W = 300;
const H = 340;
const CX = W / 2;

/* Boom angle off the centreline for each point of sail. These are the angles
   the boat actually sails at, not a smooth ramp — the whole reason the bands
   are named is that they are distinct. */
const BOOM_ANGLE: Record<string, number> = {
    Beating: 8,
    'Close reach': 22,
    'Beam reach': 45,
    'Broad reach': 68,
    Running: 88,
};

/* Traveller car along its track, -1 fully to windward … +1 fully to leeward.
   Beating puts it up to windward so the sheet can set the leech; running
   makes it irrelevant, which the diagram says by parking it at centre and
   letting the preventer flag carry the message instead. */
const TRAVELLER_POS: Record<string, number> = {
    Beating: -0.6,
    'Close reach': -0.15,
    'Beam reach': 0.35,
    'Broad reach': 0.8,
    Running: 0,
};

const PORT = '#ef5350';
const STBD = '#25b167';
const INK = '#ffffff';
const INK_2 = '#c3c2b7';
const MUTED = '#898781';
const GRID = '#2c2c2a';

export const SailPlanDiagram: React.FC<SailPlanDiagramProps> = ({
    band,
    windAngle,
    main,
    yankee,
    stay,
    runners = false,
    prevent = false,
    className = '',
}) => {
    const hasWind = windAngle !== null && Number.isFinite(windAngle);
    const ang = hasWind ? (((windAngle as number) % 360) + 360) % 360 : null;
    /* Port tack when the wind is over the port side. The sails set to
       leeward, so the whole rig mirrors — getting this backwards would draw
       a boat that cannot be sailing. */
    const windOnPort = hasWind ? (ang as number) > 180 : false;
    const lee = windOnPort ? 1 : -1; // +1 = sails to starboard
    /* Magnitude only — the side is carried by `lee`. Folding the sign into
       the angle and then taking a cosine loses it (cos is even), which drew
       the boom to starboard on both tacks. */
    const boomDeg = BOOM_ANGLE[band] ?? 45;
    const travel = (TRAVELLER_POS[band] ?? 0) * lee;

    const mainDown = main === 'Down';
    const yankeeSet = yankee !== 'Furled' && yankee !== 'Down';
    const staySet = stay === true || stay === 'storm';
    const stayStorm = stay === 'storm';

    const MAST_Y = 150;
    const BOOM_LEN = 96;
    /* Measured from straight aft, swinging to leeward: 0 is on the
       centreline over the stern, 90 is square across the boat. */
    const boomRad = (boomDeg * Math.PI) / 180;
    const boomX = CX + BOOM_LEN * Math.sin(boomRad) * lee;
    const boomY = MAST_Y + BOOM_LEN * Math.cos(boomRad);

    // Traveller track runs athwartships behind the mast.
    const TRACK_HALF = 62;
    const TRACK_Y = MAST_Y + 58;
    const carX = CX + travel * TRACK_HALF;

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            className={className}
            role="img"
            aria-label={`Sail plan: ${band}. Main ${main}, yankee ${yankee}${staySet ? ', staysail set' : ''}${prevent ? ', preventer on' : ''}.`}
        >
            {/* ── hull, bow up ── */}
            <path
                d={`M ${CX} 24 C ${CX + 44} 92, ${CX + 52} 200, ${CX + 30} 292
                    L ${CX - 30} 292 C ${CX - 52} 200, ${CX - 44} 92, ${CX} 24 Z`}
                fill="#12100f"
                stroke={GRID}
                strokeWidth={2}
            />
            {/* Centreline — the reference every angle here is measured from. */}
            <line x1={CX} y1={30} x2={CX} y2={286} stroke={GRID} strokeWidth={1} strokeDasharray="4 6" />

            {/* ── wind, drawn first so the rig sits over it ── */}
            {hasWind && (
                <g transform={`rotate(${ang} ${CX} ${MAST_Y})`}>
                    {/* Arrow flies FROM the wind toward the boat, the way a
                        masthead fly and a burgee both read. */}
                    <line
                        x1={CX}
                        y1={MAST_Y - 132}
                        x2={CX}
                        y2={MAST_Y - 96}
                        stroke={windOnPort ? PORT : STBD}
                        strokeWidth={5}
                        strokeLinecap="round"
                    />
                    <path d={`M ${CX} ${MAST_Y - 88} l 9 -16 l -18 0 Z`} fill={windOnPort ? PORT : STBD} />
                </g>
            )}

            {/* ── headsails, forward of the mast, set to leeward ── */}
            {yankeeSet && (
                <path
                    d={`M ${CX} 40 Q ${CX + lee * 54} 96, ${CX + lee * 16} 146 Z`}
                    fill={windOnPort ? 'rgba(37,177,103,0.20)' : 'rgba(239,83,80,0.20)'}
                    stroke={INK_2}
                    strokeWidth={1.5}
                />
            )}
            {staySet && (
                <path
                    d={`M ${CX} 76 Q ${CX + lee * 34} 116, ${CX + lee * 12} 148 Z`}
                    fill={stayStorm ? 'rgba(239,83,80,0.28)' : 'rgba(255,255,255,0.10)'}
                    stroke={stayStorm ? PORT : INK_2}
                    strokeWidth={1.5}
                />
            )}

            {/* ── main + boom ── */}
            {!mainDown && (
                <path
                    d={`M ${CX} ${MAST_Y} Q ${(CX + boomX) / 2 + lee * 26} ${(MAST_Y + boomY) / 2 - 16},
                        ${boomX.toFixed(1)} ${boomY.toFixed(1)} Z`}
                    fill="rgba(255,255,255,0.10)"
                    stroke={INK_2}
                    strokeWidth={1.5}
                />
            )}
            <line
                x1={CX}
                y1={MAST_Y}
                x2={boomX.toFixed(1)}
                y2={boomY.toFixed(1)}
                stroke={mainDown ? MUTED : INK}
                strokeWidth={mainDown ? 2 : 3.5}
                strokeLinecap="round"
                opacity={mainDown ? 0.5 : 1}
            />
            <circle cx={CX} cy={MAST_Y} r={5} fill={INK} />

            {/* ── traveller: track, then the car on it ── */}
            <line
                x1={CX - TRACK_HALF}
                y1={TRACK_Y}
                x2={CX + TRACK_HALF}
                y2={TRACK_Y}
                stroke={GRID}
                strokeWidth={6}
                strokeLinecap="round"
            />
            <rect
                x={(carX - 9).toFixed(1)}
                y={TRACK_Y - 6}
                width={18}
                height={12}
                rx={3}
                fill={windOnPort ? PORT : STBD}
                stroke="#0d0d0d"
                strokeWidth={1}
            />
            <text
                x={CX}
                y={TRACK_Y + 26}
                textAnchor="middle"
                fill={MUTED}
                fontSize={9}
                fontWeight={700}
                style={{ letterSpacing: '.14em' }}
            >
                TRAVELLER
            </text>

            {/* ── flags for the two things that hurt people ── */}
            {prevent && (
                <text
                    x={CX}
                    y={H - 30}
                    textAnchor="middle"
                    fill="#fbbf24"
                    fontSize={11}
                    fontWeight={800}
                    style={{ letterSpacing: '.08em' }}
                >
                    PREVENTER ON
                </text>
            )}
            {runners && (
                <text
                    x={CX}
                    y={H - 14}
                    textAnchor="middle"
                    fill="#fbbf24"
                    fontSize={11}
                    fontWeight={800}
                    style={{ letterSpacing: '.08em' }}
                >
                    RUNNERS ON
                </text>
            )}
            {!hasWind && (
                <text x={CX} y={H - 30} textAnchor="middle" fill={MUTED} fontSize={11} fontWeight={600}>
                    no wind angle
                </text>
            )}
        </svg>
    );
};
