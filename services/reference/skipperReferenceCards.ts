/**
 * Skipper's Reference — the static marine-weather reference cards, folded into Thalassa from the
 * "Passage-Maker's Weather Pack" (adversarially marine-met fact-checked, 2026-06-21). Card #1 of the
 * pack (Go/No-Go) shipped as an interactive scorer that lost its way in; 132-B23 deleted it, and the
 * Departure Window on the Plan tab covers leaving times. These are the four reference cards.
 *
 * Four rules corrected 2026-10-09 (binder audit SR-1, SR-2; pinned in tests/skipperReferenceCards.test.ts),
 * each checked to hold in both hemispheres:
 *   - Isobars: geostrophic wind = gradient / (air density x f), f = 2 Omega sin(latitude), so the same
 *     spacing blows HARDER toward the equator (4 hPa per 300 km: about 9.5 m/s at 50 deg, 21 m/s at 20 deg),
 *     and the balance fails near the equator, where f goes to zero (Stull, Practical Meteorology, ch. 10).
 *   - NW round through SW to S is 315 -> 180 deg: anticlockwise, which the Met Office marine glossary
 *     defines as BACKING; a northern cold front veers (clockwise) instead.
 *   - "Tending" names a change of direction ("Southerly 15 to 20 knots tending southeasterly", BOM
 *     coastal waters forecasts), not a build.
 *   - A barb's shaft points to where the wind blows FROM (NWS wind-barb guide; Met Office glossary,
 *     wind direction).
 *
 * Worldwide since 132-B23 (binder audit SR-3 to SR-7): the synoptic and cyclone cards follow the
 * skipper's hemisphere, with Northern Hemisphere seasons and a worldwide source list. The Australia
 * and New Zealand detail (the southerly change, the squash zone, the East Coast Low, going south for
 * the cyclone season) moved into a labelled regional block, shown with the Southern Hemisphere
 * cards. Every Northern Hemisphere fact names its source beside it; where a source could not be
 * named, the fact was left out. Two of the pack's lines were softened on the way, not sharpened:
 * no cross-isobar angle (see the synoptic notes), and the claim that the Australian and South
 * Pacific seasons have different official dates became "check the official dates".
 *
 * PURE DATA — no React/app imports — so the same content can back Bosun's knowledge scaffolding on
 * the Pi. `bodyHtml` carries light inline markup (<strong>/<em>/<code>/<br>); it is authored, trusted,
 * constant content (NOT user input), so the UI renders it via dangerouslySetInnerHTML.
 */

export type Hemisphere = 'south' | 'north';

export interface ReferenceStep {
    num: string;
    heading: string;
    bodyHtml: string;
}

export interface ReferenceCallout {
    label: string;
    items: string[];
}

/** Detail that holds for one region only, in its own labelled block under the worldwide steps (132-B23). */
export interface ReferenceRegion {
    label: string;
    /** One plain line under the label: whose waters these are. */
    note: string;
    steps: ReferenceStep[];
}

export interface ReferenceCard {
    id: string;
    emoji: string;
    title: string;
    subtitle: string;
    steps: ReferenceStep[];
    callout: ReferenceCallout;
    pullquote: string;
    sources: string;
    /** Set on a card whose content follows the skipper's hemisphere: the one it was written for. */
    hemisphere?: Hemisphere;
    region?: ReferenceRegion;
}

const AUSTRALIA_AND_NZ = 'Australia & New Zealand';

