import { CapacitorHttp } from '@capacitor/core';

export interface CloudLayer {
    cover: 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV';
    base: number; // Feet
}

export interface LocalObservation {
    // Identification
    stationId: string;
    name?: string;
    timestamp: string;
    lat?: number;
    lon?: number;
    raw: string;

    // Wind
    windSpeed: number;     // Knots
    windDirection: number; // Degrees
    windGust?: number;     // Knots (undefined if no gusts)

    // Visibility & Weather
    visibility: number;    // Nautical Miles
    weather: string;       // Raw code e.g. "+TSRA"
    precipType: string | null; // Decoded string like "Heavy Rain"

    // Clouds
    clouds: CloudLayer[];
    ceiling: number | null; // Lowest BKN/OVC layer in feet
    cloudCover: number | null; // Calculated % for app usage

    // Atmosphere
    pressure: number;      // hPa
    temperature: number;   // Celsius
    dewpoint: number;      // Celsius
    precip: number | null; // Precip in mm (Last Hour)

    // Calculated Risk Factors
    fogRisk: boolean;      // True if Temp/Dewpoint spread < 2.5 degrees
}

/**
 * Fetches real-time METAR data from NOAA Aviation Weather Center.
 * @param icaoCode - The 4-letter airport code (e.g., 'YRED' for Redcliffe, 'YBBN' for Brisbane)
 */
export const fetchMetarObservation = async (icaoCode: string): Promise<LocalObservation | null> => {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icaoCode}&format=json`;

    try {
        const response = await CapacitorHttp.get({ url });
        if (response.status !== 200) throw new Error("Fetch failed");

        const data = response.data;
        if (!data || data.length === 0) return null;

        return parseMetar(data[0]);

    } catch (error) {
        console.error("METAR Error:", error);
        return null;
    }
};

import { findNearestAirport } from './AirportDatabase';

// ... existing imports ...

/**
 * Finds the closest METAR station to a given lat/lon.
 * Strategy:
 * 1. DATABASE LOOKUP: Find nearest Major/Medium airport from local DB. (Fast, ignores small strips).
 * 2. DYNAMIC SEARCH: If DB target fails, try expanding rings to find *any* live station (Safety Net).
 */
export const fetchNearestMetar = async (lat: number, lon: number): Promise<LocalObservation | null> => {

    // 1. DATABASE TARGET (Primary)
    // "Use this file to find our closest airport" - User Requirement
    const dbTarget = findNearestAirport(lat, lon);

    if (dbTarget) {
        console.log(`[METAR GEO] 🎯 Database Target: ${dbTarget.name} (${dbTarget.icao})`);

        try {
            // Attempt Direct Fetch
            const obs = await fetchMetarObservation(dbTarget.icao);
            if (obs) {
                console.log(`[METAR GEO] ✅ Database Target Success! Locked on ${dbTarget.icao}`);
                return obs;
            } else {
                console.warn(`[METAR GEO] ⚠️ Database Target ${dbTarget.icao} offline/no-data. Falling back to Scan...`);
            }
        } catch (e) {
            console.error(`[METAR GEO] Database Fetch Error:`, e);
        }
    } else {
        console.warn("[METAR GEO] No Major Airport found in DB near location.");
    }

    // 2. DYNAMIC SEARCH (Fallback)
    // If the major airport is offline, we scan the area for ANY active station.
    // Ring 1 (0.5 deg ~ 30nm): Tight local search.
    // Ring 2 (3.0 deg ~ 180nm): Regional fallback.
    const searchRings = [0.5, 3.0];

    for (const range of searchRings) {
        // SAFE MATH for Southern Hemisphere
        const minLat = Math.min(lat - range, lat + range).toFixed(4);
        const maxLat = Math.max(lat - range, lat + range).toFixed(4);
        const minLon = Math.min(lon - range, lon + range).toFixed(4);
        const maxLon = Math.max(lon - range, lon + range).toFixed(4);

        const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;

        // Minimal params. Ring 2 uses 12h history for remote areas.
        const hours = range > 1.0 ? 12 : 2;
        const url = `https://aviationweather.gov/api/data/metar?bbox=${bbox}&format=json&hours=${hours}`;

        console.log(`[METAR GEO] Scanning Ring ${range}° around boat... [${bbox}]`);

        try {
            const response = await CapacitorHttp.get({ url });

            // If valid data found (Status 200 and Not Empty)
            if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
                console.log(`[METAR GEO] ✅ Ring ${range}° Success! Found ${response.data.length} stations.`);

                const stations = response.data;

                // Sort by distance to find the physically closest active station
                const closest = stations.reduce((prev: any, curr: any) => {
                    const prevDist = Math.pow(prev.lat - lat, 2) + Math.pow(prev.lon - lon, 2);
                    const currDist = Math.pow(curr.lat - lat, 2) + Math.pow(curr.lon - lon, 2);
                    // Prioritize database match if in list? No, we already tried DB.
                    return (currDist < prevDist) ? curr : prev;
                });

                console.log(`[METAR GEO] Locked Target: ${closest.name} (${closest.icaoId})`);
                return parseMetar(closest);
            } else {
                console.warn(`[METAR GEO] ⚠️ Ring ${range}° empty or offline (Status: ${response.status}). Expanding...`);
            }

        } catch (e) {
            console.error(`[METAR GEO] ❌ Error scanning Ring ${range}°:`, e);
        }
        // Loop continues to wider ring...
    }

    console.error("[METAR GEO] ❌ GLOBAL FAIL: No stations found via Database or Scan.");
    return null;
};

