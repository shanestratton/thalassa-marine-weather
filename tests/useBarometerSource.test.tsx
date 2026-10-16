import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ getBarometer: vi.fn(), phone: [] as { t: number; hpa: number }[] }));
vi.mock('../services/PiCacheService', () => ({ piCache: { getBarometer: h.getBarometer } }));
vi.mock('../services/native/barometer', () => ({
    getSeaLevelSamples: () => h.phone,
    subscribe: () => () => {},
}));
import { useBarometerSource } from '../hooks/useBarometerSource';
const NOW = 1_800_000_000_000;
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    h.phone = [{ t: NOW, hpa: 1013 }];
});
afterEach(() => vi.restoreAllMocks());
describe('boat pressure source', () => {
    it('does not splice BMP390 and Signal K offsets into a tendency', async () => {
        const samples = [
            { at: NOW - 3_600_000, hpa: 1020, source: 'bmp390' },
            { at: NOW - 60_000, hpa: 1010, source: 'signalk', lat: -16, lon: 146 },
            { at: NOW, hpa: 1010, source: 'signalk', lat: -16, lon: 146 },
        ];
        h.getBarometer.mockResolvedValue({ available: true, latest: samples[2], samples });
        const { result } = renderHook(() => useBarometerSource(true));
        await waitFor(() => expect(result.current.source).toBe('boat'));
        expect(result.current.samples).toHaveLength(2);
        expect(result.current.samples[0]).toEqual({ t: NOW - 60_000, hpa: 1010, lat: -16, lon: 146 });
    });
    it.each([NOW - 3 * 60_000, NOW + 60_000])('falls back from a stale/future boat clock (%s)', async (at) => {
        h.getBarometer.mockResolvedValue({ available: true, latest: { at, hpa: 1020 }, samples: [{ at, hpa: 1020 }] });
        const { result } = renderHook(() => useBarometerSource(true));
        await waitFor(() => expect(h.getBarometer).toHaveBeenCalled());
        expect(result.current.source).toBe('phone');
        expect(result.current.latest!.hpa).toBe(1013);
    });
    it('rejects a fresh latest header when the returned history is stale', async () => {
        h.getBarometer.mockResolvedValue({
            available: true,
            latest: { at: NOW, hpa: 1000 },
            samples: [{ at: NOW - 20 * 60_000, hpa: 1000 }],
        });
        const { result } = renderHook(() => useBarometerSource(true));
        await waitFor(() => expect(h.getBarometer).toHaveBeenCalled());
        expect(result.current.source).toBe('phone');
        expect(result.current.latest!.hpa).toBe(1013);
    });
});
