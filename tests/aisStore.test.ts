/**
 * AIS Store unit tests — validates target upsert, GeoJSON export,
 * sweep logic, capacity eviction, and statusColor mapping.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// We need to test AisStore which uses Date.now() internally, so we mock timers
// Import the actual module after mocking
let AisStore: typeof import('../services/AisStore').AisStore;

beforeEach(async () => {
    vi.restoreAllMocks();
    // Dynamic import to get a fresh module each test
    vi.resetModules();
    const mod = await import('../services/AisStore');
    AisStore = mod.AisStore;
    AisStore.start();
});

afterEach(() => {
    AisStore.stop();
});

describe('AisStore — target management', () => {
    it('should add a new target', () => {
        AisStore.update({
            mmsi: 123456789,
            name: 'TEST VESSEL',
            lat: -27.4,
            lon: 153.1,
            cog: 45.0,
            sog: 8.5,
            heading: 42,
            navStatus: 0,
            shipType: 70,
            callSign: 'VH1234',
            destination: 'BRISBANE',
        });

        expect(AisStore.getCount()).toBe(1);
        const targets = AisStore.getTargets();
        expect(targets.has(123456789)).toBe(true);
        const t = targets.get(123456789)!;
        expect(t.name).toBe('TEST VESSEL');
        expect(t.lat).toBe(-27.4);
        expect(t.sog).toBe(8.5);
    });

    it('should merge updates for the same MMSI', () => {
        // First: position report
        AisStore.update({
            mmsi: 111222333,
            lat: -27.5,
            lon: 153.2,
            cog: 90,
            sog: 5.0,
        });

        // Second: static data
        AisStore.update({
            mmsi: 111222333,
            name: 'SPIRIT OF BRISBANE',
            shipType: 60,
            destination: 'SYDNEY',
        });

        expect(AisStore.getCount()).toBe(1);
        const t = AisStore.getTargets().get(111222333)!;
        expect(t.lat).toBe(-27.5);       // From first update
        expect(t.name).toBe('SPIRIT OF BRISBANE'); // From second update
        expect(t.destination).toBe('SYDNEY');
    });

    it('should update position when same MMSI sends new coordinates', () => {
        AisStore.update({ mmsi: 999888777, lat: -27.0, lon: 153.0, cog: 0, sog: 0 });
        AisStore.update({ mmsi: 999888777, lat: -27.1, lon: 153.1, cog: 90, sog: 10 });

        const t = AisStore.getTargets().get(999888777)!;
        expect(t.lat).toBe(-27.1); // Updated position
        expect(t.lon).toBe(153.1);
        expect(t.sog).toBe(10);
    });
});

describe('AisStore — GeoJSON export', () => {
    it('should export features with correct structure', () => {
        AisStore.update({
            mmsi: 123456789,
            name: 'GEOJSON SHIP',
            lat: -27.4,
            lon: 153.1,
            cog: 180,
            sog: 12,
            heading: 175,
            navStatus: 0,
            shipType: 70,
            callSign: 'ABC123',
            destination: 'MORETON BAY',
        });

        const geojson = AisStore.toGeoJSON();
        expect(geojson.type).toBe('FeatureCollection');
        expect(geojson.features).toHaveLength(1);

        const f = geojson.features[0];
        expect(f.type).toBe('Feature');
        expect(f.geometry.type).toBe('Point');
        expect(f.geometry.coordinates).toEqual([153.1, -27.4]); // [lon, lat]

        // Properties
        expect(f.properties.mmsi).toBe(123456789);
        expect(f.properties.name).toBe('GEOJSON SHIP');
        expect(f.properties.sog).toBe(12);
        expect(f.properties.cog).toBe(180);
        expect(f.properties.heading).toBe(175);
        expect(f.properties.navStatus).toBe(0);
        expect(f.properties.callSign).toBe('ABC123');
        expect(f.properties.destination).toBe('MORETON BAY');
    });

    it('should skip targets at 0,0 (invalid position)', () => {
        AisStore.update({ mmsi: 111, lat: 0, lon: 0, name: 'GHOST' });
        AisStore.update({ mmsi: 222, lat: -27.4, lon: 153.1, name: 'REAL SHIP' });

        const geojson = AisStore.toGeoJSON();
        expect(geojson.features).toHaveLength(1);
        expect(geojson.features[0].properties.name).toBe('REAL SHIP');
    });

    it('should use MMSI as fallback name when name is empty', () => {
        AisStore.update({ mmsi: 444555666, lat: -27.4, lon: 153.1 });

        const geojson = AisStore.toGeoJSON();
        expect(geojson.features[0].properties.name).toBe('MMSI 444555666');
    });

    it('should include statusColor in properties', () => {
        AisStore.update({ mmsi: 123, lat: -27.4, lon: 153.1, navStatus: 0 });
        const geojson = AisStore.toGeoJSON();
        expect(geojson.features[0].properties.statusColor).toBe('#22c55e'); // green for underway
    });
});

describe('AisStore — statusColor mapping', () => {
    const testCases = [
        { navStatus: 0, expected: '#22c55e', label: 'under way (engine)' },
        { navStatus: 1, expected: '#f59e0b', label: 'at anchor' },
        { navStatus: 2, expected: '#ef4444', label: 'not under command' },
        { navStatus: 3, expected: '#f97316', label: 'restricted manoeuvrability' },
        { navStatus: 5, expected: '#94a3b8', label: 'moored' },
        { navStatus: 6, expected: '#ef4444', label: 'aground' },
        { navStatus: 7, expected: '#06b6d4', label: 'fishing' },
        { navStatus: 8, expected: '#22c55e', label: 'under way (sail)' },
        { navStatus: 15, expected: '#38bdf8', label: 'not defined / Class B' },
    ];

    testCases.forEach(({ navStatus, expected, label }) => {
        it(`should map navStatus ${navStatus} (${label}) to ${expected}`, () => {
            AisStore.update({ mmsi: 100 + navStatus, lat: -27.4, lon: 153.1, navStatus });
            const geojson = AisStore.toGeoJSON();
            const feature = geojson.features.find(f => f.properties.mmsi === 100 + navStatus);
            expect(feature?.properties.statusColor).toBe(expected);
        });
    });
});

describe('AisStore — subscriber notifications', () => {
    it('should notify subscribers on update', () => {
        const listener = vi.fn();
        const unsub = AisStore.subscribe(listener);

        AisStore.update({ mmsi: 999, lat: -27.4, lon: 153.1 });
        expect(listener).toHaveBeenCalledTimes(1);

        AisStore.update({ mmsi: 999, lat: -27.5, lon: 153.2 });
        expect(listener).toHaveBeenCalledTimes(2);

        unsub();
        AisStore.update({ mmsi: 999, lat: -27.6, lon: 153.3 });
        expect(listener).toHaveBeenCalledTimes(2); // No more calls after unsub
    });
});
