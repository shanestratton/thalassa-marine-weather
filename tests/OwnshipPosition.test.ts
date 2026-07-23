import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
    gps: vi.fn(),
    nmea: { current: {} as Record<string, unknown> },
    location: {
        current: {
            lat: -27.47,
            lon: 153.03,
            source: 'map_pin',
            timestamp: Date.parse('2026-07-24T01:00:00.000Z'),
        },
    },
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: (...args: unknown[]) => dependencies.gps(...args),
    },
}));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => dependencies.nmea.current,
    },
}));

vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: () => dependencies.location.current,
    },
}));

import {
    acquireFreshOwnshipPosition,
    getCachedOwnshipPosition,
    resolveOwnshipPosition,
} from '../services/ownshipPosition';

const NOW = Date.parse('2026-07-24T01:00:00.000Z');

function metric(value: number, lastUpdated = NOW, freshness = 'live') {
    return { value, lastUpdated, freshness };
}

describe('ownship position safety boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dependencies.nmea.current = {};
        dependencies.location.current = {
            lat: -27.47,
            lon: 153.03,
            source: 'map_pin',
            timestamp: NOW,
        };
        dependencies.gps.mockResolvedValue(null);
    });

    it('never treats a selected map or weather location as the vessel position', () => {
        expect(getCachedOwnshipPosition({ now: NOW })).toBeNull();

        dependencies.location.current = {
            lat: -27.5,
            lon: 153.1,
            source: 'weather_search',
            timestamp: NOW,
        };
        expect(getCachedOwnshipPosition({ now: NOW })).toBeNull();
    });

    it('prefers a fresh NMEA fix and rejects stale or future coordinate pairs', () => {
        const selectedGps = { lat: -27.4, lon: 153, source: 'gps', timestamp: NOW - 5_000 };
        expect(
            resolveOwnshipPosition(
                {
                    latitude: metric(-27.5),
                    longitude: metric(153.1),
                    sog: metric(7.25),
                    cog: metric(91),
                },
                selectedGps,
                { now: NOW },
            ),
        ).toMatchObject({ lat: -27.5, lon: 153.1, sog: 7.25, cog: 91, source: 'nmea' });

        expect(
            resolveOwnshipPosition(
                {
                    latitude: metric(-27.5, NOW - 15_001),
                    longitude: metric(153.1, NOW - 15_001),
                },
                { ...selectedGps, timestamp: NOW - 60_001 },
                { now: NOW },
            ),
        ).toBeNull();
        expect(
            resolveOwnshipPosition(
                {
                    latitude: metric(-27.5, NOW + 5_001),
                    longitude: metric(153.1, NOW + 5_001),
                },
                { ...selectedGps, timestamp: NOW + 5_001 },
                { now: NOW },
            ),
        ).toBeNull();
    });

    it('acquires a fresh GPS fix, converts metres per second to knots, and validates heading', async () => {
        dependencies.gps.mockResolvedValue({
            latitude: -27.48,
            longitude: 153.04,
            accuracy: 4,
            altitude: null,
            heading: 182,
            speed: 5,
            timestamp: NOW - 1_000,
        });

        await expect(acquireFreshOwnshipPosition({ now: NOW, maxGpsAgeMs: 30_000 })).resolves.toEqual({
            lat: -27.48,
            lon: 153.04,
            sog: expect.closeTo(9.719222462, 8),
            cog: 182,
            timestamp: NOW - 1_000,
            source: 'gps',
        });
        expect(dependencies.gps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
    });

    it('fails closed for stale, malformed, or rejected plugin positions', async () => {
        dependencies.gps.mockResolvedValueOnce({
            latitude: -27.48,
            longitude: 153.04,
            accuracy: 4,
            altitude: null,
            heading: 0,
            speed: 0,
            timestamp: NOW - 30_001,
        });
        await expect(acquireFreshOwnshipPosition({ now: NOW, maxGpsAgeMs: 30_000 })).resolves.toBeNull();

        dependencies.gps.mockResolvedValueOnce({
            latitude: 91,
            longitude: 153.04,
            accuracy: 4,
            altitude: null,
            heading: 0,
            speed: 0,
            timestamp: NOW,
        });
        await expect(acquireFreshOwnshipPosition({ now: NOW })).resolves.toBeNull();

        dependencies.gps.mockRejectedValueOnce(new Error('native plugin unavailable'));
        await expect(acquireFreshOwnshipPosition({ now: NOW })).resolves.toBeNull();
    });

    it('deduplicates concurrent one-shot GPS requests without sharing mutable state', async () => {
        let resolveGps!: (value: {
            latitude: number;
            longitude: number;
            accuracy: number;
            altitude: null;
            heading: number;
            speed: number;
            timestamp: number;
        }) => void;
        dependencies.gps.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveGps = resolve;
            }),
        );

        const first = acquireFreshOwnshipPosition({ now: NOW });
        const second = acquireFreshOwnshipPosition({ now: NOW });
        expect(dependencies.gps).toHaveBeenCalledTimes(1);

        resolveGps({
            latitude: -27.48,
            longitude: 153.04,
            accuracy: 5,
            altitude: null,
            heading: 45,
            speed: 1,
            timestamp: NOW,
        });

        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual(b);
        expect(a).toMatchObject({ lat: -27.48, lon: 153.04, source: 'gps' });
    });
});
