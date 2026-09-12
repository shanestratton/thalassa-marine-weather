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
 *
 * HARDWARE BESIDE / BELOW THE BOAT, 2026-09-10. The Yankee guide occupies its
 * own aft-side inset; the traveller and warnings are in document flow below
 * the SVG. These are qualitative guides, NOT control-position telemetry.
 * The Yankee fore/aft setting is not known; never turn a leave-set instruction
 * into an invented car position. Keep guidance aligned with TRIM, not POS.
 */
import React from 'react';
import '../instrumentDaylight.css';
import './SailPlanDiagram.css';

export interface SailPlanDiagramProps {
    /** 'Beating' | 'Close reach' | 'Beam reach' | 'Broad reach' | 'Running' */
    band: string;
    /** Actual advice band; the rig may depict a reach while gybing downwind. */
    adviceBand?: string;
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
const H = 390;
/**
 * How far the boat sits off the frame's centre, AWAY from the labels.
 *
 * Every label in this drawing goes to leeward, because that is where the sails
 * are and the windward side has the wind arrow and the pole on it. With the
 * boat centred, those labels ran off the right-hand edge — Shane's screenshot,
 * 2026-09-05, shows "STAYSAIL (" and nothing after it. His fix, and it is the
 * right one: "can we move it left or right depending on where the words are".
 *
 * So the hull slides to windward by this much and the words get the room. The
 * DRAWING is unchanged — every angle, position and fraction is still measured
 * from the boat's own centreline — it is only the frame that recentres, which
 * is why this cannot distort anything it says.
 *
 * 20, NOT MORE, and the constraint is on the other side. The labels go to
 * leeward; the WIND ARROW goes to windward, which is the direction the hull is
 * sliding into. Shift far enough to clear the words and the arrow runs off the
 * opposite edge — a 32 unit shift put its tip at x = -12. 20 leaves the arrow
 * 10 units of margin at full extension and still buys the labels 40 units of
 * room across a tack. Both edges are asserted, because this is the kind of
 * number that gets nudged.
 */
const CENTRE_SHIFT = 20;

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

/* Running is the one band that puts the yankee on the pole, to windward. */
const POLED_BANDS = new Set(['Running']);

const PORT = '#ef5350';
const STBD = '#25b167';
const INK = '#ffffff';
const INK_2 = '#d8d6cc';
const MUTED = '#8f8d86';
const GRID = '#2c2c2a';
/* Hull and stowed-sail strokes. Metal, not background. */
const METAL = '#6f6b62';
const CASING = '#0b0b0a';

/* A dark halo behind every label. The boom sweeps 8°–88° and will cross a
   label in SOME state wherever it is put; a mark whose position is data
   cannot be solved by repositioning the text, and charts have always used a
   halo for exactly this. */
const HALO: React.CSSProperties = {
    paintOrder: 'stroke',
    stroke: `var(--nmea-label-halo, ${CASING})`,
    strokeWidth: 4,
    strokeLinejoin: 'round',
};
const LABEL: React.CSSProperties = { ...HALO, letterSpacing: '.06em' };

// Qualitative summaries of sereneSailing.TRIM, not new sailing calculations.
// Offsets illustrate named zones, not measured positions or percentages.
const TRAVELLER_GUIDE: Record<string, { label: string; leeOffset: number | null }> = {
    Beating: { label: 'To windward', leeOffset: -0.4 },
    'Close reach': { label: 'Centreline / slightly leeward', leeOffset: 0 },
    'Beam reach': { label: 'Well to leeward', leeOffset: 0.65 },
    'Broad reach': { label: 'Fully to leeward', leeOffset: 1 },
    Running: { label: 'Not controlling trim', leeOffset: null },
};

export const SailPlanDiagram: React.FC<SailPlanDiagramProps> = ({
    band,
    adviceBand = band,
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
    /* Bow-up still, but not frame-centre: pushed away from whichever side the
       labels are on. With no wind angle there is no leeward side yet, so it
       sits centred. */
    const CX = W / 2 - (hasWind ? lee * CENTRE_SHIFT : 0);
    const boomDeg = BOOM_ANGLE[band] ?? 45;
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

    const poled = POLED_BANDS.has(band);
    /* POLED PUTS THE SAIL TO WINDWARD. Everything else on this drawing sets to
       leeward; on the pole the yankee is goose-winged out on the opposite side
       to the mainsail. */
    const headSide = poled ? -lee : lee;
    const knownGuide = hasWind && Object.hasOwn(TRAVELLER_GUIDE, adviceBand);
    const traveller = mainDown
        ? { label: 'Main down', leeOffset: null }
        : knownGuide
          ? TRAVELLER_GUIDE[adviceBand]
          : { label: 'Awaiting wind / plan', leeOffset: null };
    const carLabel = !yankeeSet
        ? 'Sail stowed'
        : !knownGuide
          ? 'No plan'
          : adviceBand === 'Broad reach'
            ? 'Rail / pole'
            : adviceBand === 'Running'
              ? 'Pole / gybe'
              : 'Leave set';
    // Clear of the boom even close-hauled, the wind arrow, and the full hull.
    const carX = lee > 0 ? 222 : 6;

    return (
        <div className={`nmea-sail-plan ${className}`}>
            <p className="sail-guide-caption">Trim guide · not live positions</p>
            <svg
                data-mark="rig-diagram"
                viewBox={`0 0 ${W} ${H}`}
                className="nmea-instrument sail-rig-diagram"
                role="img"
                aria-label={`Sail plan: ${band}. Main ${main}, yankee ${yankee}, ${
                    staySet ? (stayStorm ? 'storm jib set' : 'staysail set') : 'staysail stowed'
                }. Yankee car: ${carLabel}; fore/aft position not measured.`}
            >
                {/* ── hull, bow up ── */}
                <path
                    data-mark="hull"
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
                    <g data-mark="wind-arrow" transform={`rotate(${ang} ${CX} ${MAST_Y})`}>
                        {/* Arrow flies FROM the wind toward the boat, the way a
                        masthead fly and a burgee both read. */}
                        {/* Cased, because the arrow is drawn UNDER the rig and
                        near head-to-wind it crosses the foredeck and the
                        yankee — without this it dissolves into the sail it
                        crosses. Shane says the wind is the part that works, so
                        it is scaled and cased, not redesigned. */}
                        <line
                            x1={CX}
                            y1={MAST_Y - 140}
                            x2={CX}
                            y2={MAST_Y - 96}
                            stroke={CASING}
                            strokeWidth={13}
                            strokeLinecap="round"
                        />
                        <path
                            d={`M ${CX} ${MAST_Y - 82} l 15 -24 l -30 0 Z`}
                            fill={CASING}
                            stroke={CASING}
                            strokeWidth={6}
                        />
                        <line
                            x1={CX}
                            y1={MAST_Y - 140}
                            x2={CX}
                            y2={MAST_Y - 96}
                            stroke={windOnPort ? PORT : STBD}
                            strokeWidth={7}
                            strokeLinecap="round"
                        />
                        <path d={`M ${CX} ${MAST_Y - 86} l 13 -22 l -26 0 Z`} fill={windOnPort ? PORT : STBD} />
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
                    x={CX + lee * 76}
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
                    x={CX + lee * 76}
                    y={134}
                    textAnchor={lee > 0 ? 'start' : 'end'}
                    fill={staySet ? INK_2 : MUTED}
                    fontSize={15}
                    fontWeight={800}
                    style={LABEL}
                >
                    {staySet ? (stayStorm ? 'STORM JIB' : 'STAYSAIL') : 'STAYSAIL'}
                </text>
                {/* "(STOWED)" on its own line. As a suffix it made the longest
                string in the drawing, and the longest string is the one that
                runs off the frame — which is exactly what it did. */}
                {!staySet && (
                    <text
                        x={CX + lee * 76}
                        y={152}
                        textAnchor={lee > 0 ? 'start' : 'end'}
                        fill={MUTED}
                        fontSize={14}
                        fontWeight={700}
                        style={LABEL}
                    >
                        (STOWED)
                    </text>
                )}

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
                <circle data-mark="mast" cx={CX} cy={MAST_Y} r={7} fill={INK} stroke={CASING} strokeWidth={2} />

                {/* ── the pole, when the yankee is out on it ──
                The only piece of gear left on the drawing (2026-09-09): it
                goes to WINDWARD, the opposite side to everything else, and it
                is why the yankee is drawn on that side. The traveller, its
                car, the mainsheet, the yankee car, its track and the rail
                block came off the boat — "we know what they are". */}
                {yankeeSet && poled && (
                    <>
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
                <g data-mark="yankee-car-guide">
                    <rect x={carX} y={270} width={112} height={110} rx={12} fill="#0f172a" stroke={METAL} />
                    <text x={carX + 56} y={290} textAnchor="middle" fill={INK_2} fontSize={14} fontWeight={800}>
                        YANKEE CAR
                    </text>
                    <line x1={carX + 24} x2={carX + 24} y1={306} y2={350} stroke={METAL} strokeWidth={3} />
                    {/* A dashed full-travel outline, not a dot at an invented position. */}
                    <rect
                        x={carX + 17}
                        y={305}
                        width={14}
                        height={46}
                        rx={4}
                        fill="none"
                        stroke={INK_2}
                        strokeDasharray="3 3"
                    />
                    <text x={carX + 40} y={316} fill={MUTED} fontSize={14} fontWeight={700}>
                        FWD
                    </text>
                    <text x={carX + 40} y={350} fill={MUTED} fontSize={14} fontWeight={700}>
                        AFT
                    </text>
                    <text x={carX + 56} y={370} textAnchor="middle" fill={INK_2} fontSize={14} fontWeight={700}>
                        {carLabel}
                    </text>
                </g>
            </svg>
            <p className="sail-guide-caption">Yankee fore/aft setting not measured.</p>
            {!hasWind && <p className="sail-guide-caption">no wind angle</p>}
            <section
                className="sail-traveller-guide"
                data-mark="traveller-guide"
                aria-label={`Suggested traveller: ${traveller.label}`}
            >
                <h3>TRAVELLER</h3>
                <p className="sail-traveller-setting">{traveller.label}</p>
                <svg className="nmea-instrument" viewBox="0 0 340 62" aria-hidden="true">
                    <line x1={42} x2={298} y1={22} y2={22} stroke={METAL} strokeWidth={5} strokeLinecap="round" />
                    <line x1={170} x2={170} y1={10} y2={32} stroke={MUTED} strokeWidth={2} strokeDasharray="3 3" />
                    {traveller.leeOffset !== null && (
                        <rect
                            data-mark="traveller-car"
                            x={170 + lee * traveller.leeOffset * 120 - 10}
                            y={12}
                            width={20}
                            height={20}
                            rx={5}
                            fill={INK_2}
                            stroke={CASING}
                            strokeWidth={2}
                        />
                    )}
                    <text x={42} y={54} textAnchor="middle" fill={MUTED} fontSize={14} fontWeight={700}>
                        PORT
                    </text>
                    <text x={170} y={54} textAnchor="middle" fill={MUTED} fontSize={14} fontWeight={700}>
                        CENTRE
                    </text>
                    <text x={298} y={54} textAnchor="middle" fill={MUTED} fontSize={14} fontWeight={700}>
                        STBD
                    </text>
                </svg>
            </section>
            {(prevent || runners) && (
                <div className="sail-plan-warnings">
                    {prevent && <p data-mark="sail-warning">PREVENTER ON</p>}
                    {runners && <p data-mark="sail-warning">RUNNERS ON</p>}
                </div>
            )}
        </div>
    );
};
