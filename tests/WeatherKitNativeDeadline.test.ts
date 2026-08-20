/**
 * A hung native WeatherKit fetch must resolve null, not hang its caller.
 *
 * Apple's framework does not reject when it cannot authenticate — it hangs
 * silently (measured 2026-08-20: `weatherkit=8003! unified=8000!`, the Glass
 * page's first no-Pi paint pinned at the full 8 s source budget because
 * unified never reached its Supabase fallback). The deadline converts that
 * hang into the null the callers were already built to fall back on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = vi.hoisted(() => ({ impl: vi.fn<() => Promise<unknown>>() }));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
    registerPlugin: () => ({ fetch: () => nativeFetch.impl() }),
}));

import { fetchWeatherKitNative } from '../services/native/weatherKit';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchWeatherKitNative deadline', () => {
    it('a silent hang resolves null at the deadline instead of never', async () => {
        nativeFetch.impl.mockReturnValue(new Promise(() => {})); // hangs forever
        const call = fetchWeatherKitNative(-27.2, 153.1);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(call).resolves.toBeNull();
    });

    it('a healthy fast answer passes through untouched', async () => {
        const payload = { currentWeather: { temperature: 21 } };
        nativeFetch.impl.mockResolvedValue(payload);
        await expect(fetchWeatherKitNative(-27.2, 153.1)).resolves.toBe(payload);
    });

    it('a rejection still falls back to null', async () => {
        nativeFetch.impl.mockRejectedValue(new Error('entitlement missing'));
        await expect(fetchWeatherKitNative(-27.2, 153.1)).resolves.toBeNull();
    });
});
