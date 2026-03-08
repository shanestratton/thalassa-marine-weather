/**
 * types/api.ts — Third-party API response types
 *
 * StormGlass and World Tides API shapes.
 */

export interface WorldTidesHeight {
    dt: number;
    date: string;
    height: number;
}

export interface WorldTidesExtreme {
    dt: number;
    date: string;
    height: number;
    type: 'High' | 'Low';
}

export interface WorldTidesResponse {
    status: number;
    error?: string;
    heights?: WorldTidesHeight[];
    extremes?: WorldTidesExtreme[];
    callCount?: number;
    station?: { name: string, lat: number, lon: number };
}

export interface StormGlassValue {
    sg?: number;
    noaa?: number;
    icon?: number;
    dwd?: number;
    meteho?: number;
    [key: string]: number | undefined;
}

export interface StormGlassHour {
    time: string;
    [key: string]: StormGlassValue | string | number | undefined;
}

export interface StormGlassResponse {
    hours: StormGlassHour[];
    meta: {
        cost: number;
        dailyQuota: number;
        end: string;
        lat: number;
        lng: number;
        params: string[];
        requestCount: number;
        source: string[];
        start: string;
    };
}

export interface StormGlassTideData {
    time: string;
    sg?: number;
    noaa?: number;
    [key: string]: number | string | undefined;
}
