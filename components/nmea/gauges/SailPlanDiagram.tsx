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
 *
 * REBUILT 2026-09-05 (Shane: "make the picture bigger. we need to see each
 * sail clearly as well as the traveller and the cars... it is hard to see the
 * sails"). Four independent designs and three judges went over it; what
 * follows is the consensus, and the things they talked me OUT of are recorded
 * beside the things they talked me into, because the second list is the one
 * that gets re-proposed.
 *
 * THE VIEWBOX IS 340 WIDE ON PURPOSE. The call site's container measures 340
 * CSS px on a 390pt phone, so one user unit is one pixel and every number in
 * this file is a promise about the screen: fontSize 15 IS 15px. The old 300
 * viewBox inside a max-w-[260px] cap rendered at 0.867, which is how 12px
 * labels quietly became 10.4px — nobody could see the multiplier.
 *
 * COLOUR MEANS ONE THING: WHICH SIDE THE WIND IS ON. Red and green are for the
 * wind arrow and the headsail tint, and nothing else. The traveller car, the
 * yankee car and the rail block used to be filled `windOnPort ? PORT : STBD`
 * while being POSITIONED at `CX + lee * …` — so on a beam reach the car was
 * drawn to starboard and painted port red. It agreed with the drawn side only
 * when the traveller happened to go to windward, which is one band in five.
 * Hardware is now neutral and read by shape and position.
 *
 * WHAT WAS DELIBERATELY NOT BUILT, all of it proposed and all of it rejected
 * for the same reason — it would draw precision this file does not have:
 * reef-clew fractions and reef pips (she has in-boom furling; there are no
 * discrete reef points), a degree ring around the wind arrow (BOOM_ANGLE is
 * five named bands, not a measurement), the preventer's actual route, and
 * importing POS from sereneSailing.ts (dead code, and its sign is inverted).
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

const W = 340;
const H = 404;
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

/**
 * Where the yankee sheet actually leads, which is NOT the same question as
 * where the car is — and the prose is emphatic about it. On the wind the car
 * is left alone and sheet tension does the work. Reaching, the lead wants to
 * go outboard and the track cannot do outboard, so it comes off to a snatch
 * block on the toe rail. Running, the sail is poled to windward. Drawing a
 * car sliding along a track through all of that would illustrate the
 * opposite of the advice.
 *
 * `car` is the position along the track, 0 forward … 1 aft.
 */
const YANKEE_LEAD: Record<string, { car: number; mode: 'track' | 'rail' | 'poled' }> = {
    Beating: { car: 0.42, mode: 'track' },
    'Close reach': { car: 0.55, mode: 'track' },
    'Beam reach': { car: 0.62, mode: 'rail' },
    'Broad reach': { car: 0.62, mode: 'rail' },
    Running: { car: 0.62, mode: 'poled' },
};

const PORT = '#ef5350';
const STBD = '#25b167';
const INK = '#ffffff';
const INK_2 = '#d8d6cc';
const MUTED = '#8f8d86';
const GRID = '#2c2c2a';
/* Tracks are metal, not background. At GRID they read as a shadow, which is
   why the car looked like it was floating on the deck. */
const METAL = '#6f6b62';
/* Hardware. Bright and neutral — see the colour note in the header. */
const HARDWARE = '#f1f0ea';
const CASING = '#0b0b0a';
const WARN = '#fbbf24';

/* A dark halo behind every label. The boom sweeps 8°–88° and will cross a
   label in SOME state wherever it is put; a mark whose position is data
   cannot be solved by repositioning the text, and charts have always used a
   halo for exactly this. */
const HALO: React.CSSProperties = {
    paintOrder: 'stroke',
    stroke: CASING,
    strokeWidth: 4,
    strokeLinejoin: 'round',
};
const LABEL: React.CSSProperties = { ...HALO, letterSpacing: '.06em' };

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

    /* On a run the traveller is not the control that matters — the preventer
       is — and the table parks it at centre to say so. A filled car at dead
       centre is still a CLAIM about where a physical thing is, so it is drawn
       hollow instead: present, and visibly not the answer. */
    const runningBand = band === 'Running';
    const mainDown = main === 'Down';
    const yankeeSet = yankee !== 'Furled' && yankee !== 'Down';
    const staySet = stay === true || stay === 'storm';
    const stayStorm = stay === 'storm';

    const MAST_Y = 176;
    const BOOM_LEN = 110;
    /* Measured from straight aft, swinging to leeward: 0 is on the
       centreline over the stern, 90 is square across the boat. */
    const boomRad = (boomDeg * Math.PI) / 180;
    const boomX = CX + BOOM_LEN * Math.sin(boomRad) * lee;
    const boomY = MAST_Y + BOOM_LEN * Math.cos(boomRad);

    /* Traveller track, athwartships abaft the mast at the widest station.
       TRACK_HALF stays INSIDE the hull's half-beam there (58): a track drawn
       hanging off the topsides is a lie about the boat, and lengthening it
       further to make the car's position easier to read would be buying
       legibility with accuracy. The car got bigger instead. */
    const TRACK_HALF = 50;
    const TRACK_Y = 236;
    const carX = CX + travel * TRACK_HALF;

    // Yankee sheet track — fore-and-aft along the leeward side deck.
    const lead = YANKEE_LEAD[band] ?? { car: 0.55, mode: 'track' as const };
    const YT_FWD = 116;
    const YT_AFT = 208;
    const ytX = CX + lee * 44;
    const ytCarY = YT_FWD + (YT_AFT - YT_FWD) * lead.car;
    const railX = CX + lee * 56;
    const poled = lead.mode === 'poled';
    /* POLED PUTS THE SAIL TO WINDWARD. Everything else on this drawing sets to
       leeward, and the yankee was drawn there in every state — including the
       one where it is goose-winged out on the pole, on the opposite side to
       the mainsail. The pole was drawn correctly and the sail it carries was
       not. */
    const headSide = poled ? -lee : lee;
    /* Where the yankee's clew is, so its sheet can be drawn TO something.
       The sheet is what makes the car/rail/pole distinction legible: without
       it the three are just marks in different places. */
    const clew: [number, number] = [CX + headSide * 16, 178];
    const liveLead: [number, number] = poled
        ? [CX - lee * 84, MAST_Y - 50]
        : lead.mode === 'rail'
          ? [railX, ytCarY]
          : [ytX, ytCarY];

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            className={className}
            role="img"
            aria-label={`Sail plan: ${band}. Main ${main}, yankee ${yankee}, ${
                staySet ? (stayStorm ? 'storm jib set' : 'staysail set') : 'staysail stowed'
            }${prevent ? ', preventer on' : ''}.`}
        >
            {/* ── hull, bow up ── */}
            <path
                d={`M ${CX} 44 C ${CX + 50} 120, ${CX + 58} 236, ${CX + 34} 344
                    L ${CX - 34} 344 C ${CX - 58} 236, ${CX - 50} 120, ${CX} 44 Z`}
                fill="#12100f"
                stroke={METAL}
                strokeWidth={2.5}
            />
            {/* Centreline — the reference every angle here is measured from,
                and the mark that makes "bow up, boat-fixed" legible. */}
            <line x1={CX} y1={52} x2={CX} y2={338} stroke={GRID} strokeWidth={1.5} strokeDasharray="5 8" />

            {/* ── wind, drawn first so the rig sits over it ── */}
            {hasWind && (
                <g transform={`rotate(${ang} ${CX} ${MAST_Y})`}>
                    {/* Arrow flies FROM the wind toward the boat, the way a
                        masthead fly and a burgee both read. */}
                    {/* Cased, because the arrow is drawn UNDER the rig and
                        near head-to-wind it crosses the foredeck and the
                        yankee — without this it dissolves into the sail it
                        crosses. Shane says the wind is the part that works, so
                        it is scaled and cased, not redesigned. */}
                    <line
                        x1={CX}
                        y1={MAST_Y - 150}
                        x2={CX}
                        y2={MAST_Y - 106}
                        stroke={CASING}
                        strokeWidth={13}
                        strokeLinecap="round"
                    />
                    <path
                        d={`M ${CX} ${MAST_Y - 92} l 15 -24 l -30 0 Z`}
                        fill={CASING}
                        stroke={CASING}
                        strokeWidth={6}
                    />
                    <line
                        x1={CX}
                        y1={MAST_Y - 150}
                        x2={CX}
                        y2={MAST_Y - 106}
                        stroke={windOnPort ? PORT : STBD}
                        strokeWidth={7}
                        strokeLinecap="round"
                    />
                    <path d={`M ${CX} ${MAST_Y - 96} l 13 -22 l -26 0 Z`} fill={windOnPort ? PORT : STBD} />
                </g>
            )}

            {/* ── headsails, forward of the mast, set to leeward ── */}
            {yankeeSet && (
                <path
                    d={`M ${CX} 62 Q ${CX + headSide * 66} 128, ${CX + headSide * 18} 178 Z`}
                    fill={windOnPort ? 'rgba(37,177,103,0.26)' : 'rgba(239,83,80,0.26)'}
                    stroke={INK_2}
                    strokeWidth={2.5}
                />
            )}
            {/* The staysail. Drawn even when it is stowed — ghosted rather
                than absent, because Serene Summer is a CUTTER and the inner
                sail is half of what that means. "Where everything goes" is a
                reference for where things live on the boat, so a sail that
                simply disappears when furled teaches the wrong rig (Shane
                2026-08-28: "we need to show the staysail when we are drawing
                pictures"). */}
            <path
                data-mark="staysail"
                d={`M ${CX} 102 Q ${CX + headSide * 42} 148, ${CX + headSide * 14} 180 Z`}
                fill={staySet ? (stayStorm ? 'rgba(239,83,80,0.32)' : 'rgba(255,255,255,0.16)') : 'none'}
                stroke={staySet ? (stayStorm ? PORT : INK_2) : METAL}
                strokeWidth={2.5}
                strokeDasharray={staySet ? undefined : '4 5'}
            />

            {/* The two stay fittings on the foredeck. In plan view a stay is a
                point, and it is the SECOND one — aft of the headstay — that
                makes her a cutter rather than a sloop. Standing rigging, so
                both are drawn whatever the sails are doing. */}
            <circle data-mark="stay-fitting" cx={CX} cy={62} r={4} fill={MUTED} stroke={CASING} strokeWidth={1.5} />
            <circle
                data-mark="stay-fitting"
                cx={CX}
                cy={102}
                r={4}
                fill={staySet ? INK_2 : MUTED}
                stroke={CASING}
                strokeWidth={1.5}
            />

            {/* Labels. The sails all sit to leeward, so the windward side is
                free — the inner sail's label goes there rather than fighting
                the outer sail for room. */}
            {/* BOTH headsail labels go to leeward, stacked. The old comment
                said the windward side was free "because the sails set to
                leeward" — it is not: the wind arrow sweeps it and the whip
                pole goes out on it, and STAYSAIL (STOWED) was clipping the
                frame on both tacks. Stacking them here empties the windward
                side for the two marks that must live there. */}
            <text
                x={CX + lee * 74}
                y={112}
                textAnchor={lee > 0 ? 'start' : 'end'}
                fill={yankeeSet ? INK_2 : MUTED}
                fontSize={15}
                fontWeight={800}
                style={LABEL}
            >
                YANKEE
            </text>
            <text
                x={CX + lee * 74}
                y={134}
                textAnchor={lee > 0 ? 'start' : 'end'}
                fill={staySet ? INK_2 : MUTED}
                fontSize={15}
                fontWeight={800}
                style={LABEL}
            >
                {staySet ? (stayStorm ? 'STORM JIB' : 'STAYSAIL') : 'STAYSAIL (STOWED)'}
            </text>

            {/* ── main + boom ── */}
            {!mainDown && (
                <path
                    d={`M ${CX} ${MAST_Y} Q ${(CX + boomX) / 2 + lee * 30} ${(MAST_Y + boomY) / 2 - 18},
                        ${boomX.toFixed(1)} ${boomY.toFixed(1)} Z`}
                    fill="rgba(255,255,255,0.22)"
                    stroke={INK_2}
                    strokeWidth={2.5}
                />
            )}
            {/* data-mark on every mark a test needs to find. These used to be
                selected as querySelectorAll('line')[2] — a positional index
                into the drawing, which every visual change silently breaks and
                which says nothing about what it selected. */}
            <line
                data-mark="boom"
                x1={CX}
                y1={MAST_Y}
                x2={boomX.toFixed(1)}
                y2={boomY.toFixed(1)}
                stroke={mainDown ? MUTED : INK}
                strokeWidth={mainDown ? 3.5 : 6}
                strokeLinecap="round"
                opacity={mainDown ? 0.5 : 1}
            />
            {/* THE MAINSHEET, from the traveller car to the boom. Without it
                the car is a chip on a rail with no stated purpose; with it,
                "where the traveller is" and "what it is doing to the boom"
                are one picture. Drawn to 0.6 along the boom, which is where
                the sheet actually leads, not to the end. */}
            {!mainDown && (
                <line
                    data-mark="mainsheet"
                    x1={carX.toFixed(1)}
                    y1={TRACK_Y}
                    x2={(CX + (boomX - CX) * 0.6).toFixed(1)}
                    y2={(MAST_Y + (boomY - MAST_Y) * 0.6).toFixed(1)}
                    stroke={INK_2}
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={0.85}
                />
            )}
            <circle cx={CX} cy={MAST_Y} r={7} fill={INK} stroke={CASING} strokeWidth={2} />

            {/* ── traveller: track, then the car on it ── */}
            <line
                x1={CX - TRACK_HALF}
                y1={TRACK_Y}
                x2={CX + TRACK_HALF}
                y2={TRACK_Y}
                stroke={METAL}
                strokeWidth={9}
                strokeLinecap="round"
            />
            {/* End stops and a centre notch. The car's reading is a FRACTION
                of the track, and a fraction needs a scale — without the ends
                and the middle marked, "a bit to windward" and "hard up" look
                the same at a glance. */}
            {[-1, 1].map((side) => (
                <line
                    key={side}
                    x1={CX + side * TRACK_HALF}
                    y1={TRACK_Y - 8}
                    x2={CX + side * TRACK_HALF}
                    y2={TRACK_Y + 8}
                    stroke={METAL}
                    strokeWidth={3}
                    strokeLinecap="round"
                />
            ))}
            <line x1={CX} y1={TRACK_Y - 6} x2={CX} y2={TRACK_Y + 6} stroke={CASING} strokeWidth={2} />
            {/* NEUTRAL, not port/starboard. See the colour note in the header:
                this was filled by which side the WIND was on while being
                positioned on the LEEWARD side, so on a beam reach it sat to
                starboard painted port red. Hue means one thing here. */}
            <rect
                data-mark="traveller-car"
                x={(carX - 13).toFixed(1)}
                y={TRACK_Y - 9}
                width={26}
                height={18}
                rx={4}
                fill={runningBand ? 'none' : HARDWARE}
                stroke={runningBand ? MUTED : CASING}
                strokeWidth={2}
                strokeDasharray={runningBand ? '4 4' : undefined}
            />
            <text x={CX} y={TRACK_Y + 32} textAnchor="middle" fill={MUTED} fontSize={15} fontWeight={800} style={LABEL}>
                TRAVELLER
            </text>

            {/* ── yankee sheet lead ── */}
            {yankeeSet && (
                <g>
                    <line
                        x1={ytX.toFixed(1)}
                        y1={YT_FWD}
                        x2={ytX.toFixed(1)}
                        y2={YT_AFT}
                        stroke={METAL}
                        strokeWidth={7}
                        strokeLinecap="round"
                    />
                    {/* On the track the car IS the lead. Off it, the car is
                        drawn hollow and parked — "the car itself stays put" —
                        and the live lead is the block on the rail. */}
                    {/* THE YANKEE SHEET, clew to whichever fitting is live.
                        The whole point of this trio is the difference between
                        a car parked on its track, a live lead out on the rail,
                        and a sail poled to windward — and three marks in three
                        places do not state a difference. A line to the one
                        that is working does. */}
                    <line
                        data-mark="yankee-sheet"
                        x1={clew[0].toFixed(1)}
                        y1={clew[1]}
                        x2={liveLead[0].toFixed(1)}
                        y2={liveLead[1].toFixed(1)}
                        stroke={INK_2}
                        strokeWidth={2}
                        strokeLinecap="round"
                        opacity={0.85}
                    />
                    <rect
                        data-mark="yankee-car"
                        x={(ytX - 8).toFixed(1)}
                        y={(ytCarY - 11).toFixed(1)}
                        width={16}
                        height={22}
                        rx={4}
                        fill={lead.mode === 'track' ? HARDWARE : 'none'}
                        stroke={lead.mode === 'track' ? CASING : MUTED}
                        strokeWidth={2}
                    />
                    {lead.mode === 'rail' && (
                        <>
                            <circle
                                data-mark="rail-block"
                                cx={railX.toFixed(1)}
                                cy={ytCarY.toFixed(1)}
                                r={8.5}
                                fill={HARDWARE}
                                stroke={CASING}
                                strokeWidth={2}
                            />
                            <text
                                x={railX.toFixed(1)}
                                y={(ytCarY + 18).toFixed(1)}
                                textAnchor="middle"
                                fill={INK_2}
                                fontSize={15}
                                fontWeight={800}
                                style={LABEL}
                            >
                                RAIL BLOCK
                            </text>
                        </>
                    )}
                    {lead.mode === 'poled' && (
                        <>
                            {/* The pole goes to WINDWARD — the opposite side to
                                everything else here, which is exactly why it is
                                worth drawing rather than describing. */}
                            <line
                                data-mark="pole"
                                x1={CX}
                                y1={MAST_Y - 8}
                                x2={(CX - lee * 84).toFixed(1)}
                                y2={(MAST_Y - 50).toFixed(1)}
                                stroke={INK}
                                strokeWidth={5}
                                strokeLinecap="round"
                            />
                            <text
                                x={(CX - lee * 84).toFixed(1)}
                                y={(MAST_Y - 62).toFixed(1)}
                                textAnchor="middle"
                                fill={INK_2}
                                fontSize={15}
                                fontWeight={800}
                                style={LABEL}
                            >
                                POLED
                            </text>
                        </>
                    )}
                    <text
                        x={ytX.toFixed(1)}
                        y={(YT_AFT + 22).toFixed(1)}
                        textAnchor="middle"
                        fill={MUTED}
                        fontSize={15}
                        fontWeight={800}
                        style={LABEL}
                    >
                        YANKEE CAR
                    </text>
                </g>
            )}

            {/* ── the two things that hurt people ──
                These were the SMALLEST text in the drawing at 11px, under
                marks four times their weight. An unexpected boom is the injury
                this panel exists to prevent; that hierarchy was inverted. */}
            {(() => {
                const pills = [prevent && 'PREVENTER ON', runners && 'RUNNERS ON'].filter(Boolean) as string[];
                if (pills.length === 0) {
                    return hasWind ? null : (
                        <text
                            x={CX}
                            y={H - 26}
                            textAnchor="middle"
                            fill={MUTED}
                            fontSize={14}
                            fontWeight={700}
                            style={LABEL}
                        >
                            no wind angle
                        </text>
                    );
                }
                return pills.map((text, i) => {
                    const y = H - 52 + i * 34;
                    return (
                        <g key={text}>
                            <rect
                                x={CX - 92}
                                y={y}
                                width={184}
                                height={28}
                                rx={9}
                                fill="rgba(251,191,36,0.14)"
                                stroke="rgba(251,191,36,0.45)"
                                strokeWidth={1.5}
                            />
                            <text
                                x={CX}
                                y={y + 19}
                                textAnchor="middle"
                                fill={WARN}
                                fontSize={15}
                                fontWeight={800}
                                style={LABEL}
                            >
                                {text}
                            </text>
                        </g>
                    );
                });
            })()}
        </svg>
    );
};
