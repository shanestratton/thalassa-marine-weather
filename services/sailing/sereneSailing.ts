/**
 * sereneSailing — the sailing brain handed over from the Serene Summer
 * dashboard (extracted 26 Aug 2026 from dashboard.html build 20260824-1950;
 * see /HANDOVER.md in that package for the full reasoning).
 *
 * NONE OF THIS IS GENERIC. It encodes Serene Summer specifically:
 * 1991 Tayana 55 cutter, 26 tonnes weighed, 2.00 m draft, in-boom furling
 * main (Leisure Furl — reef to a batten, boom at 87° on the vang), high-cut
 * yankee on a furler, staysail on a furler (NOT club-footed — no staysail
 * boom), and RUNNING BACKSTAYS that must be set before the staysail loads
 * the inner forestay. UI must gate these views to this boat.
 *
 * DO NOT REMOVE — each survives a specific failure (HANDOVER.md):
 * 1. helmBalance() REFUSES to judge downwind (off < 70): the mean rudder
 *    angle averages to zero in a quartering sea and reassures the helmsman
 *    at the exact moment it should warn them. Downwind advice must come
 *    from rudder ACTIVITY, never the mean.
 * 2. The dead bands (>8 / >4 / <-2.5) are wide ON PURPOSE: the rudder
 *    reference reads ~1.2° ashore with the blade straight. Tightening them
 *    raises alarms from a sensor zero error.
 * 3. HEEL_POSITIVE_IS_STBD is UNVERIFIED under sail — carry the comment.
 * 4. DEPTH_MEASURED_OFFSET is a tape measurement; the sounder is configured
 *    with 1.79 so the instrument reads 0.33 m SHALLOWER than reality — the
 *    safe direction, deliberate. Do not "correct" the app to match the
 *    instrument; the instrument is the thing that is wrong.
 * 5. CAR has three discrete positions, set-and-forget. There is a perfect
 *    car position for every puff and chasing it is not practical sailing.
 * 6. Anything that brings the staysail in MUST say the runners go on first.
 *    Rigging failure, not trim preference.
 *
 * Every advice string is transcribed VERBATIM — plain words a person reads
 * once, at night, wondering what to do with their hands.
 */

/* eslint-disable no-irregular-whitespace */

export interface HelmWindow {
    /** MEAN rudder angle over a 30-60 s window — never instantaneous. */
    mean: number | null;
    max: number | null;
    activity: number | null;
}

export interface SailingWind {
    awa: number | null; // degrees 0-360, 0 = bow
    aws: number | null; // knots
    twa: number | null;
    tws: number | null;
    sog: number | null;
    stw: number | null;
    hdg: number | null;
    helm: HelmWindow | null;
}

export const DRAFT_M = 2.0; /* Tayana 55, from the ship's particulars */

/* --- COMFORT_M --- */
export const COMFORT_M = 1.0;

/* --- DEPTH_MEASURED_OFFSET --- */
export const DEPTH_MEASURED_OFFSET = -1.46; /* main transducer, tape, 21 Aug 2026 */

/* --- DEPTH_FALLBACK_OFFSET --- */
export const DEPTH_FALLBACK_OFFSET = DEPTH_MEASURED_OFFSET;

/* --- BAND_TWA --- */
export const BAND_TWA = { Beating: 42, 'Close reach': 67, 'Beam reach': 95, 'Broad reach': 127, Running: 163 };

