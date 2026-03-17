import { createLogger } from '../utils/createLogger';
import {
    MarineWeatherReport,
    VoyagePlan,
    VesselProfile,
    DeepAnalysisReport,
    StopDetails,
    WeatherMetrics,
    UnitPreferences,
    VesselDimensionUnits,
} from '../types';
import { convertLength, convertSpeed } from '../utils';
import { fetchStormGlassWeather } from './weather/api/stormglass';
const log = createLogger('Gemini');

// ── Supabase Edge Proxy ──────────────────────────────────────
// All Gemini calls go through the proxy-gemini edge function.
// The API key lives server-side only (Supabase Secret).
const getSupabaseUrl = (): string => {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL as string;
    }
    try {
        if (typeof process !== 'undefined' && process.env?.SUPABASE_URL) {
            return process.env.SUPABASE_URL;
        }
    } catch (e) {
        console.warn('[gemini] browser:', e);
    }
    return '';
};

const PROXY_URL = `${getSupabaseUrl()}/functions/v1/proxy-gemini`;

interface ProxyResponse {
    text: string;
    model: string;
    usage?: Record<string, unknown>;
    error?: string;
}

/**
 * Call the Gemini API via the Supabase edge proxy.
 * Replaces all direct @google/generative-ai SDK usage.
 */
const callGeminiProxy = async (opts: {
    prompt: string;
    systemInstruction?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseMimeType?: string;
}): Promise<string> => {
    const url = getSupabaseUrl();
    if (!url) throw new Error('Supabase URL not configured');

    const res = await fetch(`${url}/functions/v1/proxy-gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: opts.prompt,
            systemInstruction: opts.systemInstruction,
            model: opts.model || 'gemini-2.0-flash',
            temperature: opts.temperature ?? 0.7,
            maxTokens: opts.maxTokens ?? 8192,
            responseMimeType: opts.responseMimeType,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Proxy error: ${res.status}`);
    }

    const data: ProxyResponse = await res.json();
    if (data.error) throw new Error(data.error);
    return data.text || '';
};

export const isGeminiConfigured = () => {
    return !!getSupabaseUrl();
};

const withTimeout = <T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> => {
    return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))]);
};

const cleanAndParseJson = <T = any>(text: string): T | null => {
    if (!text) return null;
    try {
        let clean = text.replace(/```json/g, '').replace(/```/g, '');
        const firstBracket = clean.indexOf('[');
        const lastBracket = clean.lastIndexOf(']');
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');

        if (firstBracket !== -1 && lastBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
            clean = clean.substring(firstBracket, lastBracket + 1);
        } else if (firstBrace !== -1 && lastBrace !== -1) {
            clean = clean.substring(firstBrace, lastBrace + 1);
        }
        return JSON.parse(clean);
    } catch (e) {
        return null;
    }
};

const applySafetyOverride = (advice: string, current: WeatherMetrics): string => {
    const wind = current.windSpeed || 0;
    const wave = current.waveHeight || 0;
    const gust = current.windGust || 0;
    let warning = '';

    if (wind > 40 || gust > 50) {
        warning = 'LISTEN TO ME YOU IDIOT: STORM FORCE WINDS. DOCK THE BOAT OR DIE. ';
    } else if (wind > 30 || gust > 40) {
        warning = "IT'S A GALE, MORON. DON'T GO OUT. ";
    } else if (wave > 12) {
        warning = 'LOOK AT THE WAVES, STUPID. 12 FEET. YOU WILL SINK. ';
    }
    if (warning) return warning + advice;
    return advice;
};

