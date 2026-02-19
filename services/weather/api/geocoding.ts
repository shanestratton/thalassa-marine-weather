import { CapacitorHttp } from '@capacitor/core';
import { MAJOR_BUOYS, STATE_ABBREVIATIONS } from '../config';
import { getMapboxKey } from '../keys';
import { abbreviate } from '../transformers';
// geminiService dynamically imported to avoid bundling @google/generative-ai in main chunk

export interface GeoContext {
    name: string;
    lat: number;
    lon: number;
}

export const reverseGeocodeContext = async (lat: number, lon: number): Promise<GeoContext | null> => {

    try {
        // Try Mapbox First (High Precision)
        const mapboxKey = getMapboxKey();
        if (mapboxKey) {

            // Enhanced types: natural_feature (Bays/Headlands/Islands), place (Cities), locality (Suburbs)
            // natural_feature is critical for marine/coastal locations where there's no "place"
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=natural_feature,place,locality,neighborhood,district&limit=3&access_token=${mapboxKey}`;
            const res = await CapacitorHttp.get({
                url,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'ThalassaMarine/1.0'
                }
            });

            if (!res || !res.data) {
                return null;
            }

            let data = res.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) {
                    return null;
                }
            }

            if (data && data.features && data.features.length > 0) {
                // Prefer place/locality over natural_feature (e.g. prefer "Redcliffe" over "Moreton Bay")
                // But fall back to natural_feature for genuinely offshore points
                const preferredTypes = ['place', 'locality', 'neighborhood', 'district'];
                const place = data.features.find((f: any) => preferredTypes.includes(f.place_type?.[0]))
                    || data.features[0];
                // Mapbox Context: find country and region
                const context = place.context || [];
                const countryCtx = context.find((c: { id: string; text?: string; short_code?: string }) => c.id.startsWith('country'));
                const regionCtx = context.find((c: { id: string; text?: string; short_code?: string }) => c.id.startsWith('region'));

                const city = place.text;

                // FILTER: Ignore GENERIC "Ocean" or "Sea" results (e.g. "Pacific Ocean")
                // BUT Allow specific places like "Ocean City", "Seaside", "Ocean Grove"
                // Strict check: if it looks like a generic water body name
                const isGenericWater = /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(city);

                if (isGenericWater) {
                    return null;
                }

                const countryShort = countryCtx ? (countryCtx.short_code || countryCtx.text).toUpperCase() : "";

                // Allow "NSW", "CA" etc...
                let state = "";
                if (regionCtx) {
                    const regCode = regionCtx.short_code
                        ? regionCtx.short_code.replace(/^[A-Z]{2}-/i, "").toUpperCase()
                        : "";
                    const regText = regionCtx.text;
                    // Only use code if it's standard (e.g. US-CA -> CA, AU-QLD -> QLD, GB-ENG -> ENG)
                    if (regCode && regCode.length <= 3) state = regCode;
                    else if (STATE_ABBREVIATIONS[regText]) state = STATE_ABBREVIATIONS[regText];
                    else if (regText && regText.length < 20) state = regText; // Fallback to full name if reasonable
                }

                // Coordinates of the found place (center)
                const featureLat = place.center[1];
                const featureLon = place.center[0];

                const name = [city, state, countryShort].filter(p => p).join(", ");

                return { name, lat: featureLat, lon: featureLon };
            }
        } else {
        }


        // Fallback to Nominatim (OpenSource)

        const res = await CapacitorHttp.get({
            url: `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
            headers: { 'User-Agent': 'ThalassaMarine/1.0' }
        });

        if (!res || !res.data) {
            return null;
        }

        let data = res.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) {
                return null;
            }
        }

        if (!data || !data.address) {
            return null;
        }

        const addr = data.address;



        if (!addr) {
            return null;
        }

        // Expanded Locality Search for International Support
        const locality = addr.suburb || addr.town || addr.city_district || addr.village || addr.city || addr.hamlet || addr.island || addr.municipality || addr.county;

        const stateFull = addr.state || addr.province || addr.region || "";
        const state = abbreviate(stateFull) || stateFull; // Use transformer abbreviate, but fallback to full
        const country = addr.country_code ? addr.country_code.toUpperCase() : "";

        const parts = [locality, state, country].filter(part => part && part.trim().length > 0);

        // PREFER Display Name First Component ONLY if it matches a broad region type
        // The previous logic blindly took display_name[0], which often resulted in "123" (House Number) or "Smith St".
        // We want to force Suburb/Town level.

        let finalName = locality;

        // Fallback if locality is missing but we have a display name
        if (!finalName && data.display_name) {
            const parts = data.display_name.split(',').map((p: string) => p.trim());
            // Filter out things that look like numbers or streets if possible, but Nominatim doesn't guarantee type in string.
            // Safest is to just take the first part if we have NOTHING else.
            finalName = parts[0];
        }

        // If we have a structured locality, prefer it over the raw display name to avoid "12 Smith St"
        const name = [finalName, state, country].filter(p => p && p.trim().length > 0).join(", ");

        // FILTER: Ignore GENERIC "Ocean" or "Sea" results (e.g. "Pacific Ocean")
        // BUT Allow specific places like "Ocean City", "Seaside", "Ocean Grove"
        const isGenericWater = /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(name);

        if (isGenericWater) {
            return null;
        }

        // Nominatim returns lat/lon of the result
        const resLat = parseFloat(data.lat);
        const resLon = parseFloat(data.lon);


        return { name, lat: resLat, lon: resLon };

    } catch (err) {
        return null; // Return null on error
    }
}

