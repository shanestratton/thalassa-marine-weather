import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const pinnedPiRequest = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        canReachPinned: () => true,
        unifiedWeatherUrl: (lat: number, lon: number) => `https://pi.test/weather?lat=${lat}&lon=${lon}`,
    },
}));

// The Pi lane is the one this test actually exercises, and it must be PINNED.
// It used to reach the Pi through plain fetch(), so this file counted fetch
// calls and passed — while that call was failing with -1202 on every real
// device and silently falling through to direct (fixed 2026-09-05).
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest }));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../utils/timezone', () => ({
    resolveTimeZone: () => 'UTC',
    formatTimeInZone: () => '00:00',
}));

describe('unified weather point cache identity', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ provider: 'weatherkit', isPremium: false }),
            headers: { get: () => 'HIT' },
        });
        vi.stubGlobal('fetch', fetchMock);
        pinnedPiRequest.mockReset();
        pinnedPiRequest.mockResolvedValue({
            status: 200,
            headers: { 'X-Cache': 'HIT' },
            data: JSON.stringify({ provider: 'weatherkit', isPremium: false }),
        });
    });

    it('does not reuse a five-minute report for another point in the same 0.01-degree cell', async () => {
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');

        await fetchUnifiedWeatherRaw(-17.1234, 168.1234, 'sailor');
        await fetchUnifiedWeatherRaw(-17.1244, 168.1244, 'sailor');

        // One upstream request per distinct point — the cache must not serve
        // the first point's report for the second.
        expect(pinnedPiRequest).toHaveBeenCalledTimes(2);
        const [first, second] = pinnedPiRequest.mock.calls.map((c) => c[0].url);
        expect(first).not.toEqual(second);
        // And the Pi answered, so the direct leg was never needed.
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
