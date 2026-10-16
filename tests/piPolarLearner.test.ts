import { beforeEach, describe, expect, it, vi } from 'vitest';
import SunCalc from 'suncalc';
import { polarSolarAltitude, polarPeriodAt } from '../pi-cache/src/polarLearningRule';
import type { PolarData } from '../types';

const state = vi.hoisted(() => ({
    pair: { deviceId: 'boat-a', publicKeySpki: 'key-a' } as { deviceId: string; publicKeySpki: string } | null,
    available: false,
    saved: null as unknown,
    request: vi.fn(),
    save: vi.fn(),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => state.pair, pinnedPiRequest: state.request }));
vi.mock('../services/PiCacheService', () => ({ piCache: { baseUrl: 'https://paired-boat' } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => state.available }));
vi.mock('../services/nativeStorage', () => ({ loadLargeData: async () => state.saved, saveLargeData: state.save }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({ lat: 0, lon: 0 }) } }));
const grid = (speed: number, count = 42): PolarData => ({
    windSpeeds: [6, 8, 10, 12, 15, 20, 25],
    angles: [45, 60, 90, 120, 150, 180],
    matrix: Array.from({ length: 6 }, (_, a) => Array.from({ length: 7 }, (_, w) => (a * 7 + w < count ? speed : 0))),
});
const snapshot = () => ({
    version: 1,
    enabled: true,
    updatedAt: Date.now(),
    polars: { all: grid(5), day: grid(6, 1), night: grid(4, 8) },
});
beforeEach(() => {
    vi.resetModules();
    state.pair = { deviceId: 'boat-a', publicKeySpki: 'key-a' };
    state.available = false;
    state.saved = null;
    state.request.mockReset();
    state.save.mockReset();
});
describe('the paired Pi learned polar', () => {
    it('uses a sufficiently learned night shape and falls back to combined when day is thin', async () => {
        state.saved = { key: 'boat-a:key-a', snapshot: snapshot() };
        const { getPiLearnedPolar } = await import('../services/piPolarLearner');
        expect((await getPiLearnedPolar('night'))!.matrix[0][0]).toBe(4);
        expect((await getPiLearnedPolar('day'))!.matrix[0][0]).toBe(5);
        expect(state.request).not.toHaveBeenCalled();
    });
    it('keeps cached figures available offline but never gives them to a different pairing', async () => {
        state.saved = { key: 'boat-a:key-a', snapshot: snapshot() };
        const { getPiLearnedPolar } = await import('../services/piPolarLearner');
        expect(await getPiLearnedPolar()).not.toBeNull();
        state.pair = { deviceId: 'boat-b', publicKeySpki: 'key-b' };
        expect(await getPiLearnedPolar()).toBeNull();
    });
    it('does not reach an unpaired or unpinned boat', async () => {
        const { getPiLearnedPolar } = await import('../services/piPolarLearner');
        expect(await getPiLearnedPolar()).toBeNull();
        state.pair = null;
        state.available = true;
        expect(await getPiLearnedPolar()).toBeNull();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('rejects malformed grids instead of importing bogus routing speeds', async () => {
        state.available = true;
        state.request.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ ...snapshot(), polars: { all: { windSpeeds: [1], angles: [], matrix: [[100]] } } }),
        });
        const { getPiLearnedPolar } = await import('../services/piPolarLearner');
        expect(await getPiLearnedPolar()).toBeNull();
        expect(state.save).not.toHaveBeenCalled();
    });
    it('discards a response when the boat was re-paired during the request', async () => {
        state.available = true;
        let done!: (value: unknown) => void;
        state.request.mockReturnValue(
            new Promise((resolve) => {
                done = resolve;
            }),
        );
        const { getPiLearnedPolar } = await import('../services/piPolarLearner');
        const read = getPiLearnedPolar();
        await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce());
        state.pair = { deviceId: 'boat-b', publicKeySpki: 'key-b' };
        done({ status: 200, data: JSON.stringify(snapshot()) });
        expect(await read).toBeNull();
        expect(state.save).not.toHaveBeenCalled();
    });
});
it('Pi solar altitude agrees with the app SunCalc at civil twilight and at high latitudes', () => {
    for (const [lat, lon] of [
        [-27, 153],
        [0, 0],
        [78, 16],
        [-78, -170],
    ]) {
        for (const date of ['2026-03-20T00:00Z', '2026-06-21T12:00Z', '2026-12-21T18:00Z']) {
            const at = Date.parse(date);
            const altitude = (SunCalc.getPosition(new Date(at), lat, lon).altitude * 180) / Math.PI;
            expect(polarSolarAltitude(at, lat, lon)).toBeCloseTo(altitude, 8);
            expect(polarPeriodAt(at, lat, lon)).toBe(altitude < -6 ? 'night' : 'day');
        }
    }
});
