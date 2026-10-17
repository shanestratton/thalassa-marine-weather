import { describe, expect, it, vi } from 'vitest';
import {
    assertLocalChartName,
    assertLocalChartSize,
    readLocalChartBytes,
    LOCAL_CHART_FILE_BYTES,
    localChartRasterDimensions,
} from '../services/charts/localChartLimits';

function page(size = 512): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode('SQLite format 3\0'));
    new DataView(bytes.buffer).setUint16(16, 512, false);
    return bytes;
}

describe('local chart whole-file admission', () => {
    it.each([
        '../chart.mbtiles',
        'chart/other.mbtiles',
        'chart\\other.mbtiles',
        'https://host/chart.mbtiles',
        'x.oesenc',
        'x.mbtiles?file=1',
        'x\0.mbtiles',
    ])('refuses a foreign path or format: %s', (name) => {
        expect(() => assertLocalChartName(name)).toThrow();
    });
    it('admits a plain local MBTiles basename', () => {
        expect(() => assertLocalChartName('My chart-2026.mbtiles')).not.toThrow();
    });
    it.each([NaN, Infinity, -1, 0, 511, 512.5, LOCAL_CHART_FILE_BYTES + 1])(
        'refuses an unknown or oversized stat: %s',
        (size) => {
            expect(() => assertLocalChartSize(size)).toThrow();
        },
    );
    it('admits both exact file-size boundaries', () => {
        expect(() => assertLocalChartSize(512)).not.toThrow();
        expect(() => assertLocalChartSize(LOCAL_CHART_FILE_BYTES)).not.toThrow();
    });
    it('reads an exact standalone SQLite page without arrayBuffer', async () => {
        const response = new Response(page(), { headers: { 'content-length': '512' } });
        const unbounded = vi.spyOn(response, 'arrayBuffer');
        expect(await readLocalChartBytes(response, 512)).toEqual(page());
        expect(unbounded).not.toHaveBeenCalled();
    });
    it('refuses a false declared size before asking for chunks', async () => {
        const pulled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ pull: pulled }, { highWaterMark: 0 });
        await expect(
            readLocalChartBytes(new Response(stream, { headers: { 'content-length': '900' } }), 512),
        ).rejects.toThrow('changed');
        expect(pulled).not.toHaveBeenCalled();
    });
    it('cancels a growing body at the original stat boundary', async () => {
        const cancel = vi.fn();
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(page());
                    controller.enqueue(new Uint8Array(1));
                },
                cancel,
            }),
        );
        await expect(readLocalChartBytes(response, 512)).rejects.toThrow('size limit');
        expect(cancel).toHaveBeenCalledOnce();
    });
    it('refuses truncation, HTML, and a malformed SQLite page size', async () => {
        await expect(readLocalChartBytes(new Response(page().slice(0, 511)), 512)).rejects.toThrow('incomplete');
        await expect(readLocalChartBytes(new Response(new Uint8Array(512)), 512)).rejects.toThrow('not a SQLite');
        const corrupt = page();
        new DataView(corrupt.buffer).setUint16(16, 513, false);
        await expect(readLocalChartBytes(new Response(corrupt), 512)).rejects.toThrow('page size');
    });
    it('propagates a failed disk read and refuses partial HTTP responses', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.error(new Error('Disk read failed'));
            },
        });
        await expect(readLocalChartBytes(new Response(stream), 512)).rejects.toThrow('Disk read failed');
        await expect(readLocalChartBytes(new Response(page(), { status: 206 }), 512)).rejects.toThrow(
            'could not be read',
        );
    });
});

describe('local chart decoder dimensions', () => {
    it('refuses a short PNG claiming a huge native decode', () => {
        const bytes = new Uint8Array(33),
            view = new DataView(bytes.buffer);
        view.setUint32(8, 13);
        view.setUint32(12, 0x49484452);
        view.setUint32(16, 100000);
        view.setUint32(20, 100000);
        expect(localChartRasterDimensions(bytes, 'image/png')).toBeNull();
        view.setUint32(16, 1024);
        view.setUint32(20, 1024);
        expect(localChartRasterDimensions(bytes, 'image/png')).toEqual([1024, 1024]);
        view.setUint32(20, 0);
        expect(localChartRasterDimensions(bytes, 'image/png')).toBeNull();
    });
    it('refuses animation and truncated WebP headers', () => {
        const bytes = new Uint8Array(30),
            view = new DataView(bytes.buffer);
        view.setUint32(12, 0x56503858);
        expect(localChartRasterDimensions(bytes, 'image/webp')).toEqual([1, 1]);
        bytes[20] = 2;
        expect(localChartRasterDimensions(bytes, 'image/webp')).toBeNull();
        expect(localChartRasterDimensions(bytes.subarray(0, 29), 'image/webp')).toBeNull();
    });
    it('reads bounded JPEG SOF dimensions and refuses malformed marker lengths', () => {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 1, 0, 1, 0, 1]);
        expect(localChartRasterDimensions(bytes, 'image/jpeg')).toEqual([256, 256]);
        bytes[5] = 1;
        expect(localChartRasterDimensions(bytes, 'image/jpeg')).toBeNull();
        expect(localChartRasterDimensions(bytes, 'image/gif')).toBeNull();
    });
});
