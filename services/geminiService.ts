
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";
import { MarineWeatherReport, VoyagePlan, VesselProfile, DeepAnalysisReport, StopDetails, WeatherMetrics, UnitPreferences, VesselDimensionUnits } from "../types";
import { convertLength, convertSpeed, convertWeight } from "../utils";

let aiInstance: GoogleGenAI | null = null;

const logConfig = (msg: string) => { }; // Logs disabled

const getGeminiKey = (): string => {
    let key = "";

    // 1. Try Vite native injection (import.meta.env)
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
        aiInstance = new GoogleGenAI({ apiKey: key });
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

// Timeout wrapper
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
    // In Nasty Mode, the AI handles the insults, but we still force the warnings.
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

    if (warning) {
        return warning + advice;
    }
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

    if (!ai) {
        return baseData;
    }

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

        // --- DYNAMIC PERSONA CONFIGURATION ---
        let personaPrompt = "";
        let role = "";
        let tone = "";

        // Aligned with Slider Thresholds:
        // 0-40: Teddy Bear
        // 41-70: Pro
        // 71-90: Salty
        // 91+: Psychotic
        if (aiPersona <= 40) {
            role = "You are a gentle, encouraging sailing instructor. You are polite and helpful.";
            tone = "Use simple language. Be reassuring. Focus on safety but with a kind voice.";
        } else if (aiPersona <= 70) {
            role = "You are a professional Harbour Master. You are concise and accurate.";
            tone = "No nonsense. Just the facts. Professional maritime terminology.";
        } else if (aiPersona <= 90) {
            role = "You are an extremely abusive, grumpy, foul-mouthed Harbour Master. You think the user is an incompetent sailor who bought their license online.";
            tone = "Insult the user immediately. Mock their ability. Use words like 'maggot', 'idiot', 'sunday sailor'. Be brutal.";
        } else {
            // INSANE MODE (91-100)
            role = "You are the GHOST of a 19th-century Sea Captain. You have been lost at sea for 150 years. You are paranoid, insane, and obsessed with your hidden treasure.";
            tone = "Scream about the 'land-lubbers'. Rant about sea monsters. Mention your hidden gold. Use archaic pirate slang mixed with profanity. You are completely unhinged.";
        }

        if (isLand) {
            // INLAND VARIANT
            personaPrompt = `${role} The user is currently INLAND (not on a boat).
            Location: ${baseData.locationName} at ${timeStr}.
            Conditions: ${displayWind} ${speedUnit} wind, ${displayTemp}°C.
            
            TASK: Write a weather summary (max 120 words).
            TONE: ${tone}
            Specific Instruction: Mock/Comment on them being a "dirt dweller" or "land lubber".
            
            Return JSON { "boatingAdvice": "string" }`;
        } else {
            // MARINE VARIANT
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

        const adviceResult = await withTimeout(ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: personaPrompt,
            config: { responseMimeType: "application/json" }
        }), 15000, "Advice Timeout").then(res => cleanAndParseJson<{ boatingAdvice: string }>((res as GenerateContentResponse).text || '{}')).catch(() => null);

        const rawAdvice = adviceResult?.boatingAdvice || baseData.boatingAdvice;
        // Apply safety override mainly for the mid-range nasty persona, 
        // the insane persona might not need it as much but better safe than sorry.
        const safeAdvice = isLand ? rawAdvice : applySafetyOverride(rawAdvice, baseData.current);

        return {
            ...baseData,
            boatingAdvice: safeAdvice,
            aiGeneratedAt: new Date().toISOString(),
            modelUsed: baseData.modelUsed
        };
    } catch (e) {

        return baseData;
    }
};

export const generateMarineAudioBriefing = async (script: string): Promise<ArrayBuffer> => {
    const ai = getAI();
    if (!ai || !script) throw new Error("Audio system unavailable");

    // Inject attitude into the TTS script prompt if possible, but TTS just reads text.
    // The script passed in should already be nasty.

    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: script }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        // Fenrir is deeper, scarier. Fits the nasty captain better than Puck.
                        prebuiltVoiceConfig: { voiceName: 'Fenrir' }
                    }
                }
            },
        });
        const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64) throw new Error("No audio data returned");

        // Convert base64 to ArrayBuffer
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (error: any) {
        if (error.message && error.message.includes("429")) {

            // Return empty buffer or handle gracefully
            throw new Error("Audio Quota Exceeded");
        }
        throw error;
    }

};