export const enrichMarineWeather = async (
    baseData: MarineWeatherReport,
    vessel?: VesselProfile,
    units?: UnitPreferences,
    vesselUnits?: VesselDimensionUnits,
    aiPersona: number = 50,
): Promise<MarineWeatherReport> => {
    if (!isGeminiConfigured()) return baseData;

    try {
        const isLand = baseData.isLandlocked;
        const vesselType = vessel?.type || 'sail';
        const lenUnit = vesselUnits?.length || 'ft';
        const lenStr = vessel?.length ? vessel.length.toFixed(0) : 'Unknown';
        const speedUnit = units?.speed || 'kts';
        const waveUnit = units?.length || 'ft';

        const displayWind = convertSpeed(baseData.current.windSpeed, speedUnit);
        const displayWave = convertLength(baseData.current.waveHeight, waveUnit);
        const displayTemp =
            baseData.current.airTemperature !== null ? Math.round(baseData.current.airTemperature!) : 'Unknown';
        const windDir = baseData.current.windDirection || 'Unknown';

        let tideState = 'Slack';
        if (baseData.tides && baseData.tides.length > 0) {
            const nowTime = new Date().getTime();
            const nextTide = baseData.tides.find((t) => new Date(t.time).getTime() > nowTime);
            if (nextTide) {
                tideState = nextTide.type === 'High' ? 'In' : 'Out';
            }
        }
        const now = new Date();
        const timeStr =
            now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '') +
            ' HRS';

        // Persona Logic
        let role = '';
        let tone = '';

        if (aiPersona <= 40) {
            role = 'You are a gentle, encouraging sailing instructor. You are polite and helpful.';
            tone = 'Use simple language. Be reassuring. Focus on safety but with a kind voice.';
        } else if (aiPersona <= 70) {
            role = 'You are a professional Harbour Master. You are concise and accurate.';
            tone = 'No nonsense. Just the facts. Professional maritime terminology.';
        } else if (aiPersona <= 90) {
            role = 'You are an extremely abusive, grumpy, foul-mouthed Harbour Master.';
            tone = "Insult the user immediately. Mock their ability. Use words like 'maggot', 'idiot'. Be brutal.";
        } else {
            role =
                'You are the GHOST of a 19th-century Sea Captain. You have been lost at sea for 150 years. You are paranoid, insane.';
            tone =
                "Scream about the 'land-lubbers'. Rant about sea monsters. Mention your hidden gold. Use archaic pirate slang mixed with profanity. You are completely unhinged.";
        }

        let prompt: string;
        if (isLand) {
            prompt = `${role} The user is currently INLAND (not on a boat).
             Location: ${baseData.locationName} at ${timeStr}.
             Conditions: ${displayWind} ${speedUnit} wind, ${displayTemp}°C.
             TASK: Write a weather summary (max 120 words).
             TONE: ${tone}
             Specific Instruction: Mock/Comment on them being a "dirt dweller" or "land lubber".
             Return JSON { "boatingAdvice": "string" }`;
        } else {
            const vesselNamePart = vessel?.name && vessel.name !== 'Observer' ? `named "${vessel.name}"` : '';
            const vesselDesc = `Sailing a ${lenStr} ${lenUnit} ${vesselType} ${vesselNamePart} `.trim();
            prompt = `${role}
            THE USER IS: ${vesselDesc}.
            LOCATION: ${baseData.locationName}.
            TIME: ${timeStr}.
            LIVE CONDITIONS (USE THESE):
            - Wind: ${displayWind} ${speedUnit} (${windDir})
            - Sea: ${displayWave} ${waveUnit}
            - Tide: ${tideState}
            - Temp: ${displayTemp}°C
            TASK: Write the log entry (max 150 words).
            TONE: ${tone}
            Return JSON { "boatingAdvice": "string" }`;
        }

        const text = await withTimeout(
            callGeminiProxy({ prompt, responseMimeType: 'application/json' }),
            15000,
            'Advice Timeout',
        );

        const data = cleanAndParseJson<{ boatingAdvice: string }>(text || '{}');
        const rawAdvice = data?.boatingAdvice || baseData.boatingAdvice;
        const safeAdvice = isLand ? rawAdvice : applySafetyOverride(rawAdvice, baseData.current);

        return {
            ...baseData,
            boatingAdvice: safeAdvice,
            aiGeneratedAt: new Date().toISOString(),
            modelUsed: 'gemini-2.0-flash',
        };
    } catch (e) {
        return baseData;
    }
};

