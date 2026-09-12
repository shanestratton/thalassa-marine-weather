import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudTelemetry } from '../services/CloudTelemetryService';

const world = vi.hoisted(() => ({
    readOnce: vi.fn<() => Promise<CloudTelemetry | null>>(),
    pinnedPiRequest: vi.fn(),
}));
vi.mock('../services/CloudTelemetryService', () => ({ CloudTelemetryService: { readOnce: world.readOnce } }));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getPosition: () => null } }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { getBaseUrl: () => 'http://100.1.2.3:3000', getStatus: () => ({ reachable: true }) },
}));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: world.pinnedPiRequest }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn() }) }));

import { cloudFix, piFix } from '../services/boatPositionChain';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const NOW = Date.UTC(2026, 8, 10, 0, 0, 0);
const telemetry = (overrides: Partial<CloudTelemetry> = {}): CloudTelemetry => ({
    ownerId: 'skipper',
    boatId: 'serene-summer',
    source: 'pi',
    deviceLabel: 'Calypso',
    reportedAt: NOW,
    receivedAt: NOW,
    snapshot: {
        source: 'pi',
        via: 'cloud',
        deviceLabel: 'Calypso',
        reportedAt: NOW,
        lat: -27.195,
        lon: 153.1056,
        sogKts: 0,
        cogDeg: null,
        headingDeg: null,
        stwKts: null,
        twsKts: null,
        twaDeg: null,
        twdDeg: null,
        awsKts: null,
        awaDeg: null,
        depthM: null,
        heelDeg: null,
        pitchDeg: null,
        waterTempC: null,
        rudderDeg: null,
        rpm: null,
        voltageV: null,
    },
    ...overrides,
});

describe('boat receiver provenance at the wire boundary', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        setAuthIdentityScope('skipper');
        world.readOnce.mockReset();
        world.pinnedPiRequest.mockReset();
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('accepts a fresh Pi cloud row and preserves its receiver timestamp', async () => {
        world.readOnce.mockResolvedValue(telemetry({ reportedAt: NOW - 5_000 }));
        expect(await cloudFix(NOW)).toMatchObject({
            latitude: -27.195,
            longitude: 153.1056,
            timestamp: NOW - 5_000,
            rung: 'cloud',
            source: 'pi-cloud',
        });
    });

    it('rejects a phone-uploaded cloud row even when it is fresh and has valid coordinates', async () => {
        world.readOnce.mockResolvedValue(telemetry({ source: 'device' }));
        expect(await cloudFix(NOW)).toBeNull();
    });

    it.each([NOW - 60_001, NOW + 5_001, Number.NaN, 0])('rejects an invalid cloud time %s', async (reportedAt) => {
        world.readOnce.mockResolvedValue(telemetry({ reportedAt }));
        expect(await cloudFix(NOW)).toBeNull();
    });

    it.each([
        [null, 153],
        [-27, null],
        [91, 153],
        [-27, 181],
        [Number.NaN, 153],
    ])('rejects unusable cloud coordinates %s, %s', async (lat, lon) => {
        const row = telemetry();
        world.readOnce.mockResolvedValue({ ...row, snapshot: { ...row.snapshot, lat, lon } });
        expect(await cloudFix(NOW)).toBeNull();
    });

    it('fences a cloud response that completes after an account change', async () => {
        let finish!: (row: CloudTelemetry | null) => void;
        world.readOnce.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = cloudFix(NOW);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        expect(finish).toBeTypeOf('function');
        setAuthIdentityScope('other-skipper');
        finish(telemetry());
        expect(await pending).toBeNull();
    });

    it.each([null, undefined, '2026-09-10', 0])('never fabricates a Pi GPS timestamp from %s', async (timestamp) => {
        world.pinnedPiRequest.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ available: true, latitude: -27.195, longitude: 153.1056, timestamp }),
        });
        expect(await piFix()).toBeNull();
    });

    it('reads a real timestamp from the pinned Pi endpoint', async () => {
        world.pinnedPiRequest.mockResolvedValue({
            status: 200,
            data: JSON.stringify({
                available: true,
                latitude: -27.195,
                longitude: 153.1056,
                timestamp: NOW,
                source: 'ublox-gps.GP',
            }),
        });
        expect(await piFix()).toMatchObject({ timestamp: NOW, rung: 'pi', source: 'ublox-gps.GP' });
    });
});