const GRIB_CARD: ReferenceCard = {
    id: 'grib-60s',
    emoji: '🛰️',
    title: 'GRIB in 60 Seconds',
    subtitle: 'Read the model fast, distrust it in the right places.',
    steps: [
        {
            num: '1',
            heading: "KNOW WHAT YOU'RE LOOKING AT",
            bodyHtml: `A GRIB is <strong>raw numerical model output</strong> — no forecaster has touched it. It inherits every blind spot of the model that made it. Treat it as a smart input to your decision, <em>not</em> the decision.`,
        },
        {
            num: '2',
            heading: 'THE FIELDS THAT MATTER',
            bodyHtml: `<strong>10 m wind</strong> (barbs) · <strong>MSLP</strong> (isobars — tight packing = strong wind) · <strong>gusts</strong> if your source carries them · <strong>precip</strong> · <strong>waves</strong>, and read all three: significant <em>height</em>, <em>period</em>, and <em>direction</em>. Height alone tells you almost nothing.`,
        },
        {
            num: '3',
            heading: 'READ THE BARB AT A GLANCE',
            bodyHtml: `Half barb, full barb, pennant — confirm the <strong>knot value each tick carries</strong> for your GRIB before you trust the sum. The shaft points to where the wind is <em>coming from</em>. By strict convention barbs sit to the <strong>right</strong> of the shaft in the Southern Hemisphere (left in the Northern) — but <em>many GRIB viewers don't flip for the SH</em>, so never use barb side to read speed or to guess your hemisphere. Speed is in the ticks, full stop.`,
        },
        {
            num: '4',
            heading: 'THE RESOLUTION TRAP',
            bodyHtml: `A GRIB <strong>smooths terrain and coastline</strong> to its grid. It under-reads coastal acceleration, capes and headlands, sea-breeze and katabatic fall-off. <strong>Never trust fine inshore detail</strong> — the closer to land, the more you back local knowledge over the grid.`,
        },
        {
            num: '5',
            heading: 'MODEL SPREAD IS YOUR SIGNAL',
            bodyHtml: `Always compare <strong>two or more models</strong>. Agreement = confidence. Divergence = <strong>high uncertainty</strong> — not proof either run is wrong, but a flag that the atmosphere is hard to pin down here. The size of the spread <em>is</em> your uncertainty. Don't pick the friendliest run; plan to the worst of the cluster.`,
        },
        {
            num: '6',
            heading: 'MIND THE TIME HORIZON',
            bodyHtml: `Skill <strong>decays with lead time</strong>. As a working frame: the <strong>first few days</strong> are actionable; the <strong>middle of the range</strong> gives trend and direction only, not detail; <strong>further out</strong> is mood music — useful for whether a window <em>might</em> exist, useless for committing to one. Where each band falls depends on the model and the synoptic setup.`,
        },
        {
            num: '7',
            heading: 'GUSTS AND CONVECTION LIE LOW',
            bodyHtml: `GRIB gust fields <strong>under-read squalls and thunderstorm downbursts</strong> — convection lives below the grid. <strong>Add margin, reef early</strong>, and watch the sky and radar, not just the file. The number is a floor, not a ceiling.`,
        },
    ],
    callout: {
        label: 'DISTRUST THE GRIB WHEN',
        items: [
            'Two models disagree — the spread is the forecast',
            "You're within a few miles of land or terrain",
            'Convection or squalls are in play (gusts under-read)',
            "You're reading fine detail past the first few days",
            'Your source has no gust field and you assumed one',
        ],
    },
    pullquote: "A GRIB is a model's best guess, not a promise it ever made you.",
    sources:
        'Sources you trust: the source/help docs for your own GRIB provider and the named model behind each file (e.g. GFS, ECMWF, ICON), plus a recognised national forecaster (BOM, MetService) to sanity-check the model against a human.',
};

