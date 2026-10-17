/** Owned reference replaces the public-mirror/browser wall. These fictional
 * fixtures prove client behavior, not admission of a live planet database. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock('../services/osm/ownedOverpass', () => ({ fetchOwnedOverpass: mocks.fetch }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: mocks.get, set: mocks.set } }));
const now = Date.UTC(2026, 9, 17, 0),
    clock = now - 86400_000;
const way = {
    type: 'way',
    id: 1,
    geometry: [
        { lat: -27, lon: 153 },
        { lat: -27.1, lon: 153.1 },
    ],
};
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.fetch
        .mockReset()
        .mockResolvedValue({ elements: [way], thalassaSource: { sourceAt: new Date(clock).toISOString() } });
    mocks.get.mockReset().mockResolvedValue({ value: null });
    mocks.set.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('owned coastline on web/native', () => {
    it('uses a bounded owned coastline recipe without a native-only branch', async () => {
        const { fetchCoastlineSegments } = await import('../services/weather/shelter/coastlineSource');
        expect(await fetchCoastlineSegments(-27, 153)).toEqual([
            [
                [153, -27],
                [153.1, -27.1],
            ],
        ]);
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.fetch.mock.calls[0][0]).toContain('way["natural"="coastline"]');
        expect(mocks.fetch.mock.calls[0][1]).toEqual({ timeoutMs: 9000 });
        expect(readFileSync('services/weather/shelter/coastlineSource.ts', 'utf8')).not.toContain('isNativePlatform');
    });
    it('persists the original database date, so another read cannot renew its age', async () => {
        const { fetchCoastlineSegments } = await import('../services/weather/shelter/coastlineSource');
        await fetchCoastlineSegments(-27, 153);
        const saved = mocks.set.mock.calls[0][0];
        expect(saved.key).toMatch(/^coast_owned_v1_/);
        expect(JSON.parse(saved.value).ts).toBe(clock);
        vi.setSystemTime(clock + 30 * 86400_000 + 1);
        expect(await fetchCoastlineSegments(-27, 153)).toBeNull();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('restores the owned cache without rewriting the original date', async () => {
        const segments = [
            [
                [153, -27],
                [153.1, -27.1],
            ],
        ];
        mocks.get.mockResolvedValue({ value: JSON.stringify({ ts: clock, segs: segments }) });
        const { fetchCoastlineSegments } = await import('../services/weather/shelter/coastlineSource');
        expect(await fetchCoastlineSegments(-27, 153)).toEqual(segments);
        expect(mocks.get.mock.calls[0][0].key).toMatch(/^coast_owned_v1_/);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.set).not.toHaveBeenCalled();
    });
    it('missing database never becomes empty success; existing negative caching bounds repeated asks', async () => {
        mocks.fetch.mockRejectedValue(new Error('Owned source unavailable'));
        const { fetchCoastlineSegments } = await import('../services/weather/shelter/coastlineSource');
        expect(await fetchCoastlineSegments(-27, 153)).toBeNull();
        expect(await fetchCoastlineSegments(-27, 153)).toBeNull();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.set).not.toHaveBeenCalled();
    });
    it('retires both public mirror origins from the actual CSPs', () => {
        for (const file of ['index.html', 'vercel.json']) {
            const source = readFileSync(file, 'utf8');
            expect(source).not.toContain('https://overpass-api.de');
            expect(source).not.toContain('https://overpass.kumi.systems');
        }
    });
    it('keeps the actual missing-coastline wave fallback unchanged', () => {
        expect(readFileSync('services/weather/shelter/index.ts', 'utf8')).toContain('coastline data is unavailable');
    });
});
