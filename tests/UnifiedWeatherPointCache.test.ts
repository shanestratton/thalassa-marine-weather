import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        unifiedWeatherUrl: (lat: number, lon: number) => `https://pi.test/weather?lat=${lat}&lon=${lon}`,
    },
}));

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
    });

    it('does not reuse a five-minute report for another point in the same 0.01-degree cell', async () => {
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');

        await fetchUnifiedWeatherRaw(-17.1234, 168.1234, 'sailor');
        await fetchUnifiedWeatherRaw(-17.1244, 168.1244, 'sailor');

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
