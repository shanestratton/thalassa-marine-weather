import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudTelemetry } from '../services/CloudTelemetryService';

const world = vi.hoisted(() => ({
    readOnce: vi.fn<(owner?: string) => Promise<CloudTelemetry | null>>(),
    pinnedPiRequest: vi.fn(),
    piStatus: { reachable: true } as { reachable: boolean; diaryRelayConfigured?: boolean; diaryRelayOwnerId?: string },
    link: 'disconnected' as string,
}));
vi.mock('../services/CloudTelemetryService', () => ({ CloudTelemetryService: { readOnce: world.readOnce } }));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getPosition: () => null } }));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({ connectionStatus: world.link }) } }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { getBaseUrl: () => 'http://100.1.2.3:3000', getStatus: () => world.piStatus },
}));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: world.pinnedPiRequest }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ info: vi.fn() }) }));

import { cloudFix, deviceRungOwner, piFix } from '../services/boatPositionChain';
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
        world.piStatus = { reachable: true };
        world.link = 'disconnected';
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

    // Shane 2026-10-07: ashore, Obs's close-in wind should be the boat's own
    // when the row carries it. The row's true wind and the Pi's own sample
    // time ride along with the position; nothing is invented when absent.
    it('carries her true wind and its sample time from the row, and leaves them unknown when absent', async () => {
        const row = telemetry({ reportedAt: NOW - 5_000 });
        world.readOnce.mockResolvedValue({
            ...row,
            snapshot: {
                ...row.snapshot,
                twsKts: 14,
                twdDeg: 200,
                twaDeg: -40,
                windSampleAt: NOW - 3_000,
                // Pi update 1 (125): the TWD reading's own time rides along too.
                twdSampleAt: NOW - 4_000,
            },
        });
        expect(await cloudFix(NOW)).toMatchObject({
            twsKts: 14,
            twdDeg: 200,
            twaDeg: -40,
            windSampleAt: NOW - 3_000,
            twdSampleAt: NOW - 4_000,
        });
        world.readOnce.mockResolvedValue(row);
        expect(await cloudFix(NOW)).toMatchObject({
            twsKts: null,
            twdDeg: null,
            twaDeg: null,
            windSampleAt: null,
            twdSampleAt: null,
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

    // Crew with GPS on their own boat and on the boat they are invited to
    // (Shane 2026-10-05). Fictional ids.
    it('reads one boat’s cloud row when named, and the Ship’s Log callers’ row when not', async () => {
        world.readOnce.mockResolvedValue(telemetry({ reportedAt: NOW - 5_000 }));
        await cloudFix(NOW, 'skipper-wd');
        expect(world.readOnce).toHaveBeenLastCalledWith('skipper-wd');
        await cloudFix(NOW, 'self');
        expect(world.readOnce).toHaveBeenLastCalledWith('self');
        await cloudFix(NOW);
        expect(world.readOnce).toHaveBeenLastCalledWith(undefined);
    });

    it('names the paired Pi’s boat by its relay owner; a gateway socket names nobody', () => {
        expect(deviceRungOwner('pi')).toBeNull();
        world.piStatus = { reachable: true, diaryRelayConfigured: true, diaryRelayOwnerId: 'skipper-wd' };
        expect(deviceRungOwner('pi')).toBe('skipper-wd');
        // The bus over the boat LAN is the Pi's relay of her bus.
        world.link = 'remote';
        expect(deviceRungOwner('bus')).toBe('skipper-wd');
        // A socket straight to a gateway says nothing about whose boat it is.
        world.link = 'connected';
        expect(deviceRungOwner('bus')).toBeNull();
        // A relay that is not set up names nobody.
        world.piStatus = { reachable: true, diaryRelayConfigured: false, diaryRelayOwnerId: 'skipper-wd' };
        expect(deviceRungOwner('pi')).toBeNull();
    });
});
