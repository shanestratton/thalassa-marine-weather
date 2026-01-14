import { BuoyStation } from '../../types';

export const STATE_ABBREVIATIONS: Record<string, string> = {
    "New South Wales": "NSW", "Queensland": "QLD", "Victoria": "VIC", "Tasmania": "TAS",
    "Western Australia": "WA", "South Australia": "SA", "Northern Territory": "NT",
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
    "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
    "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"
};

// GLOBAL BUOY LIST (Curated for Major Maritime Approaches)
export const MAJOR_BUOYS: BuoyStation[] = [
    // --- AUSTRALIA (East Coast) ---
    { id: 'Moreton', name: 'Cape Moreton (QLD)', lat: -27.031, lon: 153.562, type: 'bom' },
    { id: 'Mooloolaba', name: 'Mooloolaba Wave (QLD)', lat: -26.66, lon: 153.18, type: 'bom' },
    { id: 'Stradbroke', name: 'North Stradbroke (QLD)', lat: -27.42, lon: 153.56, type: 'bom' },
    { id: 'GoldCoast', name: 'Gold Coast Seaway (QLD)', lat: -27.93, lon: 153.43, type: 'bom' },
    { id: 'DoubleIsland', name: 'Double Island Point', lat: -25.93, lon: 153.19, type: 'bom' },
    { id: 'Byron', name: 'Cape Byron (NSW)', lat: -28.63, lon: 153.64, type: 'bom' },
    { id: 'Coffs', name: 'Coffs Harbour (NSW)', lat: -30.30, lon: 153.16, type: 'bom' },
    { id: 'Sydney', name: 'Sydney Heads (NSW)', lat: -33.78, lon: 151.35, type: 'bom' },
    { id: 'Botany', name: 'Botany Bay (NSW)', lat: -34.02, lon: 151.24, type: 'bom' },
    { id: 'Eden', name: 'Eden Coastal (NSW)', lat: -37.07, lon: 150.00, type: 'bom' },
    { id: 'Lord', name: 'Lord Howe Island', lat: -31.55, lon: 159.08, type: 'bom' },

    // --- MORETON BAY LOCALS (Startup Options) ---
    { id: 'MB_Cent', name: 'Moreton Bay Central', lat: -27.25, lon: 153.20, type: 'bom' },
    { id: 'Spitfire', name: 'Spitfire Channel', lat: -27.05, lon: 153.25, type: 'bom' },
    { id: 'Rous', name: 'Rous Channel', lat: -27.38, lon: 153.40, type: 'bom' },
    { id: 'Banana', name: 'Banana Bank', lat: -27.50, lon: 153.30, type: 'bom' },

    // --- USA (West Coast) ---
    { id: '46237', name: 'San Francisco Bar (CA)', lat: 37.787, lon: -122.628, type: 'noaa' },
    { id: '46026', name: 'San Francisco (CA)', lat: 37.759, lon: -122.833, type: 'noaa' },
    { id: '46012', name: 'Half Moon Bay (CA)', lat: 37.36, lon: -122.88, type: 'noaa' },
    { id: '46042', name: 'Monterey Bay (CA)', lat: 36.75, lon: -122.42, type: 'noaa' },
    { id: '46011', name: 'Santa Maria (CA)', lat: 34.88, lon: -120.87, type: 'noaa' },
    { id: '46025', name: 'Santa Monica Basin (CA)', lat: 33.749, lon: -119.053, type: 'noaa' },
    { id: '46221', name: 'Santa Monica Bay (CA)', lat: 33.86, lon: -118.64, type: 'noaa' },
    { id: '46086', name: 'San Clemente Basin (CA)', lat: 32.49, lon: -118.03, type: 'noaa' },
    { id: '46232', name: 'Point Loma (SD)', lat: 32.53, lon: -117.43, type: 'noaa' },
    { id: '46050', name: 'Stonewall Bank (OR)', lat: 44.64, lon: -124.50, type: 'noaa' },
    { id: '46029', name: 'Columbia River Bar (OR)', lat: 46.12, lon: -124.51, type: 'noaa' },
    { id: '46041', name: 'Cape Elizabeth (WA)', lat: 47.34, lon: -124.73, type: 'noaa' },
    { id: '46087', name: 'Neah Bay (WA)', lat: 48.49, lon: -124.73, type: 'noaa' },
    { id: '46088', name: 'Juan de Fuca (WA)', lat: 48.33, lon: -123.17, type: 'noaa' },
    { id: '51001', name: 'Hawaii NW', lat: 23.4, lon: -162.2, type: 'noaa' },
    { id: '51003', name: 'Hawaii SW', lat: 19.1, lon: -160.7, type: 'noaa' },

    // --- USA (East Coast) ---
    { id: '44013', name: 'Boston Approach (MA)', lat: 42.346, lon: -70.651, type: 'noaa' },
    { id: '44097', name: 'Block Island (RI)', lat: 40.97, lon: -71.13, type: 'noaa' },
    { id: '44017', name: 'Montauk Point (NY)', lat: 40.693, lon: -72.049, type: 'noaa' },
    { id: '44025', name: 'Long Island Offshore', lat: 40.25, lon: -73.17, type: 'noaa' },
    { id: '44065', name: 'New York Harbor (NY)', lat: 40.37, lon: -73.70, type: 'noaa' },
    { id: '44009', name: 'Delaware Bay (DE)', lat: 38.46, lon: -74.70, type: 'noaa' },
    { id: '44091', name: 'Barnegat (NJ)', lat: 39.78, lon: -73.77, type: 'noaa' },
    { id: '41001', name: 'Cape Hatteras (NC)', lat: 34.68, lon: -72.64, type: 'noaa' },
    { id: '41002', name: 'South Hatteras (SC)', lat: 31.76, lon: -74.94, type: 'noaa' },
    { id: '41009', name: 'Canaveral (FL)', lat: 28.51, lon: -80.19, type: 'noaa' },
    { id: '41010', name: 'Canaveral East (FL)', lat: 28.88, lon: -78.49, type: 'noaa' },
    { id: '41046', name: 'Bahamas (East)', lat: 23.82, lon: -68.39, type: 'noaa' },
    { id: '41047', name: 'Bahamas (NE)', lat: 27.47, lon: -71.46, type: 'noaa' },
    { id: '41043', name: 'NE Puerto Rico', lat: 21.05, lon: -64.78, type: 'noaa' },

    // --- UK & EUROPE ---
    { id: '62001', name: 'Gascogne (Biscay)', lat: 45.2, lon: -5.00, type: 'other' },
    { id: '62103', name: 'Channel Lightship (UK)', lat: 49.9, lon: -2.9, type: 'other' },
    { id: '62304', name: 'Sandettie Light (Dover)', lat: 51.15, lon: 1.80, type: 'other' },
    { id: '62305', name: 'Greenwich Light (UK)', lat: 50.4, lon: 0.0, type: 'other' },
    { id: '62107', name: 'Seven Stones (Scilly)', lat: 50.1, lon: -6.1, type: 'other' },
    { id: '62029', name: 'K1 (Bay of Biscay)', lat: 48.7, lon: -12.4, type: 'other' },
    { id: '62081', name: 'K2 (Atlantic)', lat: 51.0, lon: -13.3, type: 'other' },
    { id: '64045', name: 'Brittany Buoy (FR)', lat: 47.8, lon: -4.5, type: 'other' },
    { id: '61001', name: 'Nice (France)', lat: 43.4, lon: 7.8, type: 'other' },
    { id: '61002', name: 'Lion (France)', lat: 42.1, lon: 4.7, type: 'other' },

    // --- ASIA / PACIFIC ---
    { id: '21001', name: 'Kuroshio (Japan)', lat: 28.1, lon: 134.3, type: 'other' },
    { id: '21004', name: 'East China Sea', lat: 29.5, lon: 126.5, type: 'other' },
    { id: '22101', name: 'Donghae (Korea)', lat: 37.5, lon: 130.0, type: 'other' },
    { id: 'HK1', name: 'Hong Kong (Waglan)', lat: 22.18, lon: 114.30, type: 'other' },
    { id: 'HK2', name: 'Lamma Channel', lat: 22.10, lon: 114.10, type: 'other' },
    { id: '23001', name: 'Phuket (Thailand)', lat: 7.8, lon: 98.3, type: 'other' },

    // --- SOUTH AMERICA ---
    { id: '31001', name: 'Santos (Brazil)', lat: -25.3, lon: -45.1, type: 'other' },
    { id: '32012', name: 'Chilean Coast (Humboldt)', lat: -20.5, lon: -72.0, type: 'other' }
];
