/**
 * Skipper's Reference — the static marine-weather reference cards, folded into Thalassa from the
 * "Passage-Maker's Weather Pack" (adversarially marine-met fact-checked, 2026-06-21). Card #1 of the
 * pack (Go/No-Go) ships as the interactive scorer (components/weatherWindow/WeatherWindowCheck.tsx);
 * these are the four reference cards.
 *
 * PURE DATA — no React/app imports — so the same content can back Bosun's knowledge scaffolding on
 * the Pi. `bodyHtml` carries light inline markup (<strong>/<em>/<code>/<br>); it is authored, trusted,
 * constant content (NOT user input), so the UI renders it via dangerouslySetInnerHTML.
 */

export interface ReferenceStep {
    num: string;
    heading: string;
    bodyHtml: string;
}

export interface ReferenceCallout {
    label: string;
    items: string[];
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
}

export const SKIPPER_REFERENCE_CARDS: ReferenceCard[] = [
    {
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
                bodyHtml: `Half barb, full barb, pennant — confirm the <strong>knot value each tick carries</strong> for your GRIB before you trust the sum. The shaft points the way the wind is <em>going from</em>. By strict convention barbs sit to the <strong>right</strong> of the shaft in the Southern Hemisphere (left in the Northern) — but <em>many GRIB viewers don't flip for the SH</em>, so never use barb side to read speed or to guess your hemisphere. Speed is in the ticks, full stop.`,
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
    },
    {
        id: 'synoptic',
        emoji: '🌀',
        title: 'Synoptic Chart Decoder',
        subtitle: 'Read the surface chart, get the wind — Southern Hemisphere',
        steps: [
            {
                num: '1',
                heading: 'ISOBARS = WIND SPEED',
                bodyHtml: `Tight isobars mean strong wind, wide spacing means light — the gradient is the speed gauge. <strong>Same spacing blows harder nearer the pole</strong> (Coriolis weakens toward the equator), so don't read a tropical chart like a temperate one. <em>Learn your own chart's spacing-to-knots feel and recalibrate by latitude</em> — then trust your eyes before the model's wind arrows.`,
            },
            {
                num: '2',
                heading: 'ROTATION — SOUTH SPINS THE OTHER WAY',
                bodyHtml: `Southern Hemisphere: wind runs <strong>CLOCKWISE around a LOW</strong> and <strong>ANTICLOCKWISE around a HIGH</strong>. <em>This is the mirror of the North</em> — northern charts reverse both. Surface wind doesn't follow the isobar exactly; friction turns it <strong>inward across the isobars toward the low</strong> — only a few degrees over open water, much more over land. <em>Use the cross-isobar angle that matches your sea area.</em>`,
            },
            {
                num: '3',
                heading: 'BUYS BALLOT — POINT TO THE WEATHER',
                bodyHtml: `Back to the wind in the SH and <strong>the low is on your RIGHT hand</strong> (high on your left). <em>In the NH the low is on your left.</em> One glance at the chart's spin tells you which way the breeze sets across your track — and where the next system sits relative to you, without waiting for the text forecast.`,
            },
            {
                num: '4',
                heading: 'HIGHS / RIDGES vs LOWS / TROUGHS',
                bodyHtml: `<strong>High / ridge = sinking air, settling weather</strong> — lighter winds near the centre, clearer skies, but a strong high parked nearby still drives hard wind on its edges. <strong>Low / trough = rising air, unsettled</strong> — cloud, rain, shifting and building wind. Name the feature first; <em>the wind is just a symptom of it.</em>`,
            },
            {
                num: '5',
                heading: 'FRONTS & THE SOUTHERLY CHANGE',
                bodyHtml: `On the Australian east/south coast a <strong>cold front brings the "southerly change"</strong> behind it — wind swings hard from the NW round to the S (clockwise in the SH), strengthens sharply, seas build, then ease as the ridge follows. <em>A southerly buster can slam in near-instantly</em> with a wind line and squalls. Reef before it arrives, not after. <strong>NH cold fronts mirror this</strong> — the shift is opposite-handed.`,
            },
            {
                num: '6',
                heading: "THE SQUASH ZONE — STRONG WIND, NO 'WEATHER'",
                bodyHtml: `Where a <strong>strong high presses against a trough or low</strong>, the gradient compresses and reinforces the trades — Coral and Tasman Seas especially. <em>It looks benign on the chart: no front, no centre near you</em> — just tightly packed isobars delivering <strong>days of reinforced trades</strong> from one quarter. Watch the gap between high and low, not the systems themselves.`,
            },
            {
                num: '7',
                heading: 'THE EAST COAST LOW — TRUST IT EARLY',
                bodyHtml: `A <strong>fast-deepening coastal low</strong> that broad global models routinely <em>under-cook</em> — they smear the central pressure and lag the spin-up. If the setup is there (a low forming off a trough against a coast), assume worse and earlier than the chart shows. <strong>When mesoscale and global models disagree, believe the angrier one</strong> and stay in port.`,
            },
        ],
        callout: {
            label: 'READ THE CHART IN THIS ORDER',
            items: [
                'Name the systems — highs, lows, fronts, troughs',
                'Read isobar spacing for strength, recalibrated by latitude',
                'Apply SH spin to get direction (clockwise=low, anticlockwise=high)',
                'Find the squash zones — tight gradients with no front',
                'Flag any coastal low; trust the angrier model, not the smoother one',
            ],
        },
        pullquote: 'Isobars are the speedo, the spin is the compass — and down south the compass turns the other way.',
        sources:
            'Sources you trust: official met-bureau surface analyses and forecasts (BOM, MetService NZ, Fiji Met), gridded GFS/ECMWF model charts, and a recognised marine-meteorology text.',
    },
    {
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
                bodyHtml: `<strong>Tending / freshening</strong> = building; <strong>easing / abating</strong> = dropping. A change forecast "during the afternoon" usually shows at one <em>edge</em> of that window, rarely the tidy middle — and the front edge is where it catches you out. <br> · Plan for the early arrival and the late departure, not the average. <br> · "Easing" after a blow still leaves a left-over sea running for hours.`,
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
    },
    {
        id: 'squall-cyclone',
        emoji: '⛈️',
        title: 'Squalls & Cyclone-Season Rules',
        subtitle: 'Two killers on two clocks: squalls in minutes, cyclones across a whole season.',
        steps: [
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
            {
                num: '5',
                heading: 'OUT BEFORE THE SEASON',
                bodyHtml: `Tropical-cyclone season covers the <em>warm half of the year</em> in the Australian region and the South Pacific — but the two regions don't share identical official dates. The cruiser's strategic rule is simple: <strong>be out of the cyclone belt, or tucked in a vetted cyclone hole, before the season opens</strong> — not scrambling once it does. The common convention here is to get out of the tropics — <em>south</em>, toward NZ and higher latitudes — by a set go-by date, or commit to a hole. Set your own date from the official dates for your region and your insurer's box — don't trust a remembered number.`,
            },
            {
                num: '6',
                heading: 'WHAT A CYCLONE HOLE NEEDS',
                bodyHtml: `Not just any anchorage. A real hole has <strong>all-round protection, genuinely good holding, and room to lay out scope</strong> and swing. Surrounding mangroves or hills beat an open bay every time. Scout and commit to it <em>before</em> you need it — a hole you've never set in is a guess.`,
            },
            {
                num: '7',
                heading: 'TIE IT TO GO / NO-GO',
                bodyHtml: `Tactical and strategic meet here. <strong>If a named tropical system sits anywhere in your forecast track window, you don't go.</strong> Not "probably fine," not "it'll curve away." Watch the official warning centre for your waters and let it veto the departure — that's what the Go / No-Go card is for.`,
            },
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
        sources:
            'Trust official tropical-cyclone warning centres (in the Australian region BOM; for the South Pacific RSMC Nadi / Fiji Met; the US JTWC issues military advisories), live radar/satellite, and your own eyes — not a single GRIB.',
    },
];
