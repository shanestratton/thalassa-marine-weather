import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
    gps: vi.fn(),
    foregroundGps: vi.fn(),
    safetyGps: vi.fn(),
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
        getCurrentPositionIfGranted: (...args: unknown[]) => dependencies.gps(...args),
        requestCurrentForegroundPosition: (...args: unknown[]) => dependencies.foregroundGps(...args),
        getCurrentPosition: (...args: unknown[]) => dependencies.safetyGps(...args),
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
        dependencies.foregroundGps.mockResolvedValue(null);
        dependencies.safetyGps.mockResolvedValue(null);
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
        expect(dependencies.foregroundGps).not.toHaveBeenCalled();
        expect(dependencies.safetyGps).not.toHaveBeenCalled();
    });

    it('uses prompt-capable providers only for an explicit foreground or safety intent', async () => {
        const position = {
            latitude: -27.48,
            longitude: 153.04,
            accuracy: 4,
            altitude: null,
            heading: 182,
            speed: 5,
            timestamp: NOW - 1_000,
        };
        dependencies.foregroundGps.mockResolvedValueOnce(position);
        await expect(
            acquireFreshOwnshipPosition({
                now: NOW,
                maxGpsAgeMs: 30_000,
                locationAccess: 'foreground-request',
            }),
        ).resolves.toMatchObject({ lat: -27.48, source: 'gps' });
        expect(dependencies.foregroundGps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
        expect(dependencies.gps).not.toHaveBeenCalled();
        expect(dependencies.safetyGps).not.toHaveBeenCalled();

        vi.clearAllMocks();
        dependencies.safetyGps.mockResolvedValueOnce(position);
        await expect(
            acquireFreshOwnshipPosition({
                now: NOW,
                maxGpsAgeMs: 30_000,
                locationAccess: 'background-safety',
            }),
        ).resolves.toMatchObject({ lat: -27.48, source: 'gps' });
        expect(dependencies.safetyGps).toHaveBeenCalledWith({ staleLimitMs: 30_000, timeoutSec: 10 });
        expect(dependencies.gps).not.toHaveBeenCalled();
        expect(dependencies.foregroundGps).not.toHaveBeenCalled();
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

    it('never lets a passive acquisition borrow a concurrent safety request', async () => {
        let resolvePassive!: (value: null) => void;
        dependencies.gps.mockReturnValueOnce(
            new Promise((resolve) => {
                resolvePassive = resolve;
            }),
        );
        dependencies.safetyGps.mockResolvedValueOnce({
            latitude: -27.49,
            longitude: 153.05,
            accuracy: 5,
            altitude: null,
            heading: 45,
            speed: 1,
            timestamp: NOW,
        });

        const passive = acquireFreshOwnshipPosition({ now: NOW });
        const safety = acquireFreshOwnshipPosition({ now: NOW, locationAccess: 'background-safety' });
        await expect(safety).resolves.toMatchObject({ lat: -27.49, source: 'gps' });
        expect(dependencies.gps).toHaveBeenCalledOnce();
        expect(dependencies.safetyGps).toHaveBeenCalledOnce();

        resolvePassive(null);
        await expect(passive).resolves.toBeNull();
    });

    // Build 123, package VL (voyagelog.md, whyWrong 3a): every store lat/lon
    // was "nmea", including the Pi's cloud row stamped with the phone's read
    // time — so a preflight could call a minute-old relayed fix the live bus.
    // It is still the BOAT (ten chart, HUD and diary readers rely on 'nmea'
    // meaning "her own receiver, any lane"), but it now says it was relayed,
    // and when the Pi reported it.
    describe('a cloud-row ingest is the boat relayed, not the bus', () => {
        const cloudStore = (reportedAt: number, positionSampleAt?: number) => ({
            connectionStatus: 'remote',
            remote: {
                source: 'pi',
                via: 'cloud',
                deviceLabel: null,
                reportedAt,
                ...(positionSampleAt ? { positionSampleAt } : {}),
                receivedAt: NOW,
            },
            // Stamped with the phone's read time, exactly as NmeaStore.ingestRemote does.
            latitude: metric(-22.2796, NOW),
            longitude: metric(166.4389, NOW),
        });
        const noPhone = { lat: 0, lon: 0, source: 'map_pin', timestamp: NOW };

        it('marks the relay and dates it by the Pi, not by the phone reading it', () => {
            const own = resolveOwnshipPosition(cloudStore(NOW - 40_000), noPhone, { now: NOW });
            expect(own).toMatchObject({ lat: -22.2796, lon: 166.4389, source: 'nmea' });
            expect(own?.relay).toEqual({ reportedAt: NOW - 40_000 });
        });

        it("prefers the receiver's own position time when the row carries it", () => {
            const own = resolveOwnshipPosition(cloudStore(NOW - 10_000, NOW - 25_000), noPhone, { now: NOW });
            expect(own?.relay).toEqual({ reportedAt: NOW - 25_000 });
        });

        it('the Pi on her LAN and the gateway socket are the bus: no relay mark', () => {
            const lan = {
                ...cloudStore(NOW - 2_000),
                remote: { source: 'pi', via: 'lan', deviceLabel: null, reportedAt: NOW - 2_000, receivedAt: NOW },
            };
            expect(resolveOwnshipPosition(lan, noPhone, { now: NOW })?.relay).toBeUndefined();
            const socket = {
                connectionStatus: 'connected',
                remote: null,
                latitude: metric(50.7712),
                longitude: metric(-1.3005),
            };
            expect(resolveOwnshipPosition(socket, noPhone, { now: NOW })).not.toHaveProperty('relay');
        });
    });
});
