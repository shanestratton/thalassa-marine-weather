import { afterEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
    sample: null as ((event: { pressureHpa: number; timestamp: number }) => void) | null,
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: () => ({
        isAvailable: async () => ({ available: true, authorization: 'authorized', running: false }),
        addListener: async (_name: string, callback: typeof native.sample) => {
            native.sample = callback;
            return { remove: async () => {} };
        },
        start: async () => ({ running: true }),
        stop: async () => {},
    }),
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }));
import * as barometer from '../services/native/barometer';
afterEach(async () => {
    await barometer.stopLogging();
    barometer.__resetForTests();
});
describe('phone pressure history', () => {
    it('accumulates a continuous 15 second stream across fixed storage buckets', async () => {
        barometer.__resetForTests();
        await barometer.startLogging();
        const start = Date.UTC(2026, 9, 14);
        for (let seconds = 0; seconds <= 3 * 3600; seconds += 15)
            native.sample!({ pressureHpa: 1018 - seconds / 1800, timestamp: start + seconds * 1000 });
        const samples = barometer.getStationSamples();
        expect(samples.length).toBeGreaterThan(100);
        expect(samples.at(-1)!.t - samples[0].t).toBeGreaterThan(2.9 * 3_600_000);
        expect(samples.at(-1)!.hpa).toBe(1012);
    });
});