export const SAILPLAN = [
    {
        band: 'Beating',
        from: 30,
        to: 55,
        rows: [
            {
                to: 12,
                main: 'Full',
                yankee: 'Full',
                stay: false,
                note: 'She wants breeze — full sail is right well past where a lighter boat would reef. Genuinely light and hard on the wind is the one place the staysail is in the way: she crowds the yankee and you lose pointing for almost nothing.',
            },
            {
                to: 18,
                main: 'Full',
                yankee: 'Full',
                stay: 'try',
                runners: true,
                note: 'Roll the staysail out and see. She costs you a degree of pointing and buys footing — on 26 tonnes punching chop that is usually the better trade. Runners on before you load the inner stay.',
            },
            {
                to: 23,
                main: 'Reef 1',
                yankee: 'Full',
                stay: true,
                runners: true,
                note: 'First reef — roll down to the first batten. A cockpit job on the Leisure Furl, so take it early. Reefed main and full yankee is plenty of area up high and not enough down low: this is the row the staysail was drawn for.',
            },
            {
                to: 28,
                main: 'Reef 2',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                note: 'The cutter’s working gear. Roll to the second batten. The staysail is already up by now — this is where she starts doing the heavy lifting rather than helping.',
            },
            {
                to: 36,
                main: 'Reef 3',
                yankee: 'Furled',
                stay: true,
                runners: true,
                note: 'Yankee away entirely — the staysail is now the headsail.',
            },
            {
                to: 45,
                main: 'Reef 3 flat',
                yankee: 'Furled',
                stay: 'storm',
                runners: true,
                note: 'Traveller down, outhaul hard, vang on. Flatten what is left.',
            },
            { to: 99, main: 'Down', yankee: 'Furled', stay: 'storm', runners: true, note: 'Main off her and lashed.' },
        ],
    },

    {
        band: 'Close reach',
        from: 55,
        to: 80,
        rows: [
            {
                to: 12,
                main: 'Full',
                yankee: 'Full',
                stay: 'try',
                runners: true,
                note: 'Best point of sail for her. Let her go — and this is the cell to prove the staysail to yourself in comfortable conditions.',
            },
            {
                to: 19,
                main: 'Full',
                yankee: 'Full',
                stay: true,
                runners: true,
                note: 'Her strongest case anywhere in this table. Cracked off, the sheeting angles open and the yankee’s exhaust runs past the staysail rather than into it.',
            },
            {
                to: 24,
                main: 'Reef 1',
                yankee: 'Full',
                stay: true,
                runners: true,
                note: 'Reefed main, full yankee, staysail set — the classic cutter rig, and the one she was drawn for.',
            },
            {
                to: 29,
                main: 'Reef 2',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                note: 'Staysail fills the slot the rolled yankee leaves.',
            },
            { to: 37, main: 'Reef 3', yankee: 'Furled', stay: true, runners: true, note: '' },
            { to: 45, main: 'Reef 3 flat', yankee: 'Furled', stay: 'storm', runners: true, note: '' },
            { to: 99, main: 'Down', yankee: 'Furled', stay: 'storm', runners: true, note: '' },
        ],
    },

    {
        band: 'Beam reach',
        from: 80,
        to: 110,
        rows: [
            {
                to: 14,
                main: 'Full',
                yankee: 'Full',
                stay: false,
                note: 'Apparent wind is easing off the bow now — she carries more here. Too light for the staysail: the yankee wants to be eased well out and the staysail ends up over-sheeted in its shadow.',
            },
            {
                to: 20,
                main: 'Full',
                yankee: 'Full',
                stay: 'try',
                runners: true,
                note: 'Worth a go, but only if her sheet goes OUTBOARD to the rail. Led to an inboard fairlead she stalls and does nothing.',
            },
            {
                to: 25,
                main: 'Reef 1',
                yankee: 'Full',
                stay: true,
                runners: true,
                note: 'Enough breeze now that even an imperfect lead has her drawing, and the low inboard area steadies her and takes load off the yankee.',
            },
            { to: 30, main: 'Reef 2', yankee: 'Rolled to two-thirds', stay: true, runners: true, note: '' },
            { to: 38, main: 'Reef 3', yankee: 'Furled', stay: true, runners: true, note: '' },
            { to: 45, main: 'Reef 3 flat', yankee: 'Furled', stay: 'storm', runners: true, note: '' },
            { to: 99, main: 'Down', yankee: 'Furled', stay: 'storm', runners: true, note: '' },
        ],
    },

    {
        band: 'Broad reach',
        from: 110,
        to: 145,
        rows: [
            {
                to: 19,
                main: 'Full',
                yankee: 'Full',
                stay: false,
                prevent: true,
                note: 'Preventer rigged and led AFT before the boom goes out. Not to a foredeck cleat.',
            },
            {
                to: 23,
                main: 'Reef 1',
                yankee: 'Full',
                stay: false,
                prevent: true,
                pole: 'down',
                note: 'Pole comes down at 20 kn and does not go back up.',
            },
            {
                to: 27,
                main: 'Reef 2',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                prevent: true,
                note: 'Last cell with the main up. Decide the next step NOW, not at 27.',
            },
            {
                to: 33,
                main: 'Down',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                note: 'Main off her. Headsails cannot gybe and reduce from the cockpit.',
            },
            {
                to: 42,
                main: 'Down',
                yankee: 'Furled',
                stay: true,
                runners: true,
                note: 'Staysail alone. She will still make five knots under this.',
            },
            {
                to: 99,
                main: 'Down',
                yankee: 'Furled',
                stay: 'storm',
                runners: true,
                note: 'Storm staysail, and think about the drogue.',
            },
        ],
    },

    {
        band: 'Running',
        from: 145,
        to: 180,
        rows: [
            {
                to: 19,
                main: 'Full',
                yankee: 'Full',
                stay: false,
                prevent: true,
                note: 'Preventer mandatory. Poled out if you want, but see the 20 kn rule.',
            },
            {
                to: 23,
                main: 'Reef 1',
                yankee: 'Full',
                stay: false,
                prevent: true,
                pole: 'down',
                note: 'Pole down by 20 kn. You cannot furl a yankee against a set pole.',
            },
            {
                to: 27,
                main: 'Reef 2',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                prevent: true,
                note: 'Above 20 kn stop sailing dead downwind — sail 145–165° and gybe down.',
            },
            {
                to: 33,
                main: 'Down',
                yankee: 'Rolled to two-thirds',
                stay: true,
                runners: true,
                note: 'Main down. Nothing to blanket the yankee now, so the pole is not needed.',
            },
            { to: 42, main: 'Down', yankee: 'Furled', stay: true, runners: true, note: '' },
            { to: 99, main: 'Down', yankee: 'Furled', stay: 'storm', runners: true, note: '' },
        ],
    },
];

