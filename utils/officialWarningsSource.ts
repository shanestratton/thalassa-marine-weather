/**
 * Where the official warnings are for a position, anywhere in the world.
 *
 * Thalassa's forecast alerts are its own model checks, never official
 * warnings, so the Forecast alerts page sends the skipper on to the official
 * issuer. It used to send everyone to the Bureau of Meteorology, a boat in the
 * Med included. Thalassa is a global app (Shane 2026-10-07), so the link now
 * follows the position (build 123, W1-02):
 *
 *   - national issuers where the app can name one: BOM, NWS, the Met Office,
 *     MeteoAlarm (the EUMETNET members), ECCC, MetService
 *   - everywhere else, the WMO: the Severe Weather Information Centre (every
 *     member's official warnings) on land and the coast, and WWMIWS (the
 *     METAREA high-seas warnings) offshore
 *   - offshore in MeteoAlarm's seas, WWMIWS too: MeteoAlarm has no
 *     high-seas product
 *
 * The national areas are deliberately conservative outlines: each stays clear
 * of its neighbours' waters and borders, so a doubtful position (a strait, a
 * border river, a neighbour's island) falls through to the WMO, which lists
 * every national service, rather than to the wrong country. Areas are
 * [lon, lat] rings, checked in order; the first that holds the point wins.
 *
 * Pure and dependency-free. It is imported only by the lazily loaded Warnings
 * page, so the outlines stay out of the main bundle.
 */

export type OfficialWarningsSourceId =
    | 'bom'
    | 'nws'
    | 'metoffice'
    | 'meteoalarm'
    | 'eccc'
    | 'metservice'
    | 'wmo-swic'
    | 'wmo-wwmiws';

export interface OfficialWarningsSource {
    id: OfficialWarningsSourceId;
    /** On the button: "Open {shortName} warnings". */
    shortName: string;
    /** Spoken after the button, and named in full where space allows. */
    name: string;
    /** Reads into "…so check {checkPhrase} too." */
    checkPhrase: string;
    /** The issuer's official public warnings page (verified 2026-10-07). */
    url: string;
}

export const OFFICIAL_WARNINGS_SOURCES: Record<OfficialWarningsSourceId, OfficialWarningsSource> = {
    bom: {
        id: 'bom',
        shortName: 'BoM',
        name: 'Bureau of Meteorology',
        checkPhrase: 'the Bureau of Meteorology’s warnings',
        // The 2025 site redirects every old state and marine warnings URL
        // here; it lists Marine Wind Warnings with its own state filter.
        url: 'https://www.bom.gov.au/weather-and-climate/warnings-and-alerts',
    },
    nws: {
        id: 'nws',
        shortName: 'NWS',
        name: 'National Weather Service',
        checkPhrase: 'the National Weather Service’s alerts',
        url: 'https://www.weather.gov/alerts',
    },
    metoffice: {
        id: 'metoffice',
        shortName: 'Met Office',
        name: 'Met Office shipping forecast and gale warnings',
        // The shipping forecast's sea areas cover UK and Irish waters.
        checkPhrase: 'the Met Office’s gale warnings',
        url: 'https://weather.metoffice.gov.uk/specialist-forecasts/coast-and-sea/shipping-forecast',
    },
    meteoalarm: {
        id: 'meteoalarm',
        shortName: 'MeteoAlarm',
        name: 'MeteoAlarm, the European national weather services',
        checkPhrase: 'the national warnings on MeteoAlarm',
        url: 'https://meteoalarm.org/en/live/',
    },
    eccc: {
        id: 'eccc',
        shortName: 'Environment Canada',
        name: 'Environment and Climate Change Canada marine forecasts and warnings',
        checkPhrase: 'Environment Canada’s marine warnings',
        url: 'https://weather.gc.ca/marine/index_e.html',
    },
    metservice: {
        id: 'metservice',
        shortName: 'MetService',
        name: 'MetService New Zealand marine warnings',
        checkPhrase: 'MetService’s marine warnings',
        url: 'https://www.metservice.com/warnings/marine',
    },
    'wmo-swic': {
        id: 'wmo-swic',
        shortName: 'WMO',
        name: 'WMO Severe Weather Information Centre',
        checkPhrase: 'your national weather service’s warnings (listed by the WMO)',
        url: 'https://severeweather.wmo.int/',
    },
    'wmo-wwmiws': {
        id: 'wmo-wwmiws',
        shortName: 'METAREA',
        name: 'WMO-IMO high-seas warnings by METAREA',
        checkPhrase: 'the official high-seas warnings for your METAREA',
        url: 'https://wwmiws.wmo.int/',
    },
};

