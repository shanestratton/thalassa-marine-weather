/**
 * Thalassa's own forecast checks stop posing as official warnings
 * (build 123, W1-02; gap register must-do #4).
 *
 *  - one classifier decides which forecast alerts are critical (never
 *    dismissable), for the new 'Forecast: …' texts AND the legacy
 *    'GALE WARNING: …' strings still sitting in cached reports
 *  - the onward link goes to the official warnings issuer for the boat's
 *    position, anywhere in the world: a boat in the Med is never sent to BOM
 */
import { describe, expect, it } from 'vitest';
import {
    FORECAST_ALERT_RULES,
    LEGACY_CRITICAL_PATTERNS,
    forecastAlertRule,
    isCriticalForecastAlert,
} from '../utils/forecastAlerts';
import { OFFICIAL_WARNINGS_SOURCES, officialWarningsSource } from '../utils/officialWarningsSource';

describe('isCriticalForecastAlert', () => {
    it('keeps every legacy critical string critical, so cached reports stay non-dismissable', () => {
        for (const legacy of [
            'STORM WARNING: Winds exceeding 48kts',
            'GALE WARNING: Winds exceeding 34kts',
            'DANGEROUS SEAS: Waves exceeding 15ft',
            'DENSE FOG ADVISORY: Visibility < 1nm',
            'EXCESSIVE HEAT WARNING: Extreme Danger',
            'FREEZING SPRAY WARNING: Icing risk',
            'FREEZE WARNING: Hypothermia risk',
            'STORM WATCH: Thunderstorm forecast for Tue',
            'GALE WATCH: High winds (36kts) forecast for Wed',
            'Gale warning for coastal waters',
        ]) {
            expect(isCriticalForecastAlert(legacy), legacy).toBe(true);
        }
    });

    it('keeps every legacy dismissable string dismissable', () => {
        for (const legacy of [
            'Small Craft Advisory: Winds > 22kts',
            'Hazardous Seas Advisory: Waves > 8ft',
            'Low Visibility: < 3nm',
            'Severe Thunderstorm Potential',
            'Heavy Rainfall: Visibility Reduced',
            'HEAT ADVISORY: Dangerous temperatures expected',
            'Heat Caution: Prolonged sun exposure risky',
            'HIGH UV ALERT: Protection Required',
            'THRESHOLD ALERT: Sustained wind reaching 25.0kts in next 24h',
            'THRESHOLD ALERT: Seas building to 6.0ft in next 24h',
        ]) {
            expect(isCriticalForecastAlert(legacy), legacy).toBe(false);
        }
    });

    it('marks the new critical texts critical', () => {
        for (const text of [
            'Forecast: storm-force wind, 48 kt+',
            'Forecast: storm-force gusts, 60 kt+',
            'Forecast: gale-force wind, 34 kt+',
            'Forecast: gale-force gusts, 45 kt+',
            'Forecast: gale-force wind on Wed, 36 kt',
            'Forecast: dangerous seas, 15 ft+ (4.6 m)',
            'Forecast: dense fog, visibility under 1 nm',
            'Forecast: storm risk on Tue (Thunderstorm)',
            'Forecast: extreme heat, 38 °C+ (100 °F)',
            'Forecast: freezing spray, air below 0 °C (32 °F)',
            'Forecast: near-freezing air, below 4 °C (39 °F)',
        ]) {
            expect(isCriticalForecastAlert(text), text).toBe(true);
        }
    });

    it('leaves the new caution texts dismissable', () => {
        for (const text of [
            'Forecast: strong wind, 22 kt+',
            'Forecast: strong gusts, 30 kt+',
            'Forecast: rough seas, 8 ft+ (2.4 m)',
            'Forecast: poor visibility, under 3 nm',
            'Forecast: thunderstorms possible',
            'Forecast: heavy rain, visibility reduced',
            'Forecast: high heat, 33 °C+ (91 °F)',
            'Forecast: heat, 29 °C+ (84 °F), limit sun exposure',
            'Forecast: very high UV, protection needed',
        ]) {
            expect(isCriticalForecastAlert(text), text).toBe(false);
        }
    });

    it('has one rule table: every rule starts "Forecast:" and no rule wears an official product name', () => {
        const rules = Object.values(FORECAST_ALERT_RULES);
        expect(rules.length).toBeGreaterThan(10);
        for (const rule of rules) {
            expect(rule.stem.startsWith('Forecast: ')).toBe(true);
            expect(rule.stem).not.toMatch(/\b(warning|watch|advisory)\b/i);
            expect(isCriticalForecastAlert(`${rule.stem}, anything`)).toBe(rule.critical);
        }
        // The legacy patterns are the exact nine the three components carried.
        expect([...LEGACY_CRITICAL_PATTERNS].sort()).toEqual(
            [
                'STORM WARNING',
                'GALE WARNING',
                'DANGEROUS SEAS',
                'FREEZING SPRAY',
                'FREEZE WARNING',
                'EXCESSIVE HEAT',
                'DENSE FOG',
                'STORM WATCH',
                'GALE WATCH',
            ].sort(),
        );
    });

    it('finds the rule each text came from (what it reads), and none for a legacy text', () => {
        for (const rule of Object.values(FORECAST_ALERT_RULES)) {
            expect(forecastAlertRule(`${rule.stem} anything`)).toBe(rule);
        }
        expect(forecastAlertRule('Forecast: rough seas, 8 ft+ (2.4 m)')?.reads).toBe('sea');
        expect(forecastAlertRule('Forecast: storm-force gusts, 60 kt+')?.reads).toBe('wind');
        expect(forecastAlertRule('Forecast: storm risk on Tue (Thunderstorm)')?.reads).toBe('weather');
        expect(forecastAlertRule('GALE WARNING: Winds exceeding 34kts')).toBeUndefined();
    });
});