/* --- TRIM --- */
export const TRIM = {
    Beating: {
        traveller:
            'Traveller up to windward of the centreline, then sheet on ' +
            'hard. On this boat the traveller sets the angle and the sheet ' +
            'sets the leech. THIS is the one you play in a gust — it is in ' +
            'the cockpit, it moves under load, and it costs you nothing.',
        mainsheet:
            'Firm — top leech telltale streaming maybe half the time. If it ' +
            'stalls completely you are over-sheeted and making helm, not drive.',
        yankee:
            'Leave the car alone. What you play here is sheet tension, and on ' +
            'a furling sail that matters more than the car does anyway. Sheet ' +
            'until the leech stops fluttering and no further.',
        staysail:
            'She is NOT self-tacking — no boom, just sheets — so she adds a ' +
            'second headsail to every tack, and beating is where you tack most. ' +
            'Worth it for the drive on a long board; furl her for short-tacking up ' +
            'a channel single-handed. ' +
            'Sheet so its leech twists the same as the yankee’s. If the ' +
            'yankee backwinds, the staysail is over-sheeted — ease it, do not drop it.',
    },
    'Close reach': {
        traveller:
            'Traveller to the centreline or a touch below. Ease the sheet ' + 'before you drop the traveller further.',
        mainsheet: 'Ease until the luff just breathes, then take up an inch.',
        yankee:
            'Still leave it. Cracking off a few degrees does not move the car — ' +
            'easing the sheet already lets the clew rise and swing forward, ' +
            'which is the same thing the car would have done.',
        staysail: 'Comes into its own here — it is doing real work on a close reach.',
    },
    'Beam reach': {
        traveller: 'Traveller well down to leeward. Boom out over the quarter.',
        mainsheet: 'Eased. The VANG now holds the leech, not the sheet — put it on.',
        yankee:
            'The lead now wants to go OUTBOARD rather than aft, and the track ' +
            'cannot do outboard. A snatch block on the toe rail beats anything ' +
            'the car can give you. The car itself stays put.',
        staysail: 'Sheeted outboard if you have a spare fairlead for it.',
    },
    'Broad reach': {
        traveller:
            'Fully to leeward, and it stops mattering. PREVENTER on, led aft, ' +
            'releasable under load from the cockpit.',
        mainsheet:
            'Well out. Vang on hard — that is what stops the boom skying and ' + 'the top of the main twisting off.',
        yankee:
            'Off the track altogether now — snatch block to the rail, or poled ' +
            'out to windward below 20 kn gusts. Rig the block with the sail ' +
            'rolled away, never against a loaded sheet.',
        staysail: 'Sheeted to the rail. In heavy going this and nothing else is a ' + 'lovely way to run.',
    },
    Running: {
        traveller: 'Irrelevant. PREVENTER is not optional — that boom will kill ' + 'someone if it comes across.',
        mainsheet: 'Right out, vang hard on.',
        yankee:
            'Poled to windward under 20 kn gusts. Above that the pole comes down ' +
            'and stays down, and you sail 145–165° and gybe your way downwind.',
        staysail: 'Set it on the opposite side to the yankee and she settles down.',
    },
};

/* --- KITE --- */
export const KITE = {
    area: 200,
    twaLow: 70,
    twaHigh: 150,
    gustMax: 15 /* gust knots - conservative, and shorthanded */,
    gustMaxCrewed: 20,
};

export const SAILPARTS = [
    [
        'Head',
        'The top corner.',
        'The halyard. Tension here pulls the luff straight — too little and the sail sags away from the mast.',
    ],
    [
        'Tack',
        'The bottom forward corner, at the gooseneck or the stemhead.',
        'Fixed in place. On the main the cunningham pulls down beside it to flatten her as the breeze builds.',
    ],
    [
        'Clew',
        'The bottom aft corner. Where the sheet pulls from.',
        'Mainsheet and outhaul on the main. On a headsail, the sheet and the position of its car.',
    ],
    [
        'Luff',
        'The leading edge — up the mast, or up the forestay.',
        'Halyard and cunningham. A tight luff drags the draft forward and flattens her, which is what you want going to windward.',
    ],
    [
        'Leech',
        'The trailing edge. The one that does the damage if you let it flog.',
        'Mainsheet upwind, the vang once you are off the wind, and the car on a headsail. Leech telltales tell you whether it is stalled.',
    ],
    [
        'Foot',
        'The bottom edge.',
        'The outhaul. Hard on flattens her for a breeze; eased gives a deeper, more powerful shape off the wind.',
    ],
    [
        'Roach',
        'The curve of the leech outside a straight line from head to clew — free sail area.',
        'Held out by the battens. It is also why a mainsail will not simply roll away like a headsail.',
    ],
    [
        'Battens',
        'Stiffeners running across the leech.',
        'Nothing to trim. They support the roach — a broken one shows up as a hooked leech that will not set.',
    ],
    [
        'Reefing — in-boom',
        'She has a Leisure Furl boom, so there are no reef cringles. The sail rolls into the boom and the reef can be any depth you like.',
        'Furling line and halyard together. Finish the roll ON A BATTEN — stop between them and fullness creeps into the foot, which costs you upwind. Boom at 87° on the rigid vang while it rolls.',
    ],
    [
        'Telltales',
        'Ribbons on the luff of a headsail, and on the leech of the main.',
        'Not trimmed — read. Luff telltales streaming together means the angle is right. A leech telltale that stops streaming means you are over-sheeted.',
    ],
];

