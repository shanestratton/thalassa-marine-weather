import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import expected from './fixtures/local-charts142/expected.json';
import { decodeKap } from '../services/charts/decodeKap';
import { decodeGeoTiff } from '../services/charts/decodeGeoTiff';
import { rasterDeadline, inverseWgs84Mercator, wgs84Mercator } from '../services/charts/localRasterContract';

const root = resolve(process.cwd(), 'tests/fixtures/local-charts142');
const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(resolve(root, name)));
interface ExpectedImage {
    sha256: string;
    bounds?: number[];
    width?: number;
    height?: number;
    displayRgba?: number[];
}
const reference: Record<string, ExpectedImage> = expected.files;
const noDeadline = () => undefined;
function tiffTag(bytes: Uint8Array, id: number) {
    const little = bytes[0] === 73,
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directory = view.getUint32(4, little),
        count = view.getUint16(directory, little);
    for (let i = 0; i < count; i++) {
        const at = directory + 2 + 12 * i;
        if (view.getUint16(at, little) === id)
            return {
                at,
                little,
                view,
                type: view.getUint16(at + 2, little),
                count: view.getUint32(at + 4, little),
                data:
                    view.getUint32(at + 4, little) * (view.getUint16(at + 2, little) === 3 ? 2 : 4) <= 4
                        ? at + 8
                        : view.getUint32(at + 8, little),
            };
    }
    throw new Error('Fixture tag missing: ' + id);
}
function scalar(bytes: Uint8Array, id: number, value: number) {
    const tag = tiffTag(bytes, id);
    if (tag.type === 3) tag.view.setUint16(tag.data, value, tag.little);
    else tag.view.setUint32(tag.data, value, tag.little);
}
function key(bytes: Uint8Array, id: number, value: number) {
    const tag = tiffTag(bytes, 34735),
        count = tag.view.getUint16(tag.data + 6, tag.little);
    for (let i = 0; i < count; i++) {
        const at = tag.data + 8 + i * 8;
        if (tag.view.getUint16(at, tag.little) === id) {
            tag.view.setUint16(at + 6, value, tag.little);
            return;
        }
    }
    throw new Error('Fixture GeoKey missing.');
}
function kapChange(bytes: Uint8Array, before: string, after: string): Uint8Array<ArrayBuffer> {
    const marker = bytes.findIndex((value, i) => value === 26 && bytes[i + 1] === 0);
    const header = new TextDecoder().decode(bytes.subarray(0, marker));
    expect(header).toContain(before);
    const changed = new TextEncoder().encode(header.replace(before, after));
    const result = new Uint8Array(changed.length + bytes.length - marker);
    result.set(changed);
    result.set(bytes.subarray(marker), changed.length);
    return result;
}
describe('actual own KAP and native Pillow/libtiff format fixtures', () => {
    it.each([
        'rgb-4326-raw.tif',
        'rgb-4326-deflate.tif',
        'rgb-3857-packbits.tif',
        'rgba-4326.tif',
        'gray-nodata.tif',
        'point-4326.tif',
        'phone.tif',
    ])('matches independent original/warped pixels and exact georeferencing: %s', (name) => {
        const raw = fixture(name),
            saved = reference[name];
        expect(createHash('sha256').update(raw).digest('hex')).toBe(saved.sha256);
        const result = decodeGeoTiff(raw, noDeadline);
        expect([result.width, result.height]).toEqual([saved.width, saved.height]);
        expect([...result.rgba]).toEqual(saved.displayRgba);
        result.bounds.forEach((value, index) => expect(value).toBeCloseTo(saved.bounds![index], 10));
        expect(result.datum).toBe('WGS84');
    });
    it.each(['own-mercator.kap', 'own-cutline.kap', 'phone.kap'])(
        'reads exact documented KAP runs, mask and optional original row index: %s',
        (name) => {
            const raw = fixture(name),
                saved = reference[name];
            expect(createHash('sha256').update(raw).digest('hex')).toBe(saved.sha256);
            const result = decodeKap(raw, noDeadline);
            expect([...result.rgba]).toEqual(saved.displayRgba);
            result.bounds.forEach((value, index) => expect(value).toBeCloseTo(saved.bounds![index], 10));
            expect(result.note).toContain('UNVERIFIED TEST ONLY');
        },
    );
    it('uses the explicit ellipsoidal Mercator inverse, including high-latitude round trips', () => {
        for (const lat of [-85, -27, 0, 50, 75, 85])
            expect(inverseWgs84Mercator(wgs84Mercator(lat))).toBeCloseTo(lat, 11);
    });
    it.each([
        ['GD=WGS84', 'GD=NAD83', 'datum'],
        ['PR=MERCATOR', 'PR=TRANSVERSE MERCATOR', 'projection'],
        ['SK=0', 'SK=2', 'Skewed'],
        ['DTM/0,0', 'DTM/1,0', 'datum shifts'],
        ['REF/4,8,8,50,150.08', 'REF/4,8,8,53,150.08', 'inconsistent'],
    ])('refuses unsupported original KAP georeferencing: %s', (before, after, reason) => {
        expect(() => decodeKap(kapChange(fixture('own-mercator.kap'), before, after), noDeadline)).toThrow(reason);
    });
    it('holds an unreferenced KAP image and an oversized raster before expansion', () => {
        const original = fixture('phone.kap');
        const withoutRef = kapChange(original, 'REF/1,0,0,-27,152.9', '!No point');
        const fewer = kapChange(
            kapChange(withoutRef, 'REF/2,8,0,-27,153.1', '!No point'),
            'REF/3,0,8,-27.2,152.9',
            '!No point',
        );
        expect(() => decodeKap(fewer, noDeadline)).toThrow('registration points');
        expect(() => decodeKap(kapChange(original, 'RA=8,8', 'RA=8192,8192'), noDeadline)).toThrow('1024');
    });
    it('refuses incomplete or overflowing KAP rows and changed original row offsets', () => {
        const raw = fixture('own-mercator.kap'),
            data = raw.findIndex((value, i) => value === 26 && raw[i + 1] === 0) + 3;
        const wrongRow = new Uint8Array(raw);
        wrongRow[data] = 4;
        expect(() => decodeKap(wrongRow, noDeadline)).toThrow('out of order');
        const overflow = new Uint8Array(raw);
        overflow[data + 1] = 63;
        expect(() => decodeKap(overflow, noDeadline)).toThrow('overruns');
        const wrongIndex = new Uint8Array(raw);
        wrongIndex[wrongIndex.length - 1] ^= 1;
        expect(() => decodeKap(wrongIndex, noDeadline)).toThrow('row index');
        expect(() => decodeKap(raw.subarray(0, data + 3), noDeadline)).toThrow('truncated');
    });
    it('refuses unknown/conflicting GeoTIFF CRS and unknown pixel-centre semantics', () => {
        for (const [id, value] of [
            [2048, 4269],
            [1024, 1],
            [1025, 0],
        ]) {
            const raw = fixture('rgb-4326-raw.tif');
            key(raw, id, value);
            expect(() => decodeGeoTiff(raw, noDeadline)).toThrow(/CRS|PixelIsArea/);
        }
    });
    it('refuses polar bounds, oversized source pixels, BigTIFF and unsupported LZW before any strip expansion', () => {
        const large = fixture('rgb-4326-deflate.tif');
        scalar(large, 256, 8192);
        expect(() => decodeGeoTiff(large, noDeadline)).toThrow('1024');
        const big = fixture('rgb-4326-raw.tif');
        big[2] = 43;
        expect(() => decodeGeoTiff(big, noDeadline)).toThrow('BigTIFF');
        const lzw = fixture('rgb-4326-raw.tif');
        scalar(lzw, 259, 5);
        expect(() => decodeGeoTiff(lzw, noDeadline)).toThrow('compression');
        const polar = fixture('rgb-4326-raw.tif'),
            tie = tiffTag(polar, 33922);
        tie.view.setFloat64(tie.view.getUint32(tie.at + 8, tie.little) + 4 * 8, 90, tie.little);
        expect(() => decodeGeoTiff(polar, noDeadline)).toThrow('polar');
    });
    it('refuses an actual compressed expansion bomb using its admitted pixel count', () => {
        const base = fixture('rgb-4326-deflate.tif'),
            bomb = deflateSync(new Uint8Array(2 * 1024 * 1024));
        const raw = new Uint8Array(base.length + bomb.length);
        raw.set(base);
        raw.set(bomb, base.length);
        scalar(raw, 256, 1);
        scalar(raw, 257, 1);
        scalar(raw, 273, base.length);
        scalar(raw, 279, bomb.length);
        expect(() => decodeGeoTiff(raw, noDeadline)).toThrow('expands beyond');
    });
    it('refuses a mismatched compressed checksum and incomplete raw strip', () => {
        const raw = fixture('rgb-4326-deflate.tif'),
            strip = tiffTag(raw, 273),
            length = tiffTag(raw, 279);
        const at =
            strip.type === 3
                ? strip.view.getUint16(strip.data, strip.little)
                : strip.view.getUint32(strip.data, strip.little);
        const size =
            length.type === 3
                ? length.view.getUint16(length.data, length.little)
                : length.view.getUint32(length.data, length.little);
        raw[at + size - 1] ^= 1;
        expect(() => decodeGeoTiff(raw, noDeadline)).toThrow('checksum');
        const short = fixture('rgb-4326-raw.tif');
        scalar(short, 279, 4);
        expect(() => decodeGeoTiff(short, noDeadline)).toThrow('strip length');
    });
    it('shares the monotonic parse/inflate/output deadline and a caller retirement check', () => {
        let clock = 0;
        const current = vi.fn();
        const check = rasterDeadline(current, () => clock);
        clock = 15_000;
        expect(() => decodeGeoTiff(fixture('rgb-4326-raw.tif'), check)).toThrow('15 seconds');
        expect(current).toHaveBeenCalled();
        const stopped = () => {
            throw new Error('retired');
        };
        expect(() => decodeKap(fixture('phone.kap'), stopped)).toThrow('retired');
    });
});