type Ring = ReadonlyArray<readonly [number, number]>;

/** A [west, south, east, north] box as a ring. */
const box = (west: number, south: number, east: number, north: number): Ring => [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
];

interface Area {
    /** null: a carve-out that falls through to the WMO. */
    issuer: OfficialWarningsSourceId | null;
    /** For reading the table, and for failing tests. */
    label: string;
    ring: Ring;
}

// Australia and its waters, clear of Indonesia, Timor-Leste, PNG (the Torres
// Strait's northern islands included), the Solomons and New Caledonia.
const AUSTRALIA: Ring = [
    [108.0, -47.0],
    [108.0, -20.0],
    [114.0, -15.0],
    [121.0, -13.0],
    [122.5, -11.9],
    [126.5, -11.3],
    [129.0, -10.7],
    [131.5, -10.6],
    [134.5, -10.5],
    [137.5, -10.4],
    [141.0, -10.05],
    [142.9, -10.0],
    [144.0, -10.6],
    [147.0, -12.0],
    [150.5, -12.5],
    [153.0, -13.0],
    [156.0, -14.0],
    [157.0, -17.0],
    [157.0, -47.0],
];

// The contiguous US and its coastal and offshore waters: the Canadian border
// (the Great Lakes, St Lawrence, Maine) kept on the US side, clear of the
// Bahamas, Cuba, Mexico and Bermuda. Clockwise from the Pacific north-west.
const US_CONTIGUOUS: Ring = [
    [-131.0, 48.0],
    [-124.8, 48.45],
    [-124.0, 48.35],
    [-123.3, 48.25],
    [-123.12, 48.45],
    [-123.05, 48.68],
    [-122.85, 48.9],
    [-95.3, 48.9],
    [-94.6, 48.6],
    [-93.0, 48.45],
    [-91.0, 47.95],
    [-89.7, 47.85],
    [-89.35, 47.9],
    [-88.9, 48.2],
    [-88.3, 48.2],
    [-86.0, 47.4],
    [-84.9, 46.85],
    [-84.5, 46.45],
    [-83.5, 45.9],
    [-82.65, 45.3],
    [-82.55, 43.1],
    [-82.6, 42.6],
    [-82.95, 42.4],
    [-83.12, 42.25],
    [-83.17, 42.0],
    [-82.7, 41.65],
    [-81.25, 42.2],
    [-79.8, 42.45],
    [-78.94, 42.84],
    [-78.905, 42.95],
    [-79.04, 43.08],
    [-79.06, 43.27],
    [-77.0, 43.5],
    [-76.6, 43.9],
    [-76.5, 44.0],
    [-76.35, 44.09],
    [-76.08, 44.23],
    [-75.92, 44.33],
    [-75.65, 44.56],
    [-75.49, 44.68],
    [-75.0, 44.9],
    [-74.75, 44.95],
    [-71.5, 44.95],
    [-71.15, 45.25],
    [-70.85, 45.28],
    [-70.45, 45.7],
    [-70.25, 45.95],
    [-70.0, 46.35],
    [-69.3, 47.25],
    [-68.9, 47.12],
    [-68.35, 47.3],
    [-67.85, 46.98],
    [-67.85, 46.0],
    [-67.8, 45.7],
    [-67.5, 45.45],
    [-67.35, 45.15],
    [-67.15, 44.95],
    [-67.35, 44.2],
    [-67.8, 42.9],
    [-67.55, 42.5],
    [-65.8, 40.4],
    [-67.0, 37.0],
    [-70.0, 32.5],
    [-75.0, 29.0],
    [-77.5, 28.6],
    [-79.55, 27.0],
    [-79.6, 24.6],
    [-80.6, 24.3],
    [-82.0, 24.15],
    [-83.2, 24.3],
    [-85.5, 25.0],
    [-88.5, 25.6],
    [-93.0, 25.9],
    [-97.25, 26.0],
    [-98.5, 26.3],
    [-99.5, 27.6],
    [-100.3, 28.8],
    [-101.5, 29.9],
    [-103.0, 29.3],
    [-104.5, 30.0],
    [-106.6, 32.0],
    [-108.2, 31.45],
    [-111.0, 31.45],
    [-114.8, 32.6],
    [-117.0, 32.65],
    [-117.3, 32.6],
    [-118.5, 32.2],
    [-120.5, 31.5],
    [-125.0, 30.8],
    [-131.0, 31.0],
];

