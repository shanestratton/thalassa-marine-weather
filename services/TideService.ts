import { Tide, TideStation } from '../types';
import { GLOBAL_TIDE_STATIONS } from './TideDatabase';
export { GLOBAL_TIDE_STATIONS };

export type { TideStation }; // Re-export for compatibility if needed, or just let consumers import from types

// 50 Nautical Miles in Kilometers (1 NM = 1.852 km)

// 20 Nautical Miles in Kilometers (1 NM = 1.852 km)
const MAX_DISTANCE_COASTAL_KM = 20 * 1.852;

// Local High-Accuracy Stations (Prioritized)
const LOCAL_TIDE_STATIONS: TideStation[] = [
    // --- REFERENCE STATIONS (Standard Ports) ---
    {
        id: 'brisbane_bar',
        name: 'Brisbane Bar',
        coords: { lat: -27.3667, lon: 153.1667 },
        timeOffsetMinutes: 0,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'gold_coast_seaway',
        name: 'Gold Coast Seaway',
        coords: { lat: -27.9391, lon: 153.4296 },
        timeOffsetMinutes: 0,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'mooloolaba',
        name: 'Mooloolaba',
        coords: { lat: -26.6833, lon: 153.1333 },
        timeOffsetMinutes: 0,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'noosa_head',
        name: 'Noosa Head',
        coords: { lat: -26.3833, lon: 153.1000 },
        timeOffsetMinutes: 0, // Generally follows Mooloolaba closely or is a Std Port
        heightOffsetRatio: 1.0,
        z0: 0,
    },

    // --- MORETON BAY (Western Side - North to South) ---
    {
        id: 'bribie_island_bongaree',
        name: 'Bongaree (Bribie Is)',
        coords: { lat: -27.0833, lon: 153.1667 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: -20,
        heightOffsetRatio: 0.9,
        z0: 0,
    },
    {
        id: 'redcliffe',
        name: 'Redcliffe',
        coords: { lat: -27.2267, lon: 153.1167 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 0, // Approx same as Bar
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'newport_canals',
        name: 'Newport Canals',
        coords: { lat: -27.2272, lon: 153.1128 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 15,
        timeOffsetHigh: 5,
        timeOffsetLow: 7,
        heightOffsetRatio: 0.95,
        z0: 0,
    },
    {
        id: 'shorncliffe',
        name: 'Shorncliffe',
        coords: { lat: -27.3233, lon: 153.0883 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 10,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'cabbage_tree_creek',
        name: 'Cabbage Tree Creek',
        coords: { lat: -27.3167, lon: 153.0833 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 5,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'pinkenba',
        name: 'Pinkenba (Brisbane River)',
        coords: { lat: -27.4167, lon: 153.1167 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 25, // Upriver delay
        heightOffsetRatio: 1.1, // Amplification upriver
        z0: 0,
    },
    {
        id: 'brisbane_port_office',
        name: 'Brisbane Port Office',
        coords: { lat: -27.4667, lon: 153.0333 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 50, // Significant river delay
        heightOffsetRatio: 1.15,
        z0: 0,
    },

    // --- MORETON BAY (Eastern Side / Islands) ---
    {
        id: 'tangalooma',
        name: 'Tangalooma (Moreton Is)',
        coords: { lat: -27.1667, lon: 153.3667 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: -15, // Ocean side influence
        heightOffsetRatio: 0.9,
        z0: 0,
    },
    {
        id: 'kooringal',
        name: 'Kooringal',
        coords: { lat: -27.3500, lon: 153.4000 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 10,
        heightOffsetRatio: 0.8,
        z0: 0,
    },
    {
        id: 'amity_point',
        name: 'Amity Point',
        coords: { lat: -27.4000, lon: 153.4333 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: -25, // Close to ocean entrance
        heightOffsetRatio: 0.8,
        z0: 0,
    },
    {
        id: 'dunwich',
        name: 'Dunwich',
        coords: { lat: -27.5000, lon: 153.4000 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 20,
        heightOffsetRatio: 0.9,
        z0: 0,
    },

    // --- SOUTHERN BAY ---
    {
        id: 'cleveland_point',
        name: 'Cleveland Point',
        coords: { lat: -27.5167, lon: 153.2833 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 20,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'victoria_point',
        name: 'Victoria Point',
        coords: { lat: -27.5833, lon: 153.3167 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 30,
        heightOffsetRatio: 0.95,
        z0: 0,
    },
    {
        id: 'macleay_island',
        name: 'Macleay Island (Potts Pt)',
        coords: { lat: -27.6000, lon: 153.3500 },
        referenceStationId: 'brisbane_bar',
        timeOffsetMinutes: 35,
        heightOffsetRatio: 0.9,
        z0: 0,
    },
    {
        id: 'russell_island',
        name: 'Russell Island (Canaipa)',
        coords: { lat: -27.6667, lon: 153.3833 },
        referenceStationId: 'gold_coast_seaway', // Switch reference? Or keep Bris? Usually Bris for Bay.
        timeOffsetMinutes: 60, // Deep in the narrows
        heightOffsetRatio: 0.8,
        z0: 0,
    },

    // --- GOLD COAST BROADWATER (Ref: Gold Coast Seaway) ---
    {
        id: 'coomera_river_entrance',
        name: 'Coomera River Ent',
        coords: { lat: -27.8500, lon: 153.3833 },
        referenceStationId: 'gold_coast_seaway',
        timeOffsetMinutes: 20,
        heightOffsetRatio: 1.0,
        z0: 0,
    },
    {
        id: 'sanctuary_cove',
        name: 'Sanctuary Cove',
        coords: { lat: -27.8500, lon: 153.3667 },
        referenceStationId: 'gold_coast_seaway',
        timeOffsetMinutes: 45, // Up river
        heightOffsetRatio: 0.9,
        z0: 0,
    },
    {
        id: 'surfers_paradise',
        name: 'Surfers Paradise',
        coords: { lat: -28.0000, lon: 153.4167 },
        referenceStationId: 'gold_coast_seaway',
        timeOffsetMinutes: 20,
        heightOffsetRatio: 0.8,
        z0: 0,
    }
];

export const ALL_STATIONS = [...LOCAL_TIDE_STATIONS, ...GLOBAL_TIDE_STATIONS];

/**
 * Returns the actual Lat/Lon we should fetch from.
 * If station has a referenceStationId, we resolve THAT station's coords.
 */
export const resolveTideFetchSource = (station: TideStation): { lat: number, lon: number } => {
    if (station.referenceStationId) {
        const refParams = ALL_STATIONS.find(s => s.id === station.referenceStationId);
        if (refParams) {

            return refParams.coords;
        }

    }
    return station.coords;
};

// --- 2. The Math (Haversine Formula) ---

const deg2rad = (deg: number): number => deg * (Math.PI / 180);

/**
 * Calculates distance between two coordinates in Kilometers
 */
const getDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Radius of Earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// --- 3. The Main Logic ---

export interface CoastalContext {
    mode: 'COASTAL';
    station: TideStation;
    distanceKm: number;
    isGeneric?: boolean;
}

export interface OffshoreContext {
    mode: 'OFFSHORE';
}

export type NavigationMode = CoastalContext | OffshoreContext;

/**
 * Determines if we are Coastal or Offshore and finds the relevant tide station.
 * GLOBAL STRATEGY: 
 * 1. Check if near a Known Station (< 50nm). If so, SNAP to it.
 * 2. If not, use Generic Coordinates (Global Fallback).
 */
export const getNavigationMode = (userLat: number, userLon: number): NavigationMode => {
    let nearestStation: TideStation | null = null;
    let minDistance = Infinity;

    // Find nearest neighbor in our DB
    for (const station of ALL_STATIONS) {
        const dist = getDistanceKm(userLat, userLon, station.coords.lat, station.coords.lon);
        if (dist < minDistance) {
            minDistance = dist;
            nearestStation = station;
        }
    }

    // RANGE CHECK: Are we within the 50nm limit of a KNOWN station?
    if (nearestStation && minDistance <= MAX_DISTANCE_COASTAL_KM) {
        return {
            mode: 'COASTAL',
            station: nearestStation,
            distanceKm: parseFloat(minDistance.toFixed(2)),
        };
    }

    // FALLBACK: Global "3rd World Backwater" Support
    // We don't have a station, but we still try to fetch tides at the user's location.
    // We treat it as a "Station" with 0 offset.
    return {
        mode: 'COASTAL',
        isGeneric: true,
        distanceKm: 0,
        station: {
            id: 'generic_gps',
            name: 'Local GPS Tide',
            coords: { lat: userLat, lon: userLon },
            timeOffsetMinutes: 0,
            heightOffsetRatio: 1.0
        }
    };
};

export const applyTideOffsets = (tides: Tide[], station: TideStation): Tide[] => {
    if (!tides) return [];

    return tides.map(t => {
        // Determine correct time offset (High vs Low vs Default)
        let minutes = station.timeOffsetMinutes;
        if (t.type === 'High' && station.timeOffsetHigh !== undefined) minutes = station.timeOffsetHigh;
        if (t.type === 'Low' && station.timeOffsetLow !== undefined) minutes = station.timeOffsetLow;

        const timeOffsetMs = minutes * 60 * 1000;

        const originalTime = new Date(t.time).getTime();
        const newTime = new Date(originalTime + timeOffsetMs).toISOString();

        // Formula: (Height * Ratio) + Z0 (if present)
        // FIX: Input 't.height' is in METERS (raw from StormGlass/WorldTides).
        // Station Z0 is in METERS. We apply offset in METERS.
        const z0Meters = station.z0 || 0;

        const adjustedHeight = (t.height * station.heightOffsetRatio) + z0Meters;

        return {
            ...t,
            time: newTime,
            height: parseFloat(adjustedHeight.toFixed(2))
        };
    });
};
