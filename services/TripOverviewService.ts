/**
 * TripOverviewService — assemble a "whole trip" view from a chain of legs.
 *
 * The route planner saves each leg as its own draft voyage + planned
 * route in the logbook. The leg picker chains them together by
 * destination → next-leg-departure matching. This service takes that
 * chain and produces a single TripOverview record with:
 *
 *   - trip-level stats (total NM, total duration, date range)
 *   - per-leg breakdown
 *   - countries visited (derived from arrival port names)
 *   - high-level "skipper notes" for the trip type (long ocean
 *     crossing vs island hopping, tropical vs temperate, etc.)
 *
 * The TripOverviewSheet UI + TripPdfService both consume this shape
 * so the on-screen overview and the exported PDF share one source
 * of truth.
 */

import type { Voyage } from './VoyageService';

/** Per-leg breakdown for the overview. */
export interface TripOverviewLeg {
    legNumber: number;
    departurePort: string;
    arrivalPort: string;
    distanceNm: number;
    durationHours: number;
    departureDateIso?: string | null;
    arrivalDateIso?: string | null;
    /** Country detected from arrival port (e.g. "New Caledonia", "Fiji"). */
    arrivalCountry?: string;
    /** Approximate description shown on each leg card. */
    summary?: string;
}

export interface TripOverview {
    /** Display name — "Brisbane → Tahiti" form. */
    name: string;
    legs: TripOverviewLeg[];
    totalDistanceNm: number;
    totalDurationHours: number;
    /** ISO timestamps spanning the entire trip. */
    earliestDepartureIso?: string | null;
    latestArrivalIso?: string | null;
    /** Distinct countries visited along the route. */
    countries: string[];
    /** Crew count at trip planning time (from the active or first voyage). */
    crewCount?: number;
}

// ── Country detection ────────────────────────────────────────────────
//
// Maps a port-name fragment → country. Pure substring match. Covers
// the common Pacific cruising stops and Australia east coast; extend
// as needed. The matcher is forgiving — "Nouméa, NC" and "Port Moselle
// Marina, New Caledonia" both resolve to "New Caledonia".

const COUNTRY_HINTS: { match: string[]; country: string }[] = [
    { match: ['au', 'australia', 'qld', 'nsw', 'tas', 'vic', 'sa', 'wa', 'brisbane', 'sydney'], country: 'Australia' },
    { match: ['nz', 'new zealand', 'auckland', 'opua', 'whangarei'], country: 'New Zealand' },
    {
        match: ['nc', 'new caledonia', 'nouvelle calédonie', 'noumea', 'nouméa', 'île des pins', 'isle of pines'],
        country: 'New Caledonia',
    },
    {
        match: ['vanuatu', 'port vila', 'luganville', 'tanna', 'efate', 'aneityum', 'erromango'],
        country: 'Vanuatu',
    },
    { match: ['fj', 'fiji', 'lautoka', 'suva', 'musket cove', 'savusavu', 'mamanuca', 'yasawa'], country: 'Fiji' },
    { match: ['tonga', 'vavaʻu', 'vavau', 'neiafu', 'nukuʻalofa', 'nukualofa'], country: 'Tonga' },
    { match: ['cook islands', 'rarotonga', 'aitutaki', 'palmerston'], country: 'Cook Islands' },
    {
        match: [
            'french polynesia',
            'tahiti',
            'papeete',
            'bora bora',
            'moorea',
            'huahine',
            'raiatea',
            'taha’a',
            'taha‘a',
            'rangiroa',
            'marquesas',
        ],
        country: 'French Polynesia',
    },
    { match: ['niue'], country: 'Niue' },
    { match: ['samoa', 'apia', 'pago pago'], country: 'Samoa' },
    { match: ['kiribati', 'tarawa'], country: 'Kiribati' },
    { match: ['tuvalu', 'funafuti'], country: 'Tuvalu' },
    { match: ['solomon islands', 'honiara'], country: 'Solomon Islands' },
    { match: ['png', 'papua new guinea', 'port moresby'], country: 'Papua New Guinea' },
    { match: ['indonesia', 'bali', 'jakarta', 'kupang'], country: 'Indonesia' },
    { match: ['hawaii', 'honolulu', 'hilo'], country: 'Hawaii' },
];

