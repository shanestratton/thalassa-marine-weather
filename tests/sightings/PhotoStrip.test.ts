/**
 * A sighting photo must never carry a position: every metadata segment is
 * removed from the re-encoded JPEG and the result is checked again; any
 * failure throws and the original file is never used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PHOTO_MAX_BYTES,
    PhotoStripError,
    jpegHasMetadata,
    stripAndCompressPhoto,
    stripJpegMetadata,
} from '../../services/sightings/photoStrip';

function segment(marker: number, payload: number[]): number[] {
    const length = payload.length + 2;
    return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const SOI = [0xff, 0xd8];
const APP0_JFIF = segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
// An EXIF block with a (fictional) GPS IFD marker in it.
const APP1_EXIF = segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('MM'), 0, 0x2a, ...ascii('GPS-19.1200S146.8800E')]);
const APP1_XMP = segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta/>')]);
const APP2_ICC = segment(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, ...ascii('sRGB')]);
const APP13_IPTC = segment(0xed, [...ascii('Photoshop 3.0'), 0, ...ascii('8BIM')]);
const COM = segment(0xfe, ascii('Kittiwake Run, anchored off Bait Reef'));
const DQT = segment(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const SOS_AND_DATA = [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9];

const jpeg = (...parts: number[][]) => new Uint8Array(parts.flat());

/** jsdom's Blob has no arrayBuffer(): read it the old way. */
function readBytes(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
}

describe('jpegHasMetadata', () => {
    it('passes a clean JPEG (JFIF, ICC profile, tables)', () => {
        expect(jpegHasMetadata(jpeg(SOI, APP0_JFIF, APP2_ICC, DQT, SOS_AND_DATA))).toBe(false);
    });

    it('catches EXIF, XMP, Photoshop/IPTC and comments', () => {
        for (const meta of [APP1_EXIF, APP1_XMP, APP13_IPTC, COM]) {
            expect(jpegHasMetadata(jpeg(SOI, APP0_JFIF, meta, DQT, SOS_AND_DATA))).toBe(true);
        }
    });

    it('refuses what it cannot read', () => {
        expect(() => jpegHasMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(PhotoStripError);
        expect(() => jpegHasMetadata(jpeg(SOI, APP0_JFIF.slice(0, 6)))).toThrow(PhotoStripError);
        expect(() => jpegHasMetadata(jpeg(SOI, APP0_JFIF))).toThrow(PhotoStripError);
    });
});

describe('stripJpegMetadata', () => {
    it('removes every metadata segment and copies the image untouched', () => {
        const dirty = jpeg(SOI, APP0_JFIF, APP1_EXIF, APP2_ICC, APP1_XMP, APP13_IPTC, COM, DQT, SOS_AND_DATA);
        const clean = stripJpegMetadata(dirty);
        expect(jpegHasMetadata(clean)).toBe(false);
        expect([...clean]).toEqual([...SOI, ...APP0_JFIF, ...APP2_ICC, ...DQT, ...SOS_AND_DATA]);
        expect(new TextDecoder().decode(clean)).not.toMatch(/Exif|GPS|xap|8BIM|Bait Reef/);
    });
});

describe('stripAndCompressPhoto', () => {
    let encoded: (quality: number) => Blob | null;
    const drawn: Array<{ width: number; height: number }> = [];

    beforeEach(() => {
        drawn.length = 0;
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => ({ width: 4032, height: 3024, close: vi.fn() })),
        );
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
            drawn.push({ width: this.width, height: this.height });
            return { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' } as never;
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
            this: HTMLCanvasElement,
            callback: BlobCallback,
            _type?: string,
            quality?: number,
        ) {
            callback(encoded(quality ?? 0.92));
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('re-draws at most 1600 px and returns a JPEG with no metadata, even when the encoder adds EXIF', async () => {
        // iOS ImageIO-style output: its own EXIF block on the re-encoded image.
        encoded = () => new Blob([jpeg(SOI, APP0_JFIF, APP1_EXIF, DQT, SOS_AND_DATA)], { type: 'image/jpeg' });
        const original = new Blob([jpeg(SOI, APP1_EXIF, DQT, SOS_AND_DATA)], { type: 'image/jpeg' });
        const out = await stripAndCompressPhoto(original);
        expect(drawn[0]).toEqual({ width: 1600, height: 1200 });
        expect(out.type).toBe('image/jpeg');
        const bytes = await readBytes(out);
        expect(jpegHasMetadata(bytes)).toBe(false);
        expect(out).not.toBe(original);
    });

    it('throws when the canvas cannot encode, and never falls back to the original', async () => {
        encoded = () => null;
        const original = new Blob([jpeg(SOI, APP1_EXIF, DQT, SOS_AND_DATA)], { type: 'image/jpeg' });
        await expect(stripAndCompressPhoto(original)).rejects.toBeInstanceOf(PhotoStripError);
    });

    it('steps quality and size down to fit 2 MB, and throws if it never fits', async () => {
        const big = new Uint8Array(PHOTO_MAX_BYTES + 10);
        big.set(jpeg(SOI, APP0_JFIF, DQT, SOS_AND_DATA.slice(0, 10)));
        const qualities: number[] = [];
        encoded = (q) => {
            qualities.push(q);
            return q < 0.7 && drawn.length > 1
                ? new Blob([jpeg(SOI, APP0_JFIF, DQT, SOS_AND_DATA)], { type: 'image/jpeg' })
                : new Blob([big], { type: 'image/jpeg' });
        };
        const out = await stripAndCompressPhoto(new Blob([big]));
        expect(qualities).toEqual([0.82, 0.6, 0.82, 0.6]);
        expect(drawn.map((d) => d.width)).toEqual([1600, 1200]);
        expect(out.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);

        encoded = () => new Blob([big], { type: 'image/jpeg' });
        await expect(stripAndCompressPhoto(new Blob([big]))).rejects.toThrow(/too large/);
    });
});