export const generateMarineAudioBriefing = async (_script: string): Promise<ArrayBuffer> => {
    // Audio not currently supported via proxy — returning empty buffer
    return new ArrayBuffer(0);
};

export const findNearestCoastalPoint = async (
    lat: number,
    lon: number,
    originalName: string,
): Promise<{ name: string; lat: number; lon: number }> => {
    if (!isGeminiConfigured()) return { name: originalName, lat, lon };
    try {
        const prompt = `Coordinates (${lat}, ${lon}) are INLAND. Find nearest OPEN SEA coordinates. Return JSON { "name": "string", "lat": number, "lon": number }`;

        const text = await withTimeout(
            callGeminiProxy({ prompt, responseMimeType: 'application/json' }),
            8000,
            'Geo Timeout',
        );

        const data = cleanAndParseJson<{ name: string; lat: number; lon: number }>(text || '{}');
        if (data && data.lat && data.lon) return data;
        throw new Error('No coords');
    } catch (e) {
        console.warn('[gemini]', e);
        /* AI geo-lookup failed — return slight coord offset as safe fallback */
        return { name: `${originalName} (Offshore)`, lat: lat, lon: lon + 0.045 };
    }
};

export const fetchVoyagePlan = async (
    origin: string,
    destination: string,
    vessel: VesselProfile,
    departureDate: string,
    vesselUnits?: VesselDimensionUnits,
    generalUnits?: UnitPreferences,
    via?: string,
    weatherContext?: Record<string, unknown>,
    userLocation?: { lat: number; lon: number },
): Promise<VoyagePlan> => {
    if (!isGeminiConfigured()) throw new Error('Gemini AI unavailable');
    try {
        const length = vessel?.length || 30;
        const type = vessel?.type || 'sail';
        const name = vessel?.name || 'Thalassa';

        let contextString = '';
        if (weatherContext) {
            contextString = `\nREAL-TIME WEATHER CONTEXT (Use this to assess viability/timing):\n${JSON.stringify(weatherContext, null, 2)}\n`;
        }
        const today = new Date().toISOString().split('T')[0];

        // ── Proximity-based disambiguation context ──
        let disambiguationCtx = '';
        if (userLocation) {
            const latDir = userLocation.lat >= 0 ? 'N' : 'S';
            const lonDir = userLocation.lon >= 0 ? 'E' : 'W';
            disambiguationCtx = `
USER'S CURRENT GPS POSITION: ${Math.abs(userLocation.lat).toFixed(2)}°${latDir}, ${Math.abs(userLocation.lon).toFixed(2)}°${lonDir}
DISAMBIGUATION RULES (CRITICAL):
- When resolving AMBIGUOUS place names, ALWAYS prefer the port/marina geographically CLOSEST to the user's current position.
- Common maritime abbreviations that are ambiguous:
  • "NC" near Oceania/Pacific = New Caledonia (Nouvelle-Calédonie), NOT North Carolina (USA)
  • "NC" near US East Coast = North Carolina, NOT New Caledonia
  • "NZ" = New Zealand
  • "NSW" = New South Wales, Australia
  • "WA" near Australia = Western Australia, NOT Washington State (USA)
  • "QLD" = Queensland, Australia
- ALWAYS resolve to the interpretation that is geographically closest to the user's position.
- Include the full country name in your response (e.g. "Port Moselle, New Caledonia" not "Port Moselle, NC").
`;
        }

        const prompt = `Act as a professional Master Mariner. Plan a marine voyage for a ${length}ft ${type} vessel named "${name}" from "${origin}" to "${destination}" via "${via || 'direct'}" departing ${departureDate}.
        ${contextString}${disambiguationCtx}
        CRITICAL INSTRUCTIONS:
        1. COORDINATES: If the origin or destination contains GPS coordinates in parentheses like "Port Name (-22.2765, 166.4377)", you MUST use those EXACT coordinates for originCoordinates/destinationCoordinates. Do NOT substitute with city-center or generic port coordinates.
        2. GEOCODING ACCURACY: You MUST resolve origin and destination to their SPECIFIC suburb/marina/harbour coordinates. For Australian locations:
           - "Newport" in SE QLD = Newport Waterways canal estate near Scarborough, lat -27.210, lon 153.090
           - "Scarborough" in QLD = Scarborough Beach/harbour near Redcliffe, lat -27.190, lon 153.106
           - "Manly" in QLD = Manly Boat Harbour, lat -27.452, lon 153.193
           - NEVER return generic state or region coordinates (e.g. "Queensland, Queensland, AU" is WRONG).
           - The origin and destination names in your response must match the actual place, not generic regions.
        3. DEPARTURE WINDOW: Today is ${today}. The bestDepartureWindow MUST specify a CONCRETE date and time within the next 10 days based on actual weather patterns for this route and season. Give a specific ISO datetime (e.g. "2026-02-26T06:00:00Z"), NOT vague advice like "March" or "next season". Consider: synoptic weather patterns, trade wind cycles, frontal systems, and tidal windows. If departing now would be acceptable, say so with confidence.
        4. PRECISION: All waypoint coordinates must be in open navigable water, not on land.

        TONE: Professional, concise, safety-focused.
        RETURN PURE JSON ONLY. NO MARKDOWN. STRICTLY ADHERE TO THIS SCHEMA:
        {
          "origin": "string",
          "destination": "string",
          "departureDate": "YYYY-MM-DD",
          "originCoordinates": { "lat": number, "lon": number },
          "destinationCoordinates": { "lat": number, "lon": number },
          "distanceApprox": "string",
          "durationApprox": "string",
          "overview": "string (Professional summary)",
          "suitability": {
            "status": "SAFE" | "CAUTION" | "UNSAFE",
            "reasoning": "string (Safety assessment)",
            "maxWindEncountered": number,
            "maxWaveEncountered": number
          },
          "waypoints": [
            { "name": "string", "coordinates": { "lat": number, "lon": number }, "windSpeed": number, "waveHeight": number }
          ],
          "hazards": [
            { "name": "string", "severity": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "description": "string" }
          ],
          "customs": {
            "required": boolean,
            "departingCountry": "string",
            "departureProcedures": "string",
            "destinationCountry": "string",
            "procedures": "string",
            "contactPhone": "string"
          },
          "bestDepartureWindow": {
            "dateTimeISO": "string (CRITICAL: ISO 8601 datetime for the OPTIMAL departure. Analyze weather patterns and pick the BEST day within the next 10 days — this must NOT always be today. If a front is passing, recommend departing AFTER it clears. If conditions worsen mid-week, recommend departing BEFORE. e.g. '2026-03-19T06:00:00Z'. Today is ${today}.)",
            "timeRange": "string (e.g. '06:00 - 10:00 local' — the optimal time window on that specific day)",
            "reasoning": "string (WHY this specific date/time: reference wind forecast, fronts, tides, swell. Be concrete, e.g. 'SE trade winds ease to 12-15kts after frontal passage on the 19th, with 1.2m SE swell. Ebb tide at 0600 assists departure from the channel.')"
          },
          "safeHarbours": [
            {
              "name": "string (name of port or marina ALONG THE ROUTE — NOT the origin or destination)",
              "lat": "number",
              "lon": "number",
              "description": "string (why this is a good refuge: shelter, facilities, depth, approach notes)"
            }
          ],
          "routeReasoning": "string (Explain WHY this specific route was chosen over alternatives. Consider: prevailing winds, currents, reef/shoal avoidance, shipping lanes, safe harbours en route, and any relevant maritime geography.)"
        }`;

        // NOTE to AI: provide 2-3 safe harbours that are BETWEEN origin and destination, spaced along the route.
        // These must NOT be the origin or destination port. They are emergency ports of refuge.

        const text = await callGeminiProxy({ prompt, responseMimeType: 'application/json' });

        let data = cleanAndParseJson<any>(text || '{}');

        // Handle generic array response if the model decides to return a list
        if (Array.isArray(data)) {
            data = data[0];
        }

        if (!data) throw new Error('Failed to parse VoyagePlan');

        if (!data.waypoints) data.waypoints = [];
        if (!data.hazards) data.hazards = [];
        if (!data.customs) data.customs = { required: false, destinationCountry: '', procedures: '' };

        // ── Geocoding Sanity Check ──────────────────────────────────────
        // If origin and destination coordinates are suspiciously close (< 1km),
        // AND the user typed different place names, Gemini probably failed to geocode.
        if (data.originCoordinates && data.destinationCoordinates) {
            const oLat = data.originCoordinates.lat;
            const oLon = data.originCoordinates.lon;
            const dLat = data.destinationCoordinates.lat;
            const dLon = data.destinationCoordinates.lon;
            const dxKm = Math.abs(dLon - oLon) * 111 * Math.cos((oLat * Math.PI) / 180);
            const dyKm = Math.abs(dLat - oLat) * 111;
            const distKm = Math.sqrt(dxKm * dxKm + dyKm * dyKm);

            if (distKm < 1 && origin.trim().toLowerCase() !== destination.trim().toLowerCase()) {
                // Common SE QLD fallbacks
                const seqldFallbacks: Record<string, { lat: number; lon: number }> = {
                    scarborough: { lat: -27.19, lon: 153.106 },
                    redcliffe: { lat: -27.227, lon: 153.13 },
                    manly: { lat: -27.452, lon: 153.193 },
                    mooloolaba: { lat: -26.681, lon: 153.138 },
                    noosa: { lat: -26.384, lon: 153.091 },
                    'moreton island': { lat: -27.119, lon: 153.409 },
                    tangalooma: { lat: -27.184, lon: 153.37 },
                    'gold coast seaway': { lat: -27.937, lon: 153.429 },
                    southport: { lat: -27.96, lon: 153.41 },
                    brisbane: { lat: -27.388, lon: 153.156 },
                    sandgate: { lat: -27.32, lon: 153.064 },
                    shorncliffe: { lat: -27.328, lon: 153.081 },
                    'woody point': { lat: -27.244, lon: 153.099 },
                };
                const destKey = destination.trim().toLowerCase();
                const fallback = seqldFallbacks[destKey];
                if (fallback) {
                    data.destinationCoordinates = fallback;
                    data.destination = destination;
                }
            }
        }

        // Always fix generic destination names — Gemini sometimes returns
        // "Queensland, Queensland, AU" even when coordinates are correct.
        // The user input may ALSO be contaminated from a previous session.
        if (data.destination && data.destinationCoordinates) {
            const geminiDest = data.destination.toLowerCase().trim();
            const isGeminiGeneric =
                geminiDest.includes('queensland, queensland') ||
                geminiDest.includes('new south wales, new south wales') ||
                geminiDest.includes('victoria, victoria');

            if (isGeminiGeneric) {
                const { lat, lon } = data.destinationCoordinates;
                const coordStr = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;

                // Check if user input is ALSO contaminated
                const userDest = (destination || '').toLowerCase().trim();
                const isUserGeneric =
                    userDest.includes('queensland') ||
                    userDest.includes('new south wales') ||
                    userDest.includes('victoria, victoria');

                if (isUserGeneric || !destination) {
                    // Both are generic — reverse geocode from coordinates
                    try {
                        const { reverseGeocode } = await import('./weatherService');
                        const placeName = await reverseGeocode(lat, lon);
                        if (placeName && !placeName.toLowerCase().includes('queensland, queensland')) {
                            data.destination = `${placeName} ${coordStr}`;
                        } else {
                            data.destination = `Destination ${coordStr}`;
                        }
                    } catch (e) {
                        console.warn('[gemini]', e);
                        data.destination = `Destination ${coordStr}`;
                    }
                } else {
                    // User input is clean — use it with coordinates
                    data.destination = `${destination} ${coordStr}`;
                }
            }
        }

        data.waypoints = data.waypoints.map(
            (wp: {
                name: string;
                coordinates?: { lat: number; lon: number };
                windSpeed?: number;
                waveHeight?: number;
            }) => {
                const isCoordName = /^[+-]?\d+(\.\d+)?[,\s]+[+-]?\d+(\.\d+)?$/.test(wp.name.trim());
                if (isCoordName && !wp.name.toUpperCase().startsWith('WP')) {
                    return { ...wp, name: `WP ${wp.name}` };
                }
                return wp;
            },
        );

        // ── Wind/Wave Sanity Check ──────────────────────────────────────
        data.waypoints = data.waypoints.map(
            (wp: {
                name: string;
                coordinates?: { lat: number; lon: number };
                windSpeed?: number;
                waveHeight?: number;
            }) => {
                if (wp.windSpeed != null && wp.waveHeight != null && wp.windSpeed > 0) {
                    const expectedMinWaves = 0.005 * wp.windSpeed * wp.windSpeed;
                    if (wp.waveHeight < expectedMinWaves * 0.4) {
                        wp.waveHeight = Math.round(expectedMinWaves * 0.7 * 10) / 10;
                    }
                }
                return wp;
            },
        );

        // Recalculate max values from corrected waypoints
        if (data.suitability) {
            const maxWind = Math.max(...data.waypoints.map((wp: { windSpeed?: number }) => wp.windSpeed ?? 0));
            const maxWave = Math.max(...data.waypoints.map((wp: { waveHeight?: number }) => wp.waveHeight ?? 0));
            if (maxWind > 0) data.suitability.maxWindEncountered = maxWind;
            if (maxWave > 0) data.suitability.maxWaveEncountered = maxWave;
        }

        // ── Country Qualifier: append full country name to origin/destination ──
        // Prevents ambiguous abbreviations like "NC" (New Caledonia vs North Carolina)
        if (data.destinationCoordinates) {
            try {
                const { reverseGeocode } = await import('./weatherService');
                const destName = await reverseGeocode(data.destinationCoordinates.lat, data.destinationCoordinates.lon);
                if (destName && data.destination) {
                    // Extract country from reverse geocode result (usually last part after comma)
                    const parts = destName.split(',').map((p: string) => p.trim());
                    const country = parts.length >= 2 ? parts[parts.length - 1] : null;
                    // Only append if the destination doesn't already contain the country
                    if (country && !data.destination.toLowerCase().includes(country.toLowerCase())) {
                        data.destination = `${data.destination}, ${country}`;
                    }
                }
            } catch {
                /* Non-critical — keep original name */
            }
        }
        if (data.originCoordinates) {
            try {
                const { reverseGeocode } = await import('./weatherService');
                const origName = await reverseGeocode(data.originCoordinates.lat, data.originCoordinates.lon);
                if (origName && data.origin) {
                    const parts = origName.split(',').map((p: string) => p.trim());
                    const country = parts.length >= 2 ? parts[parts.length - 1] : null;
                    if (country && !data.origin.toLowerCase().includes(country.toLowerCase())) {
                        data.origin = `${data.origin}, ${country}`;
                    }
                }
            } catch {
                /* Non-critical — keep original name */
            }
        }

        return data;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        const status = (e as Record<string, unknown>)?.status;
        if (msg?.includes('429') || msg?.includes('Quota') || status === 429) {
            return { ...MOCK_VOYAGE_PLAN, origin: origin, destination: destination };
        }
        throw e;
    }
};

