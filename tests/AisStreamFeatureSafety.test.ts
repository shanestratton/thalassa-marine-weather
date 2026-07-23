import { describe, expect, it } from 'vitest';
import {
    buildGuardZoneCircle,
    longitudeWithinPaddedBounds,
    normaliseInternetAisFeature,
} from '../components/map/useAisStreamLayer';
import { resolveOwnshipPosition } from '../services/ownshipPosition';

const NOW = Date.parse('2026-07-24T01:00:00.000Z');

function feature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['153.0251', '-27.4698'] },
        properties: {
            mmsi: '503123456',
            name: 'Safe Vessel',
            call_sign: 'VK123',
            destination: 'MORETON BAY',
            ship_type: 70,
            nav_status: 0,
            sog: 8.5,
            cog: 120,
            heading: 118,
            updated_at: '2026-07-24T00:50:00.000Z',
        },
        ...overrides,
    };
}

describe('internet AIS feature boundary', () => {
    it('returns a small, canonical point with explicit freshness', () => {
        expect(normaliseInternetAisFeature(feature(), NOW)).toEqual({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [153.0251, -27.4698] },
            properties: {
                mmsi: 503123456,
                name: 'Safe Vessel',
                callSign: 'VK123',
                destination: 'MORETON BAY',
                shipType: 70,
                navStatus: 0,
                sog: 8.5,
                cog: 120,
                heading: 118,
                updatedAt: '2026-07-24T00:50:00.000Z',
                staleMinutes: 10,
                source: 'aisstream',
                statusColor: '#22c55e',
            },
        });
    });

    it.each([
        null,
        [],
        feature({ geometry: { type: 'LineString', coordinates: [153, -27] } }),
        feature({ geometry: { type: 'Point', coordinates: [[153], [-27]] } }),
        feature({ geometry: { type: 'Point', coordinates: [181, -27] } }),
        feature({ properties: { mmsi: '123' } }),
    ])('rejects malformed identifiers and geometry', (value) => {
        expect(normaliseInternetAisFeature(value, NOW)).toBeNull();
    });

    it('fails unknown/future timestamps stale and bounds movement/text fields', () => {
        const normalised = normaliseInternetAisFeature(
            feature({
                properties: {
                    mmsi: 503123456,
                    name: 'N'.repeat(10_000),
                    updated_at: '2026-07-24T01:10:01.000Z',
                    sog: 999,
                    cog: -1,
                    heading: 510,
                    nav_status: 99,
                    ship_type: 999,
                },
            }),
            NOW,
        );

        expect(normalised?.properties).toMatchObject({
            updatedAt: '',
            staleMinutes: 1440,
            sog: 0,
            cog: 0,
            heading: 511,
            navStatus: 15,
            shipType: 0,
        });
        expect(normalised?.properties?.name).toHaveLength(120);
    });
});

describe('AIS viewport longitude wrapping', () => {
    it('keeps targets visible across both representations of the antimeridian', () => {
        expect(longitudeWithinPaddedBounds(-179, 170, -170)).toBe(true);
        expect(longitudeWithinPaddedBounds(179, -190, -170)).toBe(true);
        expect(longitudeWithinPaddedBounds(150, 170, -170)).toBe(false);
    });

    it('preserves ordinary viewport clipping and rejects malformed bounds', () => {
        expect(longitudeWithinPaddedBounds(153, 150, 156)).toBe(true);
        expect(longitudeWithinPaddedBounds(140, 150, 156)).toBe(false);
        expect(longitudeWithinPaddedBounds(Number.NaN, 150, 156)).toBe(false);
    });

    it('builds finite, closed guard circles at high latitude and the antimeridian', () => {
        const points = buildGuardZoneCircle(89.5, 179.9, 50);
        expect(points).toHaveLength(65);
        expect(points.at(-1)?.[0]).toBeCloseTo(points[0][0], 8);
        expect(points.at(-1)?.[1]).toBeCloseTo(points[0][1], 8);
        expect(
            points.every(
                ([lon, lat]) =>
                    Number.isFinite(lon) &&
                    lon >= -180 &&
                    lon <= 180 &&
                    Number.isFinite(lat) &&
                    lat >= -90 &&
                    lat <= 90,
            ),
        ).toBe(true);
        expect(buildGuardZoneCircle(0, 0, -1)).toEqual([]);
    });
});

describe('AIS ownship position boundary', () => {
    const metric = (value: number, lastUpdated = NOW, freshness = 'live') => ({
        value,
        lastUpdated,
        freshness,
    });

    it('prefers a fresh NMEA fix over a selected map/weather pin', () => {
        expect(
            resolveOwnshipPosition(
                {
                    latitude: metric(-27.5),
                    longitude: metric(153.1),
                    sog: metric(7.5),
                    cog: metric(84),
                },
                { lat: -20, lon: 149, source: 'map_pin', timestamp: NOW },
                NOW,
            ),
        ).toEqual({
            lat: -27.5,
            lon: 153.1,
            sog: 7.5,
            cog: 84,
            timestamp: NOW,
            source: 'nmea',
        });
    });

    it('falls back only to a recent location explicitly sourced from GPS', () => {
        expect(
            resolveOwnshipPosition({}, { lat: -27.5, lon: 153.1, source: 'gps', timestamp: NOW - 30_000 }, NOW),
        ).toEqual({
            lat: -27.5,
            lon: 153.1,
            sog: 0,
            cog: 0,
            timestamp: NOW - 30_000,
            source: 'gps',
        });
        expect(
            resolveOwnshipPosition({}, { lat: -27.5, lon: 153.1, source: 'map_pin', timestamp: NOW }, NOW),
        ).toBeNull();
        expect(
            resolveOwnshipPosition({}, { lat: -27.5, lon: 153.1, source: 'gps', timestamp: NOW - 60_001 }, NOW),
        ).toBeNull();
    });

    it('rejects dead NMEA coordinates and dead movement metrics', () => {
        expect(
            resolveOwnshipPosition(
                {
                    latitude: metric(-27.5, NOW - 20_000, 'dead'),
                    longitude: metric(153.1, NOW - 20_000, 'dead'),
                    sog: metric(8, NOW - 20_000, 'dead'),
                    cog: metric(90, NOW - 20_000, 'dead'),
                },
                { lat: -27.4, lon: 153, source: 'gps', timestamp: NOW },
                NOW,
            ),
        ).toEqual({
            lat: -27.4,
            lon: 153,
            sog: 0,
            cog: 0,
            timestamp: NOW,
            source: 'gps',
        });
    });
});
