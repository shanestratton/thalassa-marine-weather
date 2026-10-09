import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { packagedFetch } from './helpers/packagedFetch';
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: vi.fn() } }));

// The regional reference is a packaged data file (public/data, build 126),
// read with a same-origin fetch; the stub serves it from public/.
beforeAll(() => vi.stubGlobal('fetch', packagedFetch()));
afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

it('lets precise island names finish after a backlog instead of timing out queued cards to their district', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { CapacitorHttp: http } = await import('@capacitor/core');
    vi.mocked(http.get).mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return {
            status: 200,
            headers: {},
            url: '',
            data: {
                lat: '-20.3471589',
                lon: '148.9499519',
                address: { city_district: 'Whitsundays', village: 'Hamilton Island' },
            },
        };
    });
    const { marineEndpointName } = await import('../services/marineEndpointName');
    const results = Promise.all([
        marineEndpointName(-20.3475, 148.9499),
        marineEndpointName(-20.3476, 148.9499),
        marineEndpointName(-20.3477, 148.9499),
    ]);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await results).toEqual(['Hamilton Island', 'Hamilton Island', 'Hamilton Island']);
    expect(http.get).toHaveBeenCalledTimes(3);
});

it('rejects invalid coordinates without requesting a geocode', async () => {
    const { CapacitorHttp: http } = await import('@capacitor/core');
    const { resolveDetailedEndpointName } = await import('../services/marineEndpointName');
    expect(await resolveDetailedEndpointName(NaN, 149)).toBeNull();
    expect(await resolveDetailedEndpointName(-20, 181)).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
});