// Alaska east of the antimeridian: the Yukon and BC border kept on the
// Alaskan side, and the Russian convention line in the Bering and Chukchi
// seas.
const ALASKA: Ring = [
    [-141.3, 71.5],
    [-141.3, 60.2],
    [-139.2, 60.1],
    [-137.7, 59.1],
    [-136.6, 59.25],
    [-135.25, 59.5],
    [-134.9, 59.2],
    [-133.6, 58.35],
    [-132.2, 57.1],
    [-131.0, 56.3],
    [-130.3, 55.7],
    [-130.75, 54.8],
    [-132.7, 54.7],
    [-135.0, 54.6],
    [-140.0, 54.0],
    [-150.0, 53.5],
    [-160.0, 51.5],
    [-170.0, 50.5],
    [-180.0, 50.0],
    [-180.0, 59.0],
    [-175.5, 62.3],
    [-172.0, 64.2],
    [-168.85, 65.6],
    [-168.85, 72.0],
];

// Canada and its waters, clockwise from the Beaufort Sea: Greenland's and
// Alaska's borders and the whole US border kept on the Canadian side.
const CANADA: Ring = [
    [-140.7, 72.0],
    [-125.0, 77.5],
    [-90.0, 83.5],
    [-63.5, 83.0],
    [-63.0, 82.3],
    [-65.0, 81.6],
    [-67.5, 80.8],
    [-71.0, 79.5],
    [-74.2, 78.4],
    [-74.0, 76.0],
    [-67.0, 72.0],
    [-60.5, 68.5],
    [-58.0, 66.0],
    [-56.0, 62.0],
    [-53.0, 58.0],
    [-49.0, 54.0],
    [-47.5, 49.0],
    [-48.5, 44.5],
    [-52.0, 42.8],
    [-56.0, 42.0],
    [-61.0, 41.5],
    [-65.4, 40.8],
    [-67.2, 42.55],
    [-67.45, 42.95],
    [-67.0, 44.2],
    [-66.85, 44.6],
    [-66.88, 44.95],
    [-67.2, 45.25],
    [-67.65, 45.7],
    [-67.65, 47.1],
    [-68.2, 47.5],
    [-69.1, 47.6],
    [-69.9, 46.85],
    [-70.25, 46.25],
    [-70.5, 45.95],
    [-70.85, 45.5],
    [-71.1, 45.4],
    [-71.5, 45.15],
    [-74.7, 45.15],
    [-75.45, 44.78],
    [-75.95, 44.42],
    [-76.35, 44.25],
    [-76.6, 44.15],
    [-77.0, 43.75],
    [-79.0, 43.45],
    [-79.12, 43.28],
    [-79.09, 43.1],
    [-78.96, 42.9],
    [-79.0, 42.85],
    [-80.0, 42.5],
    [-81.5, 42.45],
    [-82.45, 41.74],
    [-82.8, 41.74],
    [-83.12, 42.1],
    [-83.1, 42.24],
    [-83.06, 42.31],
    [-83.0, 42.335],
    [-82.92, 42.35],
    [-82.6, 42.55],
    [-82.43, 42.9],
    [-82.415, 43.0],
    [-82.3, 43.3],
    [-82.35, 45.3],
    [-83.4, 46.0],
    [-83.95, 46.3],
    [-84.15, 46.55],
    [-84.6, 46.75],
    [-84.6, 47.05],
    [-86.4, 47.65],
    [-88.4, 48.45],
    [-89.4, 48.2],
    [-89.6, 48.12],
    [-90.8, 48.25],
    [-92.0, 48.5],
    [-93.4, 48.75],
    [-94.6, 48.85],
    [-95.15, 49.1],
    [-123.2, 49.1],
    [-123.35, 49.05],
    [-123.2, 48.82],
    [-123.3, 48.6],
    [-123.32, 48.33],
    [-124.0, 48.43],
    [-124.75, 48.52],
    [-127.0, 48.45],
    [-134.5, 48.5],
    [-134.5, 54.2],
    [-132.8, 54.45],
    [-130.8, 54.55],
    [-130.2, 54.8],
    [-130.0, 55.2],
    [-129.8, 56.0],
    [-131.0, 57.0],
    [-132.6, 58.4],
    [-133.2, 59.0],
    [-134.9, 59.8],
    [-137.0, 59.6],
    [-138.7, 60.35],
    [-140.7, 60.5],
];