/* --- TELLTALES --- */
export const TELLTALES = [
    {
        sail: 'Yankee',
        ic: '⛵',
        sub: 'the working headsail — luff ribbons, in pairs',
        where:
            'On the front edge, a pair at each height — one ribbon each side of the ' +
            'cloth at the same spot, so you can compare them. Four sets up the sail, ' +
            'three at the very least, spaced evenly from a fifth of the way up to ' +
            'four fifths.' +
            '<br><br><b>How far back matters more than people think.</b> The sail is ' +
            'much wider at the bottom than the top, so the spacing has to be ' +
            'proportional, not the same all the way up: roughly a hand-span (200 mm) ' +
            'down low, but only 75–125 mm at the top set. Put the top one as far back ' +
            'as the bottom one and it will always break late — which reads exactly ' +
            'like a car in the wrong place, and would send you moving a perfectly ' +
            'good one.',
        read:
            'Watch the <b>windward</b> ribbon — the one on the side the wind is coming ' +
            'from. It is the sensitive one. The leeward ribbon will sit there ' +
            'streaming happily through a wide band of angles that are all slightly ' +
            'wrong, so it never tells you you are wasting the afternoon.' +
            '<br><br>They need her <b>moving</b>. Straight after a tack, coming out ' +
            'of a lull, or punching into a head sea under motor, there is not enough ' +
            'flow across the sail for a ribbon to mean anything and both sides will ' +
            'flap rubbish. Get her going first, then read them.',
        signs: [
            ['Both lying flat, pointing aft', 'Angle is right. Nothing to do.', 'good'],
            [
                'Windward ribbon lifting and dancing',
                'Too close to the wind — she is pinching. <b>Bear away a few degrees.</b>',
                'warn',
            ],
            [
                'Leeward ribbon drooping or curling back',
                'Too far off the wind, or the sheet is too loose. <b>Come up a few ' +
                    'degrees</b>, or pull the sheet in.',
                'warn',
            ],
            [
                'Both misbehaving at once',
                'She is stalled, or she has no way on. Bear away, let her build speed, ' + 'then come back up.',
                'bad',
            ],
            [
                'One ribbon never settles at any angle',
                'That one is stuck too close to the front edge, sitting in the tumbling ' +
                    'air off the forestay. Bad placement, not bad steering.',
                'bad',
            ],
        ],
        quirk:
            '<b>Roll the yankee even one turn and every luff ribbon disappears.</b> ' +
            'The foil turns as one piece, so a single turn swallows 150–250 mm of ' +
            'cloth at every height — and that is where the ribbons live. They are ' +
            'gone at the first click of the furling line, long before you reach ' +
            '“rolled to two-thirds”.' +
            '<br><br><b>Worth doing at the dock:</b> roll her to the two-thirds mark, ' +
            'pencil a line where the new front edge sits, unroll, and sew one extra ' +
            'pair about 200 mm behind that line at mid height. Full sail, it sits out ' +
            'in the middle of the sail and you ignore it. Rolled down, it is your ' +
            'steering instrument back.',
    },

    {
        sail: 'Staysail',
        ic: '🎏',
        sub: 'the inner headsail — same ribbons, different truth',
        where:
            'Same as the yankee: pairs on the front edge, both faces. It is a small ' +
            'sail, so three sets is plenty — but they sit close together, which means ' +
            'there is not much spread to read from. Put one ribbon on the back edge ' +
            'too; on this sail it does more work than the front ones.',
        read:
            'Here is the thing nobody tells you about a cutter. <b>The staysail lives ' +
            'in the yankee’s dirty air.</b> On a sloop the windward ribbon is the ' +
            'truth. On her, with both headsails up, it is not — the yankee is ' +
            'throwing its exhaust straight at the staysail’s front edge.' +
            '<br><br>So on the staysail, read the <b>leeward</b> ribbon and the back-' +
            'edge one instead, and treat a lifting windward ribbon as information ' +
            'about the <i>yankee</i>, not the staysail.',
        signs: [
            [
                'Windward ribbon lifting all the time, whatever you do',
                'Not the staysail’s fault. The yankee is over-sheeted and dumping into ' +
                    'it. <b>Ease the yankee</b> — do not sheet the staysail harder, and do ' +
                    'not drop it.',
                'warn',
            ],
            [
                'Back-edge ribbon folded away behind the sail',
                'Staysail sheeted too hard. Ease it until it streams.',
                'warn',
            ],
            ['Everything clean and streaming', 'The slot is working. This is what you are aiming for.', 'good'],
        ],
        quirk:
            'The sail plan used to leave her in the bag until it was blowing 25, so ' +
            'the only time you ever saw her set, the yankee was already rolled and ' +
            'blowing its worst air backwards. Judge her only in that state and you ' +
            'would conclude she is badly cut and stop bothering with her.' +
            '<br><br><b>The plan now asks for her from about twelve knots</b>, close ' +
            'reaching especially — full main, full yankee, staysail set. That is the ' +
            'configuration this rig was drawn for, and it is where her ribbons go ' +
            'clean. Once you have seen that, you will trust her in a blow.' +
            '<br><br>With the yankee rolled she is back in dirty air and the reading ' +
            'above applies again. Same sail, different information.',
    },

    {
        sail: 'Mainsail',
        ic: '🩱',
        sub: 'leech ribbons at the battens — one you actually watch',
        where:
            'On the <b>back edge only</b>, one short ribbon at the end of each batten ' +
            'pocket. No pairs — there is only one edge, so one ribbon per height. ' +
            'Make them long, 250–300 mm, and dark: the top one is nearly twenty ' +
            'metres up and you are reading it against a bright sky.' +
            '<br><br>Nothing on the front edge. The mast is a fat round tube sitting ' +
            'right in front of it and the air arriving behind it is already tumbling, ' +
            'so those ribbons dance whatever you do. If the sailmaker fits them, ' +
            'ignore them.',
        read:
            'You watch <b>one</b> of them — the top one. Everything else is a ' +
            'cross-check.' +
            '<br><br>Going upwind it should stream about <b>half the time</b>: a few ' +
            'seconds pointing straight aft, then it folds away behind the sail for a ' +
            'moment, then it comes back. That flicker on and off is the top of the ' +
            'sail loaded as hard as it will take without the air letting go.',
        signs: [
            ['Flicking on and off every few seconds', 'Upwind, that is the target.', 'good'],
            [
                'Streaming all the time, never folds',
                'Not enough on. The top of the sail has fallen open and you are giving ' +
                    'away drive. Take some mainsheet on, or bring the traveller up.',
                'warn',
            ],
            [
                'Folded away behind the sail and staying there',
                'Over-sheeted and stalled. She will be heeling more and the wheel going ' +
                    'heavy, and neither is drive. Ease the mainsheet an inch.',
                'warn',
            ],
            [
                'Off the wind, one has stopped streaming',
                'Out there you want them all streaming all the time — and off the wind it ' +
                    'is the <b>vang</b> holding the back edge, not the sheet. Ease the ' +
                    'vang.',
                'warn',
            ],
            [
                'Top streaming but a middle one stalled',
                'Unusual. Normally a broken or badly seated batten hooking that part of ' +
                    'the edge. Worth going and looking — a hooked leech will not set and ' +
                    'will not come right on its own.',
                'bad',
            ],
        ],
        quirk:
            '<b>The boom eats them from the bottom up, and that is good news.</b> She ' +
            'rolls into the boom foot-first, so every reef swallows the lowest ' +
            'battens and their ribbons and leaves the upper ones flying. The one you ' +
            'actually steer the mainsheet by — the top one — survives every reef she ' +
            'has.' +
            '<br><br>That is the exact opposite of the yankee, where the first turn ' +
            'takes your ribbons away. It is also why the mainsheet stays readable ' +
            'when the headsail has stopped talking to you.' +
            '<br><br>One fitting note: <b>nothing lumpy.</b> Sewn flat or nothing. A ' +
            'plastic sleeve or a lump of tape goes round and round inside the boom ' +
            'and builds a ridge in the roll.',
    },

    {
        sail: 'Asymmetric',
        ic: '🪂',
        sub: '200 m² — no telltales at all, and that is deliberate',
        where:
            '<b>Nowhere.</b> This sail does not get them, and that is an answer rather ' +
            'than an oversight.' +
            '<br><br>The other three sails have a front edge fixed to something — the ' +
            'mast, a stay — so the only way to know what the air is doing there is to ' +
            'stick a ribbon on and look. The spinnaker’s front edge is flying free, ' +
            'held at the top and the bottom corner and nowhere in between. When the ' +
            'angle goes wrong the edge itself moves: it folds. That fold is a metre ' +
            'of white nylon twenty metres away. Putting a 150 mm ribbon on a sail ' +
            'that already tells you in metres is adding a whisper to a shout.',
        read:
            'The fold is called the <b>curl</b>, and flying her is one loop you repeat ' +
            'the whole time she is up.' +
            '<br><br>Let the sheet out slowly until a soft fold appears in the front ' +
            'edge, up in the top third. Pull in an inch or two until it goes. Start ' +
            'letting out again. If the sheet has not moved in five minutes she is ' +
            'over-sheeted and you are dragging her along rather than flying her.',
        signs: [
            [
                'Curl appearing and vanishing every ten or twenty seconds, always in the ' + 'top third',
                'Set right and being flown right.',
                'good',
            ],
            [
                'Curl appears and will not go',
                'Not enough angle at the front edge. <b>Pull the sheet in — or bear ' +
                    'away.</b> Do NOT head up: coming up makes the curl bigger, not ' +
                    'smaller.',
                'warn',
            ],
            [
                'Front edge collapses right in, all down its length',
                'Too far off the wind, or she has run out of wind. Come up until she ' + 'fills, then settle.',
                'bad',
            ],
            [
                'No curl no matter how far you ease',
                'Over-sheeted, or the wind has gone aft of where this sail works.',
                'warn',
            ],
        ],
        quirk:
            'The rules on the Sail plan page are hard limits and this page does not ' +
            'soften them: <b>not at night, not short-handed</b>, and she comes down ' +
            'before the gusts get to her ceiling — not as they arrive.',
    },
];

