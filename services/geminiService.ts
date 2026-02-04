
import { GoogleGenerativeAI } from "@google/generative-ai";
import { MarineWeatherReport, VoyagePlan, VesselProfile, DeepAnalysisReport, StopDetails, WeatherMetrics, UnitPreferences, VesselDimensionUnits } from "../types";
import { convertLength, convertSpeed, convertWeight } from "../utils";
import { fetchStormGlassWeather } from "./weather/api/stormglass";

let aiInstance: GoogleGenerativeAI | null = null;
const logConfig = (msg: string) => { }; // Logs disabled

const getGeminiKey = (): string => {
    let key = "";
    // 1. Try Vite native injection
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) {
        key = import.meta.env.VITE_GEMINI_API_KEY as string;
    }
    // 2. Try process.env shim
    if (!key) {
        try {
            // @ts-ignore
            if (typeof process !== 'undefined' && process.env) {
                // @ts-ignore
                key = process.env.API_KEY || process.env.GEMINI_API_KEY;
            }
        } catch (e) { }
    }
    return key;
};

const getAI = () => {
    if (aiInstance) return aiInstance;
    const key = getGeminiKey();

    if (!key || key.length < 10 || key.includes("YOUR_")) {
        return null;
    }
    try {
        aiInstance = new GoogleGenerativeAI(key);
        return aiInstance;
    } catch (e) {
        console.error("Gemini Service: Init Failed", e);
        return null;
    }
};

export const isGeminiConfigured = () => {
    const key = getGeminiKey();
    return !!(key && key.length > 10 && !key.includes("YOUR_"));
};

const withTimeout = <T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
    ]);
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
    let warning = "";

    if (wind > 40 || gust > 50) {
        warning = "LISTEN TO ME YOU IDIOT: STORM FORCE WINDS. DOCK THE BOAT OR DIE. ";
    } else if (wind > 30 || gust > 40) {
        warning = "IT'S A GALE, MORON. DON'T GO OUT. ";
    } else if (wave > 12) {
        warning = "LOOK AT THE WAVES, STUPID. 12 FEET. YOU WILL SINK. ";
    }
    if (warning) return warning + advice;
    return advice;
};

