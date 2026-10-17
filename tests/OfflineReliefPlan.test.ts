import { describe, expect, it, vi } from 'vitest';
import {
    RELIEF_TILE_MAX_BYTES,
    planReliefArea,
    readReliefBytes,
    reliefTile,
    validateReliefBytes,
} from '../services/offlineReliefPlan';
import { RELIEF_TILE_BASE } from '../components/map/reliefBase';

function reliefImage(mime = 'image/png', size = 44): Uint8Array<ArrayBuffer> {
    const b = new Uint8Array(size),
        d = new DataView(b.buffer);
    if (mime === 'image/png') {
        b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        d.setUint32(16, 256);
        d.setUint32(20, 256);
    } else {
        b.set([82, 73, 70, 70]);
        d.setUint32(4, size - 8, true);
        b.set([87, 69, 66, 80, 86, 80, 56, 76], 8);
        d.setUint32(16, size - 20, true);
        b.set([47, 255, 192, 63, 0], 20);
    }
    return b;
}
describe('owned offline relief plan', () => {
    it('uses the actual reliefBase paths, both images and the supported zooms only', () => {
        const p = planReliefArea({ north: -26.9, south: -27, west: 153, east: 153.01 }, 13, RELIEF_TILE_BASE);
        expect(p.tooLarge).toBe(false);
        expect(p.tileCount).toBe(p.tiles.length);
        expect(new Set(p.tiles.map((t) => Number(t.url.split('/')[6])))).toContain(13);
        expect(p.tiles.some((t) => t.url.includes('/relief-au/dem/13/'))).toBe(true);
        expect(p.tiles.every((t) => reliefTile(t.url)?.key === t.key)).toBe(true);
        expect(
            p.tiles.filter((t) => t.url.includes('relief-global')).every((t) => Number(t.url.split('/')[6]) <= 9),
        ).toBe(true);
        expect(p.tiles.filter((t) => t.url.includes('relief-au')).every((t) => Number(t.url.split('/')[6]) >= 8)).toBe(
            true,
        );
    });
    it('never allocates an unbounded world request, omits GBR outside Queensland and retains sparse NZ', () => {
        const world = planReliefArea({ north: 90, south: -90, west: -180, east: 180 }, 13);
        expect(world.tooLarge).toBe(true);
        expect(world.tileCount).toBeGreaterThan(4096);
        expect(world.tiles).toEqual([]);
        const nz = planReliefArea({ north: -36, south: -36.01, west: 175, east: 175.01 }, 13);
        expect(nz.tiles.every((t) => /\/relief-(global|nz)\//.test(t.url))).toBe(true);
        expect(nz.tiles.some((t) => t.url.includes('/relief-nz/'))).toBe(true);
        const polar = planReliefArea({ north: 90, south: 89, west: 10, east: 11 }, 4);
        expect(polar.tiles.length).toBeGreaterThan(0);
        expect(polar.tiles.every((t) => Number(t.url.split('/')[8].split('.')[0]) === 0)).toBe(true);
    });
    it('takes the narrow dateline crossing and counts duplicate low-zoom tiles once', () => {
        const p = planReliefArea({ north: 1, south: -1, west: 179, east: -179 }, 4);
        expect(p.tooLarge).toBe(false);
        expect(new Set(p.tiles.map((t) => t.key)).size).toBe(p.tileCount);
        expect(p.tiles.filter((t) => t.url.includes('/0/0/0.'))).toHaveLength(2);
        for (const tile of p.tiles) {
            const z = Number(tile.url.split('/')[6]),
                x = Number(tile.url.split('/')[7]);
            expect(x === 0 || x === 2 ** z - 1).toBe(true);
        }
    });
    it.each([
        'https://api.mapbox.com/v1/relief-global/idx/0/0/0.png',
        'https://tile.openstreetmap.org/0/0/0.png',
        'https://evil.tiles.thalassatiles.com/v1/relief-global/idx/0/0/0.png',
        'https://tiles.thalassatiles.com/v1/relief-global/idx/10/0/0.png',
        'https://tiles.thalassatiles.com/v1/relief-au/dem/7/0/0.webp',
        'https://tiles.thalassatiles.com/v1/relief-au/dem/8/0/0.webp',
        'https://tiles.thalassatiles.com/v1/relief-global/dem/0/0/0.png',
        'https://tiles.thalassatiles.com/v1/relief-global/idx/1/2/0.png',
        'https://tiles.thalassatiles.com/v1/relief-global/idx/0/00/0.png',
        'https://tiles.thalassatiles.com/v1/relief-global/idx/0/0/0.png?token=secret',
        'https://u:p@tiles.thalassatiles.com/v1/relief-global/idx/0/0/0.png',
        'https://tiles.thalassatiles.com/v1/chart-vault/a.png',
    ])('refuses paths outside the public terrain contract: %s', (url) => expect(reliefTile(url)).toBeNull());
    it('rejects invalid or zero-area bounds and arbitrary configured hosts', () => {
        for (const b of [
            { north: NaN, south: 0, west: 0, east: 1 },
            { north: 0, south: 1, west: 0, east: 1 },
            { north: 1, south: 0, west: 3, east: 3 },
            { north: 91, south: 0, west: 0, east: 1 },
        ])
            expect(() => planReliefArea(b, 9)).toThrow();
        expect(() => planReliefArea({ north: 1, south: 0, west: 0, east: 1 }, 9, 'https://tiles.example/v1')).toThrow();
    });
    it('checks image magic, dimensions, RIFF length, MIME and byte limits', async () => {
        for (const mime of ['image/png', 'image/webp'] as const)
            expect(
                await readReliefBytes(new Response(reliefImage(mime), { headers: { 'content-type': mime } }), mime),
            ).toHaveLength(44);
        expect(() => validateReliefBytes(new TextEncoder().encode('<html>not a tile</html>'), 'image/png')).toThrow();
        const wrong = reliefImage();
        new DataView(wrong.buffer).setUint32(16, 1024);
        expect(() => validateReliefBytes(wrong, 'image/png')).toThrow();
        const truncated = reliefImage('image/webp');
        truncated[4]++;
        expect(() => validateReliefBytes(truncated, 'image/webp')).toThrow();
        await expect(
            readReliefBytes(new Response(reliefImage(), { headers: { 'content-type': 'text/html' } }), 'image/png'),
        ).rejects.toThrow();
        await expect(
            readReliefBytes(
                new Response(reliefImage(), {
                    headers: { 'content-type': 'image/png', 'content-length': String(RELIEF_TILE_MAX_BYTES + 1) },
                }),
                'image/png',
            ),
        ).rejects.toThrow();
        const cancel = vi.fn(),
            stream = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(new Uint8Array(RELIEF_TILE_MAX_BYTES + 1));
                },
                cancel,
            });
        await expect(
            readReliefBytes(new Response(stream, { headers: { 'content-type': 'image/png' } }), 'image/png'),
        ).rejects.toThrow();
        expect(cancel).toHaveBeenCalledOnce();
    });
});