export const POS = {
    /* boom angle off centreline, and the traveller car (-1 leeward .. +1
     windward). Both of these genuinely do move with the point of sail.

     The headsail car used to be in here too, a fraction per band running
     0.20 to 0.92 - nearly three-quarters of the track. That was wrong twice
     over, and it is what made the picture look like a control you chase.
     See CAR below. */
    Beating: { boom: 12, trav: 0.35 },
    'Close reach': { boom: 28, trav: 0.0 },
    'Beam reach': { boom: 52, trav: -0.65 },
    'Broad reach': { boom: 72, trav: -1.0 },
    Running: { boom: 86, trav: -1.0 },
};

/* --- CAR --- */
export const CAR = {
    set: 0.62 /* leave it here - covers everything she normally does */,
    full: 0.78 /* deliberate, set alongside: full sail all day          */,
    rolled: 0.42 /* deliberate, set alongside: expecting to be reefed     */,
};

/* --- REEFPICK --- */
export const REEFPICK = [
    {
        key: 'wind',
        label: 'On the wind',
        band: 'Beating',
        note:
            'Beating and close reaching. The binding case — apparent wind is ' +
            'highest here, so these are the lowest numbers on the boat.',
    },
    {
        key: 'beam',
        label: 'Beam reach',
        band: 'Beam reach',
        note:
            'Apparent wind easing off the bow, so she carries a couple of knots ' +
            'more than upwind before each step.',
    },
    {
        key: 'down',
        label: 'Downwind',
        band: 'Broad reach',
        note:
            'Broad reaching and running. The main comes OFF by 27 kn — off the ' +
            'wind it is the sail that rolls her and broaches her, and these ' +
            'numbers never let her carry more main than she could round up under.',
    },
];

export const REEFWHEN = [
    [
        'The first time you think about it',
        'The oldest rule afloat and still the best one. The thought arrives before the need, every time.',
    ],
    [
        'Before dark',
        'Reef at sunset for the night ahead, not for the wind you have at sunset. Undoing it at 2am is easy; putting one in is not.',
    ],
    [
        'Before it arrives, not when it does',
        'Use the forecast gust for the next few hours. The strip below this shows it.',
    ],
    [
        'Before you bear away',
        'Reef while you are still on the wind. Rolling a main in with the boom right out and the vang loaded is a different job entirely.',
    ],
    ['Before the crew is tired', 'Or cold, or seasick, or it is rough. Early is easy; late is a wrestle.'],
    [
        'When she starts telling you',
        'Weather helm past about 5° on the Steering page, sustained heel past 20°, rounding up in the gusts, or speed no longer rising with the wind. She asks before the numbers do.',
    ],
];