const MOCK_VOYAGE_PLAN: VoyagePlan = {
    origin: 'San Diego, CA',
    destination: 'Cabo San Lucas, MX',
    departureDate: new Date().toISOString().split('T')[0],
    durationApprox: '3 days, 4 hours',
    distanceApprox: '750 NM',
    originCoordinates: { lat: 32.7157, lon: -117.1611 },
    destinationCoordinates: { lat: 22.8905, lon: -109.9167 },
    waypoints: [
        { name: 'San Diego Channel', coordinates: { lat: 32.6, lon: -117.2 }, windSpeed: 12, waveHeight: 3 },
        { name: 'Ensenada Offshore', coordinates: { lat: 31.8, lon: -116.8 }, windSpeed: 15, waveHeight: 4 },
        { name: 'Punta Baja', coordinates: { lat: 29.9, lon: -115.9 }, windSpeed: 18, waveHeight: 5 },
        { name: 'Cedros Island leeward', coordinates: { lat: 28.1, lon: -115.1 }, windSpeed: 10, waveHeight: 2 },
        { name: 'Magdalena Bay', coordinates: { lat: 24.5, lon: -112.0 }, windSpeed: 14, waveHeight: 3 },
    ],
    hazards: [
        {
            name: 'Tehuantepec Winds',
            severity: 'MEDIUM',
            description: 'Gap winds accelerating through mountain passes.',
        },
        {
            name: 'Fishing Traffic',
            severity: 'LOW',
            description: 'Heavy panga traffic expected near coastal villages.',
        },
    ],
    overview:
        'A favorable passage with following seas expected for the majority of the route. High pressure ridge keeps conditions stable.',
    suitability: {
        status: 'SAFE',
        maxWindEncountered: 18,
        maxWaveEncountered: 5,
        reasoning: 'Conditions well within vessel limits.',
    },
    customs: {
        required: true,
        destinationCountry: 'Mexico',
        procedures: 'Check into Ensenada or Cabo San Lucas. Temporary Import Permit (TIP) required.',
        contactPhone: '+52 646 178 8800',
    },
    bestDepartureWindow: { timeRange: '06:00 - 10:00 PST', reasoning: 'Morning ebb tide assists departure.' },
};