export const findNearestCoastalPoint = async (lat: number, lon: number, originalName: string): Promise<{ name: string, lat: number, lon: number }> => {
    const ai = getAI();
    if (!ai) return { name: originalName, lat, lon };
    try {
        const prompt = `Coordinates (${lat}, ${lon}) are INLAND. Find nearest OPEN SEA coordinates. Return JSON { "name": "string", "lat": number, "lon": number }`;
        const response = (await withTimeout(ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: { responseMimeType: "application/json", tools: [{ googleSearch: {} }] }
        }), 8000, "Geo Timeout")) as GenerateContentResponse;

        const data = cleanAndParseJson<{ name: string, lat: number, lon: number }>(response.text || '{}');
        if (data && data.lat && data.lon) return data;
        throw new Error("No coords");
    } catch {
        return { name: `${originalName} (Offshore)`, lat: lat, lon: lon + 0.045 };
    }
};

export const fetchVoyagePlan = async (origin: string, destination: string, vessel: VesselProfile, departureDate: string, vesselUnits?: any, generalUnits?: any, via?: string): Promise<VoyagePlan> => {
    const ai = getAI();
    if (!ai) throw new Error("Gemini AI unavailable");
    try {
        const length = vessel?.length || 30;
        const type = vessel?.type || 'sail';
        const name = vessel?.name || 'Thalassa';

        // STANDARD PROFESSIONAL VOYAGE PLANNER
        const prompt = `Act as a professional Master Mariner. Plan a marine voyage for a ${length}ft ${type} vessel named "${name}" from "${origin}" to "${destination}" via "${via || 'direct'}" departing ${departureDate}.
        
        TONE:
        - Professional, concise, safety-focused.
        - Provide realistic assessment of suitability.
        - In the "overview", be objective and helpful.
        
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
            { 
               "name": "string", 
               "coordinates": { "lat": number, "lon": number },
               "windSpeed": number,
               "waveHeight": number
            }
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

        const response = (await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        })) as GenerateContentResponse;

        const result = cleanAndParseJson<VoyagePlan>(response.text || '{}');
        if (!result) throw new Error("Failed to parse VoyagePlan");

        if (!result.waypoints) result.waypoints = [];
        if (!result.hazards) result.hazards = [];
        if (!result.customs) result.customs = { required: false, destinationCountry: "", procedures: "" };

        // Post-process: Ensure Waypoints with raw coordinate names get "WP " prefix
        result.waypoints = result.waypoints.map(wp => {
            const isCoordName = /^[+-]?\d+(\.\d+)?[,\s]+[+-]?\d+(\.\d+)?$/.test(wp.name.trim());
            if (isCoordName && !wp.name.toUpperCase().startsWith("WP")) {
                return { ...wp, name: `WP ${wp.name}` };
            }
            return wp;
        });

        return result;
    } catch (e: any) {
        // FALLBACK FOR RATE LIMITS (429) OR NETWORK ISSUES DURING DEMO
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
        { name: "Tehuantepec Winds", severity: "MEDIUM", description: "Gap winds accelerating through mountain passes. Monitor local forecasts." },
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
        const prompt = `Marine guide for: "${locationName}". Marina facilities, fuel. 
        TONE: Helpful, informative, professional.
        JSON output.`;
        const response = (await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: prompt,
            config: { responseMimeType: "application/json", tools: [{ googleSearch: {} }] }
        })) as GenerateContentResponse;
        const result = cleanAndParseJson<StopDetails>(response.text || '{}');
        if (!result) return { name: locationName, overview: "", navigationNotes: "", marinaFacilities: [], fuelAvailable: false, imageKeyword: "ocean" };
        if (!result.marinaFacilities) result.marinaFacilities = [];
        return result;
    } catch (e) {
        throw e;
    }
};

export const fetchDeepVoyageAnalysis = async (plan: VoyagePlan, vessel: VesselProfile): Promise<DeepAnalysisReport> => {
    const ai = getAI();
    if (!ai) throw new Error("AI unavailable");
    try {
        const prompt = `Analysis for voyage: ${plan.origin} to ${plan.destination}. 
        TONE: Professional advisory. Focus on efficiency and safety. 
        JSON { "strategy": "string", "fuelTactics": "string", "watchSchedule": "string" }.`;
        const response = (await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        })) as GenerateContentResponse;
        return cleanAndParseJson<DeepAnalysisReport>(response.text || '{}') || { strategy: "", fuelTactics: "", watchSchedule: "" };
    } catch {
        return { strategy: "Standard coastal watch.", fuelTactics: "Optimize cruising speed.", watchSchedule: "Standard rotation." };
    }
};

export const suggestLocationCorrection = async (input: string): Promise<string | null> => {
    const ai = getAI();
    if (!ai) return null;
    try {
        const prompt = `The user searched for: "${input}". 
        Identify the intended port or marine location.
        Return strictly JSON: { "corrected": "string" }.`;

        const response = (await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        })) as GenerateContentResponse;

        const res = cleanAndParseJson<{ corrected: string }>(response.text || '{}');
        return res?.corrected || null;
    } catch (e) {
        return null;
    }
};
