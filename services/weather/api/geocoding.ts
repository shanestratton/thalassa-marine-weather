import { CapacitorHttp } from '@capacitor/core';
import { MAJOR_BUOYS, STATE_ABBREVIATIONS } from '../config';
import { getMapboxKey } from '../keys';
import { abbreviate } from '../transformers';
import { piCache } from '../../PiCacheService';

import { createLogger } from '../../../utils/createLogger';

const log = createLogger('geocoding');
// geminiService dynamically imported to avoid bundling @google/generative-ai in main chunk

export interface GeoContext {
    name: string;
    lat: number;
    lon: number;
}

export const reverseGeocodeContext = async (lat: number, lon: number): Promise<GeoContext | null> => {
    // ── Pi Cache shortcut: 7-day TTL, location names don't change ──
    if (piCache.isAvailable()) {
        try {
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=place,locality,neighborhood,poi&access_token=${getMapboxKey() || 'NONE'}`;
            const piUrl = piCache.passthroughUrl(url, 7 * 24 * 60 * 60 * 1000, 'mapbox-geocode');
            if (piUrl) {
                const res = await CapacitorHttp.get({ url: piUrl, connectTimeout: 5000, readTimeout: 10000 });
                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data?.features?.length) {
                    // Preferred-type sort. `district` was here in an
                    // earlier pass and was the source of the second
                    // generalisation leak ("le Grand Sud" — Mapbox tags
                    // the southern administrative district of New
                    // Caledonia as place_type=district, which outranked
                    // the actual port `place` features in the same
                    // response). For a marine app, districts are never
                    // port names — drop it.
                    //
                    // poi outranks place so marine landmarks (marina,
                    // harbour, named anchorage) win over generic city
                    // matches when both exist.
                    const preferredTypes = ['neighborhood', 'locality', 'poi', 'place'];
                    const place =
                        data.features.sort(
                            (
                                a: Record<string, unknown> & { place_type?: string[] },
                                b: Record<string, unknown> & { place_type?: string[] },
                            ) => {
                                const ai = preferredTypes.indexOf(a.place_type?.[0] ?? '');
                                const bi = preferredTypes.indexOf(b.place_type?.[0] ?? '');
                                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                            },
                        )[0] || data.features[0];
                    const context = place.context || [];
                    const countryCtx = context.find((c: { id: string }) => c.id.startsWith('country'));
                    const regionCtx = context.find((c: { id: string; text?: string }) => c.id.startsWith('region'));
                    const city = place.text;
                    const isGenericWater =
                        /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(
                            city,
                        );
                    // Generalisation guard — bail through to the direct
                    // Mapbox path (which has its own retry + fallbacks)
                    // rather than caching a state-level name.
                    const matchedType: string = place.place_type?.[0] ?? '';
                    const isTooGeneric =
                        !preferredTypes.includes(matchedType) ||
                        (regionCtx?.text &&
                            typeof regionCtx.text === 'string' &&
                            regionCtx.text.toLowerCase() === city?.toLowerCase());
                    if (!isGenericWater && !isTooGeneric) {
                        const countryShort = countryCtx ? (countryCtx.short_code || countryCtx.text).toUpperCase() : '';
                        let state = '';
                        if (regionCtx) {
                            const regCode = regionCtx.short_code
                                ? regionCtx.short_code.replace(/^[A-Z]{2}-/i, '').toUpperCase()
                                : '';
                            if (regCode && regCode.length <= 3) state = regCode;
                            else if (STATE_ABBREVIATIONS[regionCtx.text]) state = STATE_ABBREVIATIONS[regionCtx.text];
                            else if (regionCtx.text && regionCtx.text.length < 20) state = regionCtx.text;
                        }
                        const name = [city, state, countryShort].filter((p) => p).join(', ');
                        return { name, lat: place.center[1], lon: place.center[0] };
                    }
                }
            }
        } catch {
            // Pi failed — fall through to direct
        }
    }

    try {
        // Try Mapbox First (High Precision)
        const mapboxKey = getMapboxKey();
        if (mapboxKey) {
            // Enhanced types: place (Cities), locality (Suburbs), poi (Points of Interest for marine features)
            // Note: Mapbox doesn't support 'natural_feature' as a type in the Places API.
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=place,locality,neighborhood,poi&access_token=${mapboxKey}`;
            const res = await CapacitorHttp.get({
                url,
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'ThalassaMarine/1.0',
                },
            });

            if (!res || !res.data) {
                return null;
            }

            let data = res.data;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    return null;
                }
            }

            if (data && data.features && data.features.length > 0) {
                // Preferred-type sort. `district` was here in an earlier
                // pass and was the source of the second generalisation
                // leak — Mapbox tags the southern administrative district
                // of New Caledonia as place_type=district ("le Grand
                // Sud"), and it outranked the actual port `place` features
                // in the same response. For a marine app, districts are
                // never port names — drop it.
                //
                // poi outranks place so marine landmarks (marina, harbour,
                // named anchorage) win over generic city matches when both
                // exist.
                const preferredTypes = ['neighborhood', 'locality', 'poi', 'place'];
                const place =
                    data.features.sort(
                        (
                            a: Record<string, unknown> & { place_type?: string[] },
                            b: Record<string, unknown> & { place_type?: string[] },
                        ) => {
                            const ai = preferredTypes.indexOf(a.place_type?.[0] ?? '');
                            const bi = preferredTypes.indexOf(b.place_type?.[0] ?? '');
                            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                        },
                    )[0] || data.features[0];
                // Mapbox Context: find country and region
                const context = place.context || [];
                const countryCtx = context.find((c: { id: string; text?: string; short_code?: string }) =>
                    c.id.startsWith('country'),
                );
                const regionCtx = context.find((c: { id: string; text?: string; short_code?: string }) =>
                    c.id.startsWith('region'),
                );

                const city = place.text;

                // GENERALISATION GUARD: reject if the matched feature is
                // really just a region/state masquerading as a place. The
                // symptom this fixes: Newport, QLD getting saved as
                // "Queensland → South Province" because Mapbox at offshore
                // coords sometimes returns a feature whose `text` matches
                // the parent region context word-for-word, with the
                // place_type stripped or labelled as something benign.
                //
                // We treat any of these as "not specific enough":
                //   - the matched place type is `region`, `country`, or
                //     anything else outside our preferred list
                //   - the matched feature's text equals the region
                //     context's text (i.e. "Queensland" feature with
                //     "Queensland" region context)
                const matchedType: string = place.place_type?.[0] ?? '';
                const isTooGeneric =
                    !preferredTypes.includes(matchedType) ||
                    (regionCtx?.text &&
                        typeof regionCtx.text === 'string' &&
                        regionCtx.text.toLowerCase() === city?.toLowerCase());

                if (isTooGeneric) {
                    // Don't return a state-level name — let the caller
                    // fall back to the Nominatim path or coordinates.
                    log.warn(
                        `Mapbox match too generic: place_type="${matchedType}", text="${city}", region="${regionCtx?.text}" — bailing out`,
                    );
                    return null;
                }

                // FILTER: Ignore GENERIC "Ocean" or "Sea" results (e.g. "Pacific Ocean")
                // BUT Allow specific places like "Ocean City", "Seaside", "Ocean Grove"
                // Strict check: if it looks like a generic water body name
                const isGenericWater =
                    /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(
                        city,
                    );

                if (isGenericWater) {
                    return null;
                }

                const countryShort = countryCtx ? (countryCtx.short_code || countryCtx.text).toUpperCase() : '';

                let state = '';
                if (regionCtx) {
                    const regCode = regionCtx.short_code
                        ? regionCtx.short_code.replace(/^[A-Z]{2}-/i, '').toUpperCase()
                        : '';
                    const regText = regionCtx.text;
                    if (regCode && regCode.length <= 3) state = regCode;
                    else if (STATE_ABBREVIATIONS[regText]) state = STATE_ABBREVIATIONS[regText];
                    else if (regText && regText.length < 20) state = regText;
                }

                const featureLat = place.center[1];
                const featureLon = place.center[0];

                const name = [city, state, countryShort].filter((p) => p).join(', ');

                return { name, lat: featureLat, lon: featureLon };
            }
        }

        // Fallback to Nominatim if Mapbox failed or returned no features
        const res = await CapacitorHttp.get({
            url: `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
            headers: { 'User-Agent': 'ThalassaMarine/1.0' },
        });

        if (!res || !res.data) {
            return null;
        }

        let data = res.data;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return null;
            }
        }

        if (!data || !data.address) {
            return null;
        }

        const addr = data.address;
        // `county` removed from the chain 2026-05-05 — Nominatim returns
        // county/region-level names for offshore points and the result
        // (e.g. "le Grand Sud" for waters off New Caledonia, "Queensland"
        // for offshore Australia) is never a port name. If we don't have
        // anything more specific (suburb / town / village / city /
        // municipality / city_district / hamlet / island), fall through
        // to the generalisation guard below and return null.
        const locality =
            addr.suburb ||
            addr.town ||
            addr.city_district ||
            addr.village ||
            addr.city ||
            addr.hamlet ||
            addr.island ||
            addr.municipality;
        const stateFull = addr.state || addr.province || addr.region || '';
        const state = abbreviate(stateFull) || stateFull;
        const country = addr.country_code ? addr.country_code.toUpperCase() : '';

        // GENERALISATION GUARD (Nominatim path).
        //
        // If we have NO locality (no suburb/town/village/island/etc.),
        // do NOT fall through to display_name's first segment — that
        // segment is often the state itself ("Queensland", "New South
        // Wales") for offshore points or coarse address records, which
        // is exactly the bug the user reported ("Queensland → South
        // Province" instead of "Newport → Port Moselle").
        //
        // Returning null here lets the caller treat the location as
        // un-named and either keep the user's typed value or fall
        // back to coordinates — both better than overwriting with a
        // state name.
        if (!locality) {
            log.warn(
                `Nominatim returned no locality (suburb/town/village/etc) at ${lat},${lon} — refusing to use display_name's "${data.display_name?.split(',')[0]}" which is likely a state. Returning null so caller falls back.`,
            );
            return null;
        }

        // Reject if the locality somehow IS the state (some Nominatim
        // records have addr.county === addr.state for sparsely-populated
        // areas). Same end result: don't return a generalised name.
        if (locality.toLowerCase() === stateFull.toLowerCase()) {
            log.warn(`Nominatim locality "${locality}" matches state "${stateFull}" — refusing as too generic`);
            return null;
        }

        const finalName = locality;
        const name = [finalName, state, country].filter((p) => p && p.trim().length > 0).join(', ');

        const isGenericWater =
            /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(name);

        if (isGenericWater) {
            return null;
        }

        const resLat = parseFloat(data.lat);
        const resLon = parseFloat(data.lon);

        return { name, lat: resLat, lon: resLon };
    } catch (err) {
        return null;
    }
};