/** Best-effort country match from a port string. Returns the country
 *  name when a hint matches (case-insensitive substring), otherwise
 *  undefined — the caller decides what to do with unknowns. */
export function detectCountry(portName: string | null | undefined): string | undefined {
    if (!portName) return undefined;
    const lc = portName.toLowerCase();
    for (const hint of COUNTRY_HINTS) {
        if (hint.match.some((m) => lc.includes(m))) return hint.country;
    }
    return undefined;
}

/** Greatcircle distance in NM between two coords. */
function haversineNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 3440.065;
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const dφ = ((b.lat - a.lat) * Math.PI) / 180;
    const dλ = ((b.lon - a.lon) * Math.PI) / 180;
    const aa = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

/** Voyage row enriched by CrewManagement with departure/arrival coords. */
type EnrichedVoyage = Voyage & {
    departureCoords?: { lat: number; lon: number };
    arrivalCoords?: { lat: number; lon: number };
    durationHours?: number;
};

/** Infer per-leg distance — uses attached coords when available, else 0.
 *  Caller can substitute a real route polyline distance if it has one. */
function inferLegDistanceNm(v: EnrichedVoyage): number {
    if (v.departureCoords && v.arrivalCoords) {
        return haversineNm(v.departureCoords, v.arrivalCoords);
    }
    return 0;
}

/** Infer per-leg duration — prefers explicit durationHours from the
 *  saved route, else (departure_time, eta) gap, else distance / 6 kt
 *  as the floor. */
function inferLegDurationHours(v: EnrichedVoyage, fallbackDistanceNm: number): number {
    if (typeof v.durationHours === 'number' && v.durationHours > 0) return v.durationHours;
    if (v.departure_time && v.eta) {
        const dep = Date.parse(v.departure_time);
        const arr = Date.parse(v.eta);
        if (Number.isFinite(dep) && Number.isFinite(arr) && arr > dep) {
            return (arr - dep) / 3_600_000;
        }
    }
    if (fallbackDistanceNm > 0) return fallbackDistanceNm / 6;
    return 0;
}

/**
 * Build a TripOverview from an ordered chain of voyage rows. The
 * chain is what LegPickerDropdown produces via its destination →
 * next-leg-departure linkage; passing it through preserves leg order.
 */
export function buildTripOverview(
    legs: EnrichedVoyage[],
    opts?: { tripName?: string; crewCount?: number },
): TripOverview {
    const overviewLegs: TripOverviewLeg[] = legs.map((v, i) => {
        const distNm = inferLegDistanceNm(v);
        const dur = inferLegDurationHours(v, distNm);
        const arrCountry = detectCountry(v.destination_port);
        const summary =
            v.destination_port && v.departure_port
                ? `${v.departure_port} → ${v.destination_port}`
                : v.voyage_name || `Leg ${i + 1}`;
        return {
            legNumber: i + 1,
            departurePort: v.departure_port ?? '?',
            arrivalPort: v.destination_port ?? '?',
            distanceNm: Math.round(distNm * 10) / 10,
            durationHours: Math.round(dur * 10) / 10,
            departureDateIso: v.departure_time,
            arrivalDateIso: v.eta,
            arrivalCountry: arrCountry,
            summary,
        };
    });

    const totalDistanceNm = overviewLegs.reduce((acc, l) => acc + l.distanceNm, 0);
    const totalDurationHours = overviewLegs.reduce((acc, l) => acc + l.durationHours, 0);

    const earliestDepartureIso = legs.find((v) => v.departure_time)?.departure_time || null;
    const latestArrivalIso = [...legs].reverse().find((v) => v.eta)?.eta || null;

    const tripName =
        opts?.tripName ||
        (legs.length > 0
            ? `${legs[0].departure_port ?? '?'} → ${legs[legs.length - 1].destination_port ?? '?'}`
            : 'Trip');

    // Distinct countries visited along the route (in encounter order).
    const countriesSet = new Set<string>();
    const countries: string[] = [];
    for (const v of legs) {
        const dep = detectCountry(v.departure_port);
        const arr = detectCountry(v.destination_port);
        if (dep && !countriesSet.has(dep)) {
            countriesSet.add(dep);
            countries.push(dep);
        }
        if (arr && !countriesSet.has(arr)) {
            countriesSet.add(arr);
            countries.push(arr);
        }
    }

    return {
        name: tripName,
        legs: overviewLegs,
        totalDistanceNm: Math.round(totalDistanceNm * 10) / 10,
        totalDurationHours: Math.round(totalDurationHours * 10) / 10,
        earliestDepartureIso,
        latestArrivalIso,
        countries,
        crewCount: opts?.crewCount,
    };
}

