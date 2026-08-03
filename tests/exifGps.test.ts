import { describe, it, expect } from 'vitest';
import { parseExif } from '../utils/exifGps';

/**
 * Build a minimal JPEG head containing an EXIF APP1 with a GPS IFD
 * (and optionally an Exif IFD with DateTimeOriginal). Little-endian
 * TIFF unless bigEndian is set.
 */
function buildJpegWithGps(opts: {
    lat: [number, number, number];
    latRef: 'N' | 'S';
    lon: [number, number, number];
    lonRef: 'E' | 'W';
    bigEndian?: boolean;
    dateTimeOriginal?: string;
    zeroDenominator?: boolean;
}): DataView {
    const le = !opts.bigEndian;
    const buf = new ArrayBuffer(2048);
    const v = new DataView(buf);
    const w16 = (o: number, val: number) => v.setUint16(o, val, le);
    const w32 = (o: number, val: number) => v.setUint32(o, val, le);

    v.setUint16(0, 0xffd8); // SOI
    v.setUint16(2, 0xffe1); // APP1
    v.setUint16(4, 2000); // APP1 size (generous)
    v.setUint32(6, 0x45786966); // "Exif"
    v.setUint16(10, 0x0000);
    const tiff = 12;
    v.setUint16(tiff, opts.bigEndian ? 0x4d4d : 0x4949);
    w16(tiff + 2, 0x002a);
    w32(tiff + 4, 8); // IFD0 at tiff+8

    // IFD0: GPS pointer (+ optional Exif pointer)
    const ifd0 = tiff + 8;
    const entryCount = opts.dateTimeOriginal ? 2 : 1;
    w16(ifd0, entryCount);
    let e = ifd0 + 2;
    const gpsIfdRel = 200;
    // 0x8825 GPS IFD pointer, type LONG, count 1
    w16(e, 0x8825);
    w16(e + 2, 4);
    w32(e + 4, 1);
    w32(e + 8, gpsIfdRel);
    e += 12;
    const exifIfdRel = 400;
    if (opts.dateTimeOriginal) {
        w16(e, 0x8769);
        w16(e + 2, 4);
        w32(e + 4, 1);
        w32(e + 8, exifIfdRel);
        e += 12;
    }
    w32(e, 0); // next-IFD terminator

    // GPS IFD: latRef, lat, lonRef, lon
    const gps = tiff + gpsIfdRel;
    w16(gps, 4);
    let g = gps + 2;
    const writeRef = (tag: number, ch: string) => {
        w16(g, tag);
        w16(g + 2, 2); // ASCII
        w32(g + 4, 2);
        v.setUint8(g + 8, ch.charCodeAt(0));
        v.setUint8(g + 9, 0);
        g += 12;
    };
    const writeDms = (tag: number, valsRel: number, dms: [number, number, number]) => {
        w16(g, tag);
        w16(g + 2, 5); // RATIONAL
        w32(g + 4, 3);
        w32(g + 8, valsRel);
        const o = tiff + valsRel;
        const den = opts.zeroDenominator ? 0 : 1000;
        w32(o, Math.round(dms[0] * 1000));
        w32(o + 4, den);
        w32(o + 8, Math.round(dms[1] * 1000));
        w32(o + 12, den);
        w32(o + 16, Math.round(dms[2] * 1000));
        w32(o + 20, den);
        g += 12;
    };
    writeRef(0x0001, opts.latRef);
    writeDms(0x0002, 280, opts.lat);
    writeRef(0x0003, opts.lonRef);
    writeDms(0x0004, 320, opts.lon);
    w32(g, 0);

    // Exif IFD with DateTimeOriginal
    if (opts.dateTimeOriginal) {
        const exif = tiff + exifIfdRel;
        w16(exif, 1);
        const de = exif + 2;
        w16(de, 0x9003);
        w16(de + 2, 2);
        w32(de + 4, 20);
        const strRel = 500;
        w32(de + 8, strRel);
        for (let i = 0; i < opts.dateTimeOriginal.length; i++) {
            v.setUint8(tiff + strRel + i, opts.dateTimeOriginal.charCodeAt(i));
        }
        w32(de + 12, 0);
    }

    return v;
}

describe('parseExif', () => {
    it('decodes a southern-hemisphere fix (little-endian) to signed degrees', () => {
        // 27°12.5094'S 153°5.2515'E — mid Moreton Bay, nowhere near a berth.
        const view = buildJpegWithGps({
            lat: [27, 12, 30.564],
            latRef: 'S',
            lon: [153, 5, 15.09],
            lonRef: 'E',
        });
        const out = parseExif(view);
        expect(out).not.toBeNull();
        expect(out!.lat).toBeCloseTo(-27.20849, 4);
        expect(out!.lon).toBeCloseTo(153.087525, 4);
    });

    it('decodes big-endian TIFF and NW refs', () => {
        const view = buildJpegWithGps({
            lat: [47, 36, 0],
            latRef: 'N',
            lon: [122, 20, 0],
            lonRef: 'W',
            bigEndian: true,
        });
        const out = parseExif(view);
        expect(out).not.toBeNull();
        expect(out!.lat).toBeCloseTo(47.6, 4);
        expect(out!.lon).toBeCloseTo(-122.3333, 3);
    });

    it('parses DateTimeOriginal as local epoch-ms', () => {
        const view = buildJpegWithGps({
            lat: [27, 0, 0],
            latRef: 'S',
            lon: [153, 0, 0],
            lonRef: 'E',
            dateTimeOriginal: '2026:07:31 10:15:00',
        });
        const out = parseExif(view);
        expect(out!.takenAt).toBe(new Date(2026, 6, 31, 10, 15, 0).getTime());
    });

    it('returns null for a JPEG without EXIF GPS', () => {
        const buf = new ArrayBuffer(64);
        const v = new DataView(buf);
        v.setUint16(0, 0xffd8);
        v.setUint16(2, 0xffda); // straight to start-of-scan
        expect(parseExif(v)).toBeNull();
    });

    it('returns null for non-JPEG data', () => {
        const buf = new ArrayBuffer(64);
        expect(parseExif(new DataView(buf))).toBeNull();
    });

    it('rejects the (0,0) stripped-GPS sentinel', () => {
        const view = buildJpegWithGps({ lat: [0, 0, 0], latRef: 'N', lon: [0, 0, 0], lonRef: 'E' });
        expect(parseExif(view)).toBeNull();
    });

    it('rejects zero-denominator rationals instead of dividing by zero', () => {
        const view = buildJpegWithGps({
            lat: [27, 12, 30],
            latRef: 'S',
            lon: [153, 5, 15],
            lonRef: 'E',
            zeroDenominator: true,
        });
        expect(parseExif(view)).toBeNull();
    });
});
