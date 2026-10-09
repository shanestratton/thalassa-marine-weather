/**
 * The marine place-name reference is a data file, not JavaScript (build 126
 * bundle diet). It used to be bundled into its own 124 KB JS chunk; it now
 * lives at public/data/marine-place-names-qld.json, fetched once and kept in
 * memory.
 *
 * public/ is copied into dist/ and from there into the iOS app by cap sync,
 * so the file is ON THE PHONE: a same-origin fetch of it works with no
 * signal at all. That is the airplane-mode test below — every network
 * request fails, and the packaged file still names the anchorage.
 *
 * The reference is regional (the Queensland gazetteer is what we hold). A
 * fix anywhere else must not even open the file: the global geocoder
 * fallback in the callers handles the rest of the world.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packagedFetch } from './helpers/packagedFetch';

vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { get: vi.fn().mockRejectedValue(new Error('The Internet connection appears to be offline.')) },
}));

const ROOT = process.cwd();
const PLACES_URL = '/data/marine-place-names-qld.json';

let fetchMock: ReturnType<typeof packagedFetch>;

beforeEach(async () => {
    vi.resetModules();
    // Airplane mode: only files packaged in the app (public/) answer.
    fetchMock = packagedFetch();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('marine place names in airplane mode', () => {
    it('names Daydream Island from the packaged file with every network request failing', async () => {
        const { marineEndpointName } = await import('../services/marineEndpointName');
        expect(await marineEndpointName(-20.2543216666667, 148.815016666667)).toBe('Daydream Island');
        expect(fetchMock).toHaveBeenCalledWith(PLACES_URL);
    });

    it('fetches the file once and answers later lookups from memory', async () => {
        const { marineEndpointName } = await import('../services/marineEndpointName');
        await Promise.all([
            marineEndpointName(-20.2543216666667, 148.815016666667),
            marineEndpointName(-19.8504027, 147.9602496),
        ]);
        await marineEndpointName(-20.2543216666667, 148.815016666667);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not open the file for a fix outside the regional reference', async () => {
        const { marineEndpointName } = await import('../services/marineEndpointName');
        // The Solent, the Bay of Islands (NZ), the British Virgin Islands, Phuket.
        for (const [lat, lon] of [
            [50.77, -1.3],
            [-35.22, 174.12],
            [18.43, -64.62],
            [7.82, 98.3],
        ]) {
            expect(await marineEndpointName(lat, lon)).toBeNull();
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a missing file is no name, not a crash, and is retried next time', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
        const { marineEndpointName } = await import('../services/marineEndpointName');
        expect(await marineEndpointName(-20.2543216666667, 148.815016666667)).toBeNull();
        expect(await marineEndpointName(-20.2543216666667, 148.815016666667)).toBe('Daydream Island');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('the reference ships as a data file, not as JavaScript', () => {
    it('lives in public/data with every place the gazetteer refresh verified', () => {
        expect(existsSync(join(ROOT, 'data/marine-place-names-qld.json'))).toBe(false);
        const places = JSON.parse(readFileSync(join(ROOT, 'public', PLACES_URL), 'utf8')) as {
            id: string;
            kind: string;
        }[];
        // Counts from data/marine-place-names-qld.SOURCES.md (retrieved 2026-09-25).
        expect(places).toHaveLength(1196);
        const kinds = places.reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {});
        expect(kinds).toEqual({ island: 891, bay: 266, harbour: 27, anchorage: 12 });
        expect(new Set(places.map((p) => p.id)).size).toBe(1196);
    });

    it('is fetched, never imported into a chunk', () => {
        const service = readFileSync(join(ROOT, 'services/marineEndpointName.ts'), 'utf8');
        expect(service).not.toMatch(/import\(['"][^'"]*marine-place-names/);
        expect(service).not.toMatch(/from ['"][^'"]*marine-place-names/);
        expect(service).toContain(`'${PLACES_URL}'`);
    });

    it('the refresh script writes the public copy', () => {
        const script = readFileSync(join(ROOT, 'scripts/refresh-marine-place-names-qld.mjs'), 'utf8');
        expect(script).toContain("'../public/data/marine-place-names-qld.json'");
    });
});