export const reverseGeocode = async (lat: number, lon: number): Promise<string | null> => {
    const ctx = await reverseGeocodeContext(lat, lon);
    return ctx ? ctx.name : null;
};

/**
 * Marine query interceptor — expands ambiguous abbreviations into
 * unambiguous geographic strings before they hit the geocoder.
 *
 * Geocoding APIs are notoriously US-centric: free-text geocoding fails
 * on marine edge cases because "NC" rigidly maps to North Carolina,
 * "WA" to Washington, etc. For a marine routing app, the maritime
 * interpretation is what the user almost always means.
 *
 * Word-boundary regex (`\bnc\b`) catches the abbreviation anywhere in
 * the string, not just at the trailing position — handles "NC, Port
 * Moselle" or "Port Moselle NC" or just "NC" alone equally well. The
 * /i flag handles case variations (NC, nc, Nc).
 *
 * Note on US-state collisions: these expansions are unconditional, so
 * a US east coast user typing "Newport, NC" would get "Newport, New
 * Caledonia" instead of Newport NC USA. For a marine routing app
 * that's the right default — if a US user really wants Newport NC,
 * they can spell it as "Newport, North Carolina" or "Newport NC USA"
 * to bypass the expansion. Marine context wins by default.
 */
interface GeoCorrection {
    pattern: RegExp;
    replacement: string;
}

