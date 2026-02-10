
// src/services/worldTides.ts

// Key Access Strategy: Try Vite env first, then Node process.env
const API_KEY = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_WORLD_TIDES_API_KEY)
    || (typeof process !== 'undefined' && process.env && process.env.WORLD_TIDES_API_KEY)
    || '';

export interface TideResult {
    height: number;       // The depth relative to LAT
    timestamp: number;    // Time of reading
    stationName: string;  // Where this data came from
    datum: string;        // MUST be 'LAT'
    isSafe: boolean;      // Our internal safety flag
    error?: string;
}

export const fetchLiveTideDepth = async (lat: number, lon: number): Promise<TideResult> => {
    // SAFETY: Request LAT and strict 50km radius
    // Note: API Key needs to be real. 
    // If the user put it in 'our api file', might need to import it.

    // I will write the file EXACTLY as requested, but I suspect API_KEY might be undefined if not in .env
    const url = `https://www.worldtides.info/api/v3?heights&lat=${lat}&lon=${lon}&datum=LAT&station_distance=50&key=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        // 1. API Level Errors
        if (data.error) {
            return { height: 0, timestamp: 0, stationName: 'Unknown', datum: 'UNKNOWN', isSafe: false, error: data.error };
        }

        // 2. Data Integrity Check
        // If we didn't get LAT, the number is useless for our charts.
        if (data.datum !== 'LAT') {
            return {
                height: 0,
                timestamp: 0,
                stationName: data.station || 'Unknown',
                datum: data.datum, // Pass back the wrong datum so we can show a warning
                isSafe: false,
                error: `Invalid Datum: ${data.datum}`
            };
        }

        // 3. Success
        const reading = data.heights[0];
        return {
            height: Number(reading.height),
            timestamp: reading.dt,
            stationName: data.station || 'Nearby Station',
            datum: 'LAT',
            isSafe: true
        };

    } catch (err) {
        return { height: 0, timestamp: 0, stationName: 'N/A', datum: 'N/A', isSafe: false, error: 'Network Failure' };
    }
};