/* --- HEEL_POSITIVE_IS_STBD --- */
export const HEEL_POSITIVE_IS_STBD = true; /* CHECK ON THE FIRST BEAT */

/* --- HULL --- */
export const HULL = {
    /* Seen from astern, looking forward: starboard to the right, as she
     sits. Beamy topsides, a hard turn of bilge, and the fin under her. */
    stern: [
        'M -50 -10 L 50 -10 L 44 2 Q 26 12 12 15 L 12 16 L -12 16 L -12 15 ' + 'Q -26 12 -44 2 Z',
        'M -6 16 L 6 16 L 4.5 44 L -4.5 44 Z',
        'M -1.6 -10 L 1.6 -10 L 1.6 -46 L -1.6 -46 Z',
    ],
    /* Seen from the port side, bow to the right: a springy sheer dipping
     amidships and lifting to a raked stem, trunk cabin, cutter rig on a
     bowsprit, fin keel, and a rudder hung on the aft edge of a skeg -
     which is what she actually has, per her own particulars page. */
    side: [
        /* Hull. The sheer is the line that makes a boat look like a boat: it
       must sit HIGH at the transom, dip amidships, and lift again to the
       bow. Drawn rising monotonically from stern to bow it reads as a
       drooping stern, which is what the first attempt at this did.
       Counter stern, so the deck overhangs the waterline aft. */
        /* Freeboard is about a tenth of her length, not a fifth. Drawn too
       tall with too much lift at the bow she came out as a Viking
       longship - a boat is mostly a long low thing with a gentle spring
       to the sheer, and the eye notices the proportion before anything
       else. Deck sits 8 units up amidships on a 120-unit hull. */
        'M -60 -11 C -42 -9 -20 -8 0 -8 C 24 -8 44 -11 60 -16 ' +
            'C 58 -10 55 -4 50 0 C 44 4 34 6 24 6 ' +
            'C 4 7 -22 7 -42 5 L -54 3 Z',
        /* Trunk cabin, sitting on the deck rather than merging into it. */
        'M -20 -8 C -19 -13 -16 -15 -12 -15 L 12 -15 C 16 -15 18 -13 19 -8 Z',
        /* Fin keel. Her draft is 2.00 m on 16.76 m LOA, which to scale would
       be a fin about half this deep - and near invisible at dial size.
       Drawn slightly deep on purpose; this is an icon, not a lines plan. */
        'M 2 5 L 24 5 L 19 24 L 7 25 Z',
        /* Rudder, as ONE appendage. Drawn as a separate skeg and blade it
       came out as two detached rectangles under the counter, which reads
       as a boat with two rudders - she has one, hung on a skeg, and the
       two are a single shape from the side. */
        'M -26 3 L -42 3 L -40 22 L -28 21 Z',
        /* Mast, stepped just forward of amidships. */
        'M 2.5 -15 L 5.5 -15 L 5.5 -66 L 2.5 -66 Z',
        /* Boom. */
        'M -32 -23 L 4 -25 L 4 -21 L -32 -19 Z',
    ],
};

/* --- JOLLY --- */
export const JOLLY = {
    sail: 'M 5.5 -64 L 5.5 -25 L -32 -22 Z',
    /* Sized to the triangle rather than to taste. The leech runs from the
     masthead to the clew, so the sail narrows sharply toward the head -
     an emblem laid out by eye put the ends of the crossbones straight
     through the after edge. At y=-42 the cloth only reaches x=-14, and
     nothing here goes past it. */
    bones: ['M -14 -30 L -2 -42', 'M -2 -30 L -14 -42'],
    cranium: [-8, -36, 4.3],
    jaw: 'M -11 -33.4 L -5 -33.4 L -5.9 -29.8 L -10.1 -29.8 Z',
    sockets: [
        [-9.6, -36.8, 1.35],
        [-6.4, -36.8, 1.35],
    ],
    grin: 'M -10.2 -31.9 L -5.8 -31.9 L -5.8 -31 L -10.2 -31 Z',
};

// ─────────────────────────────────────────────────────────────────────────
// Pure functions, ported verbatim. Colour tokens become semantic levels the
// UI maps to its own palette.
// ─────────────────────────────────────────────────────────────────────────

export type SeverityLevel = 'good' | 'warning' | 'serious' | 'critical' | 'muted';

const fmt = (v: number | null | undefined, d = 1): string =>
    v === null || v === undefined || Number.isNaN(v) ? '—' : (+v).toFixed(d);

export interface HelmRefusal {
    ok: false;
    downwind?: boolean;
    why: string;
}

export interface HelmJudgement {
    ok: true;
    state: 'over' | 'under' | 'balanced';
    deg: number;
    level: 'good' | 'warning' | 'serious';
    word: string;
    tack: 'starboard' | 'port';
    what: string;
    fix: string;
}

