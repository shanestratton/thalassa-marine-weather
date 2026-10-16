import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReliefAvailability, reliefAvailableRanges } from '../services/reliefAvailability';
import nz61 from './fixtures/relief/nz61-availability.json';

const expected = { region: 'nz', version: 'v2', minzoom: 8, maxzoom: 14 };
const manifest = {
    schema: 1,
    ...expected,
    tilePairs: 4,
    rows: [
        [8, 153, 251, 252],
        [8, 153, 254, 254],
        [14, 9800, 16000, 16000],
    ],
};
afterEach(() => {
    vi.doUnmock('../services/reliefDisplayRegions');
    vi.resetModules();
});
describe('exact regional relief availability', () => {
    it('accepts actual completed LINZ availability and uses it in the bounded offline consumer', async () => {
        // Public provider fixture:2,197 finite-source pairs verified against all
        // 6,425 original checkpoints and6,591 decoded/hash-checked images.
        const availability = parseReliefAvailability(nz61, expected)!;
        expect(availability?.tilePairs).toBe(2197);
        expect(availability?.rows).toHaveLength(724);
        vi.resetModules();
        vi.doMock('../services/reliefDisplayRegions', async (original) => {
            const actual = await original<typeof import('../services/reliefDisplayRegions')>();
            return {
                ...actual,
                RELIEF_DISPLAY_REGIONS: [
                    {
                        id: 'nz',
                        version: 'v2',
                        minzoom: 8,
                        maxzoom: 14,
                        bounds: [166, -48, 179, -33],
                        tintFade: [14.5, 15.5],
                        shadeFade: [14.5, 15.5],
                        datum: 'NZVD2016; GEBCO fallback',
                        availability,
                    },
                ],
            };
        });
        const { planReliefArea, reliefTile } = await import('../services/offlineReliefPlan');
        const whole = planReliefArea({ west: 166, east: 179, south: -48, north: -33 }, 14);
        expect(whole).toMatchObject({ tileCount: 4394, tooLarge: true, tiles: [] });
        const [z, y, x] = availability.rows.find((row) => row[0] === 14)!;
        const longitude = (tx: number) => (tx / 2 ** z) * 360 - 180;
        const latitude = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI;
        const area = planReliefArea(
            {
                west: longitude(x) + 1e-7,
                east: longitude(x + 1) - 1e-7,
                south: latitude(y + 1) + 1e-7,
                north: latitude(y) - 1e-7,
            },
            14,
        );
        expect(area.tooLarge).toBe(false);
        expect(area.tiles.some((tile) => tile.url.includes(`/14/${x}/${y}.`))).toBe(true);
        expect(area.tiles.every((tile) => reliefTile(tile.url)?.key === tile.key)).toBe(true);
        expect(area.tileCount).toBe(area.tiles.length);
    });
    it('accepts canonical builder rows and preserves holes when clipping a saved area', () => {
        const result = parseReliefAvailability(manifest, expected)!;
        expect(result).not.toBeNull();
        expect(reliefAvailableRanges(result, 8, 250, 255, 152, 154)).toEqual([
            { x0: 251, x1: 252, y0: 153, y1: 153 },
            { x0: 254, x1: 254, y0: 153, y1: 153 },
        ]);
        expect(reliefAvailableRanges(result, 8, 253, 253, 153, 153)).toEqual([]);
    });
    it.each([
        { version: 'v1' },
        { tilePairs: 3 },
        {
            rows: [
                [8, 153, 251, 252],
                [8, 153, 252, 254],
            ],
        },
        {
            rows: [
                [8, 153, 251, 252],
                [8, 153, 253, 254],
            ],
        },
        { rows: [[8, 256, 1, 4]] },
        { rows: [[15, 153, 1, 4]] },
        { rows: [[8, 153, 1.5, 4.5]] },
        { rows: [[8, 153, 254, 256]] },
    ])('refuses changed identity, invalid coordinates, overlap or noncanonical rows: %o', (change) => {
        expect(parseReliefAvailability({ ...manifest, ...change }, expected)).toBeNull();
    });
    it('plans only actually emitted regional pairs while retaining global fallback and strict tile URLs', async () => {
        vi.resetModules();
        vi.doMock('../services/reliefDisplayRegions', async (original) => {
            const actual = await original<typeof import('../services/reliefDisplayRegions')>();
            return {
                ...actual,
                RELIEF_DISPLAY_REGIONS: [
                    ...actual.RELIEF_DISPLAY_REGIONS,
                    {
                        id: 'nz',
                        version: 'v2',
                        minzoom: 8,
                        maxzoom: 14,
                        bounds: [170, -50, 180, -30],
                        tintFade: [14.5, 15.5],
                        shadeFade: [14.5, 15.5],
                        datum: 'NZVD2016; GEBCO fallback',
                        availability: parseReliefAvailability(manifest, expected),
                    },
                ],
            };
        });
        const { reliefTile, planReliefArea } = await import('../services/offlineReliefPlan');
        const missing = 'https://tiles.thalassatiles.com/v2/relief-nz/idx/8/253/153.png';
        const present = missing.replace('/253/', '/252/');
        expect(reliefTile(missing)).toBeNull();
        expect(reliefTile(present)).toMatchObject({ key: 'v2_nz_idx_8_252_153.png' });
        const plan = planReliefArea({ west: 172, east: 179, south: -36, north: -32 }, 8);
        const regional = plan.tiles.filter((tile) => tile.url.includes('/relief-nz/'));
        expect(regional).toHaveLength(6);
        expect(regional.some((tile) => tile.url.includes('/253/'))).toBe(false);
        expect(plan.tiles.some((tile) => tile.url.includes('/relief-global/'))).toBe(true);
        expect(plan.tileCount).toBe(plan.tiles.length);
    });
});
