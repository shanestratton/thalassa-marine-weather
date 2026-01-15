import { MAJOR_BUOYS, STATE_ABBREVIATIONS } from '../config';
import { getMapboxKey } from '../keys';
import { abbreviate } from '../transformers';
import { suggestLocationCorrection } from '../../geminiService';

export interface GeoContext {
    name: string;
    lat: number;
    lon: number;
}

export const reverseGeocodeContext = async (lat: number, lon: number): Promise<GeoContext | null> => {
    try {
        console.log('[Geocoding] Reverse Request:', lat, lon);

        // Try Mapbox First (High Precision)
        const mapboxKey = getMapboxKey();
        if (mapboxKey) {
            // Enhanced types: natural_feature (Bays/Beaches), place (Cities), locality (Suburbs)
            // Removed 'poi' to prevent "Mickey Mouse" business names (e.g. "Joe's Fish Shack")
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=natural_feature,place,locality,neighborhood,district&limit=1&access_token=${mapboxKey}`;
            const res = await fetch(url);
            const data = await res.json();

            console.log('[Geocoding] Mapbox response:', data?.features?.length > 0 ? `Found ${data.features[0].text}` : 'Empty');

            if (data.features && data.features.length > 0) {
                const place = data.features[0];
                // Mapbox Context: find country and region
                const context = place.context || [];
                const countryCtx = context.find((c: any) => c.id.startsWith('country'));
                const regionCtx = context.find((c: any) => c.id.startsWith('region'));

                const city = place.text;

                // FILTER: Ignore "Ocean" or "Sea" results if we are looking for LAND context
                // This prevents "Pacific Ocean" being returned as the nearest "place", which breaks Offshore detection.
                if (city.includes('Ocean') || city.includes('Sea')) {
                    console.log(`[Geocoding] Filtered out water feature: ${city}`);
                    return null;
                }

                const countryShort = countryCtx ? (countryCtx.short_code || countryCtx.text).toUpperCase() : "";

                // Allow "NSW", "CA" etc...
                let state = "";
                if (regionCtx) {
                    const regCode = regionCtx.short_code ? regionCtx.short_code.replace("US-", "").toUpperCase() : "";
                    const regText = regionCtx.text;
                    // Only use code if it's standard (e.g. US-CA -> CA, AU-NSW -> NSW)
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
            console.warn('[Geocoding] Missing Mapbox Token');
        }

        // Fallback to Nominatim (OpenSource)
        console.log('[Geocoding] Trying Nominatim...');
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
            headers: { 'User-Agent': 'ThalassaMarine/1.0' }
        });
        const data = await res.json();
        const addr = data.address;

        console.log('[Geocoding] Nominatim data:', data?.display_name);

        if (!addr) return null;

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

        // FILTER: Ignore "Ocean" or "Sea" results from Nominatim as well
        if (name.includes('Ocean') || name.includes('Sea')) {
            console.log(`[Geocoding] Filtered out water feature (Nominatim): ${name}`);
            return null;
        }

        // Nominatim returns lat/lon of the result
        const resLat = parseFloat(data.lat);
        const resLon = parseFloat(data.lon);

        return { name, lat: resLat, lon: resLon };

    } catch (err) {
        console.error('[Geocoding] Error:', err);
        return null; // Return null on error
    }
}

export const reverseGeocode = async (lat: number, lon: number): Promise<string | null> => {
    const ctx = await reverseGeocodeContext(lat, lon);
    return ctx ? ctx.name : null;
}

export const parseLocation = async (location: string): Promise<{ lat: number, lon: number, name: string }> => {
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

        // Reverse Geocode to get a nice name (Mooloolaba, etc) instead of "-26, 153"
        const friendlyName = await reverseGeocode(lat, lon);
        if (friendlyName) {
            name = friendlyName;
        } else {
            name = `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        }
    } else {
        // 4. Fallback to Nominatim Search
        const fetchNominatim = async (query: string) => {
            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`);
                return await res.json();
            } catch { return []; }
        }

        let searchData = await fetchNominatim(location);

        // AUTOCORRECT LOGIC
        if (!searchData || searchData.length === 0) {
            console.log(`Location "${location}" not found. Attempting AI Autocorrect...`);
            const corrected = await suggestLocationCorrection(location);

            if (corrected) {
                console.log(`AI suggested: "${corrected}"`);
                searchData = await fetchNominatim(corrected);
                if (searchData && searchData.length > 0) {
                    name = corrected;
                }
            }
        }

        if (!searchData || searchData.length === 0) throw new Error(`Location "${location}" not found.`);

        lat = parseFloat(searchData[0].lat);
        lon = parseFloat(searchData[0].lon);

        if (searchData[0].address) {
            const a = searchData[0].address;
            const city = a.city || a.town || a.village || a.suburb || a.hamlet || a.county || "";
            const stateFull = a.state || a.province || a.region || "";
            const state = abbreviate(stateFull) || stateFull;
            const country = (a.country_code || "").toUpperCase();

            const parts = [city, state, country].filter(p => p && p.trim().length > 0);

            const inputIsShort = location.length < 4;
            const foundSpecificCity = city && city.length > 0;

            // PREFER Display Name's first part (e.g. "Mooloolaba") as it is usually the most specific.
            // fallback to 'parts' strategy only if display_name is missing.
            const displayNameFirst = searchData[0].display_name ? searchData[0].display_name.split(',')[0] : "";

            if (displayNameFirst && displayNameFirst.length > 1) {
                // Reconstruct: "Mooloolaba, QLD, AU"
                // Use the explicit town name from display_name, because 'city' variable might have fallen back to 'county' (Sunshine Coast Regional)
                const cleanParts = [displayNameFirst, state, country].filter(p => p && p.trim().length > 0 && p !== displayNameFirst); // Avoid duplications if state == city
                // Ensure distinctness
                name = Array.from(new Set([displayNameFirst, state, country].filter(x => x))).join(", ");
            } else if (foundSpecificCity || inputIsShort) {
                if (parts.length > 0) name = parts.join(", ");
            }
            // OTHERWISE: Keep user input 'location' (e.g. "Mooloolaba") if it was already good.

        } else if (searchData[0].display_name) {
            // Fallback for missing address object
            if (location.length < 4) {
                name = searchData[0].display_name.split(',')[0];
            }
        }
    }

    return { lat, lon, name };
}