export const enrichMarineWeather = async (
    baseData: MarineWeatherReport,
    vessel?: VesselProfile,
    units?: UnitPreferences,
    vesselUnits?: VesselDimensionUnits,
    aiPersona: number = 50
): Promise<MarineWeatherReport> => {
    const ai = getAI();
    if (!ai) return baseData;

    try {
        const isLand = baseData.isLandlocked;
        const vesselType = vessel?.type || 'sail';
        const lenUnit = vesselUnits?.length || 'ft';
        const lenStr = vessel?.length ? vessel.length.toFixed(0) : "Unknown";
        const speedUnit = units?.speed || 'kts';
        const waveUnit = units?.length || 'ft';

        const displayWind = convertSpeed(baseData.current.windSpeed, speedUnit);
        const displayWave = convertLength(baseData.current.waveHeight, waveUnit);
        const displayTemp = baseData.current.airTemperature !== null ? Math.round(baseData.current.airTemperature!) : "Unknown";
        const windDir = baseData.current.windDirection || "Unknown";

        let tideState = "Slack";
        if (baseData.tides && baseData.tides.length > 0) {
            const nowTime = new Date().getTime();
            const nextTide = baseData.tides.find(t => new Date(t.time).getTime() > nowTime);
            if (nextTide) {
                tideState = nextTide.type === 'High' ? "In" : "Out";
            }
        }
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '') + " HRS";

        // Persona Logic
        let personaPrompt = "";
        let role = "";
        let tone = "";

        if (aiPersona <= 40) {
            role = "You are a gentle, encouraging sailing instructor. You are polite and helpful.";
            tone = "Use simple language. Be reassuring. Focus on safety but with a kind voice.";
        } else if (aiPersona <= 70) {
            role = "You are a professional Harbour Master. You are concise and accurate.";
            tone = "No nonsense. Just the facts. Professional maritime terminology.";
        } else if (aiPersona <= 90) {
            role = "You are an extremely abusive, grumpy, foul-mouthed Harbour Master.";
            tone = "Insult the user immediately. Mock their ability. Use words like 'maggot', 'idiot'. Be brutal.";
        } else {
            role = "You are the GHOST of a 19th-century Sea Captain. You have been lost at sea for 150 years. You are paranoid, insane.";
            tone = "Scream about the 'land-lubbers'. Rant about sea monsters. Mention your hidden gold. Use archaic pirate slang mixed with profanity. You are completely unhinged.";
        }

        if (isLand) {
            personaPrompt = `${role} The user is currently INLAND (not on a boat).
             Location: ${baseData.locationName} at ${timeStr}.
             Conditions: ${displayWind} ${speedUnit} wind, ${displayTemp}°C.
             TASK: Write a weather summary (max 120 words).
             TONE: ${tone}
             Specific Instruction: Mock/Comment on them being a "dirt dweller" or "land lubber".
             Return JSON { "boatingAdvice": "string" }`;
        } else {
            const vesselNamePart = (vessel?.name && vessel.name !== "Observer") ? `named "${vessel.name}"` : "";
            const vesselDesc = `Sailing a ${lenStr} ${lenUnit} ${vesselType} ${vesselNamePart} `.trim();
            personaPrompt = `${role}
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

        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await withTimeout(model.generateContent({
            contents: [{ role: 'user', parts: [{ text: personaPrompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        }), 15000, "Advice Timeout");

        const data = cleanAndParseJson<{ boatingAdvice: string }>(result.response.text() || '{}');
        const rawAdvice = data?.boatingAdvice || baseData.boatingAdvice;
        const safeAdvice = isLand ? rawAdvice : applySafetyOverride(rawAdvice, baseData.current);

        return {
            ...baseData,
            boatingAdvice: safeAdvice,
            aiGeneratedAt: new Date().toISOString(),
            modelUsed: "gemini-2.0-flash"
        };
    } catch (e) {
        return baseData;
    }
};

export const generateMarineAudioBriefing = async (script: string): Promise<ArrayBuffer> => {
    // Audio not currently supported in JS/Web SDK shim easily, returning empty buffer 
    // to prevent application crash until server-side solution or stable Web Speech API is ready.
    // The previous implementation relied on a Preview model that may not be compatible with the standard Web SDK.
    return new ArrayBuffer(0);
};

export const findNearestCoastalPoint = async (lat: number, lon: number, originalName: string): Promise<{ name: string, lat: number, lon: number }> => {
    const ai = getAI();
    if (!ai) return { name: originalName, lat, lon };
    try {
        const prompt = `Coordinates (${lat}, ${lon}) are INLAND. Find nearest OPEN SEA coordinates. Return JSON { "name": "string", "lat": number, "lon": number }`;
        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await withTimeout(model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        }), 8000, "Geo Timeout");

        const data = cleanAndParseJson<{ name: string, lat: number, lon: number }>(result.response.text() || '{}');
        if (data && data.lat && data.lon) return data;
        throw new Error("No coords");
    } catch {
        return { name: `${originalName} (Offshore)`, lat: lat, lon: lon + 0.045 };
    }
};

export const fetchVoyagePlan = async (origin: string, destination: string, vessel: VesselProfile, departureDate: string, vesselUnits?: any, generalUnits?: any, via?: string, weatherContext?: any): Promise<VoyagePlan> => {
    const ai = getAI();
    if (!ai) throw new Error("Gemini AI unavailable");
    try {
        const length = vessel?.length || 30;
        const type = vessel?.type || 'sail';
        const name = vessel?.name || 'Thalassa';

        let contextString = "";
        if (weatherContext) {
            contextString = `\nREAL-TIME WEATHER CONTEXT (Use this to assess viability/timing):\n${JSON.stringify(weatherContext, null, 2)}\n`;
        }

        const prompt = `Act as a professional Master Mariner. Plan a marine voyage for a ${length}ft ${type} vessel named "${name}" from "${origin}" to "${destination}" via "${via || 'direct'}" departing ${departureDate}.
        ${contextString}
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
            "timeRange": "string",
            "reasoning": "string"
          }
        }`;

        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        let data = cleanAndParseJson<any>(result.response.text() || '{}');

        // Handle generic array response if the model decides to return a list
        if (Array.isArray(data)) {
            data = data[0];
        }

        if (!data) throw new Error("Failed to parse VoyagePlan");

        if (!data.waypoints) data.waypoints = [];
        if (!data.hazards) data.hazards = [];
        if (!data.customs) data.customs = { required: false, destinationCountry: "", procedures: "" };

        data.waypoints = data.waypoints.map((wp: any) => {
            const isCoordName = /^[+-]?\d+(\.\d+)?[,\s]+[+-]?\d+(\.\d+)?$/.test(wp.name.trim());
            if (isCoordName && !wp.name.toUpperCase().startsWith("WP")) {
                return { ...wp, name: `WP ${wp.name}` };
            }
            return wp;
        });
        return data;

    } catch (e: any) {
        if (e.message?.includes('429') || e.message?.includes('Quota') || e.status === 429) {
            return { ...MOCK_VOYAGE_PLAN, origin: origin, destination: destination };
        }
        throw e;
    }
};

const MOCK_VOYAGE_PLAN: VoyagePlan = {
    origin: "San Diego, CA",
    destination: "Cabo San Lucas, MX",
    departureDate: new Date().toISOString().split('T')[0],
    durationApprox: "3 days, 4 hours",
    distanceApprox: "750 NM",
    originCoordinates: { lat: 32.7157, lon: -117.1611 },
    destinationCoordinates: { lat: 22.8905, lon: -109.9167 },
    waypoints: [
        { name: "San Diego Channel", coordinates: { lat: 32.6, lon: -117.2 }, windSpeed: 12, waveHeight: 3 },
        { name: "Ensenada Offshore", coordinates: { lat: 31.8, lon: -116.8 }, windSpeed: 15, waveHeight: 4 },
        { name: "Punta Baja", coordinates: { lat: 29.9, lon: -115.9 }, windSpeed: 18, waveHeight: 5 },
        { name: "Cedros Island leeward", coordinates: { lat: 28.1, lon: -115.1 }, windSpeed: 10, waveHeight: 2 },
        { name: "Magdalena Bay", coordinates: { lat: 24.5, lon: -112.0 }, windSpeed: 14, waveHeight: 3 },
    ],
    hazards: [
        { name: "Tehuantepec Winds", severity: "MEDIUM", description: "Gap winds accelerating through mountain passes." },
        { name: "Fishing Traffic", severity: "LOW", description: "Heavy panga traffic expected near coastal villages." }
    ],
    overview: "A favorable passage with following seas expected for the majority of the route. High pressure ridge keeps conditions stable.",
    suitability: { status: "SAFE", maxWindEncountered: 18, maxWaveEncountered: 5, reasoning: "Conditions well within vessel limits." },
    customs: { required: true, destinationCountry: "Mexico", procedures: "Check into Ensenada or Cabo San Lucas. Temporary Import Permit (TIP) required.", contactPhone: "+52 646 178 8800" },
    bestDepartureWindow: { timeRange: "06:00 - 10:00 PST", reasoning: "Morning ebb tide assists departure." }
};

export const fetchStopDetails = async (locationName: string): Promise<StopDetails> => {
    const ai = getAI();
    if (!ai) throw new Error("AI unavailable");
    try {
        const prompt = `Marine guide for: "${locationName}". Marina facilities, fuel. TONE: Helpful, informative, professional. JSON output.`;
        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const data = cleanAndParseJson<StopDetails>(result.response.text() || '{}');
        if (!data) return { name: locationName, overview: "", navigationNotes: "", marinaFacilities: [], fuelAvailable: false, imageKeyword: "ocean" };
        if (!data.marinaFacilities) data.marinaFacilities = [];
        return data;
    } catch (e) {
        throw e;
    }
};

export const fetchDeepVoyageAnalysis = async (plan: VoyagePlan, vessel: VesselProfile): Promise<DeepAnalysisReport> => {
    const ai = getAI();
    if (!ai) throw new Error("AI unavailable");
    try {

        let weatherContext: string = "";

        // Check if voyage is near-term (within 10 days)
        const departure = new Date(plan.departureDate);
        const now = new Date();
        const diffDays = (departure.getTime() - now.getTime()) / (1000 * 3600 * 24);

        if (diffDays >= -1 && diffDays <= 10) {
            try {
                // Fetch basic weather for Origin and Destination to ground the AI
                // We use parallel fetches for speed
                const pOrigin = plan.originCoordinates ? fetchStormGlassWeather(plan.originCoordinates.lat, plan.originCoordinates.lon, "Origin") : Promise.resolve(null);
                const pDest = plan.destinationCoordinates ? fetchStormGlassWeather(plan.destinationCoordinates.lat, plan.destinationCoordinates.lon, "Destination") : Promise.resolve(null);

                const [wOrigin, wDest] = await Promise.all([pOrigin, pDest]);

                let weatherStr = "REAL-TIME FORECAST DATA (Use this for your analysis):\n";

                if (wOrigin) {
                    const d = wOrigin.forecast[0];
                    weatherStr += `ORIGIN (${plan.origin}) CONDITIONS ON DEPARTURE: Wind ${d.windSpeed}kts ${d.condition}, Gust ${d.windGust}kts, Wave ${d.waveHeight}ft.\n`;
                }
                if (wDest) {
                    // Simple approximation: destination forecast for 3 days out (index 2) or end of array
                    const idx = Math.min(2, (wDest.forecast.length || 1) - 1);
                    const d = wDest.forecast[idx];
                    weatherStr += `DESTINATION (${plan.destination}) ARRIVAL FORECAST: Wind ${d.windSpeed}kts ${d.condition}, Wave ${d.waveHeight}ft.\n`;
                }
                weatherContext = weatherStr;
            } catch (e) {
                console.warn("Deep Analysis: Could not fetch real weather", e);
            }
        }

        const prompt = `Analyze this marine voyage plan and return a valid JSON object.
        
        ROUTE:
        Origin: ${plan.origin}
        Destination: ${plan.destination}
        Distance: ${plan.distanceApprox}
        Vessel: ${vessel.length}ft ${vessel.type}
        Cruising Speed: ${vessel.cruisingSpeed} kts
        Points: ${plan.waypoints.map(wp => wp.name).join(', ')}

        ${weatherContext}

        INSTRUCTIONS:
        - Act as a senior Master Mariner with access to global maritime databases.
        - LEVERAGE knowledge of typical weather patterns (Pilot Charts), currents, and seasonal conditions for this specific route.
        - ${weatherContext ? "INCORPORATE the provided Real-Time Forecast Data above into your Strategy and Weather Summary." : "Since no real-time data is provided, use typical seasonal climatology."}
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



        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const data = cleanAndParseJson<DeepAnalysisReport>(result.response.text() || '{}');

        // Fix: Ensure data is not just an empty object
        if (!data || !data.strategy) {
            return {
                strategy: "Standard coastal watch.",
                fuelTactics: "Optimize cruising speed.",
                watchSchedule: "Standard rotation.",
                weatherSummary: "No detailed weather data available.",
                hazards: ["General precaution advised."]
            };
        }
        return data;
    } catch {
        return {
            strategy: "Analysis unavailable due to network or quota limits.",
            fuelTactics: "Standard conservation recommended.",
            watchSchedule: "Standard 4-on-4-off advised.",
            weatherSummary: "Unable to retrieve dynamic weather routing.",
            hazards: ["Maintain standard lookout."]
        };
    }
};

export const suggestLocationCorrection = async (input: string): Promise<string | null> => {
    const ai = getAI();
    if (!ai) return null;
    try {
        const prompt = `The user searched for: "${input}".Identify the intended port or marine location.Return strictly JSON: { "corrected": "string" }.`;
        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const res = cleanAndParseJson<{ corrected: string }>(result.response.text() || '{}');
        return res?.corrected || null;
    } catch (e) {
        return null;
    }
};