// ── Country snippets ─────────────────────────────────────────────────
//
// Tight, opinionated entries for the most common Pacific/AU
// destinations. Used by the on-screen sheet AND by the PDF generator
// so both surfaces stay in lockstep. Each snippet covers what a
// skipper actually needs at provisioning + arrival time, not a
// travel-guide synopsis.

export interface CountrySnippet {
    country: string;
    visa: string;
    biosecurity: string;
    portsOfEntry: string;
    notes?: string;
}

const COUNTRY_SNIPPETS: Record<string, CountrySnippet> = {
    Australia: {
        country: 'Australia',
        visa: 'NZ citizens visa-free (Special Category Visa on arrival). Other nationalities check DIBP — eVisitor / ETA usually required pre-departure.',
        biosecurity:
            'Strict — no fresh produce, meat, dairy, seeds, or open packets. Declare everything; AQIS will board on arrival.',
        portsOfEntry: 'Cairns · Mackay · Brisbane (Rivergate) · Sydney · Hobart · Fremantle.',
        notes: 'Submit ABF Form 1300 at least 96 hours before arrival. Quarantine fee applies.',
    },
    'New Zealand': {
        country: 'New Zealand',
        visa: 'Australian citizens visa-free. Others typically need NZeTA + IVL pre-departure.',
        biosecurity:
            'World-strictest — MPI inspection on arrival. No fresh produce, honey, wood, untreated dairy. Vacuum-clean storage lockers before arrival.',
        portsOfEntry: 'Opua · Whangarei · Tauranga · Auckland · Picton · Lyttelton.',
        notes: 'Advance Notice of Arrival via SailGuide 48 hours pre-arrival. NZ Customs + MPI both inspect.',
    },
    'New Caledonia': {
        country: 'New Caledonia',
        visa: 'AU/NZ visa-free 90 days in 180 (Schengen rules — French territory).',
        biosecurity:
            'Strict — no fresh fruit, vegetables, fresh meat (especially chicken/pork), eggs, honey, or open seeds/nuts. Plan to arrive with the fridge empty. Declare everything.',
        portsOfEntry: 'Nouméa (Port Moselle).',
        notes: 'Call Port Moselle on VHF 67 on approach. Customs (Douane) + Police aux Frontières clear vessel and crew at the marina.',
    },
    Vanuatu: {
        country: 'Vanuatu',
        visa: 'AU/NZ visa-free, 30 days on arrival (extendable to 120 days at Immigration in Port Vila or Luganville).',
        biosecurity: 'Moderate — declare all produce. No restrictions on most pantry staples.',
        portsOfEntry: 'Port Vila (Efate) · Luganville (Espiritu Santo) · Lenakel (Tanna) · Sola (Vanua Lava).',
        notes: 'Yacht-friendly. Cruising permit issued at first port; valid for entire stay.',
    },
    Fiji: {
        country: 'Fiji',
        visa: 'AU/NZ visa-free, 4 months on arrival, extendable.',
        biosecurity: 'Moderate. Declare all produce, meat, dairy. Some items confiscated; honest declaration is key.',
        portsOfEntry: 'Lautoka · Suva · Savusavu · Levuka.',
        notes: 'Submit Form C2-C (Advance Notification of Arrival) to Customs at least 48 hours before arrival. Required at every Port of Entry.',
    },
    Tonga: {
        country: 'Tonga',
        visa: 'AU/NZ visa-free, 31 days on arrival (extendable to 6 months).',
        biosecurity: 'Moderate. Declare produce, meat, dairy. No restrictions on canned/dry pantry items.',
        portsOfEntry: 'Neiafu (Vavaʻu) · Nukuʻalofa (Tongatapu) · Pangai (Haʻapai).',
        notes: 'Whale-watching peak Jul-Oct. Anchorage in the Vavaʻu group is unrestricted between Ports of Entry.',
    },
    'Cook Islands': {
        country: 'Cook Islands',
        visa: 'AU/NZ visa-free, 31 days on arrival (extendable).',
        biosecurity: 'Moderate. Declare all produce; meat/dairy restrictions apply.',
        portsOfEntry: 'Avatiu (Rarotonga) · Aitutaki · Palmerston (limited).',
        notes: 'Palmerston has no harbour — you anchor outside the reef and the host family meets you in a tinny. Aitutaki lagoon entry is shallow and tide-dependent.',
    },
    'French Polynesia': {
        country: 'French Polynesia',
        visa: 'AU/NZ visa-free 90 days in 180 (Schengen rules — French territory). Long-stay visa needed for >90 days.',
        biosecurity: 'Moderate. No fresh produce or meat allowed; vacuum-cleaning of storage lockers expected.',
        portsOfEntry: 'Papeete (Tahiti) · Hiva Oa (Marquesas) · Bora Bora · Raiatea.',
        notes: 'Bond required for non-EU vessels OR proof of repatriation insurance. Check current rules with your agent before arrival.',
    },
    Niue: {
        country: 'Niue',
        visa: 'AU/NZ visa-free, 30 days on arrival.',
        biosecurity: 'Moderate. Declare all produce.',
        portsOfEntry: 'Alofi (mooring buoys, no harbour).',
        notes: 'Anchoring is forbidden — pre-book a mooring with the Niue Yacht Club. Swell can be uncomfortable; be ready to leave on short notice.',
    },
    Samoa: {
        country: 'Samoa',
        visa: 'AU/NZ visa-free, 60 days on arrival.',
        biosecurity: 'Moderate. Declare all produce + meat.',
        portsOfEntry: 'Apia (Upolu) · Asau (Savaiʻi).',
        notes: 'Sunday is a quiet day — no clearance, shops closed.',
    },
};