/* ── Synoptic Chart Decoder ─────────────────────────────────────────────────
 * Northern Hemisphere lines (132-B23), each read against its source on
 * 2026-10-15:
 *   - Wind blows anticlockwise round a low and clockwise round a high in the
 *     north, deflected right there and left in the south: UK Met Office,
 *     "Wind flow" and "How to read synoptic weather charts" (Learn about weather).
 *   - Buys Ballot's law, back to the wind: low pressure on the left in the
 *     north, on the right in the south. Bowditch, The American Practical
 *     Navigator (NGA Pub. No. 9, 2019 edition), Vol. II, Glossary of Marine
 *     Navigation, "Buys Ballot's Law", p. 311: facing away from the wind, the
 *     low lies to the left in the northern hemisphere, to the right in the
 *     southern.
 *   - Friction turns surface wind across the isobars toward the low, by less
 *     over the sea than over land (both hemispheres): Penn State METEO 3,
 *     "Against the Wind" (about 10-25 degrees over large water bodies, 30-45
 *     over land). The pack's "only a few degrees over open water" undersold
 *     that, so the card now gives no number.
 *   - A northern cold front veers the wind sharply as it passes: Met Office
 *     National Meteorological Library fact sheet 10, "Air masses and weather
 *     fronts"; typically south-south-west ahead to west-north-west behind:
 *     Penn State METEO 3, "Cold Fronts".
 */

const SYNOPTIC_ISOBARS: ReferenceStep = {
    num: '1',
    heading: 'ISOBARS = WIND SPEED',
    bodyHtml: `Tight isobars mean strong wind, wide spacing means light — the gradient is the speed gauge. <strong>The same spacing blows harder toward the equator</strong>, where Coriolis is weaker, so wide tropical isobars can still mean a fresh trade. <em>Within a few degrees of the equator isobars stop working: use the model's wind.</em> Learn your own chart's spacing-to-knots feel and recalibrate by latitude.`,
};

const SYNOPTIC_FRICTION = `Surface wind doesn't follow the isobar exactly; friction turns it <strong>inward across the isobars toward the low</strong>, less over open water than over land. <em>Use the cross-isobar angle that matches your sea area.</em>`;

const SYNOPTIC_SYSTEMS: ReferenceStep = {
    num: '4',
    heading: 'HIGHS / RIDGES vs LOWS / TROUGHS',
    bodyHtml: `<strong>High / ridge = sinking air, settling weather</strong> — lighter winds near the centre, clearer skies, but a strong high parked nearby still drives hard wind on its edges. <strong>Low / trough = rising air, unsettled</strong> — cloud, rain, shifting and building wind. Name the feature first; <em>the wind is just a symptom of it.</em>`,
};

const SYNOPTIC_TIGHT_GRADIENT: ReferenceStep = {
    num: '6',
    heading: "STRONG WIND, NO 'WEATHER'",
    bodyHtml: `Where a <strong>strong high presses against a trough or low</strong>, the gradient compresses and the wind blows hard with no front and no centre near you — reinforcing the trades where they blow. <em>It looks benign on the chart</em>: just tightly packed isobars delivering <strong>days of strong wind</strong> from one quarter. Watch the gap between high and low, not the systems themselves.`,
};

const SYNOPTIC_SOURCES =
    "Sources you trust: the official surface analyses and forecasts for your waters (NOAA's Ocean Prediction Center, the UK Met Office, BOM, MetService NZ, or your own national met service), gridded GFS/ECMWF model charts, and a recognised marine-meteorology text.";

const synopticCallout = (spin: string): ReferenceCallout => ({
    label: 'READ THE CHART IN THIS ORDER',
    items: [
        'Name the systems — highs, lows, fronts, troughs',
        'Read isobar spacing for strength, recalibrated by latitude',
        spin,
        'Find the tight gradients — strong wind with no front',
        'Mark each front and which way it will swing the wind',
    ],
});