export function helmBalance(w: SailingWind | null): HelmRefusal | HelmJudgement | null {
    if (!w) return null;
    const h = w.helm;
    if (!h || h.mean == null || !isFinite(h.mean)) return null;

    const awa = w.awa,
        aws = w.aws;
    const sog = w.sog,
        stw = w.stw;
    const way = Math.max(sog != null ? sog : 0, stw != null ? stw : 0);

    if (way < 1.5) return { ok: false, why: 'not enough way on for the helm to mean anything' };
    if (aws == null || aws < 4) return { ok: false, why: 'too little wind to judge her balance by' };
    if (awa == null) return { ok: false, why: 'no wind angle, so which tack is unknown' };

    /* Refuses aft of 110 degrees, and this is the important gate.
       Downwind in a quartering sea the helm swings twenty degrees each way
       and the MEAN of that is zero - so an average-rudder rule reports
       "nicely balanced" right up until she broaches. The number is not
       merely noisy off the wind, it is actively reassuring at the moment it
       should not be. What matters downwind is rudder ACTIVITY, not its
       average, and that is a different measurement. */
    const twa = w.twa != null && isFinite(w.twa) ? w.twa : awa;
    const off = Math.abs((((twa % 360) + 360) % 360) - 180); /* 0 = dead run */
    if (off < 70)
        return {
            ok: false,
            downwind: true,
            why:
                'she is off the wind, where average rudder angle means nothing — ' +
                'it averages to zero in a quartering sea even while she is being ' +
                'thrown about',
        };

    const a = ((awa % 360) + 360) % 360;
    const windOnStbd = a > 0 && a < 180;
    /* Positive = weather helm, whichever tack she is on. */
    const wh = windOnStbd ? -h.mean : h.mean;

    /* A band wide enough to absorb a rudder reference that is not perfectly
       zeroed - this one reads 1.2 degrees with the boat ashore and the blade
       presumably straight, so a degree or so of offset is already known
       about and must not be allowed to raise alarms by itself. */
    /* Said in plain words. "Trim on" and "ease the traveller" are what a
       racing crew says to each other; they are no use on a screen someone
       reads once, at night, wondering what to do with their hands. */
    if (wh > 8)
        return {
            ok: true,
            state: 'over',
            deg: wh,
            level: 'serious',
            word: 'Too much sail up',
            tack: windOnStbd ? 'starboard' : 'port',
            what:
                'She is fighting to turn INTO the wind, and you are holding her ' +
                'straight with the rudder. That rudder is now a brake.',
            fix:
                'Slide the traveller — the mainsheet car — down away from the wind. ' +
                'If that is not enough, roll some main into the boom — down to the ' +
                'next batten, boom at 87° on the vang.',
        };
    if (wh > 4)
        return {
            ok: true,
            state: 'over',
            deg: wh,
            level: 'warning',
            word: 'Starting to fight you',
            tack: windOnStbd ? 'starboard' : 'port',
            what:
                'She is pulling towards the wind more than she should, and you ' +
                'are correcting for it all the time.',
            fix:
                'Slide the traveller — the mainsheet car — down away from the wind. ' +
                'It is the reversible one: it de-powers her without spoiling the ' +
                'sail shape, so you can slide it back up when the gust passes.',
        };
    if (wh < -2.5)
        return {
            ok: true,
            state: 'under',
            deg: wh,
            level: 'warning',
            word: 'Falling away from the wind',
            tack: windOnStbd ? 'starboard' : 'port',
            what:
                'She keeps sliding AWAY from the wind and will not come back up ' +
                'on her own. Too much sail at the front, not enough at the back.',
            fix:
                'Pull the mainsail in tighter. Or roll away some of the headsail. ' +
                'Either one shifts the pull backwards, which is what she needs.',
        };
    return {
        ok: true,
        state: 'balanced',
        deg: wh,
        level: 'good',
        word: 'Nicely balanced',
        tack: windOnStbd ? 'starboard' : 'port',
        what: 'She is close to steering herself — barely any rudder needed.',
        fix: 'Nothing to do. This is where she is quickest.',
    };
}

export function helmVerdict(mean: number): { word: string; level: SeverityLevel; note: string } {
    const a = Math.abs(mean);
    if (a < 1.5) return { word: 'Balanced', level: 'good', note: 'she is steering herself' };
    if (a < 4) return { word: 'A touch of helm', level: 'good', note: 'normal, and what you want upwind' };
    if (a < 8)
        return { word: 'Carrying helm', level: 'warning', note: 'the rudder is working — she is asking for a reef' };
    return {
        word: 'Fighting her',
        level: 'serious',
        note: 'this much helm is a brake — reef or ease and she will go faster',
    };
}

export function heelBand(deg: number): { word: string; level: SeverityLevel; note: string } {
    const a = Math.abs(deg);
    if (a < 10) return { word: 'Sailing easy', level: 'good', note: 'barely leaning on her' };
    if (a < 18) return { word: 'Working', level: 'good', note: 'where she likes to be' };
    if (a < 25) return { word: 'Pressed', level: 'warning', note: 'still driving, but the rail is going down' };
    if (a < 32) return { word: 'Overpressed', level: 'serious', note: 'making leeway now — a reef would go faster' };
    return { word: 'Reef her', level: 'critical', note: 'past useful — she is being pushed sideways' };
}

export interface SailPlanRow {
    to: number;
    main: string;
    yankee: string;
    stay: boolean | 'try' | 'storm';
    runners?: boolean;
    prevent?: boolean;
    pole?: string;
    note: string;
}

export interface SailPlanChoice {
    band: { band: string; from: number; to: number; rows: SailPlanRow[] };
    row: SailPlanRow;
    off: number;
    headToWind: boolean;
    trim: { traveller: string; mainsheet: string; yankee: string; staysail: string } | null;
}

export function sailPlanFor(gustKn: number | null, twa: number | null): SailPlanChoice | null {
    if (gustKn == null || twa == null) return null;
    const a = ((twa % 360) + 360) % 360;
    const off = a > 180 ? 360 - a : a; /* 0 = head to wind, 180 = run */
    const plan = SAILPLAN as unknown as SailPlanChoice['band'][];
    const band = plan.find((b) => off >= b.from && off < b.to) || (off < 30 ? plan[0] : plan[plan.length - 1]);
    const row = band.rows.find((r) => gustKn < r.to) || band.rows[band.rows.length - 1];
    return {
        band,
        row,
        off,
        headToWind: off < 30,
        trim: (TRIM as Record<string, SailPlanChoice['trim']>)[band.band] || null,
    };
}

