
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";
import { MarineWeatherReport, VoyagePlan, VesselProfile, DeepAnalysisReport, StopDetails, WeatherMetrics, UnitPreferences, VesselDimensionUnits } from "../types";
import { convertLength, convertSpeed, convertWeight } from "../utils";

let aiInstance: GoogleGenAI | null = null;

const logConfig = (msg: string) => console.log(`[Gemini Config] ${msg}`);

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
        } catch (e) {}
    }

    return key;
};

const getAI = () => {
    if (aiInstance) return aiInstance;
    
    const key = getGeminiKey();
    
    if (!key || key.length < 10 || key.includes("YOUR_")) {
        console.warn("Gemini Service: API Key Missing or Invalid");
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
        console.warn("JSON Parse Error:", e);
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
            personaPrompt = `${role}
            
            THE USER IS: Sailing a ${lenStr} ${lenUnit} ${vesselType} named "${vessel?.name}".
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
            modelUsed: baseData.modelUsed + ` (Persona: ${aiPersona})`
        };
    } catch (e) {
        console.warn("Enrichment Error:", e);
        return baseData;
    }
};

export const generateMarineAudioBriefing = async (script: string): Promise<ArrayBuffer> => {
    const ai = getAI();
    if (!ai || !script) throw new Error("Audio system unavailable");
    
    // Inject attitude into the TTS script prompt if possible, but TTS just reads text.
    // The script passed in should already be nasty.
    
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
    if (!base64) throw new Error("No audio generated");
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
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
        return { name: `${originalName} (Offshore)`, lat: lat, lon: lon + 0.05 };
    }
};

export const fetchVoyagePlan = async (origin: string, destination: string, vessel: VesselProfile, departureDate: string, vesselUnits?: any, generalUnits?: any, via?: string): Promise<VoyagePlan> => {
    const ai = getAI();
    if (!ai) throw new Error("Gemini AI unavailable");
    try {
        const length = vessel?.length || 30;
        const type = vessel?.type || 'sail';
        const name = vessel?.name || 'Thalassa';
        
        // UPGRADED TO NASTY VOYAGE PLANNER
        const prompt = `Act as an extremely grumpy, cynical Master Mariner. Plan a marine voyage for a ${length}ft ${type} vessel named "${name}" from "${origin}" to "${destination}" via "${via || 'direct'}" departing ${departureDate}.
        
        TONE:
        - Mock the user's choice of route.
        - Be pessimistic about the "suitability".
        - In the "overview", insult the captain's skills.
        
        RETURN PURE JSON ONLY. NO MARKDOWN. STRICTLY ADHERE TO THIS SCHEMA:
        {
          "origin": "string",
          "destination": "string",
          "departureDate": "YYYY-MM-DD",
          "originCoordinates": { "lat": number, "lon": number },
          "destinationCoordinates": { "lat": number, "lon": number },
          "distanceApprox": "string",
          "durationApprox": "string",
          "overview": "string (Rude summary)",
          "suitability": {
            "status": "SAFE" | "CAUTION" | "UNSAFE",
            "reasoning": "string (Why the user will probably fail)",
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
        
        return result;
    } catch (e) {
        throw e;
    }
};

export const fetchStopDetails = async (locationName: string): Promise<StopDetails> => {
    const ai = getAI();
    if (!ai) throw new Error("AI unavailable");
    try {
        const prompt = `Marine guide for: "${locationName}". Marina facilities, fuel. 
        TONE: You are annoyed the user wants to stop here. Mock the location.
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
        const prompt = `Tactical analysis: ${plan.origin} to ${plan.destination}. 
        TONE: Brutal honesty. Tell them they are burning too much fuel because they are bad at trimming sails. 
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
        const prompt = `The user searched for: "${input}". They probably spelled it wrong because they are stupid.
        Identify the intended port.
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