export const fetchStopDetails = async (locationName: string): Promise<StopDetails> => {
    if (!isGeminiConfigured()) throw new Error('AI unavailable');
    try {
        const prompt = `Marine guide for: "${locationName}". Marina facilities, fuel. TONE: Helpful, informative, professional. JSON output.`;

        const text = await callGeminiProxy({ prompt, responseMimeType: 'application/json' });

        const data = cleanAndParseJson<StopDetails>(text || '{}');
        if (!data)
            return {
                name: locationName,
                overview: '',
                navigationNotes: '',
                marinaFacilities: [],
                fuelAvailable: false,
                imageKeyword: 'ocean',
            };
        if (!data.marinaFacilities) data.marinaFacilities = [];
        return data;
    } catch (e) {
        throw e;
    }
};

export const fetchDeepVoyageAnalysis = async (plan: VoyagePlan, vessel: VesselProfile): Promise<DeepAnalysisReport> => {
    if (!isGeminiConfigured()) throw new Error('AI unavailable');
    try {
        let weatherContext: string = '';

        // Check if voyage is near-term (within 10 days)
        const departure = new Date(plan.departureDate);
        const now = new Date();
        const diffDays = (departure.getTime() - now.getTime()) / (1000 * 3600 * 24);

        if (diffDays >= -1 && diffDays <= 10) {
            try {
                const pOrigin = plan.originCoordinates
                    ? fetchStormGlassWeather(plan.originCoordinates.lat, plan.originCoordinates.lon, 'Origin')
                    : Promise.resolve(null);
                const pDest = plan.destinationCoordinates
                    ? fetchStormGlassWeather(
                          plan.destinationCoordinates.lat,
                          plan.destinationCoordinates.lon,
                          'Destination',
                      )
                    : Promise.resolve(null);

                const [wOrigin, wDest] = await Promise.all([pOrigin, pDest]);

                let weatherStr = 'REAL-TIME FORECAST DATA (Use this for your analysis):\n';

                if (wOrigin) {
                    const d = wOrigin.forecast[0];
                    weatherStr += `ORIGIN (${plan.origin}) CONDITIONS ON DEPARTURE: Wind ${d.windSpeed}kts ${d.condition}, Gust ${d.windGust}kts, Wave ${d.waveHeight}ft.\n`;
                }
                if (wDest) {
                    const idx = Math.min(2, (wDest.forecast.length || 1) - 1);
                    const d = wDest.forecast[idx];
                    weatherStr += `DESTINATION (${plan.destination}) ARRIVAL FORECAST: Wind ${d.windSpeed}kts ${d.condition}, Wave ${d.waveHeight}ft.\n`;
                }
                weatherContext = weatherStr;
            } catch (e) {
                // Silently ignored — non-critical failure
            }
        }

        const prompt = `Analyze this marine voyage plan and return a valid JSON object.
        
        ROUTE:
        Origin: ${plan.origin}
        Destination: ${plan.destination}
        Distance: ${plan.distanceApprox}
        Vessel: ${vessel.length}ft ${vessel.type}
        Cruising Speed: ${vessel.cruisingSpeed} kts
        Points: ${plan.waypoints.map((wp) => wp.name).join(', ')}

        ${weatherContext}

        INSTRUCTIONS:
        - Act as a senior Master Mariner with access to global maritime databases.
        - LEVERAGE knowledge of typical weather patterns (Pilot Charts), currents, and seasonal conditions for this specific route.
        - ${weatherContext ? 'INCORPORATE the provided Real-Time Forecast Data above into your Strategy and Weather Summary.' : 'Since no real-time data is provided, use typical seasonal climatology.'}
        - IDENTIFY real-world shipping lanes, traffic separation schemes (TSS), and high-congestion areas (e.g. fishing fleets).
        - PROVIDE specific geographic hazards (shoals, headlands, tidal races) relevant to this route.

        REQUIRED OUTPUT FORMAT (JSON ONLY, NO MARKDOWN):
        {
          "strategy": "Comprehensive routing strategy. Discuss departure timing relative to tides/weather and route geometry.",
          "weatherSummary": "Detailed forecast simulation. Include likely wind directions, speeds (knots), and wave heights. Mention specific weather systems.",
          "hazards": [
             "Specific hazard 1 (e.g. 'Heavy merchant traffic near [Location]')",
             "Specific hazard 2 (e.g. 'Strong tidal rips off [Point] during ebb')", 
             "Regulatory issues"
          ],
          "fuelTactics": "Specific advice based on vessel limits and route length.",
          "watchSchedule": "Recommended watch schedule tailored to crew fatigue and route intensity."
        }`;

        const text = await callGeminiProxy({ prompt, responseMimeType: 'application/json' });

        const data = cleanAndParseJson<DeepAnalysisReport>(text || '{}');

        if (!data || !data.strategy) {
            return {
                strategy: 'Standard coastal watch.',
                fuelTactics: 'Optimize cruising speed.',
                watchSchedule: 'Standard rotation.',
                weatherSummary: 'No detailed weather data available.',
                hazards: ['General precaution advised.'],
            };
        }
        return data;
    } catch (e) {
        console.warn('[gemini]', e);
        /* AI analysis unavailable — return static safety defaults */
        return {
            strategy: 'Analysis unavailable due to network or quota limits.',
            fuelTactics: 'Standard conservation recommended.',
            watchSchedule: 'Standard 4-on-4-off advised.',
            weatherSummary: 'Unable to retrieve dynamic weather routing.',
            hazards: ['Maintain standard lookout.'],
        };
    }
};

export const suggestLocationCorrection = async (input: string): Promise<string | null> => {
    if (!isGeminiConfigured()) return null;
    try {
        const prompt = `The user searched for: "${input}".Identify the intended port or marine location.Return strictly JSON: { "corrected": "string" }.`;

        const text = await callGeminiProxy({ prompt, responseMimeType: 'application/json' });

        const res = cleanAndParseJson<{ corrected: string }>(text || '{}');
        return res?.corrected || null;
    } catch (e) {
        return null;
    }
};
