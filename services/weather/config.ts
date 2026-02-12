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
    // Wave Buoys (wave data only, no wind sensors)
    { id: 'MB_Cent', name: 'Moreton Bay Central', lat: -27.25, lon: 153.20, type: 'bom' },
    { id: 'Spitfire', name: 'Spitfire Channel', lat: -27.05, lon: 153.25, type: 'bom' },
    { id: 'Rous', name: 'Rous Channel', lat: -27.38, lon: 153.40, type: 'bom' },
    { id: 'Banana', name: 'Banana Bank', lat: -27.50, lon: 153.30, type: 'bom' },

    // BOM Automatic Weather Stations (AWS) - Full wind sensors + marine data
    { id: 'InnerBeacon', name: 'Inner Beacon (AWS)', lat: -27.28, lon: 153.17, type: 'bom-aws', bomStationId: '94590' },
    { id: 'HopeBanks', name: 'Hope Banks (AWS)', lat: -27.32, lon: 153.37, type: 'bom-aws', bomStationId: '99497' },
    { id: 'BananaAWS', name: 'Banana Bank (AWS)', lat: -27.50, lon: 153.30, type: 'bom-aws', bomStationId: '94591' },

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

    // --- IRELAND (Marine Institute ERDDAP) ---
    { id: 'M2', name: 'M2 Buoy (Galway)', lat: 53.48, lon: -5.43, type: 'marine-ie' },
    { id: 'M3', name: 'M3 Buoy (SW Ireland)', lat: 51.22, lon: -10.55, type: 'marine-ie' },
    { id: 'M4', name: 'M4 Buoy (Donegal)', lat: 55.00, lon: -10.00, type: 'marine-ie' },
    { id: 'M5', name: 'M5 Buoy (Belmullet)', lat: 54.23, lon: -10.15, type: 'marine-ie' },
    { id: 'M6', name: 'M6 Buoy (Porcupine)', lat: 53.07, lon: -15.93, type: 'marine-ie' },

    // --- ASIA / PACIFIC ---
    { id: '21001', name: 'Kuroshio (Japan)', lat: 28.1, lon: 134.3, type: 'other' },
    { id: '21004', name: 'East China Sea', lat: 29.5, lon: 126.5, type: 'other' },
    { id: '22101', name: 'Donghae (Korea)', lat: 37.5, lon: 130.0, type: 'other' },

    // --- HONG KONG OBSERVATORY ---
    { id: 'Waglan Island', name: 'Waglan Island (HKO)', lat: 22.18, lon: 114.30, type: 'hko' },
    { id: 'Cheung Chau', name: 'Cheung Chau (HKO)', lat: 22.20, lon: 114.03, type: 'hko' },
    { id: 'Kai Tak', name: 'Kai Tak (HKO)', lat: 22.31, lon: 114.21, type: 'hko' },
    { id: 'Tsing Yi', name: 'Tsing Yi (HKO)', lat: 22.34, lon: 114.11, type: 'hko' },

    { id: '23001', name: 'Phuket (Thailand)', lat: 7.8, lon: 98.3, type: 'other' },

    // --- SOUTH AMERICA ---
    { id: '31001', name: 'Santos (Brazil)', lat: -25.3, lon: -45.1, type: 'other' },
    { id: '32012', name: 'Chilean Coast (Humboldt)', lat: -20.5, lon: -72.0, type: 'other' },
    { id: '31201', name: 'Rio de Janeiro (Brazil)', lat: -22.9, lon: -42.0, type: 'other' },
    { id: '31301', name: 'Recife (Brazil)', lat: -8.1, lon: -34.5, type: 'other' },
    { id: '32001', name: 'Valparaíso (Chile)', lat: -33.0, lon: -71.8, type: 'other' },
    { id: '32101', name: 'Strait of Magellan', lat: -52.5, lon: -70.0, type: 'other' },
    { id: '31401', name: 'Montevideo (Uruguay)', lat: -34.9, lon: -56.0, type: 'other' },
    { id: '31501', name: 'Buenos Aires (Argentina)', lat: -35.5, lon: -56.5, type: 'other' },

    // --- NEW ZEALAND ---
    { id: 'NZ01', name: 'Auckland Harbour (NZ)', lat: -36.84, lon: 174.77, type: 'other' },
    { id: 'NZ02', name: 'Hauraki Gulf (NZ)', lat: -36.6, lon: 175.1, type: 'other' },
    { id: 'NZ03', name: 'Bay of Islands (NZ)', lat: -35.2, lon: 174.2, type: 'other' },
    { id: 'NZ04', name: 'Wellington Harbour (NZ)', lat: -41.3, lon: 174.8, type: 'other' },
    { id: 'NZ05', name: 'Cook Strait (NZ)', lat: -41.0, lon: 174.5, type: 'other' },
    { id: 'NZ06', name: 'Lyttelton (NZ)', lat: -43.6, lon: 172.7, type: 'other' },
    { id: 'NZ07', name: 'Milford Sound (NZ)', lat: -44.6, lon: 167.9, type: 'other' },
    { id: 'NZ08', name: 'Tauranga (NZ)', lat: -37.6, lon: 176.2, type: 'other' },

    // --- PACIFIC ISLANDS ---
    { id: 'FJ01', name: 'Suva (Fiji)', lat: -18.14, lon: 178.44, type: 'other' },
    { id: 'FJ02', name: 'Nadi (Fiji)', lat: -17.77, lon: 177.44, type: 'other' },
    { id: 'NC01', name: 'Nouméa (New Caledonia)', lat: -22.28, lon: 166.44, type: 'other' },
    { id: 'NC02', name: 'Loyalty Islands', lat: -20.7, lon: 167.2, type: 'other' },
    { id: 'PF01', name: 'Papeete (Tahiti)', lat: -17.53, lon: -149.57, type: 'other' },
    { id: 'WS01', name: 'Apia (Samoa)', lat: -13.83, lon: -171.76, type: 'other' },
    { id: 'TO01', name: 'Nukuʻalofa (Tonga)', lat: -21.14, lon: -175.2, type: 'other' },
    { id: 'VU01', name: 'Port Vila (Vanuatu)', lat: -17.74, lon: 168.32, type: 'other' },
    { id: 'PG01', name: 'Port Moresby (PNG)', lat: -9.5, lon: 147.1, type: 'other' },
    { id: 'GU01', name: 'Guam', lat: 13.44, lon: 144.79, type: 'noaa' },
    { id: 'MH01', name: 'Majuro (Marshall Is)', lat: 7.1, lon: 171.4, type: 'other' },

    // --- AUSTRALIA (West & North Coast) ---
    { id: 'Fremantle', name: 'Fremantle (WA)', lat: -32.06, lon: 115.74, type: 'bom' },
    { id: 'Rottnest', name: 'Rottnest Island (WA)', lat: -32.0, lon: 115.5, type: 'bom' },
    { id: 'Geraldton', name: 'Geraldton (WA)', lat: -28.77, lon: 114.62, type: 'bom' },
    { id: 'Exmouth', name: 'Exmouth (WA)', lat: -21.93, lon: 114.14, type: 'bom' },
    { id: 'Broome', name: 'Broome (WA)', lat: -18.0, lon: 122.2, type: 'bom' },
    { id: 'Darwin', name: 'Darwin (NT)', lat: -12.46, lon: 130.84, type: 'bom' },
    { id: 'Cairns', name: 'Cairns (QLD)', lat: -16.92, lon: 145.77, type: 'bom' },
    { id: 'Townsville', name: 'Townsville (QLD)', lat: -19.25, lon: 146.77, type: 'bom' },
    { id: 'Gladstone', name: 'Gladstone (QLD)', lat: -23.85, lon: 151.27, type: 'bom' },
    { id: 'Adelaide', name: 'Adelaide (SA)', lat: -34.93, lon: 138.60, type: 'bom' },
    { id: 'Portland', name: 'Portland (VIC)', lat: -38.34, lon: 141.60, type: 'bom' },
    { id: 'Hobart', name: 'Hobart (TAS)', lat: -42.88, lon: 147.33, type: 'bom' },

    // --- MEDITERRANEAN ---
    { id: 'GR01', name: 'Piraeus (Greece)', lat: 37.94, lon: 23.65, type: 'other' },
    { id: 'GR02', name: 'Crete (Heraklion)', lat: 35.34, lon: 25.13, type: 'other' },
    { id: 'GR03', name: 'Rhodes (Greece)', lat: 36.44, lon: 28.22, type: 'other' },
    { id: 'GR04', name: 'Santorini (Greece)', lat: 36.39, lon: 25.46, type: 'other' },
    { id: 'IT01', name: 'Genoa (Italy)', lat: 44.41, lon: 8.93, type: 'other' },
    { id: 'IT02', name: 'Naples (Italy)', lat: 40.84, lon: 14.25, type: 'other' },
    { id: 'IT03', name: 'Strait of Messina', lat: 38.19, lon: 15.56, type: 'other' },
    { id: 'IT04', name: 'Venice (Italy)', lat: 45.43, lon: 12.33, type: 'other' },
    { id: 'IT05', name: 'Sardinia (Cagliari)', lat: 39.21, lon: 9.11, type: 'other' },
    { id: 'ES01', name: 'Barcelona (Spain)', lat: 41.35, lon: 2.16, type: 'other' },
    { id: 'ES02', name: 'Strait of Gibraltar', lat: 36.0, lon: -5.6, type: 'other' },
    { id: 'ES03', name: 'Palma de Mallorca', lat: 39.56, lon: 2.63, type: 'other' },
    { id: 'ES04', name: 'Las Palmas (Canary)', lat: 28.15, lon: -15.41, type: 'other' },
    { id: 'HR01', name: 'Split (Croatia)', lat: 43.5, lon: 16.44, type: 'other' },
    { id: 'HR02', name: 'Dubrovnik (Croatia)', lat: 42.65, lon: 18.09, type: 'other' },
    { id: 'TR01', name: 'İstanbul Strait', lat: 41.01, lon: 29.0, type: 'other' },
    { id: 'TR02', name: 'İzmir (Turkey)', lat: 38.42, lon: 27.14, type: 'other' },
    { id: 'TR03', name: 'Antalya (Turkey)', lat: 36.84, lon: 30.63, type: 'other' },
    { id: 'MT01', name: 'Malta', lat: 35.9, lon: 14.5, type: 'other' },
    { id: 'CY01', name: 'Limassol (Cyprus)', lat: 34.67, lon: 33.04, type: 'other' },

    // --- SCANDINAVIA & NORTH SEA ---
    { id: 'NO01', name: 'Oslo Fjord (Norway)', lat: 59.9, lon: 10.7, type: 'other' },
    { id: 'NO02', name: 'Bergen (Norway)', lat: 60.4, lon: 5.32, type: 'other' },
    { id: 'NO03', name: 'Stavanger (Norway)', lat: 58.97, lon: 5.73, type: 'other' },
    { id: 'NO04', name: 'Tromsø (Norway)', lat: 69.65, lon: 18.96, type: 'other' },
    { id: 'NO05', name: 'Lofoten (Norway)', lat: 68.2, lon: 14.6, type: 'other' },
    { id: 'DK01', name: 'Copenhagen (Denmark)', lat: 55.68, lon: 12.57, type: 'other' },
    { id: 'DK02', name: 'Skagerrak (Denmark)', lat: 57.7, lon: 10.2, type: 'other' },
    { id: 'NL01', name: 'IJmuiden (Netherlands)', lat: 52.46, lon: 4.52, type: 'other' },
    { id: 'NL02', name: 'Texel (Netherlands)', lat: 53.0, lon: 4.7, type: 'other' },
    { id: 'DE01', name: 'Helgoland (Germany)', lat: 54.18, lon: 7.89, type: 'other' },
    { id: 'DE02', name: 'Kiel (Germany)', lat: 54.32, lon: 10.14, type: 'other' },
    { id: 'SE01', name: 'Gothenburg (Sweden)', lat: 57.7, lon: 11.97, type: 'other' },
    { id: 'FI01', name: 'Helsinki (Finland)', lat: 60.15, lon: 24.96, type: 'other' },
    { id: 'IS01', name: 'Reykjavik (Iceland)', lat: 64.15, lon: -21.95, type: 'other' },

    // --- SOUTHEAST ASIA ---
    { id: 'SG01', name: 'Singapore Strait', lat: 1.26, lon: 103.75, type: 'other' },
    { id: 'ID01', name: 'Bali Strait (Indonesia)', lat: -8.75, lon: 115.5, type: 'other' },
    { id: 'ID02', name: 'Jakarta (Indonesia)', lat: -6.1, lon: 106.85, type: 'other' },
    { id: 'ID03', name: 'Makassar Strait', lat: -2.0, lon: 117.5, type: 'other' },
    { id: 'PH01', name: 'Manila Bay (Philippines)', lat: 14.5, lon: 120.9, type: 'other' },
    { id: 'PH02', name: 'Cebu Strait (Philippines)', lat: 10.3, lon: 123.9, type: 'other' },
    { id: 'TW01', name: 'Kaohsiung (Taiwan)', lat: 22.6, lon: 120.28, type: 'other' },
    { id: 'TW02', name: 'Keelung (Taiwan)', lat: 25.13, lon: 121.74, type: 'other' },
    { id: 'VN01', name: 'Vũng Tàu (Vietnam)', lat: 10.35, lon: 107.07, type: 'other' },
    { id: 'MY01', name: 'Penang (Malaysia)', lat: 5.42, lon: 100.35, type: 'other' },
    { id: 'MY02', name: 'Langkawi (Malaysia)', lat: 6.38, lon: 99.73, type: 'other' },

    // --- MIDDLE EAST & INDIAN OCEAN ---
    { id: 'AE01', name: 'Dubai (UAE)', lat: 25.26, lon: 55.3, type: 'other' },
    { id: 'OM01', name: 'Muscat (Oman)', lat: 23.6, lon: 58.6, type: 'other' },
    { id: 'IN01', name: 'Mumbai (India)', lat: 18.94, lon: 72.84, type: 'other' },
    { id: 'IN02', name: 'Chennai (India)', lat: 13.08, lon: 80.29, type: 'other' },
    { id: 'IN03', name: 'Kochi (India)', lat: 9.97, lon: 76.27, type: 'other' },
    { id: 'LK01', name: 'Colombo (Sri Lanka)', lat: 6.93, lon: 79.85, type: 'other' },
    { id: 'MV01', name: 'Malé (Maldives)', lat: 4.17, lon: 73.51, type: 'other' },
    { id: 'MU01', name: 'Port Louis (Mauritius)', lat: -20.16, lon: 57.5, type: 'other' },
    { id: 'RE01', name: 'Réunion (France)', lat: -20.88, lon: 55.45, type: 'other' },

    // --- AFRICA ---
    { id: 'ZA01', name: 'Cape Town (SA)', lat: -33.9, lon: 18.42, type: 'other' },
    { id: 'ZA02', name: 'Durban (SA)', lat: -29.87, lon: 31.05, type: 'other' },
    { id: 'ZA03', name: 'Cape Agulhas (SA)', lat: -34.83, lon: 20.0, type: 'other' },
    { id: 'EG01', name: 'Suez Canal (Egypt)', lat: 30.0, lon: 32.55, type: 'other' },
    { id: 'EG02', name: 'Alexandria (Egypt)', lat: 31.2, lon: 29.92, type: 'other' },
    { id: 'KE01', name: 'Mombasa (Kenya)', lat: -4.04, lon: 39.67, type: 'other' },
    { id: 'SN01', name: 'Dakar (Senegal)', lat: 14.69, lon: -17.44, type: 'other' },
    { id: 'MG01', name: 'Antananarivo Approach (Madagascar)', lat: -15.75, lon: 46.3, type: 'other' },

    // --- CANADA ---
    { id: 'CA01', name: 'Halifax (NS)', lat: 44.65, lon: -63.57, type: 'other' },
    { id: 'CA02', name: 'St. John\'s (NL)', lat: 47.57, lon: -52.71, type: 'other' },
    { id: 'CA03', name: 'Vancouver (BC)', lat: 49.28, lon: -123.12, type: 'other' },
    { id: 'CA04', name: 'Victoria (BC)', lat: 48.43, lon: -123.37, type: 'other' },
    { id: 'CA05', name: 'Prince Rupert (BC)', lat: 54.31, lon: -130.32, type: 'other' },
    { id: 'CA06', name: 'Churchill (MB)', lat: 58.77, lon: -94.17, type: 'other' },

    // --- CARIBBEAN ---
    { id: 'JM01', name: 'Kingston (Jamaica)', lat: 17.97, lon: -76.79, type: 'other' },
    { id: 'TT01', name: 'Port of Spain (Trinidad)', lat: 10.65, lon: -61.5, type: 'other' },
    { id: 'BB01', name: 'Bridgetown (Barbados)', lat: 13.1, lon: -59.6, type: 'other' },
    { id: 'AG01', name: 'Antigua', lat: 17.12, lon: -61.85, type: 'other' },
    { id: 'VI01', name: 'St. Thomas (USVI)', lat: 18.34, lon: -64.93, type: 'noaa' },
    { id: 'PA01', name: 'Panama Canal (Colón)', lat: 9.36, lon: -79.9, type: 'other' },
    { id: 'CU01', name: 'Havana (Cuba)', lat: 23.14, lon: -82.36, type: 'other' },

    // --- GULF OF MEXICO ---
    { id: '42001', name: 'Gulf of Mexico Central', lat: 25.89, lon: -89.66, type: 'noaa' },
    { id: '42002', name: 'Gulf of Mexico West', lat: 25.79, lon: -93.67, type: 'noaa' },
    { id: '42003', name: 'Gulf of Mexico East', lat: 25.97, lon: -85.59, type: 'noaa' },
    { id: '42019', name: 'Freeport (TX)', lat: 27.91, lon: -95.35, type: 'noaa' },
    { id: '42035', name: 'Galveston (TX)', lat: 29.23, lon: -94.41, type: 'noaa' },
    { id: '42040', name: 'Luke Island (LA)', lat: 29.21, lon: -88.21, type: 'noaa' },
    { id: '42036', name: 'West Tampa (FL)', lat: 28.5, lon: -84.52, type: 'noaa' },

    // --- ALASKA ---
    { id: '46060', name: 'Kodiak Island (AK)', lat: 56.0, lon: -153.9, type: 'noaa' },
    { id: '46061', name: 'Adak (Aleutians)', lat: 51.87, lon: -176.62, type: 'noaa' },
    { id: '46072', name: 'Shumagin Islands (AK)', lat: 54.56, lon: -161.78, type: 'noaa' }
];
