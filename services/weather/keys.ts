
import { CapacitorHttp } from '@capacitor/core';
import { getErrorMessage } from '../../utils/logger';

export const getApiKey = () => {
    // Priority: 1. Runtime Env (Vite), 2. Hardcoded (if any, dangerous), 3. Null
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_STORMGLASS_API_KEY) {
        return import.meta.env.VITE_STORMGLASS_API_KEY;
    }
    // Fallback or Node process env
    if (typeof process !== 'undefined' && process.env && process.env.VITE_STORMGLASS_API_KEY && process.env.VITE_STORMGLASS_API_KEY.length > 20) {
        return process.env.VITE_STORMGLASS_API_KEY;
    }

    // HARDCODED FALLBACK (Restoring functionality)
    return "d5cfe8a6-da85-11f0-9b8c-0242ac130003-d5cfe950-da85-11f0-9b8c-0242ac130003";
};

export const getOpenMeteoKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_OPEN_METEO_API_KEY) {
        return import.meta.env.VITE_OPEN_METEO_API_KEY;
    }
    return null;
};

export const getWorldTidesKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_WORLDTIDES_API_KEY) {
        return import.meta.env.VITE_WORLDTIDES_API_KEY;
    }
    // Fallback or Node process env
    if (typeof process !== 'undefined' && process.env && process.env.VITE_WORLDTIDES_API_KEY && process.env.VITE_WORLDTIDES_API_KEY.length > 10) {
        return process.env.VITE_WORLDTIDES_API_KEY;
    }

    // HARDCODED FALLBACK (Ensuring tide functionality on device)
    return "66fcf5ed-de19-4c37-861c-57455c8ae0a4";
};

export const getMapboxKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN) {
        return import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    }
    return null;
};

export const getTomorrowIoKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_TOMORROW_IO_API_KEY) {
        return import.meta.env.VITE_TOMORROW_IO_API_KEY;
    }
    // Fallback or Node process env
    if (typeof process !== 'undefined' && process.env && process.env.VITE_TOMORROW_IO_API_KEY && process.env.VITE_TOMORROW_IO_API_KEY.length > 10) {
        return process.env.VITE_TOMORROW_IO_API_KEY;
    }

    // HARDCODED FALLBACK (Ensuring functionality on device)
    return "r8504oU3evFU41QkPRQfJzqKVXRYBu3o";
};


export const getApiKeySuffix = () => {
    const key = getApiKey();
    if (!key) return "MISSING";
    return `...${key.slice(-4)}`;
};

export const isStormglassKeyPresent = () => {
    const key = getApiKey();
    return !!key && key.length > 10;
};

export const isWorldTidesKeyPresent = () => {
    const key = getWorldTidesKey();
    return !!key && key.length > 5;
};

// Returns RAW string for debugging UI
export const debugStormglassConnection = async (): Promise<string> => {
    const key = getApiKey();
    if (!key) return "Error: No API Key found in Environment.";

    const url = 'https://api.stormglass.io/v2/weather/point?lat=0&lng=0&params=windSpeed'; // Minimal request
    try {
        const options = {
            url: url,
            headers: { 'Authorization': key }
        };
        const res = await CapacitorHttp.get(options);

        // Check quota headers if available
        // SG headers: 'x-quota-total', 'x-quota-remaining'
        const headers = res.headers;
        let quotaInfo = "";
        if (headers && headers['x-quota-remaining']) {
            quotaInfo = ` | Quota: ${headers['x-quota-remaining']}/${headers['x-quota-total']}`;
        }

        if (res.status === 200) return `Success: Connected${quotaInfo}`;
        if (res.status === 402 || res.status === 429) return `Error: Quota Exceeded${quotaInfo}`;
        if (res.status === 401 || res.status === 403) return "Error: Invalid API Key";
        return `Error: HTTP ${res.status}`;
    } catch (e: unknown) {
        return `Error: Network Fail (${getErrorMessage(e)})`;
    }
};

export const checkStormglassStatus = async (): Promise<{ status: 'OK' | 'ERROR' | 'MISSING_KEY', message: string, code?: number }> => {
    const key = getApiKey();
    if (!key) return { status: 'MISSING_KEY', message: 'No API Key configured' };

    try {
        const options = {
            url: 'https://api.stormglass.io/v2/weather/point?lat=58.5&lng=17.8&params=windSpeed&start=2024-01-01&end=2024-01-01',
            headers: { 'Authorization': key }
        };
        const res = await CapacitorHttp.get(options);

        if (res.status === 200) return { status: 'OK', message: 'Service Operational' };
        return { status: 'ERROR', message: `HTTP ${res.status}`, code: res.status };
    } catch (e: unknown) {
        return { status: 'ERROR', message: getErrorMessage(e) };
    }
};