export function getCountrySnippets(countries: string[]): CountrySnippet[] {
    return countries.map((c) => COUNTRY_SNIPPETS[c]).filter((s): s is CountrySnippet => Boolean(s));
}

// ── Live-data enrichment ─────────────────────────────────────────────
//
// Pulls the actual forecast for each leg's departure point on its
// planned date, plus a trip-level "best departure window" analysis.
// Results stitch onto the TripOverview as optional fields so the
// on-screen sheet AND the PDF render dynamic content when available,
// falling back to template-static content when network/data isn't.

export interface LegForecast {
    windSpeedKt: number;
    windGustKt?: number | null;
    windDirection: string;
    waveHeightM: number | null;
    condition: string;
    isoDate: string;
}

export interface TripDepartureWindow {
    iso: string;
    label: string;
    rating: 'go' | 'marginal' | 'wait';
    score: number;
    /** Mirrors WeatherWindowService.DepartureWindow.summary verbatim
     *  so callers can pass it straight through. */
    summary: {
        avgWindKts: number;
        maxWindKts: number;
        avgWaveM: number;
        maxWaveM: number;
        dominantWindDir: string;
        rainProbability: number;
    };
    description: string;
}

export interface EnrichedTripOverview extends TripOverview {
    /** ISO timestamp of the live-data fetch; PDF renders it so the
     *  reader knows how stale the data is. */
    enrichedAt?: string;
    legsWithForecast?: (TripOverviewLeg & { forecast?: LegForecast; realDistanceNm?: number })[];
    bestDepartureWindow?: TripDepartureWindow;
}

function normLabel(s: string): string {
    return (s ?? '').trim().toLowerCase();
}