export const reverseGeocode = async (lat: number, lon: number): Promise<string | null> => {
    const ctx = await reverseGeocodeContext(lat, lon);
    return ctx ? ctx.name : null;
}

export const parseLocation = async (location: string): Promise<{ lat: number, lon: number, name: string, timezone?: string }> => {
    if (!location || typeof location !== 'string') return { lat: 0, lon: 0, name: "Invalid Location" };

    const searchStr = location.toLowerCase().trim();

    // 1. EXACT MATCH on Buoy ID or Name (Priority)
    const exactBuoy = MAJOR_BUOYS.find(b =>
        b.name.toLowerCase() === searchStr ||
        b.id.toLowerCase() === searchStr
    );
    if (exactBuoy) {
        return { lat: exactBuoy.lat, lon: exactBuoy.lon, name: exactBuoy.name };
    }

    // 2. FUZZY MATCH on Buoy Name
    const fuzzyBuoy = MAJOR_BUOYS.find(b =>
        b.name.toLowerCase().includes(searchStr) && searchStr.length > 4
    );
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
        // 4. Fallback to Open-Meteo Geocoding (Faster than Nominatim)
        const fetchOpenMeteoGeo = async (query: string) => {
            try {
                // Count=1, English
                const res = await CapacitorHttp.get({
                    url: `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`
                });

                if (!res || !res.data) {
                    return [];
                }

                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                return (data && data.results) || [];
            } catch { return []; }
            // Silently ignored — non-critical failure
        }

        let results = await fetchOpenMeteoGeo(location);

        // FALLBACK: Nominatim (Better for POIs like "Marina")
        if (!results || results.length === 0) {
            try {
                const res = await CapacitorHttp.get({
                    url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
                    headers: { 'User-Agent': 'ThalassaMarine/1.0' }
                });

                if (!res.data) {
                    throw new Error('Geocoding failed: No data from Nominatim');
                }

                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data && data.length > 0) {
                    const r = data[0];
                    // Map Nominatim result to OpenMeteo-like structure to reuse logic below
                    results = [{
                        latitude: parseFloat(r.lat),
                        longitude: parseFloat(r.lon),
                        name: r.name || r.display_name.split(',')[0],
                        admin1: '', // Nominatim breakdown is complex, leaving blank is safe
                        country_code: '', // Can extract from display_name but optional
                        timezone: 'UTC' // We don't get TZ from Nominatim easily, but we can live without it or fetch it later
                    }];
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
                results = await fetchOpenMeteoGeo(corrected);
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
        const parts = [r.name, r.admin1, r.country_code?.toUpperCase()].filter(x => x);
        name = parts.join(", ");

        return { lat, lon, name, timezone: r.timezone };
    }

    return { lat, lon, name };
}