// Helper to decode cryptic METAR codes
const decodeWeatherString = (code: string): string | null => {
    if (!code) return null;
    // Simple map for common marine weather
    const map: Record<string, string> = {
        'RA': 'Rain', 'SHRA': 'Showers', 'DZ': 'Drizzle',
        'TS': 'Thunderstorm', 'TSRA': 'Thunderstorm',
        'BR': 'Mist', 'FG': 'Fog', 'HZ': 'Haze',
        '+RA': 'Heavy Rain', '-RA': 'Light Rain',
        'VCTS': 'Vicinity Thunderstorm'
    };

    // Check exact match first
    if (map[code]) return map[code];

    // Fuzzy match
    if (code.includes('TS')) return 'Thunderstorm';
    if (code.includes('SH') && code.includes('RA')) return 'Showers';
    if (code.includes('RA')) return 'Rain';
    if (code.includes('DZ')) return 'Drizzle';
    if (code.includes('FG')) return 'Fog';
    if (code.includes('BR') || code.includes('HZ')) return 'Haze/Mist';

    return code; // Fallback to raw code if unknown
};

const parseMetar = (report: any): LocalObservation => {
    // Visibility: API gives Statute Miles. 1 SM = 0.868976 NM
    // "visib" can be "10+" (string), number, null, or undefined.
    let visNM = 10; // Default good vis if missing? NO, user wants Model Fallback.

    // If visib is NOT present, we should leave it undefined so the App uses StormGlass.
    // The API often omits 'visib' for CAVOK (Ceiling And Vis OK), which implies > 10km.
    // However, to be safe and allow model fallback if we aren't sure:
    // Actually, if rawOb contains "CAVOK" or "9999", visibility is excellent.

    let rawVis: any = report.visib;
    if (rawVis === '10+' || rawVis === '6+') rawVis = 10;

    // If strictly defined number (or parsable string)
    if (rawVis !== undefined && rawVis !== null && !isNaN(parseFloat(rawVis))) {
        visNM = parseFloat((parseFloat(rawVis) * 0.868976).toFixed(1));
    } else {
        // If "visib" field is missing, check raw text for "9999" or "CAVOK"
        if (report.rawOb && (report.rawOb.includes('CAVOK') || report.rawOb.includes('9999'))) {
            visNM = 10; // > 10nm essentially
        } else {
            // Truly missing/unknown. Return a sentinel or allow the fallback logic to handle 'undefined'
            // In the LocalObservation interface, visibility is 'number'. 
            // Let's allow it to be 10 if likely good, but if totally unknown, maybe -1?
            // But simpler: just default to 10 if we have a valid METAR but no vis tag?
            // User requested: "revert to stormglass if there is no data".
            // So we need to return undefined or null.
            // But the interface says `number`. Let's hack it: return -1 and handle in weatherService?
            // Or update interface. Let's update interface in a separate step or just assume 10 for now?
            // Actually, YBBN raw "9999" means 10km+.
            // If the API didn't parse "9999" into `visib`, we can assume 10nm is fine.
            // But if it's truly broken, we want model.
            // Let's use a cleaner check.
            visNM = -1; // Flag for fallback
        }
    }

    // Fix: If we detected 9999/CAVOK, we set it to 10 earlier.
    if (visNM === -1 && report.rawOb && (report.rawOb.includes('CAVOK') || report.rawOb.includes('9999'))) {
        visNM = 10;
    }

    // Pressure Conversion
    // Problem: report.altim can be inHg (29.92) OR hPa (1013).
    // Heuristic: If > 800, it's hPa. If < 100, it's inHg.
    let pressureHpa = 1013;
    if (report.slp) {
        pressureHpa = report.slp;
    } else if (report.altim) {
        if (report.altim > 800) {
            // Already hPa
            pressureHpa = Math.round(report.altim);
        } else {
            // inHg
            pressureHpa = Math.round(report.altim * 33.8639);
        }
    } else if (report.pres) {
        pressureHpa = Math.round(report.pres);
    }

    // Fog Risk Calculation (Temp/Dewpoint spread < 2.5 degrees)
    const spread = (report.temp !== undefined && report.dewp !== undefined)
        ? Math.abs(report.temp - report.dewp)
        : 10;

    // Cloud Parsing
    const clouds: CloudLayer[] = (report.clouds || []).map((c: any) => ({
        cover: c.cover,
        base: (c.base || 0) * 100 // Convert hundreds of feet to feet (14 -> 1400)
    }));

    // Calculate Ceiling (Lowest BKN or OVC layer)
    const ceilingLayer = clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV');
    const ceiling = ceilingLayer ? ceilingLayer.base : null;

    // Calculate Cloud Cover % (Rough Estimation for Model Override)
    let cloudCover = 0;
    // Take the highest coverage layer
    if (clouds.some(c => c.cover === 'OVC' || c.cover === 'VV')) cloudCover = 100;
    else if (clouds.some(c => c.cover === 'BKN')) cloudCover = 75;
    else if (clouds.some(c => c.cover === 'SCT')) cloudCover = 45;
    else if (clouds.some(c => c.cover === 'FEW')) cloudCover = 20;

    // Filter "valid" visibility
    // If visNM is -1, we want the consuming service to know it's invalid.
    // We will return it as is, and `weatherService` must check for >= 0.

    return {
        stationId: report.icaoId,
        name: report.name,
        timestamp: report.reportTime,
        lat: report.lat,
        lon: report.lon,
        raw: report.rawOb,

        windSpeed: report.wspd || 0,
        windDirection: report.wdir || 0,
        windGust: report.wgst || undefined,

        visibility: visNM, // Can be -1 if missing
        weather: report.wxString || "",
        precipType: decodeWeatherString(report.wxString),

        clouds: clouds,
        ceiling: ceiling,
        cloudCover: cloudCover,

        pressure: pressureHpa,
        temperature: report.temp || 0,
        dewpoint: report.dewp || 0,

        // Precip (mm) - Converted from Inches
        precip: report.precip_in ? parseFloat((report.precip_in * 25.4).toFixed(1)) : null,

        fogRisk: spread < 2.5
    };
}

