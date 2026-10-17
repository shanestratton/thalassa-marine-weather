import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { climateCellFixture } from './fixtures/climate142';
import { climateTileKey } from '../services/climatology/era5Climate';
import { readEra5Climate } from '../services/climatology/era5ClimateReader';
import { assertNetworkAllowed } from '../services/networkPolicy';
vi.mock('../services/networkPolicy', () => ({ assertNetworkAllowed: vi.fn() }));
const generation = 'a'.repeat(64),
    key = climateTileKey('-27,153');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const descriptor = async (data: Uint8Array) => ({
    bytes: data.length,
    sha256: Buffer.from(await webcrypto.subtle.digest('SHA-256', data)).toString('hex'),
});
async function source(cell = climateCellFixture()) {
    const tile = bytes({ schema: 1, generation, key, cells: [cell] });
    const manifest = bytes({
        schema: 1,
        kind: 'era5-climate',
        generation,
        firstYear: 1991,
        lastYear: 2020,
        gridDegrees: 1,
        originals: 720,
        dataset: 'reanalysis-era5-complete',
        licence: 'CC-BY-4.0',
        method: 'hourly-uv-swh-mwd-v1',
        originalCohortSha256: 'b'.repeat(64),
        generatedAt: '2026-10-17T00:00:00Z',
        tiles: { [key]: await descriptor(tile) },
    });
    return new Map([
        ['latest.json', bytes({ schema: 1, generation, manifest: await descriptor(manifest) })],
        [`${generation}/manifest.json`, manifest],
        [`${generation}/tile-${key}.json`, tile],
    ]);
}
const weights = () => new Map([['-27,153', 30]]);
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.mocked(assertNetworkAllowed).mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
describe('142 bounded immutable ERA5 climate reader', () => {
    it('verifies pointer, exact manifest and child hashes before adopting qualified cells', async () => {
        const files = await source();
        const fetcher = vi.fn(async (url: string, init: RequestInit) => {
            expect(init.redirect).toBe('error');
            const path = url.split('/climate/era5-v1/')[1];
            expect(path).toBeTruthy();
            return new Response(files.get(path) as BodyInit);
        });
        vi.stubGlobal('fetch', fetcher);
        const result = await readEra5Climate(weights(), new AbortController().signal);
        expect(result.cells.get('-27,153')?.months[0].windYears).toBe(2 ** 30 - 1);
        expect(result.generation).toBe(generation);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('refuses changed original period, child corruption and contradictory scientific counts', async () => {
        for (const corruption of ['period', 'hash', 'count']) {
            const cell = climateCellFixture();
            if (corruption === 'count') cell.months[0].galeCount++;
            const files = await source(cell);
            if (corruption === 'hash') files.set(`${generation}/tile-${key}.json`, bytes({ corrupted: true }));
            if (corruption === 'period') {
                const manifest = JSON.parse(new TextDecoder().decode(files.get(`${generation}/manifest.json`)));
                manifest.firstYear = 1981;
                const raw = bytes(manifest);
                files.set(`${generation}/manifest.json`, raw);
                files.set('latest.json', bytes({ schema: 1, generation, manifest: await descriptor(raw) }));
            }
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string) => new Response(files.get(url.split('/climate/era5-v1/')[1]) as BodyInit)),
            );
            await expect(readEra5Climate(weights(), new AbortController().signal)).rejects.toThrow(/Climate/);
        }
    });
    it('keeps an absent tile missing without borrowing another cell or making it calm', async () => {
        const files = await source();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(files.get(url.split('/climate/era5-v1/')[1]) as BodyInit)),
        );
        const result = await readEra5Climate(new Map([['0,0', 10]]), new AbortController().signal);
        expect(result.cells.size).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('honours network denial before touching fetch and refuses over-budget route windows', async () => {
        vi.stubGlobal('fetch', vi.fn());
        vi.mocked(assertNetworkAllowed).mockImplementation(() => {
            throw new Error('offline');
        });
        await expect(readEra5Climate(weights(), new AbortController().signal)).rejects.toThrow('offline');
        await expect(
            readEra5Climate(
                new Map(Array.from({ length: 129 }, (_, i) => [`0,${i}`, 1])),
                new AbortController().signal,
            ),
        ).rejects.toThrow(/limit/);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('retires ignored-abort native requests promptly but keeps both read slots charged until settlement', async () => {
        const files = await source();
        const pending: ((r: Response) => void)[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
        );
        const a = new AbortController(),
            b = new AbortController();
        const first = readEra5Climate(weights(), a.signal),
            second = readEra5Climate(weights(), b.signal);
        const settled = Promise.allSettled([first, second]);
        expect(pending).toHaveLength(2);
        a.abort();
        b.abort();
        expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
        await expect(readEra5Climate(weights(), new AbortController().signal)).rejects.toThrow(/capacity/);
        for (const resolve of pending) resolve(new Response(files.get('latest.json') as BodyInit));
        await new Promise((resolve) => setTimeout(resolve, 0));
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(files.get(url.split('/climate/era5-v1/')[1]) as BodyInit)),
        );
        expect((await readEra5Climate(weights(), new AbortController().signal)).cells.size).toBe(1);
    });
    it('rejects declared byte overflow before body allocation and aborts already retired input', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('{}', { headers: { 'Content-Length': '2049' } })),
        );
        await expect(readEra5Climate(weights(), new AbortController().signal)).rejects.toThrow();
        const c = new AbortController();
        c.abort();
        vi.mocked(fetch).mockClear();
        await expect(readEra5Climate(weights(), c.signal)).rejects.toThrow(/retired/);
        expect(fetch).not.toHaveBeenCalled();
    });
});