/** The southerly change, the squash zone and the East Coast Low: the pack's Australian lines, kept whole. */
const SYNOPTIC_AUSTRALIA_NZ: ReferenceRegion = {
    label: AUSTRALIA_AND_NZ,
    note: 'Local detail for the Australian coast, the Coral and Tasman Seas.',
    steps: [
        {
            num: '7',
            heading: 'FRONTS & THE SOUTHERLY CHANGE',
            bodyHtml: `On the Australian east/south coast a <strong>cold front brings the "southerly change"</strong> behind it — wind swings hard from the NW round through the SW to the S — it <strong>backs</strong> (turns anticlockwise) — strengthens sharply, seas build, then ease as the ridge follows. <em>A southerly buster can slam in near-instantly</em> with a wind line and squalls. Reef before it arrives, not after.`,
        },
        {
            num: '8',
            heading: 'THE SQUASH ZONE',
            bodyHtml: `Down here a strong high pressing against a trough or low has a name: the <strong>squash zone</strong>. The gradient compresses and reinforces the trades — <em>Coral and Tasman Seas especially</em> — for days, from one quarter, with nothing on the chart that looks like weather.`,
        },
        {
            num: '9',
            heading: 'THE EAST COAST LOW — TRUST IT EARLY',
            bodyHtml: `A <strong>fast-deepening coastal low</strong> that broad global models routinely <em>under-cook</em> — they smear the central pressure and lag the spin-up. If the setup is there (a low forming off a trough against a coast), assume worse and earlier than the chart shows. <strong>When mesoscale and global models disagree, believe the angrier one</strong> and stay in port.`,
        },
    ],
};

const SYNOPTIC_CARDS: Record<Hemisphere, ReferenceCard> = {
    south: {
        id: 'synoptic',
        emoji: '🌀',
        title: 'Synoptic Chart Decoder',
        subtitle: 'Read the surface chart, get the wind — Southern Hemisphere',
        hemisphere: 'south',
        steps: [
            SYNOPTIC_ISOBARS,
            {
                num: '2',
                heading: 'ROTATION — SOUTH SPINS THE OTHER WAY',
                bodyHtml: `Southern Hemisphere: wind runs <strong>CLOCKWISE around a LOW</strong> and <strong>ANTICLOCKWISE around a HIGH</strong>. <em>This is the mirror of the North</em> — northern charts reverse both. ${SYNOPTIC_FRICTION}`,
            },
            {
                num: '3',
                heading: 'BUYS BALLOT — POINT TO THE WEATHER',
                bodyHtml: `Back to the wind in the SH and <strong>the low is on your RIGHT hand</strong> (high on your left). <em>In the NH the low is on your left.</em> One glance at the chart's spin tells you which way the breeze sets across your track — and where the next system sits relative to you, without waiting for the text forecast.`,
            },
            SYNOPTIC_SYSTEMS,
            {
                num: '5',
                heading: 'FRONTS — THE WIND SWINGS',
                bodyHtml: `As a <strong>cold front</strong> goes through, the wind shifts: in the Southern Hemisphere it <strong>backs</strong> (turns anticlockwise), typically from the north-west round through the west to the south-west or south, and it often turns gusty, with showers or squalls, as the front passes. Reef before it arrives, not after. <strong>NH cold fronts mirror this</strong>: there the wind veers (turns clockwise) as the front passes.`,
            },
            SYNOPTIC_TIGHT_GRADIENT,
        ],
        callout: synopticCallout('Apply SH spin to get direction (clockwise=low, anticlockwise=high)'),
        pullquote: 'Isobars are the speedo, the spin is the compass — and down south the compass turns the other way.',
        sources: SYNOPTIC_SOURCES,
        region: SYNOPTIC_AUSTRALIA_NZ,
    },
    north: {
        id: 'synoptic',
        emoji: '🌀',
        title: 'Synoptic Chart Decoder',
        subtitle: 'Read the surface chart, get the wind — Northern Hemisphere',
        hemisphere: 'north',
        steps: [
            SYNOPTIC_ISOBARS,
            {
                num: '2',
                heading: 'ROTATION — NORTH OF THE EQUATOR',
                bodyHtml: `Northern Hemisphere: wind runs <strong>ANTICLOCKWISE around a LOW</strong> and <strong>CLOCKWISE around a HIGH</strong>. <em>This is the mirror of the South</em> — southern charts reverse both. ${SYNOPTIC_FRICTION}`,
            },
            {
                num: '3',
                heading: 'BUYS BALLOT — POINT TO THE WEATHER',
                bodyHtml: `Back to the wind in the NH and <strong>the low is on your LEFT hand</strong> (high on your right). <em>In the SH the low is on your right.</em> One glance at the chart's spin tells you which way the breeze sets across your track — and where the next system sits relative to you, without waiting for the text forecast.`,
            },
            SYNOPTIC_SYSTEMS,
            {
                num: '5',
                heading: 'FRONTS — THE WIND SWINGS',
                bodyHtml: `As a <strong>cold front</strong> goes through, the wind shifts: in the Northern Hemisphere it <strong>veers</strong> (turns clockwise), typically from the south-west round to the west or north-west, and it often turns gusty, with showers or squalls, as the front passes. Reef before it arrives, not after. <strong>SH cold fronts mirror this</strong>: there the wind backs (turns anticlockwise) as the front passes.`,
            },
            SYNOPTIC_TIGHT_GRADIENT,
        ],
        callout: synopticCallout('Apply NH spin to get direction (anticlockwise=low, clockwise=high)'),
        pullquote:
            'Isobars are the speedo, the spin is the compass — and south of the equator the compass turns the other way.',
        sources: SYNOPTIC_SOURCES,
    },
};