// UK and Irish waters, the shipping forecast's sea areas: the North Sea and
// Channel median lines kept on the British side (Calais, Cherbourg, Ostend and
// the Dutch coast stay out), clear of the Faroes.
const UK_IRELAND: Ring = [
    [-16.0, 51.0],
    [-16.0, 58.0],
    [-12.0, 60.5],
    [-5.0, 61.0],
    [-0.5, 62.0],
    [1.0, 61.0],
    [1.8, 56.5],
    [2.5, 54.0],
    [2.9, 52.5],
    [2.5, 51.65],
    [1.9, 51.3],
    [1.4, 50.95],
    [0.5, 50.35],
    [-1.0, 50.1],
    [-3.0, 49.8],
    [-6.0, 49.2],
    [-12.0, 48.5],
];

// The MeteoAlarm members of mainland Europe and their seas, clockwise from the
// Atlantic off Portugal: clear of Russia, Belarus, Crimea, Türkiye (the
// Greek-Turkish line in the Aegean), North Africa and the Levant. The UK and
// Ireland are matched first, by their own outline.
const EUROPE: Ring = [
    [-12.0, 36.4],
    [-12.0, 48.0],
    [-6.0, 48.8],
    [-3.0, 49.6],
    [1.5, 50.9],
    [2.6, 51.6],
    [3.0, 54.5],
    [2.0, 57.0],
    [1.5, 61.0],
    [0.0, 62.5],
    [5.0, 66.0],
    [10.0, 70.0],
    [16.0, 71.5],
    [25.0, 71.5],
    [31.3, 70.6],
    [31.0, 70.1],
    [30.4, 69.8],
    [29.0, 69.0],
    [28.0, 68.5],
    [28.8, 66.0],
    [29.8, 64.0],
    [30.5, 62.5],
    [28.6, 61.1],
    [27.5, 60.5],
    [26.6, 60.0],
    [27.95, 59.47],
    [27.95, 59.0],
    [27.5, 58.3],
    [27.4, 57.5],
    [27.3, 56.2],
    [26.5, 55.7],
    [26.2, 55.25],
    [25.6, 54.6],
    [24.0, 53.95],
    [23.4, 53.5],
    [23.4, 52.2],
    [23.8, 51.6],
    [30.5, 51.3],
    [33.5, 51.5],
    [34.0, 46.3],
    [32.5, 46.0],
    [31.5, 45.2],
    [30.5, 44.0],
    [29.5, 43.0],
    [28.6, 42.05],
    [28.0, 42.03],
    [27.5, 42.1],
    [26.9, 42.05],
    [26.35, 41.85],
    [26.3, 41.5],
    [26.1, 41.0],
    [25.95, 40.75],
    [25.45, 40.15],
    [25.45, 39.75],
    [25.8, 39.35],
    [25.8, 38.0],
    [26.35, 37.5],
    [26.9, 37.15],
    [27.1, 36.95],
    [27.33, 36.93],
    [27.34, 36.75],
    [27.25, 36.62],
    [27.6, 36.5],
    [28.0, 36.45],
    [28.35, 36.4],
    [28.6, 35.8],
    [27.5, 35.2],
    [26.5, 34.6],
    [24.0, 34.5],
    [21.0, 35.5],
    [19.0, 37.0],
    [15.3, 35.5],
    [14.0, 35.6],
    [12.6, 36.6],
    [11.6, 37.6],
    [10.0, 38.3],
    [8.0, 38.3],
    [5.0, 37.9],
    [1.0, 37.4],
    [-1.0, 36.8],
    [-2.2, 36.6],
    [-4.5, 36.35],
    [-5.25, 36.05],
    [-5.6, 35.97],
    [-6.3, 36.0],
    [-7.5, 36.4],
];

