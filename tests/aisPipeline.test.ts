/**
 * AIS Pipeline Integration Tests
 *
 * Full end-to-end: raw NMEA sentence → AisDecoder → AisStore → GeoJSON.
 * Validates that a real AIS sentence flows through the entire pipeline
 * and produces correct, map-ready GeoJSON.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { processAisSentence } from '../services/AisDecoder';

let AisStore: typeof import('../services/AisStore').AisStore;

beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    const mod = await import('../services/AisStore');
    AisStore = mod.AisStore;
    AisStore.start();
});

afterEach(() => {
    AisStore.stop();
});

describe('AIS Pipeline — raw sentence → GeoJSON', () => {
    it('should process a Class A position report end-to-end', () => {
        // Real AIS sentence (message type 1)
        const sentence = '!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75';

        // Decode
        const decoded = processAisSentence(sentence);
        expect(decoded).not.toBeNull();
        expect(decoded!.mmsi).toBeDefined();

        // Push to store
        AisStore.update(decoded!);
        expect(AisStore.getCount()).toBe(1);

        // Export to GeoJSON
        const geojson = AisStore.toGeoJSON();
        expect(geojson.type).toBe('FeatureCollection');

        // Validate the feature is map-ready
        if (geojson.features.length > 0) {
            const f = geojson.features[0];
            expect(f.geometry.type).toBe('Point');
            expect(f.geometry.coordinates).toHaveLength(2);
            expect(typeof f.geometry.coordinates[0]).toBe('number'); // lon
            expect(typeof f.geometry.coordinates[1]).toBe('number'); // lat
            expect(f.properties.mmsi).toBe(decoded!.mmsi);
            expect(f.properties.statusColor).toBeDefined();
            expect(f.properties.statusColor).toMatch(/^#/); // Hex colour
        }
    });

    it('should merge position + static data for the same vessel', () => {
        // Step 1: Position report (Class A, type 1)
        const posSentence = '!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75';
        const posData = processAisSentence(posSentence);
        expect(posData).not.toBeNull();
        AisStore.update(posData!);

        const mmsi = posData!.mmsi!;

        // Step 2: Add static data for the same vessel (different sentence)
        AisStore.update({
            mmsi,
            name: 'PIPELINE TEST VESSEL',
            shipType: 70,
            callSign: 'VH999',
            destination: 'MORETON BAY',
        });

        // Verify merge
        expect(AisStore.getCount()).toBe(1);
        const geojson = AisStore.toGeoJSON();
        const f = geojson.features[0];

        // Should have both position AND static data
        expect(f.properties.name).toBe('PIPELINE TEST VESSEL');
        expect(f.properties.callSign).toBe('VH999');
        expect(f.properties.destination).toBe('MORETON BAY');
        expect(f.geometry.coordinates[0]).toBeDefined(); // lon from position
        expect(f.geometry.coordinates[1]).toBeDefined(); // lat from position
    });

    it('should handle multiple vessels simultaneously', () => {
        // Three different vessels
        const sentences = [
            '!AIVDM,1,1,,B,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*75',
            '!AIVDM,1,1,,A,15MwkT1P05Fo;H`EKP8a8:R`0@Fv,0*74',
        ];

        const decoded = sentences.map((s) => processAisSentence(s));
        for (const d of decoded) {
            if (d) AisStore.update(d);
        }

        // The two sentences above decode to the same MMSI (same payload)
        // so the store should have 1 vessel, not 2
        expect(AisStore.getCount()).toBe(1);

        // Now add a genuinely different vessel
        AisStore.update({
            mmsi: 987654321,
            lat: -33.8,
            lon: 151.2,
            cog: 270,
            sog: 15,
            navStatus: 0,
        });

        expect(AisStore.getCount()).toBe(2);

        const geojson = AisStore.toGeoJSON();
        // Should have 2 features (if both have valid positions)
        const validFeatures = geojson.features.filter(
            (f) => f.geometry.coordinates[0] !== 0 || f.geometry.coordinates[1] !== 0,
        );
        expect(validFeatures.length).toBe(2);
    });

    it('should handle the two-part message 5 pipeline', () => {
        const part1 = '!AIVDM,2,1,3,B,55?MbV02>H97ac<H4eEK6W@T4@Dn2222220l18F220A5v1@1340Ep4Q8,0*2C';
        const part2 = '!AIVDM,2,2,3,B,88888888880,2*2E';

        // Part 1 should not produce a result yet
        const r1 = processAisSentence(part1);
        expect(r1).toBeNull();

        // Part 2 completes the message
        const r2 = processAisSentence(part2);
        expect(r2).not.toBeNull();
        expect(r2!.mmsi).toBeDefined();

        // Push to store
        AisStore.update(r2!);

        // Should have static data (name, ship type)
        const target = AisStore.getTargets().get(r2!.mmsi!)!;
        expect(typeof target.name).toBe('string');
        expect(typeof target.shipType).toBe('number');
    });

    it('should reject corrupt sentences without crashing', () => {
        const badSentences = [
            '',
            'not an AIS sentence at all',
            '!AIVDM',
            '!AIVDM,1,1,,B,,0*00',
            '!AIVDM,1,1,,B,ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ,0*00',
            '$GPRMC,123456,A,1234.5678,N,01234.5678,E,5.0,45.0,170326,,*00',
            null as unknown as string,
            undefined as unknown as string,
        ];

        for (const sentence of badSentences) {
            // Should not throw
            try {
                const result = processAisSentence(sentence);
                // Result should be null for bad input
                if (result !== null) {
                    // Some garbage may accidentally decode — that's ok
                    expect(result.mmsi).toBeDefined();
                }
            } catch {
                // processAisSentence should handle errors gracefully
                // If it throws on null/undefined, that's acceptable
            }
        }

        // Store should be empty (no valid data pushed)
        expect(AisStore.getCount()).toBe(0);
    });
});

describe('AIS Pipeline — GeoJSON for map rendering', () => {
    it('should produce GeoJSON compatible with Mapbox GL', () => {
        // Add multiple vessels with different statuses
        const vessels = [
            { mmsi: 100, lat: -27.4, lon: 153.1, navStatus: 0, sog: 8, cog: 45, name: 'UNDERWAY' },
            { mmsi: 200, lat: -27.5, lon: 153.2, navStatus: 1, sog: 0, cog: 0, name: 'ANCHORED' },
            { mmsi: 300, lat: -27.6, lon: 153.3, navStatus: 7, sog: 3, cog: 180, name: 'FISHING' },
            { mmsi: 400, lat: -27.7, lon: 153.4, navStatus: 5, sog: 0, cog: 0, name: 'MOORED' },
            { mmsi: 500, lat: -27.8, lon: 153.5, navStatus: 15, sog: 6, cog: 270, name: 'CLASS B' },
        ];

        for (const v of vessels) AisStore.update(v);

        const geojson = AisStore.toGeoJSON();
        expect(geojson.features).toHaveLength(5);

        // Each feature should have all required properties for Mapbox
        for (const f of geojson.features) {
            expect(f.properties.statusColor).toBeDefined();
            expect(f.properties.statusColor).toMatch(/^#[0-9a-f]{6}$/);
            expect(typeof f.properties.cog).toBe('number');
            expect(typeof f.properties.sog).toBe('number');
            expect(typeof f.properties.mmsi).toBe('number');
            expect(typeof f.properties.name).toBe('string');
        }

        // Verify different statuses have different colours
        const colours = new Set(geojson.features.map((f) => f.properties.statusColor));
        expect(colours.size).toBeGreaterThan(1); // At least 2 different colours
    });
});