const FORECAST_CARD: ReferenceCard = {
    id: 'forecast-decoder',
    emoji: '📻',
    title: 'Marine Forecast Decoder',
    subtitle: 'Read the official coastal-waters forecast like the area average it actually is',
    steps: [
        {
            num: '1',
            heading: 'WIND WORDS → KNOT BANDS',
            bodyHtml: `Descriptors are a ladder, not a number: roughly <strong>light → moderate → fresh → strong → gale and up</strong>. Learn your authority's exact bands and burn them in — but treat them as a framework, not gospel. <br> · A forecast gives a <em>range</em> ("15 to 20 kt"); plan on the top of it and reef for the gusts above it. <br> · Gusts run well over the sustained figure and forecasts under-read them — assume more, not less.`,
        },
        {
            num: '2',
            heading: 'THE WARNINGS LADDER',
            bodyHtml: `Climbs in severity: <strong>Strong Wind Warning</strong> → <strong>Gale Warning</strong> → <strong>Storm Force Wind Warning</strong> → <strong>Hurricane Force Wind Warning</strong>, with <strong>Tropical Cyclone</strong> advice in its own class. A warning is keyed to <em>sustained</em> wind, so the gusts already exceed it. <br> · A warning in your area or track is a hard input, not background colour. <br> · Confirm the exact category names and the knot threshold behind each — they are authority- and region-specific and they change.`,
        },
        {
            num: '3',
            heading: 'SEA vs SWELL — AND COMBINED',
            bodyHtml: `<strong>Sea</strong> is the local wind-wave being built right now; <strong>swell</strong> is older energy that has travelled in from elsewhere. They combine: the <strong>combined/total sea</strong> can be uglier than either line alone — but it stacks vectorially, not by simple arithmetic, so don't just add the two heights. It's worst when they cross from different directions. <br> · Watch the <strong>period</strong> — short period plus height means steep and breaking; long-period swell is a comfortable lift. <br> · Beam and quarter seas hurt more than the height number suggests.`,
        },
        {
            num: '4',
            heading: 'TIMING WORDS ARRIVE AT THE EDGES',
            bodyHtml: `<strong>Freshening</strong> = building; <strong>easing / abating</strong> = dropping; <strong>tending</strong> (as in "tending southeasterly") = the direction is shifting toward that quarter. A change forecast "during the afternoon" usually shows at one <em>edge</em> of that window, rarely the tidy middle — and the front edge is where it catches you out. <br> · Plan for the early arrival and the late departure, not the average. <br> · "Easing" after a blow still leaves a left-over sea running for hours.`,
        },
        {
            num: '5',
            heading: "IT'S AN AREA AVERAGE — TRANSLATE IT",
            bodyHtml: `A coastal-waters forecast describes the <em>average</em> of a large zone. Your actual patch is amplified by terrain and tide: <strong>capes and headlands</strong> accelerate and bend the wind, <strong>river-bar mouths</strong> stand up dangerously on the ebb, and <strong>wind-over-tide</strong> stacks short steep seas anywhere current opposes wind. <br> · Mentally add a band of wind and sea near any cape, bar or tide gate. <br> · The benign zone average is not the sea you will actually sail.`,
        },
        {
            num: '6',
            heading: 'ACROSS THE DITCH — NZ METSERVICE',
            bodyHtml: `MetService NZ runs the same logic with its own labels: coastal forecasts, <strong>Strong Wind</strong> and <strong>Gale</strong> warnings, and sea/swell stated separately. The descriptor bands and warning thresholds are <em>not</em> guaranteed identical to the Australian set. <br> · Don't carry BOM's exact numbers across the Tasman — relearn the local terminology and thresholds before you trust them.`,
        },
    ],
    callout: {
        label: 'TRANSLATE BEFORE YOU TRUST',
        items: [
            'Forecast range → plan the top, reef for the gusts above it',
            'Warning in your area or track → hard input, not background',
            "Combined sea + short period → steep and breaking, not 'just height'",
            'Timing window → expect the change at the early edge',
            'Cape, bar or wind-over-tide on your patch → add a band of wind and sea',
        ],
    },
    pullquote: "The forecast describes the average sea in the zone. You won't be sailing in the average.",
    sources:
        "Sources you trust: your national met authority's official coastal-waters forecast and its own published descriptor/warning glossary (BOM in Australia, MetService in NZ) — read the definitions page, not your memory of it.",
};