const AREAS: readonly Area[] = [
    // Carve-outs first: inside a national outline, but not that issuer's.
    { issuer: null, label: 'Saint-Pierre and Miquelon (France)', ring: box(-56.5, 46.7, -56.05, 47.2) },
    { issuer: null, label: 'Gibraltar', ring: box(-5.37, 36.1, -5.33, 36.16) },
    { issuer: null, label: 'Kaliningrad (Russia)', ring: box(19.4, 54.3, 22.95, 55.35) },
    { issuer: null, label: 'Albania, south', ring: box(19.95, 39.6, 20.6, 40.4) },
    { issuer: null, label: 'Albania, centre', ring: box(19.0, 40.4, 20.6, 41.87) },
    { issuer: null, label: 'Albania, north', ring: box(19.35, 41.87, 20.6, 42.7) },
    // Korçë, Bilisht, Ersekë and Pogradec's Lake Ohrid shore lie east of
    // 20.6°E. The edge keeps west of Kastoria and Florina; the Prespa and
    // St Naum corner it takes in falls through to the WMO, as doubtful
    // border ground should.
    {
        issuer: null,
        label: 'Albania, south-east',
        ring: [
            [20.6, 40.1],
            [20.75, 40.1],
            [20.85, 40.35],
            [20.98, 40.5],
            [21.06, 40.62],
            [21.06, 40.95],
            [20.6, 40.95],
        ],
    },

    { issuer: 'bom', label: 'Australia', ring: AUSTRALIA },
    { issuer: 'bom', label: 'Christmas Island', ring: box(105.2, -11.0, 106.2, -10.0) },
    { issuer: 'bom', label: 'Cocos (Keeling) Islands', ring: box(96.5, -12.5, 97.2, -11.6) },
    { issuer: 'bom', label: 'Lord Howe Island', ring: box(158.5, -32.2, 160.0, -29.0) },
    { issuer: 'bom', label: 'Norfolk Island', ring: box(167.5, -29.5, 168.5, -28.6) },
    { issuer: 'bom', label: 'Macquarie Island', ring: box(158.0, -55.2, 159.5, -54.0) },

    { issuer: 'nws', label: 'Contiguous US', ring: US_CONTIGUOUS },
    { issuer: 'nws', label: 'Alaska', ring: ALASKA },
    { issuer: 'nws', label: 'Western Aleutians', ring: box(171.5, 50.5, 180.0, 54.5) },
    { issuer: 'nws', label: 'Hawaii', ring: box(-179.5, 16.5, -153.5, 29.0) },
    { issuer: 'nws', label: 'Puerto Rico', ring: box(-68.2, 17.6, -65.2, 18.7) },
    // Two boxes, so neither reaches the BVI: the north one stops west of the
    // Narrows (Great Thatch, Soper's Hole), the south one west of Flanagan
    // Island. St John's last half-mile east falls through to the WMO.
    { issuer: 'nws', label: 'St Thomas and St John', ring: box(-65.1, 18.25, -64.68, 18.36) },
    { issuer: 'nws', label: 'St Thomas and St John, north shore', ring: box(-65.1, 18.36, -64.75, 18.385) },
    { issuer: 'nws', label: 'St Croix', ring: box(-65.0, 17.6, -64.5, 17.85) },
    { issuer: 'nws', label: 'Guam and the Northern Marianas', ring: box(144.4, 13.0, 146.1, 20.6) },
    { issuer: 'nws', label: 'American Samoa', ring: box(-171.2, -14.6, -169.3, -14.1) },

    { issuer: 'metoffice', label: 'UK and Irish waters', ring: UK_IRELAND },
    { issuer: 'metoffice', label: 'Channel Islands', ring: box(-2.75, 49.15, -2.0, 49.75) },

    { issuer: 'meteoalarm', label: 'Europe', ring: EUROPE },
    // North of Mytilene the edge steps west of the Ayvalık islands (Büyük
    // Maden, Cunda): Türkiye has no MeteoAlarm feed.
    {
        issuer: 'meteoalarm',
        label: 'Lesbos',
        ring: [
            [25.83, 38.95],
            [26.62, 38.95],
            [26.62, 39.2],
            [26.53, 39.25],
            [26.48, 39.3],
            [26.48, 39.4],
            [25.83, 39.4],
        ],
    },
    { issuer: 'meteoalarm', label: 'Chios', ring: box(25.85, 38.15, 26.17, 38.6) },
    { issuer: 'meteoalarm', label: 'Samos', ring: box(26.55, 37.63, 27.05, 37.82) },
    { issuer: 'meteoalarm', label: 'Rhodes', ring: box(27.68, 35.85, 28.26, 36.47) },
    { issuer: 'meteoalarm', label: 'Cyprus', ring: box(32.2, 34.5, 34.65, 35.75) },
    { issuer: 'meteoalarm', label: 'Israel, north coast', ring: box(34.5, 32.5, 35.15, 33.08) },
    { issuer: 'meteoalarm', label: 'Israel, south coast', ring: box(34.0, 31.62, 35.0, 32.5) },
    // Stepped back from the African coast as it runs south-west past Cape
    // Juby, so Moroccan and Western Saharan waters stay out.
    { issuer: 'meteoalarm', label: 'Canary Islands, north of 28.5°N', ring: box(-18.3, 28.5, -13.35, 29.5) },
    { issuer: 'meteoalarm', label: 'Canary Islands, 28–28.5°N', ring: box(-18.3, 28.0, -13.6, 28.5) },
    { issuer: 'meteoalarm', label: 'Canary Islands, south of 28°N', ring: box(-18.3, 27.5, -14.3, 28.0) },
    { issuer: 'meteoalarm', label: 'Madeira', ring: box(-17.5, 32.3, -16.0, 33.2) },
    { issuer: 'meteoalarm', label: 'Azores', ring: box(-31.5, 36.8, -24.5, 40.0) },
    { issuer: 'meteoalarm', label: 'Iceland', ring: box(-25.0, 62.8, -12.5, 67.0) },

    { issuer: 'eccc', label: 'Canada', ring: CANADA },

    { issuer: 'metservice', label: 'New Zealand', ring: box(165.0, -48.5, 180.0, -33.8) },
    { issuer: 'metservice', label: 'Chatham Islands', ring: box(-177.2, -45.0, -175.6, -43.0) },
];