/**
 * Returns a "Punchy Pilot Word" for the condition label.
 * Logic provided by User.
 */
export const getShortCondition = (obs: LocalObservation | null): string => {
    if (!obs) return "--";

    // 1. RAW METAR CODES (The Priority List)
    const wx = (obs.weather || "").toUpperCase(); // Using 'weather' from LocalObservation

    if (wx.includes("TS")) return "STORM";    // Thunderstorm
    if (wx.includes("SH")) return "SHOWERS";  // Showers
    if (wx.includes("+RA")) return "POURING"; // Heavy Rain
    if (wx.includes("RA")) return "RAIN";     // Moderate Rain
    if (wx.includes("DZ")) return "DRIZZLE";  // Light Rain
    if (wx.includes("GR")) return "HAIL";     // Hail
    if (wx.includes("FG")) return "FOG";      // Fog
    if (wx.includes("BR")) return "MIST";     // Mist
    if (wx.includes("HZ")) return "HAZE";     // Haze

    // 2. CLOUD COVER (If no precip is falling)
    // We look for the "Ceiling" layer
    if (obs.clouds && obs.clouds.length > 0) {
        const ceiling = obs.clouds.find(c => c.cover === 'OVC' || c.cover === 'BKN');

        if (ceiling) {
            return (ceiling.cover === 'OVC') ? "OVERCAST" : "CLOUDY";
        }

        // If only Scattered (SCT) or Few (FEW) clouds exist
        if (obs.clouds.some(c => c.cover === 'SCT')) return "CLOUDS"; // SCT (Scattered) -> CLOUDS
    }

    // 3. DEFAULT (If nothing else matches)
    return "CLEAR";
};