/* ── Squalls & Cyclone-Season Rules ─────────────────────────────────────────
 * Northern Hemisphere lines (132-B23), each read against its source on
 * 2026-10-15:
 *   - One storm, three names: hurricane in the North Atlantic and the central
 *     and eastern North Pacific, typhoon in the north-west Pacific, cyclone in
 *     the Indian Ocean. NOAA Ocean Service, "What is the difference between a
 *     hurricane and a typhoon?".
 *   - The Atlantic season (its basin takes in the Caribbean and the Gulf of
 *     Mexico) runs 1 June to 30 November; the East Pacific's 15 May to
 *     30 November. The north-west Pacific has no official season: storms form
 *     all year, the main season July to November. The North Indian Ocean has
 *     a double peak, May and November. All four: NOAA AOML Hurricane Research
 *     Division, Tropical Cyclone FAQ, "When is hurricane season?".
 *   - The southern season, the warm half of the year: the same FAQ (from late
 *     October or early November into May).
 *   - Every warning centre in the sources line but the JTWC is one of the
 *     WMO's tropical-cyclone Regional Specialized Meteorological Centres or
 *     Tropical Cyclone Warning Centres, as the WMO lists them with their
 *     waters: WMO Community, "Latest Advisories - RSMCs and TCWCs" (Miami,
 *     Honolulu, Tokyo, New Delhi, La Réunion, Nadi; BOM's TCWC, Wellington).
 *     The line leaves out Jakarta's and Port Moresby's.
 * No hurricane-box latitudes or insurer dates: they differ by insurer and year.
 */