const MARINE_GEO_CORRECTIONS: GeoCorrection[] = [
    // Australian states — force the API out of US/UK defaults
    { pattern: /\b(qld|queensland)\b/i, replacement: 'Queensland, Australia' },
    { pattern: /\b(nsw)\b/i, replacement: 'New South Wales, Australia' },
    { pattern: /\b(vic)\b/i, replacement: 'Victoria, Australia' },
    { pattern: /\b(tas)\b/i, replacement: 'Tasmania, Australia' },
    { pattern: /\b(wa)\b/i, replacement: 'Western Australia' },
    { pattern: /\b(nt)\b/i, replacement: 'Northern Territory, Australia' },
    { pattern: /\b(sa)\b/i, replacement: 'South Australia' },
    // Pacific Islands often confused with US states / European regions
    { pattern: /\b(nc)\b/i, replacement: 'New Caledonia' },
    { pattern: /\b(fp)\b/i, replacement: 'French Polynesia' },
    { pattern: /\b(fj)\b/i, replacement: 'Fiji' },
    { pattern: /\b(nz)\b/i, replacement: 'New Zealand' },
];

/**
 * Sanitise a user-typed location string by expanding known marine
 * abbreviations into unambiguous geographic strings.
 *
 * Examples:
 *   "Port Moselle, NC"  → "Port Moselle, New Caledonia"
 *   "Newport, QLD"      → "Newport, Queensland, Australia"
 *   "Manly, WA"         → "Manly, Western Australia"
 *   "Lautoka, FJ"       → "Lautoka, Fiji"
 */