/** Ray casting on the lon/lat plane; no ring crosses the antimeridian. */
function inRing(lon: number, lat: number, ring: Ring): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Longitude into [-180, 180). */
const normaliseLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The official warnings issuer for a position. Offshore positions outside
 * every national area, and offshore positions in MeteoAlarm's seas, go to the
 * METAREA high-seas warnings (WWMIWS); every other position outside the
 * national areas, and a missing one, to the WMO's list of national services.
 *
 * `offshore` is the weather report's own judgement (locationType 'offshore':
 * more than 20 NM from land), so this needs no coastline of its own.
 */
export function officialWarningsSource(
    lat: number | null | undefined,
    lon: number | null | undefined,
    options: { offshore?: boolean } = {},
): OfficialWarningsSource {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return OFFICIAL_WARNINGS_SOURCES['wmo-swic'];
    }
    const x = normaliseLon(lon);
    const area = AREAS.find((a) => inRing(x, lat, a.ring));
    // MeteoAlarm maps land and coastal regions and has no high-seas product,
    // yet the European outline takes in open sea (Biscay, the western Med,
    // the Aegean, the North Sea, the Baltic). Offshore there, the official
    // gale warnings are the METAREA bulletins: METAREA I (the Met Office)
    // names its North Sea and Baltic sub-areas, II (Météo-France) covers
    // Biscay and Iberia, III (Greece) the Med and the Black Sea. The other
    // national issuers each warn for their own high seas, so they stay.
    if (area?.issuer === 'meteoalarm' && options.offshore) return OFFICIAL_WARNINGS_SOURCES['wmo-wwmiws'];
    if (area?.issuer) return OFFICIAL_WARNINGS_SOURCES[area.issuer];
    return OFFICIAL_WARNINGS_SOURCES[options.offshore ? 'wmo-wwmiws' : 'wmo-swic'];
}