const SQUALL_STEPS: ReferenceStep[] = [
    {
        num: '1',
        heading: 'KNOW THE SQUALL',
        bodyHtml: `A squall is a sharp wind surge running <em>ahead</em> of a thunderstorm or heavy shower. Wind can double in seconds and the direction can shift hard either way — back <em>or</em> veer — so your nice beam reach becomes a knockdown on the wrong tack. <strong>Reef before it hits, not during.</strong> The gust front usually arrives before the rain.`,
    },
    {
        num: '2',
        heading: 'READ THE SIGNS',
        bodyHtml: `Watch for a <strong>dark flat base, a roll cloud, a wall of rain</strong>, and a bright intense cell on radar. The <em>leading edge</em> is the danger — wind tends to peak there and often eases once the rain sets in, though a cold-pool outflow can keep blowing.<br> · Eyeball: if you can't see daylight under it, treat it as live.<br> · Radar/sat is your friend at night — track the cell, don't just react to it.`,
    },
    {
        num: '3',
        heading: 'SHORTEN SAIL AT DUSK',
        bodyHtml: `Night squalls in the trades are routine and you won't see them coming. On passage, <strong>reef down at sunset as a standing rule</strong> — sail the night under canvas you can hold in a sudden hard gust. Shaking out a reef at dawn is cheap; getting caught overpowered in the dark is not. <em>Set the actual gust figure you reef for from your own boat and crew.</em>`,
    },
    {
        num: '4',
        heading: 'GIVE THUNDERSTORMS ROOM',
        bodyHtml: `Thunderstorm cells carry <strong>lightning and downbursts</strong> — sudden vertical wind that hits flat and spreads out from any direction. Don't try to thread between cells; alter course early and pass them with a wide berth. A few miles of detour beats a strike or a knockdown.`,
    },
];

const STORM_HOLE_BODY = `Not just any anchorage. A real hole has <strong>all-round protection, genuinely good holding, and room to lay out scope</strong> and swing. Surrounding mangroves or hills beat an open bay every time. Scout and commit to it <em>before</em> you need it — a hole you've never set in is a guess.`;

/** The Go/No-Go card this step pointed at was deleted (132-B23): the Departure Window finds leaving times. */
const DEPARTURE_WINDOW_STEP: ReferenceStep = {
    num: '7',
    heading: 'TIE IT TO THE DEPARTURE WINDOW',
    bodyHtml: `Tactical and strategic meet here. <strong>If a named tropical system sits anywhere in your forecast track window, you don't go.</strong> Not "probably fine," not "it'll curve away." The Departure Window on the Plan tab finds the best time to leave from the forecast; <em>a warning from the official centre for your waters overrules any time it picks</em>.`,
};

const CYCLONE_SOURCES =
    "Trust the official tropical-cyclone warning centre for your waters: NOAA's National Hurricane Center (Atlantic and eastern North Pacific), the Central Pacific Hurricane Center, the Japan Meteorological Agency (north-west Pacific), the India Meteorological Department (North Indian Ocean), Météo-France La Réunion (south-west Indian Ocean), BOM (Australian region), RSMC Nadi / Fiji Met (South Pacific) and MetService NZ; the US JTWC issues military advisories. Add live radar/satellite and your own eyes — not a single GRIB.";

/** Going south for the season, and whose warnings to watch: the pack's Australian and South Pacific lines. */
const CYCLONE_AUSTRALIA_NZ: ReferenceRegion = {
    label: AUSTRALIA_AND_NZ,
    note: 'Local detail for boats sailing from Australia and New Zealand into the South Pacific.',
    steps: [
        {
            num: '8',
            heading: 'SOUTH FOR THE SEASON',
            bodyHtml: `Tropical-cyclone season covers the <em>warm half of the year</em> in the Australian region and the South Pacific; check the official dates for the waters you're in. The common convention here is to get out of the tropics — <em>south</em>, toward NZ and higher latitudes — by a set go-by date, or commit to a cyclone hole. Watch BOM for the Australian region and RSMC Nadi / Fiji Met for the South Pacific.`,
        },
    ],
};