export const sanitizeLocationQuery = (userInput: string): string => {
    let safeQuery = userInput.trim();
    MARINE_GEO_CORRECTIONS.forEach(({ pattern, replacement }) => {
        safeQuery = safeQuery.replace(pattern, replacement);
    });
    return safeQuery;
};

/**
 * Detect the ISO 3166-1 alpha-2 country code from a sanitised query.
 * Used to add a `country=` filter to the Mapbox geocode call so results
 * are restricted to the right country — without this, Mapbox can return
 * the centroid of "New Caledonia" the country instead of the actual
 * Port Moselle marina inside it.
 */
function detectCountryISO(query: string): string | undefined {
    if (/\bAustralia\b/i.test(query)) return 'au';
    if (/\bNew Caledonia\b/i.test(query)) return 'nc';
    if (/\bFrench Polynesia\b/i.test(query)) return 'pf';
    if (/\bFiji\b/i.test(query)) return 'fj';
    if (/\bNew Zealand\b/i.test(query)) return 'nz';
    return undefined;
}

/**
 * Curated list of well-known marinas/ports — first-pass exact-match
 * shortcut before hitting Mapbox. Solves the "Mapbox returns the
 * country centroid because it doesn't have the marina indexed as a
 * POI" problem. Same pattern as MAJOR_BUOYS.
 *
 * Match is case-insensitive and uses substring fuzz so "port moselle"
 * matches "Port Moselle Marina, Nouméa". Add aliases for common short
 * forms ("port moselle nc"). Lat/lon are the real navigable
 * approach/anchorage point — never inland.
 */
interface MarinePort {
    canonicalName: string;
    lat: number;
    lon: number;
    /** Lowercase aliases — first one is the typical canonical user input */
    aliases: string[];
}

const MARINE_PORTS: MarinePort[] = [
    // ── Pacific ──
    {
        canonicalName: 'Port Moselle Marina, Nouméa, NC',
        lat: -22.2756,
        lon: 166.4421,
        aliases: [
            'port moselle',
            'port moselle marina',
            'port moselle nouméa',
            'port moselle noumea',
            'port moselle, new caledonia',
        ],
    },
    {
        canonicalName: 'Vuda Marina, Lautoka, FJ',
        lat: -17.6839,
        lon: 177.3833,
        aliases: ['vuda marina', 'vuda point marina'],
    },
    {
        canonicalName: 'Port Vila, Vanuatu',
        lat: -17.7415,
        lon: 168.3151,
        aliases: ['port vila', 'port vila vanuatu'],
    },
    // ── Australia (East coast cruising hotspots) ──
    {
        canonicalName: 'Newport Marina, QLD',
        lat: -27.21,
        lon: 153.09,
        aliases: ['newport marina', 'newport qld marina'],
    },
    {
        canonicalName: 'Manly Boat Harbour, QLD',
        lat: -27.452,
        lon: 153.193,
        aliases: ['manly boat harbour', 'manly harbour qld'],
    },
    {
        canonicalName: 'Scarborough Marina, QLD',
        lat: -27.19,
        lon: 153.106,
        aliases: ['scarborough marina', 'scarborough marina qld'],
    },
];

/**
 * Look up a curated marine port by name. Returns the port record if
 * the user's query (sanitised) matches one of the aliases, otherwise
 * undefined. Handles "Port Moselle, NC" → finds "port moselle"
 * substring after sanitization → returns Nouméa marina coords.
 */