export function reefDescribe(row: SailPlanRow, isDown: boolean): { m: string; rest: string } {
    const y =
        row.yankee.indexOf('Full') === 0
            ? 'full yankee'
            : row.yankee.indexOf('Rolled') === 0
              ? 'yankee rolled to two-thirds'
              : 'yankee rolled away';
    const s =
        row.stay === true
            ? ', staysail set'
            : row.stay === 'storm'
              ? ', storm staysail'
              : row.stay === 'try'
                ? ', staysail worth setting'
                : '';
    let m;
    if (row.main.indexOf('Full') === 0) m = 'Full main';
    else if (row.main.indexOf('Reef 3 flat') === 0) m = 'Rolled deep and flattened';
    else if (row.main.indexOf('Reef') === 0)
        m =
            'Roll to the ' +
            row.main.slice(5, 6) +
            (row.main[5] === '1' ? 'st' : row.main[5] === '2' ? 'nd' : 'rd') +
            ' batten';
    else m = 'Main rolled away' + (isDown ? ' — she runs on headsails alone' : '');
    return { m, rest: y + s };
}

export function kiteAdvice(
    gust: number | null,
    twa: number | null,
    night: boolean,
): { ok: boolean; why: string; down?: string } | null {
    if (gust == null || twa == null) return null;
    const a = Math.abs((((twa % 360) + 360) % 360) - 180);
    const angleOk = 180 - a >= KITE.twaLow && 180 - a <= KITE.twaHigh;
    if (night) return { ok: false, why: 'Not at night. Not shorthanded, not with 200 square metres.' };
    if (gust > KITE.gustMax)
        return {
            ok: false,
            why:
                `Gusting ${fmt(gust, 0)} kn. That is above the ${KITE.gustMax} kn ` +
                `you want for 200 m² two-handed. It is a fair-weather sail on a ` +
                `22-tonne boat.`,
        };
    if (!angleOk)
        return {
            ok: false,
            why:
                'Wrong angle — an asymmetric wants 70° to 150° off the wind. Too ' +
                'close and it will not set; too deep and it collapses behind the main.',
        };
    return {
        ok: true,
        why:
            `${fmt(gust, 0)} kn gusts and a good angle. Snuffer ready, tack line ` +
            `eased for the deeper angles and hard on for reaching.`,
        down:
            'Take it down at the FIRST THOUGHT of taking it down. If a squall ' +
            'line is anywhere on the horizon it comes off now, not when it arrives.',
    };
}

export interface DepthTrackPoint {
    /** epoch seconds */
    t: number;
    /** depth as displayed, metres */
    d: number;
}

export function shoalRate(
    track: DepthTrackPoint[] | null | undefined,
    off: number,
    nowMs: number = Date.now(),
): { label: string; text: string; level: SeverityLevel; note: string } {
    const now = nowMs / 1000;
    const pts = (track || []).filter((p) => p && typeof p.d === 'number' && p.t > now - 360);
    if (pts.length < 4) return { label: 'Trend', text: '—', level: 'muted', note: 'not enough of a trace yet' };
    const t0 = pts[0].t,
        span = (pts[pts.length - 1].t - t0) / 60;
    if (span < 0.5) return { label: 'Trend', text: '—', level: 'muted', note: 'not enough of a trace yet' };
    /* Least squares, so one wild sounding cannot set the trend on its own. */
    let sx = 0,
        sy = 0,
        sxy = 0,
        sxx = 0;
    pts.forEach((p) => {
        const x = (p.t - t0) / 60,
            y = p.d;
        sx += x;
        sy += y;
        sxy += x * y;
        sxx += x * x;
    });
    const n = pts.length,
        den = n * sxx - sx * sx;
    if (!den) return { label: 'Trend', text: '—', level: 'muted', note: '' };
    const m = (n * sxy - sx * sy) / den; /* metres per minute, signed */

    if (Math.abs(m) < 0.05)
        return { label: 'Trend', text: 'Steady', level: 'good', note: `over the last ${fmt(span, 0)} min` };
    if (m > 0)
        return {
            label: 'Trend',
            text: `Deepening ${fmt(m, 1)} m/min`,
            level: 'good',
            note: `over the last ${fmt(span, 0)} min`,
        };

    /* Shoaling. The number worth having is not the rate but how long it buys
       you: at this rate, when does the keel meet the bottom? */
    const last = pts[pts.length - 1].d + off;
    const mins = last > 0 ? last / Math.abs(m) : 0;
    return {
        label: 'Trend',
        text: `Shoaling ${fmt(Math.abs(m), 1)} m/min`,
        level: mins < 5 ? 'critical' : mins < 15 ? 'serious' : 'warning',
        note: mins < 60 ? `keel down in about ${fmt(mins, 0)} min at this rate` : `over the last ${fmt(span, 0)} min`,
    };
}

/** True wind from apparent + speed through water (law of cosines path). */
export function trueWindFrom(
    awa: number | null,
    aws: number | null,
    stw: number | null,
): { twa: number; tws: number } | null {
    if (awa == null || aws == null || stw == null) return null;
    const rad = (awa * Math.PI) / 180;
    const tx = aws * Math.cos(rad) - stw;
    const ty = aws * Math.sin(rad);
    const tws = Math.hypot(tx, ty);
    let twa = (Math.atan2(ty, tx) * 180) / Math.PI;
    twa = ((twa % 360) + 360) % 360;
    return { twa, tws };
}