/**
 * Enrich a TripOverview with live weather data. Returns a new object —
 * never mutates the input. All network failures caught silently;
 * corresponding fields stay absent and renderers fall back to template
 * content.
 *
 * Cost: 1 WeatherWindow call (16-day forecast for the first leg) +
 * 1 fetchFastWeather per leg. ~4-6s for a typical 3-leg trip.
 */
export async function enrichTripWithLiveData(trip: TripOverview): Promise<EnrichedTripOverview> {
    try {
        const [{ fetchRoutesAndTracks }, { fetchFastWeather }, { WeatherWindowService }] = await Promise.all([
            import('./shiplog/RoutesAndTracks'),
            import('./weather'),
            import('./WeatherWindowService'),
        ]);

        const ra = await fetchRoutesAndTracks();

        const legsWithForecast = await Promise.all(
            trip.legs.map(async (leg) => {
                const wantLabel = normLabel(`${leg.departurePort} → ${leg.arrivalPort}`);
                const matchedRoute = ra.routes.find((r) => normLabel(r.label) === wantLabel);
                const depPoint = matchedRoute?.points?.[0];
                const realDistanceNm = matchedRoute?.distanceNm;

                if (!depPoint) {
                    return { ...leg, realDistanceNm };
                }

                try {
                    const report = await fetchFastWeather(leg.departurePort, {
                        lat: depPoint.lat,
                        lon: depPoint.lon,
                    });
                    const planIso = leg.departureDateIso
                        ? new Date(leg.departureDateIso).toISOString().slice(0, 10)
                        : null;
                    const forecastDay =
                        (planIso ? report.forecast?.find((d) => d.isoDate === planIso) : null) || report.forecast?.[0];
                    if (!forecastDay) return { ...leg, realDistanceNm };

                    // ForecastDay's TS interface doesn't declare
                    // windDirection (cardinal string), but every
                    // upstream transformer sets it — see
                    // openmeteo.ts daily mapping. Read via index
                    // access to avoid pulling the type into noise.
                    const dayAny = forecastDay as unknown as Record<string, unknown>;
                    const windDir =
                        typeof dayAny.windDirection === 'string' && dayAny.windDirection ? dayAny.windDirection : '—';
                    const forecast: LegForecast = {
                        windSpeedKt: Math.round(forecastDay.windSpeed),
                        windGustKt: forecastDay.windGust ? Math.round(forecastDay.windGust) : null,
                        windDirection: windDir,
                        waveHeightM:
                            forecastDay.waveHeight !== null && forecastDay.waveHeight !== undefined
                                ? // ForecastDay.waveHeight is FEET (every
                                  // openmeteo transformer normalises to feet
                                  // at fetch time); convert to metres here
                                  // at the consumer edge so the PDF can
                                  // render real metres.
                                  Math.round((forecastDay.waveHeight / 3.28084) * 10) / 10
                                : null,
                        condition: forecastDay.condition || '—',
                        isoDate: forecastDay.isoDate || planIso || new Date().toISOString().slice(0, 10),
                    };
                    return { ...leg, forecast, realDistanceNm };
                } catch {
                    return { ...leg, realDistanceNm };
                }
            }),
        );

        let bestDepartureWindow: TripDepartureWindow | undefined;
        const firstLeg = trip.legs[0];
        if (firstLeg) {
            const firstRoute = ra.routes.find(
                (r) => normLabel(r.label) === normLabel(`${firstLeg.departurePort} → ${firstLeg.arrivalPort}`),
            );
            const firstDepPoint = firstRoute?.points?.[0];
            if (firstDepPoint) {
                try {
                    const result = await WeatherWindowService.analyse(firstDepPoint.lat, firstDepPoint.lon);
                    if (result?.bestWindowIndex >= 0 && result.windows[result.bestWindowIndex]) {
                        const w = result.windows[result.bestWindowIndex];
                        bestDepartureWindow = {
                            iso: w.time,
                            label: w.label,
                            rating: w.rating,
                            score: w.score,
                            summary: w.summary,
                            description: w.description,
                        };
                    }
                } catch {
                    /* fall through */
                }
            }
        }

        return {
            ...trip,
            enrichedAt: new Date().toISOString(),
            legsWithForecast,
            bestDepartureWindow,
        };
    } catch {
        return trip;
    }
}
