import { TideStation } from '../types';

// A selection of major global maritime hubs to ensure the app feels "Global" out of the box.
// Coordinates are generally the Port Entrance or Main Tide Gauge.
// Offsets are 0 by default (Standard Model) unless specifically tuned.

export const GLOBAL_TIDE_STATIONS: TideStation[] = [
    // --- AUSTRALIA (Major) ---
    { id: 'sydney_heads', name: 'Sydney Heads (Port Jackson)', coords: { lat: -33.829, lon: 151.269 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 0.92 },
    { id: 'melbourne_heads', name: 'Port Phillip Heads', coords: { lat: -38.293, lon: 144.613 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 0.58 },
    { id: 'darwin', name: 'Darwin', coords: { lat: -12.463, lon: 130.844 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 4.14 },
    { id: 'fremantle', name: 'Fremantle (Perth)', coords: { lat: -32.055, lon: 115.741 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 0.53 },
    { id: 'cairns', name: 'Cairns', coords: { lat: -16.918, lon: 145.782 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 1.64 },
    { id: 'townsville', name: 'Townsville', coords: { lat: -19.259, lon: 146.816 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 1.55 },
    { id: 'hobart', name: 'Hobart', coords: { lat: -42.882, lon: 147.327 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0, z0: 0.82 },

    // --- NEW ZEALAND ---
    { id: 'auckland', name: 'Auckland (Waitemata)', coords: { lat: -36.848, lon: 174.763 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'wellington', name: 'Wellington', coords: { lat: -41.286, lon: 174.776 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'christchurch', name: 'Lyttelton (Christchurch)', coords: { lat: -43.602, lon: 172.718 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },

    // --- USA (West Coast) ---
    { id: 'san_diego', name: 'San Diego', coords: { lat: 32.715, lon: -117.162 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'los_angeles', name: 'Los Angeles (Long Beach)', coords: { lat: 33.728, lon: -118.261 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'san_francisco', name: 'San Francisco (Golden Gate)', coords: { lat: 37.808, lon: -122.474 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'seattle', name: 'Seattle', coords: { lat: 47.603, lon: -122.339 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'honolulu', name: 'Honolulu', coords: { lat: 21.304, lon: -157.874 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },

    // --- USA (East Coast) ---
    { id: 'miami', name: 'Miami (Government Cut)', coords: { lat: 25.760, lon: -80.129 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'new_york', name: 'The Battery (NY)', coords: { lat: 40.700, lon: -74.014 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'boston', name: 'Boston', coords: { lat: 42.355, lon: -71.053 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'charleston', name: 'Charleston', coords: { lat: 32.776, lon: -79.931 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'norfolk', name: 'Norfolk (Chesapeake)', coords: { lat: 36.946, lon: -76.329 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },

    // --- UK & EUROPE ---
    { id: 'london', name: 'London Bridge (Thames)', coords: { lat: 51.507, lon: -0.087 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'dover', name: 'Dover', coords: { lat: 51.116, lon: 1.325 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'southampton', name: 'Southampton', coords: { lat: 50.897, lon: -1.398 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'le_havre', name: 'Le Havre', coords: { lat: 49.494, lon: 0.107 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'gibraltar', name: 'Gibraltar', coords: { lat: 36.140, lon: -5.353 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'rotterdam', name: 'Rotterdam', coords: { lat: 51.922, lon: 4.479 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'lisbon', name: 'Lisbon', coords: { lat: 38.707, lon: -9.143 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },

    // --- ASIA ---
    { id: 'singapore', name: 'Singapore (Tanjong Pagar)', coords: { lat: 1.264, lon: 103.850 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'hong_kong', name: 'Hong Kong', coords: { lat: 22.293, lon: 114.168 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'tokyo', name: 'Tokyo', coords: { lat: 35.619, lon: 139.778 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'shanghai', name: 'Shanghai', coords: { lat: 31.230, lon: 121.473 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'dubai', name: 'Dubai', coords: { lat: 25.269, lon: 55.305 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },

    // --- CARIBBEAN / OTHER ---
    { id: 'nassau', name: 'Nassau', coords: { lat: 25.078, lon: -77.339 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'panama_balboa', name: 'Panama (Balboa)', coords: { lat: 8.950, lon: -79.566 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'capetown', name: 'Cape Town', coords: { lat: -33.906, lon: 18.423 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 },
    { id: 'rio', name: 'Rio de Janeiro', coords: { lat: -22.896, lon: -43.183 }, timeOffsetMinutes: 0, heightOffsetRatio: 1.0 }
];
