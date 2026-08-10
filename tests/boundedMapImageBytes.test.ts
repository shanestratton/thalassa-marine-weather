import { describe, expect, it } from 'vitest';
import { pruneMap } from '../utils/boundedMap';
import { looksGzipped, sniffImageMime } from '../utils/imageBytes';

describe('pruneMap', () => {
    it('evicts expired entries first, then oldest down to the cap', () => {
        const map = new Map<string, { at: number }>();
        map.set('stale', { at: 0 });
        map.set('a', { at: 100 });
        map.set('b', { at: 200 });
        map.set('c', { at: 300 });
        pruneMap(map, 2, (v) => v.at === 0);
        expect([...map.keys()]).toEqual(['b', 'c']);
    });

    it('is a no-op when under the cap with nothing expired', () => {
        const map = new Map([['k', 1]]);
        pruneMap(map, 5);
        expect(map.size).toBe(1);
    });
});

describe('sniffImageMime', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

    it('identifies PNG and JPEG', () => {
        expect(sniffImageMime(png)).toBe('image/png');
        expect(sniffImageMime(jpeg)).toBe('image/jpeg');
    });

    it('accepts a complete WebP and rejects a truncated one', () => {
        // RIFF, declared chunk size 4 (total 12 bytes), WEBP.
        const complete = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        expect(sniffImageMime(complete)).toBe('image/webp');
        // Same header but declared size says 1000 bytes should follow.
        const truncated = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xe8, 0x03, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        expect(sniffImageMime(truncated)).toBeNull();
        // Prefix-slice sniffing: same truncated header, but the caller vouches
        // for a big enough total body.
        expect(sniffImageMime(truncated, 1008)).toBe('image/webp');
    });

    it('rejects HTML error pages and empty bodies', () => {
        const html = new TextEncoder().encode('<!DOCTYPE HTML><html><head>');
        expect(sniffImageMime(html)).toBeNull();
        expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    });

    it('spots gzip (vector PBF) streams', () => {
        expect(looksGzipped(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
        expect(looksGzipped(new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false);
    });
});