function findCuratedPort(query: string): MarinePort | undefined {
    const lc = query.toLowerCase().trim();
    return MARINE_PORTS.find((p) => p.aliases.some((a) => lc.includes(a)));
}

export const parseLocation = async (
    location: string,
    /**
     * Optional GPS proximity hint — biases the Mapbox geocoder toward
     * results near this point. Critical for ambiguous place names like
     * "Newport, NC" which could match Newport NC USA or Port Moselle
     * NC New Caledonia depending on where the user is.
     *
     * Without this, Mapbox just returns its global "best match" which
     * is usually the most-populous interpretation — typically wrong
     * for offshore cruisers planning passages out of obscure ports.
     */
    proximity?: { lat: number; lon: number },
): Promise<{ lat: number; lon: number; name: string; timezone?: string }> => {
    if (!location || typeof location !== 'string') return { lat: 0, lon: 0, name: 'Invalid Location' };

    const searchStr = location.toLowerCase().trim();

    // 1. EXACT MATCH on Buoy ID or Name (Priority)
    const exactBuoy = MAJOR_BUOYS.find((b) => b.name.toLowerCase() === searchStr || b.id.toLowerCase() === searchStr);
    if (exactBuoy) {
        return { lat: exactBuoy.lat, lon: exactBuoy.lon, name: exactBuoy.name };
    }

    // 2. FUZZY MATCH on Buoy Name
    const fuzzyBuoy = MAJOR_BUOYS.find((b) => b.name.toLowerCase().includes(searchStr) && searchStr.length > 4);
    if (fuzzyBuoy) {
        return { lat: fuzzyBuoy.lat, lon: fuzzyBuoy.lon, name: fuzzyBuoy.name };
    }

    let lat = 0;
    let lon = 0;
    let name = location;

    // Reject "Current" or "Current Location" as search terms (Prevents "Current Island, ME" bug)
    if (searchStr === 'current' || searchStr === 'current location') {
        throw new Error("Location string 'Current' is invalid. Please provide coordinates or city name.");
    }

    // 3. Check for Coordinate String
    const coordMatch = location.match(/([+-]?\d+(\.\d+)?)[,\s]+([+-]?\d+(\.\d+)?)/);

    if (coordMatch) {
        lat = parseFloat(coordMatch[1]);
        lon = parseFloat(coordMatch[3]);

        // OPTIMIZATION: Don't block on Reverse Geocode. Return coords immediately.
        // The WeatherContext will eventually correct the name if needed.
        // STOPPED: Formatting as "WP ..." prematurely.
        // REASON: We want WeatherContext to see it as "raw" so it triggers the Reverse Lookup.
        if (location.length < 10 && location.includes(',')) {
            // It's likely raw user input like "-25, 153"
            // Keep it as is (or simple clean) so regex /^-?\d/ matches in Context
            name = location.trim();
        } else {
            name = location;
        }
    } else {
        // ── Forward geocode via Mapbox (commercial, licensed) ──
        // Architecture (2026-05-05, refined per colleague's review):
        //
        //   1. Pre-process the user's typed string with
        //      sanitizeLocationQuery to expand marine abbreviations
        //      ("NC" → "New Caledonia", "QLD" → "Queensland, Australia").
        //   2. First-pass: check the curated MARINE_PORTS list — well-
        //      known marinas (Port Moselle Marina, Vuda Marina, etc.)
        //      have hardcoded coords because Mapbox returns the country
        //      centroid for "Port Moselle, New Caledonia" instead of
        //      the actual marina at Nouméa.
        //   3. Mapbox forward geocode with three filters stacked:
        //        - country=<iso> (restrict to detected country)
        //        - types=poi,place,locality,neighborhood (prefer POIs
        //          like marinas over admin regions like whole islands)
        //        - proximity=<userGps> (soft bias toward user)
        const cleanedQuery = sanitizeLocationQuery(location);
        if (cleanedQuery !== location) {
            log.info(`[geocoding] sanitised "${location}" → "${cleanedQuery}"`);
        }

        // ── First-pass: curated marine ports lookup ──
        const curated = findCuratedPort(cleanedQuery);
        if (curated) {
            log.info(`[geocoding] curated marine port: "${curated.canonicalName}"`);
            return { lat: curated.lat, lon: curated.lon, name: curated.canonicalName };
        }

        // Detect ISO country from the cleaned query (drives `country=`
        // filter in the Mapbox URL — without it, Mapbox can return the
        // country centroid when no specific feature matches the query).
        const countryISO = detectCountryISO(cleanedQuery);
        if (countryISO) {
            log.info(`[geocoding] country filter: ${countryISO.toUpperCase()}`);
        }

        const fetchMapboxGeo = async (query: string) => {
            try {
                const mapboxKey = getMapboxKey();
                if (!mapboxKey) return [];
                // Proximity bias: GPS coords as `proximity=lon,lat` —
                // a soft hint to Mapbox to favour the user's hemisphere
                // when results are otherwise ambiguous.
                const proxParam = proximity ? `&proximity=${proximity.lon},${proximity.lat}` : '';
                // Country filter: restricts results to the detected
                // country's borders. Without this, Mapbox can return
                // the centroid of "New Caledonia" for Port Moselle
                // queries.
                const countryParam = countryISO ? `&country=${countryISO}` : '';
                // Type filter: prefer POIs (marinas, harbours,
                // anchorages) over admin regions (countries, districts,
                // whole islands). For marine routing, POI > place
                // > locality > neighborhood.
                const typesParam = '&types=poi,place,locality,neighborhood';
                const res = await CapacitorHttp.get({
                    url: `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&language=en&access_token=${mapboxKey}${proxParam}${countryParam}${typesParam}`,
                });
                if (!res || !res.data) return [];
                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data?.features?.length) {
                    const f = data.features[0];
                    const ctx = f.context || [];
                    const regionCtx = ctx.find((c: { id: string }) => c.id.startsWith('region'));
                    const countryCtx = ctx.find((c: { id: string }) => c.id.startsWith('country'));
                    return [
                        {
                            latitude: f.center[1],
                            longitude: f.center[0],
                            name: f.text || f.place_name?.split(',')[0],
                            admin1: regionCtx?.text || '',
                            country_code: countryCtx ? (countryCtx.short_code || '').toUpperCase() : '',
                            timezone: undefined as string | undefined,
                        },
                    ];
                }
                return [];
            } catch (e) {
                log.warn('[geocoding] Mapbox forward geocode failed', e);
                return [];
            }
        };

        let results = await fetchMapboxGeo(cleanedQuery);

        // FALLBACK: Nominatim (OSS, commercial use permitted with attribution).
        // Also receives the sanitised query — Nominatim has the same
        // US-centric defaults Mapbox does, so the marine-abbreviation
        // pre-processor benefits both.
        if (!results || results.length === 0) {
            try {
                const res = await CapacitorHttp.get({
                    url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanedQuery)}&format=json&limit=1`,
                    headers: { 'User-Agent': 'ThalassaMarine/1.0' },
                });

                if (!res.data) {
                    throw new Error('Geocoding failed: No data from Nominatim');
                }

                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data && data.length > 0) {
                    const r = data[0];
                    // Map Nominatim result to OpenMeteo-like structure to reuse logic below
                    results = [
                        {
                            latitude: parseFloat(r.lat),
                            longitude: parseFloat(r.lon),
                            name: r.name || r.display_name.split(',')[0],
                            admin1: '', // Nominatim breakdown is complex, leaving blank is safe
                            country_code: '', // Can extract from display_name but optional
                            timezone: 'UTC', // We don't get TZ from Nominatim easily, but we can live without it or fetch it later
                        },
                    ];
                }
            } catch (e) {
                // Silently ignored — non-critical failure
            }
        }

        // AUTOCORRECT LOGIC
        if (!results || results.length === 0) {
            const { suggestLocationCorrection } = await import('../../geminiService');
            const corrected = await suggestLocationCorrection(location);
            if (corrected) {
                results = await fetchMapboxGeo(corrected);
                if (results && results.length > 0) {
                    name = corrected;
                }
            }
        }

        if (!results || results.length === 0) throw new Error(`Location "${location}" not found.`);

        const r = results[0];
        lat = r.latitude;
        lon = r.longitude;

        // Formulate Name: "City, Admin1, Country"
        const parts = [r.name, r.admin1, r.country_code?.toUpperCase()].filter((x) => x);
        name = parts.join(', ');

        return { lat, lon, name, timezone: r.timezone };
    }

    return { lat, lon, name };
};