const SQUALL_CYCLONE_CARDS: Record<Hemisphere, ReferenceCard> = {
    south: {
        id: 'squall-cyclone',
        emoji: '⛈️',
        title: 'Squalls & Cyclone-Season Rules',
        subtitle: 'Two killers on two clocks: squalls in minutes, cyclones across a whole season.',
        hemisphere: 'south',
        steps: [
            ...SQUALL_STEPS,
            {
                num: '5',
                heading: 'OUT BEFORE THE SEASON',
                bodyHtml: `South of the equator the tropical-cyclone season covers the <em>warm half of the year</em>, and each region publishes its own official dates. The cruiser's strategic rule is simple: <strong>be out of the cyclone belt, or tucked in a vetted cyclone hole, before the season opens</strong> — not scrambling once it does. Set your own date from the official dates for your region and your insurer's box — don't trust a remembered number.`,
            },
            { num: '6', heading: 'WHAT A CYCLONE HOLE NEEDS', bodyHtml: STORM_HOLE_BODY },
            DEPARTURE_WINDOW_STEP,
        ],
        callout: {
            label: 'AUTO NO-GO',
            items: [
                'named tropical system anywhere in your track window',
                "cyclone season open and you're still in the belt with no hole",
                'squall line on the bow with no sea-room to dodge',
                'night passage in the trades with full sail up',
                'no scouted cyclone hole and no plan to get out of the tropics',
            ],
        },
        pullquote: "You can't outrun a cyclone. So the whole game is planning never to have to.",
        sources: CYCLONE_SOURCES,
        region: CYCLONE_AUSTRALIA_NZ,
    },
    north: {
        id: 'squall-cyclone',
        emoji: '⛈️',
        title: 'Squalls & Cyclone-Season Rules',
        subtitle: 'Two killers on two clocks: squalls in minutes, hurricanes across a whole season.',
        hemisphere: 'north',
        steps: [
            ...SQUALL_STEPS,
            {
                num: '5',
                heading: 'OUT BEFORE THE SEASON',
                bodyHtml: `North of the equator one storm goes by three names: <strong>hurricane</strong> in the North Atlantic and the central and eastern North Pacific, <strong>typhoon</strong> in the north-west Pacific, <strong>cyclone</strong> in the North Indian Ocean. Each basin keeps its own season: <br> · <strong>North Atlantic, Caribbean and Gulf of Mexico:</strong> officially 1 June to 30 November. <br> · <strong>Eastern North Pacific:</strong> officially 15 May to 30 November. <br> · <strong>North-west Pacific:</strong> typhoons in any month, most from July to November. <br> · <strong>North Indian Ocean:</strong> two peaks, around May and around November. <br> The cruiser's strategic rule is simple: <strong>be out of the belt, or tucked in a vetted hurricane hole, before the season opens</strong> — not scrambling once it does. Set your own date from the official dates and your insurer's box, checked each year — don't trust a remembered number.`,
            },
            { num: '6', heading: 'WHAT A HURRICANE HOLE NEEDS', bodyHtml: STORM_HOLE_BODY },
            DEPARTURE_WINDOW_STEP,
        ],
        callout: {
            label: 'AUTO NO-GO',
            items: [
                'named tropical system anywhere in your track window',
                "hurricane or typhoon season open and you're still in the belt with no hole",
                'squall line on the bow with no sea-room to dodge',
                'night passage in the trades with full sail up',
                'no scouted hurricane hole and no plan to get out of the belt',
            ],
        },
        pullquote: "You can't outrun a hurricane. So the whole game is planning never to have to.",
        sources: CYCLONE_SOURCES,
    },
};

/** The four cards, the synoptic and cyclone ones written for `hemisphere`. */
export function skipperReferenceCards(hemisphere: Hemisphere): ReferenceCard[] {
    return [GRIB_CARD, SYNOPTIC_CARDS[hemisphere], FORECAST_CARD, SQUALL_CYCLONE_CARDS[hemisphere]];
}

/** The Southern Hemisphere set: what the cards said before they followed the hemisphere. */
export const SKIPPER_REFERENCE_CARDS: ReferenceCard[] = skipperReferenceCards('south');