describe('officialWarningsSource — the right official issuer, worldwide', () => {
    const at = (lat: number, lon: number, offshore = false) => officialWarningsSource(lat, lon, { offshore }).id;

    it('resolves the eight reference positions', () => {
        expect(at(-23.85, 151.25)).toBe('bom'); // Gladstone, QLD
        expect(at(25.77, -80.19)).toBe('nws'); // Miami
        expect(at(50.78, -1.25)).toBe('metoffice'); // the Solent
        expect(at(43.3, 5.37)).toBe('meteoalarm'); // Marseille
        expect(at(44.65, -63.57)).toBe('eccc'); // Halifax
        expect(at(-36.85, 174.76)).toBe('metservice'); // Auckland
        expect(at(30, -40, true)).toBe('wmo-wwmiws'); // mid-Atlantic, offshore
        expect(at(-17.75, 177.45)).toBe('wmo-swic'); // Fiji (Nadi)
    });

    it('never sends a boat in the Mediterranean to BOM', () => {
        for (let lat = 31; lat <= 45; lat += 0.5) {
            for (let lon = -5; lon <= 36; lon += 0.5) {
                for (const offshore of [false, true]) {
                    expect(at(lat, lon, offshore), `${lat},${lon}`).not.toBe('bom');
                }
            }
        }
    });

    it('sends BOM only Australian waters, not its neighbours', () => {
        expect(at(-27.47, 153.03)).toBe('bom'); // Brisbane
        expect(at(-12.46, 130.84)).toBe('bom'); // Darwin
        expect(at(-10.58, 142.22)).toBe('bom'); // Thursday Island
        expect(at(-42.88, 147.33)).toBe('bom'); // Hobart
        expect(at(-31.95, 115.86)).toBe('bom'); // Perth
        expect(at(-12.25, 123.0)).toBe('bom'); // Ashmore Reef
        expect(at(-31.55, 159.08)).toBe('bom'); // Lord Howe Island
        expect(at(-29.03, 167.95)).toBe('bom'); // Norfolk Island
        expect(at(-10.49, 105.63)).toBe('bom'); // Christmas Island
        expect(at(-9.47, 147.15)).not.toBe('bom'); // Port Moresby, PNG
        expect(at(-9.07, 143.2)).not.toBe('bom'); // Daru, PNG
        expect(at(-8.65, 115.2)).not.toBe('bom'); // Bali
        expect(at(-10.18, 123.6)).not.toBe('bom'); // Kupang, Timor
        expect(at(-8.55, 125.57)).not.toBe('bom'); // Dili
        expect(at(-22.27, 166.45)).not.toBe('bom'); // Noumea
        expect(at(-19.2, 158.6)).not.toBe('bom'); // Chesterfield Islands (New Caledonia)
        expect(at(-11.4, 154.1)).not.toBe('bom'); // Rossel Island, PNG
    });

    it('keeps NWS to US waters: Bahamas, Cuba, Mexico, Canada and Bermuda are not NWS', () => {
        expect(at(24.55, -81.8)).toBe('nws'); // Key West
        expect(at(29.95, -90.07)).toBe('nws'); // New Orleans
        expect(at(32.72, -117.16)).toBe('nws'); // San Diego
        expect(at(47.6, -122.33)).toBe('nws'); // Seattle
        expect(at(48.37, -124.62)).toBe('nws'); // Neah Bay
        expect(at(41.88, -87.63)).toBe('nws'); // Chicago
        expect(at(42.33, -83.045)).toBe('nws'); // Detroit
        expect(at(42.89, -78.88)).toBe('nws'); // Buffalo
        expect(at(42.36, -71.05)).toBe('nws'); // Boston
        expect(at(61.22, -149.9)).toBe('nws'); // Anchorage
        expect(at(58.3, -134.42)).toBe('nws'); // Juneau
        expect(at(53.89, -166.54)).toBe('nws'); // Dutch Harbor
        expect(at(52.9, 172.9)).toBe('nws'); // Attu, west of the antimeridian
        expect(at(21.31, -157.86)).toBe('nws'); // Honolulu
        expect(at(18.47, -66.11)).toBe('nws'); // San Juan, Puerto Rico
        expect(at(18.34, -64.93)).toBe('nws'); // Charlotte Amalie, USVI
        expect(at(13.44, 144.79)).toBe('nws'); // Guam
        expect(at(-14.28, -170.7)).toBe('nws'); // Pago Pago, American Samoa

        expect(at(25.06, -77.35)).not.toBe('nws'); // Nassau
        expect(at(25.73, -79.28)).not.toBe('nws'); // Bimini
        expect(at(26.69, -78.98)).not.toBe('nws'); // West End, Grand Bahama
        expect(at(23.14, -82.36)).not.toBe('nws'); // Havana
        expect(at(32.52, -117.04)).not.toBe('nws'); // Tijuana
        expect(at(25.87, -97.5)).not.toBe('nws'); // Matamoros
        expect(at(32.3, -64.78)).not.toBe('nws'); // Bermuda
        expect(at(48.42, -123.37)).not.toBe('nws'); // Victoria, BC
        expect(at(42.3, -83.03)).not.toBe('nws'); // Windsor, ON
        expect(at(43.65, -79.38)).not.toBe('nws'); // Toronto
        expect(at(48.38, -89.25)).not.toBe('nws'); // Thunder Bay
        expect(at(54.32, -130.32)).not.toBe('nws'); // Prince Rupert
        expect(at(60.72, -135.05)).not.toBe('nws'); // Whitehorse
        expect(at(18.43, -64.62)).not.toBe('nws'); // Road Town, BVI
        expect(at(13.83, -171.76)).not.toBe('nws'); // Apia, Samoa
        expect(at(64.42, -173.2)).not.toBe('nws'); // Provideniya, Russia
    });

    it('splits Canada from the US and France', () => {
        expect(at(49.28, -123.12)).toBe('eccc'); // Vancouver
        expect(at(48.42, -123.37)).toBe('eccc'); // Victoria
        expect(at(54.32, -130.32)).toBe('eccc'); // Prince Rupert
        expect(at(43.65, -79.38)).toBe('eccc'); // Toronto
        expect(at(48.38, -89.25)).toBe('eccc'); // Thunder Bay
        expect(at(47.56, -52.71)).toBe('eccc'); // St John's
        expect(at(46.81, -71.21)).toBe('eccc'); // Quebec City
        expect(at(44.23, -76.48)).toBe('eccc'); // Kingston
        expect(at(42.315, -83.036)).toBe('eccc'); // Windsor riverfront
        expect(at(46.78, -56.17)).not.toBe('eccc'); // Saint-Pierre (France)
        expect(at(64.18, -51.72)).not.toBe('eccc'); // Nuuk, Greenland
    });

    it('splits the UK from France and the Low Countries, and Europe from its non-member neighbours', () => {
        expect(at(51.13, 1.31)).toBe('metoffice'); // Dover
        expect(at(53.35, -6.26)).toBe('metoffice'); // Dublin (UK/IE sea areas)
        expect(at(60.15, -1.14)).toBe('metoffice'); // Lerwick
        expect(at(49.92, -6.3)).toBe('metoffice'); // Isles of Scilly
        expect(at(49.19, -2.11)).toBe('metoffice'); // St Helier, Jersey
        expect(at(50.95, 1.85)).toBe('meteoalarm'); // Calais
        expect(at(49.64, -1.62)).toBe('meteoalarm'); // Cherbourg
        expect(at(51.23, 2.92)).toBe('meteoalarm'); // Ostend
        expect(at(52.95, 4.75)).toBe('meteoalarm'); // Den Helder
        expect(at(60.39, 5.32)).toBe('meteoalarm'); // Bergen
        expect(at(69.73, 30.05)).toBe('meteoalarm'); // Kirkenes
        expect(at(37.94, 23.64)).toBe('meteoalarm'); // Piraeus
        expect(at(36.44, 28.22)).toBe('meteoalarm'); // Rhodes
        expect(at(36.89, 27.29)).toBe('meteoalarm'); // Kos
        expect(at(39.1, 26.56)).toBe('meteoalarm'); // Mytilene, Lesbos
        expect(at(35.9, 14.51)).toBe('meteoalarm'); // Valletta
        expect(at(39.57, 2.65)).toBe('meteoalarm'); // Palma
        expect(at(36.01, -5.6)).toBe('meteoalarm'); // Tarifa
        expect(at(28.1, -15.42)).toBe('meteoalarm'); // Las Palmas
        expect(at(37.74, -25.67)).toBe('meteoalarm'); // Ponta Delgada, Azores
        expect(at(64.15, -21.94)).toBe('meteoalarm'); // Reykjavik
        expect(at(34.92, 33.63)).toBe('meteoalarm'); // Larnaca
        expect(at(32.8, 34.99)).toBe('meteoalarm'); // Haifa
        expect(at(43.2, 27.91)).toBe('meteoalarm'); // Varna
        expect(at(46.48, 30.72)).toBe('meteoalarm'); // Odesa
        expect(at(42.64, 18.11)).toBe('meteoalarm'); // Dubrovnik
        expect(at(41.92, 19.2)).toBe('meteoalarm'); // Ulcinj, Montenegro

        expect(at(37.03, 27.43)).not.toBe('meteoalarm'); // Bodrum, Türkiye
        expect(at(36.2, 29.64)).not.toBe('meteoalarm'); // Kaş, Türkiye
        expect(at(41.0, 28.98)).not.toBe('meteoalarm'); // Istanbul
        expect(at(36.81, 10.18)).not.toBe('meteoalarm'); // Tunis
        expect(at(36.77, 3.06)).not.toBe('meteoalarm'); // Algiers
        expect(at(35.78, -5.8)).not.toBe('meteoalarm'); // Tangier
        expect(at(32.9, 13.18)).not.toBe('meteoalarm'); // Tripoli
        expect(at(31.2, 29.92)).not.toBe('meteoalarm'); // Alexandria
        expect(at(33.89, 35.5)).not.toBe('meteoalarm'); // Beirut
        expect(at(44.95, 34.1)).not.toBe('meteoalarm'); // Simferopol, Crimea
        expect(at(54.71, 20.51)).not.toBe('meteoalarm'); // Kaliningrad
        expect(at(59.93, 30.36)).not.toBe('meteoalarm'); // St Petersburg
        expect(at(53.9, 27.56)).not.toBe('meteoalarm'); // Minsk
        expect(at(40.47, 19.49)).not.toBe('meteoalarm'); // Vlorë, Albania
        expect(at(39.87, 20.0)).not.toBe('meteoalarm'); // Sarandë, Albania
        expect(at(62.01, -6.77)).not.toBe('meteoalarm'); // Tórshavn, Faroe
        expect(at(36.14, -5.35)).not.toBe('meteoalarm'); // Gibraltar
        expect(at(35.89, -5.32)).not.toBe('meteoalarm'); // Ceuta
    });

    it('splits New Zealand from its neighbours', () => {
        expect(at(-41.29, 174.78)).toBe('metservice'); // Wellington
        expect(at(-45.88, 170.5)).toBe('metservice'); // Dunedin
        expect(at(-43.95, -176.56)).toBe('metservice'); // Chatham Islands
        expect(at(-29.03, 167.95)).not.toBe('metservice'); // Norfolk Island
        expect(at(-21.14, -175.2)).not.toBe('metservice'); // Nuku'alofa, Tonga
    });

    it('falls back to WMO: SWIC on land and coast, WWMIWS offshore', () => {
        expect(at(-17.75, 177.45, true)).toBe('wmo-wwmiws'); // offshore near Fiji
        expect(at(30, -40)).toBe('wmo-swic'); // no offshore hint: the coast service
        expect(at(-33.92, 18.42)).toBe('wmo-swic'); // Cape Town
        expect(at(35.68, 139.77)).toBe('wmo-swic'); // Tokyo
        expect(at(-23.0, -43.2)).toBe('wmo-swic'); // Rio de Janeiro
        expect(at(1.29, 103.85)).toBe('wmo-swic'); // Singapore
        expect(at(-17.53, -149.57, true)).toBe('wmo-wwmiws'); // offshore Tahiti
        // Offshore inside a national area still goes to that issuer, which
        // warns for its own high seas (MeteoAlarm aside: see below).
        expect(at(-24.5, 154.5, true)).toBe('bom');
        expect(at(40.0, -69.0, true)).toBe('nws');
        expect(at(49.5, -9.0, true)).toBe('metoffice'); // sea area Sole
        expect(at(44.0, -60.0, true)).toBe('eccc'); // Sable Island Bank
        expect(at(-40.0, 177.0, true)).toBe('metservice');
    });

    it('sends an offshore boat in MeteoAlarm’s seas to its METAREA warnings: MeteoAlarm has no high-seas product', () => {
        expect(at(46, -8, true)).toBe('wmo-wwmiws'); // Biscay (METAREA II)
        expect(at(40, 12, true)).toBe('wmo-wwmiws'); // mid-Tyrrhenian (III)
        expect(at(39, 5, true)).toBe('wmo-wwmiws'); // between the Balearics and Sardinia
        expect(at(39.5, 5.5, true)).toBe('wmo-wwmiws');
        expect(at(38.5, 19.0, true)).toBe('wmo-wwmiws'); // the Ionian
        expect(at(43.5, 29.3, true)).toBe('wmo-wwmiws'); // western Black Sea (III)
        expect(at(55.0, 6.0, true)).toBe('wmo-wwmiws'); // German Bight (I names the North Sea)
        expect(at(56.5, 19.0, true)).toBe('wmo-wwmiws'); // central Baltic (I names the Baltic)
        expect(at(29.3, -15.5, true)).toBe('wmo-wwmiws'); // between Tenerife and Lanzarote
        // On land and the coast MeteoAlarm stays.
        expect(at(43.3, 5.37)).toBe('meteoalarm'); // Marseille
        expect(at(46.16, -1.15)).toBe('meteoalarm'); // La Rochelle
        expect(at(39.57, 2.65)).toBe('meteoalarm'); // Palma
        expect(at(54.18, 7.89)).toBe('meteoalarm'); // Heligoland
    });

    it('keeps carve-in boxes off the neighbours’ islands and waters', () => {
        // Lesbos: Mytilene and Molyvos are Greek; the Ayvalık islands are Turkish.
        expect(at(39.1, 26.56)).toBe('meteoalarm'); // Mytilene
        expect(at(39.37, 26.17)).toBe('meteoalarm'); // Molyvos
        expect(at(39.383, 26.583)).not.toBe('meteoalarm'); // Büyük Maden Island, Türkiye
        expect(at(39.335, 26.615)).not.toBe('meteoalarm'); // Cunda (Alibey) west shore, Türkiye
        // St Thomas and St John, not the BVI next door.
        expect(at(18.33, -64.79)).toBe('nws'); // Cruz Bay, St John
        expect(at(18.355, -64.76)).toBe('nws'); // Cinnamon Bay, St John
        expect(at(18.345, -64.71)).toBe('nws'); // Coral Bay, St John
        expect(at(18.384, -64.7)).not.toBe('nws'); // Soper's Hole, Tortola, BVI
        expect(at(18.381, -64.695)).not.toBe('nws'); // Frenchman's Cay, BVI
        expect(at(18.32, -64.665)).not.toBe('nws'); // Flanagan Island, BVI
        // The Canaries, not Moroccan or Western Saharan waters.
        expect(at(28.96, -13.55)).toBe('meteoalarm'); // Arrecife, Lanzarote
        expect(at(28.5, -13.86)).toBe('meteoalarm'); // Puerto del Rosario, Fuerteventura
        expect(at(28.05, -14.36)).toBe('meteoalarm'); // Morro Jable, Fuerteventura
        expect(at(27.74, -15.59)).toBe('meteoalarm'); // Maspalomas, Gran Canaria
        expect(at(27.81, -17.92)).toBe('meteoalarm'); // Valverde, El Hierro
        expect(at(28.02, -13.45)).not.toBe('meteoalarm'); // off Cape Juby, Morocco
        expect(at(27.6, -13.4)).not.toBe('meteoalarm'); // 13 nm off Western Sahara
        // Albania (no MeteoAlarm feed) east of 20.6°E, its neighbours kept.
        expect(at(40.902, 20.652)).not.toBe('meteoalarm'); // Pogradec, Lake Ohrid
        expect(at(40.62, 20.78)).not.toBe('meteoalarm'); // Korçë
        expect(at(40.63, 20.99)).not.toBe('meteoalarm'); // Bilisht
        expect(at(41.12, 20.8)).toBe('meteoalarm'); // Ohrid, North Macedonia
        expect(at(40.52, 21.27)).toBe('meteoalarm'); // Kastoria, Greece
        expect(at(40.04, 20.75)).toBe('meteoalarm'); // Konitsa, Greece
    });

    it('falls back to WMO SWIC without a position', () => {
        expect(officialWarningsSource(undefined, undefined).id).toBe('wmo-swic');
        expect(officialWarningsSource(null, null, { offshore: true }).id).toBe('wmo-swic');
        expect(officialWarningsSource(Number.NaN, 151).id).toBe('wmo-swic');
    });

    it('accepts any longitude form across the antimeridian', () => {
        expect(at(-43.95, 183.44)).toBe('metservice'); // Chathams written east-positive
        expect(at(52.9, -187.1)).toBe('nws'); // Attu written west-negative
    });

    it('links only to official https warning pages, with words for the copy', () => {
        const ids = Object.keys(OFFICIAL_WARNINGS_SOURCES).sort();
        expect(ids).toEqual(
            ['bom', 'eccc', 'meteoalarm', 'metoffice', 'metservice', 'nws', 'wmo-swic', 'wmo-wwmiws'].sort(),
        );
        const hosts: Record<string, string> = {
            bom: 'www.bom.gov.au',
            nws: 'www.weather.gov',
            metoffice: 'weather.metoffice.gov.uk',
            meteoalarm: 'meteoalarm.org',
            eccc: 'weather.gc.ca',
            metservice: 'www.metservice.com',
            'wmo-swic': 'severeweather.wmo.int',
            'wmo-wwmiws': 'wwmiws.wmo.int',
        };
        for (const source of Object.values(OFFICIAL_WARNINGS_SOURCES)) {
            const url = new URL(source.url);
            expect(url.protocol).toBe('https:');
            expect(url.host).toBe(hosts[source.id]);
            expect(source.shortName.length).toBeGreaterThan(0);
            expect(source.name.length).toBeGreaterThan(0);
            expect(source.checkPhrase.length).toBeGreaterThan(0);
        }
        // No Australia-only wording on any other issuer.
        for (const source of Object.values(OFFICIAL_WARNINGS_SOURCES)) {
            if (source.id === 'bom') continue;
            expect(`${source.name} ${source.checkPhrase}`).not.toMatch(/Bureau|BoM|Australia/);
        }
    });
});
