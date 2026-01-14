import { LocalObservation } from './MetarService';

/**
 * Determines the best label for precipitation based on METAR ground truth codes
 * or falling back to Model Volume if METAR is silent.
 */
export const getPrecipitationLabelV2 = (obs: LocalObservation | null, modelRain: number): { label: string, value: string } => {
    if (!obs) {
        // Fallback to model data if no METAR
        if (modelRain > 5.0) return { label: "HEAVY RAIN", value: `${modelRain.toFixed(1)} mm` };
        if (modelRain > 0.5) return { label: "SHOWERS", value: `${modelRain.toFixed(1)} mm` };
        if (modelRain >= 0.15) {
            return { label: "LIGHT", value: `${modelRain.toFixed(1)} mm` };
        }
        return { label: "DRY", value: "0.0 mm" };
    }

    const wx = (obs.weather || "").toUpperCase();

    // 4. METAR Volume (If available and significant)
    if (obs.precip !== null && obs.precip >= 0.15) {
        let label = "LIGHT";
        if (obs.precip > 5.0) label = "HEAVY RAIN";
        else if (obs.precip > 0.5) label = "SHOWERS";

        // Enrich with code if available
        if (wx.includes("TS")) label = "STORM";
        else if (wx.includes("+RA")) label = "DOWNPOUR";

        return { label, value: `${obs.precip.toFixed(1)} mm` };
    }

    // 5. METAR Codes Fallback (If no volume but code exists)
    // "if it is just a piss of rain, then it can say trace."
    if (wx.includes("+RA")) return { label: "DOWNPOUR", value: "Heavy" };
    if (wx.includes("SHRA")) return { label: "SHOWERS", value: "Mod" };
    if (wx.includes("RA")) return { label: "RAINING", value: "Steady" };
    if (wx.includes("DZ") || wx.includes("VC") || wx.includes("-RA") || wx.includes("SH")) {
        // Light Rain, Drizzle, Vicinity, Showers (without volume) -> TRACE
        return { label: "LIGHT", value: "Trace" };
    }

    // 6. STRICT AIRPORT TRUTH: If METAR exists but says nothing, assume DRY.
    return { label: "DRY", value: "0.0 mm" };
};
