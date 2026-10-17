/** Fictional WMO regular-grid/simple-packing messages. No downloaded/provider/boat data. */
import { concatenate } from './grib1Fixtures';
export interface Grib2FixtureOptions {
    component?: 'u' | 'v' | 'p';
    scan?: number;
    hour?: number;
    lead?: number;
    unit?: number;
    width?: number;
    height?: number;
    west?: number;
    south?: number;
    values?: number[];
    bitmap?: boolean[];
    reference?: number;
    binary?: number;
    decimal?: number;
    bits?: number;
}
export function grib2Message(options: Grib2FixtureOptions = {}): Uint8Array {
    const width = options.width ?? 3,
        height = options.height ?? 2,
        scan = options.scan ?? 0,
        west = options.west ?? -30,
        south = options.south ?? -2;
    const east = west + width - 1,
        north = south + height - 1;
    const section = (size: number, id: number) => {
        const bytes = new Uint8Array(size);
        new DataView(bytes.buffer).setUint32(0, size);
        bytes[4] = id;
        return bytes;
    };
    const sm = (n: number, sign: number) => (n < 0 ? sign + -n : n);
    const s1 = section(21, 1),
        v1 = new DataView(s1.buffer);
    v1.setUint16(5, 7);
    s1[9] = 2;
    s1[11] = 1;
    v1.setUint16(12, 2026);
    s1[14] = 1;
    s1[15] = 1;
    s1[16] = options.hour ?? 0;
    const s3 = section(72, 3),
        v3 = new DataView(s3.buffer);
    v3.setUint32(6, width * height);
    s3[14] = 6;
    v3.setUint32(30, width);
    v3.setUint32(34, height);
    const coord = (at: number, n: number) => v3.setUint32(at, sm(Math.round(n * 1e6), 0x80000000));
    coord(46, scan & 64 ? south : north);
    coord(50, scan & 128 ? east : west);
    s3[54] = 0x30;
    coord(55, scan & 64 ? north : south);
    coord(59, scan & 128 ? west : east);
    v3.setUint32(63, 1000000);
    v3.setUint32(67, 1000000);
    s3[71] = scan;
    const s4 = section(34, 4),
        v4 = new DataView(s4.buffer),
        component = options.component ?? 'u';
    s4[9] = component === 'p' ? 3 : 2;
    s4[10] = component === 'u' ? 2 : component === 'v' ? 3 : 1;
    s4[11] = 2;
    s4[13] = 81;
    s4[17] = options.unit ?? 1;
    v4.setUint32(18, options.lead ?? 0);
    s4[22] = component === 'p' ? 101 : 103;
    v4.setUint32(24, component === 'p' ? 0 : 10);
    s4[28] = 255;
    s4[29] = 255;
    v4.setUint32(30, 0xffffffff);
    const natural = options.values ?? Array.from({ length: width * height }, (_, i) => i + 1),
        ordered: number[] = [],
        mask: number[] = [];
    for (let i = 0; i < width * height; i++) {
        const a = scan & 32 ? Math.floor(i / height) : i % width,
            b = scan & 32 ? i % height : Math.floor(i / width),
            x = scan & 128 ? width - 1 - a : a,
            y = scan & 64 ? b : height - 1 - b,
            j = y * width + x,
            exists = options.bitmap?.[j] ?? true;
        mask.push(exists ? 1 : 0);
        if (exists) ordered.push(natural[j]);
    }
    const pack = (values: number[], bits: number) => {
        const bytes = new Uint8Array(Math.ceil((values.length * bits) / 8));
        let pos = 0;
        for (const value of values)
            for (let b = bits - 1; b >= 0; b--, pos++)
                if (Math.floor(value / 2 ** b) % 2) bytes[Math.floor(pos / 8)] |= 1 << (7 - (pos % 8));
        return bytes;
    };
    const bits = options.bits ?? 8,
        s5 = section(21, 5),
        v5 = new DataView(s5.buffer);
    v5.setUint32(5, ordered.length);
    v5.setFloat32(11, options.reference ?? 0);
    v5.setUint16(15, sm(options.binary ?? 0, 0x8000));
    v5.setUint16(17, sm(options.decimal ?? 0, 0x8000));
    s5[19] = bits;
    const bitmap = pack(mask, 1),
        s6 = section(options.bitmap ? 6 + bitmap.length : 6, 6);
    s6[5] = options.bitmap ? 0 : 255;
    if (options.bitmap) s6.set(bitmap, 6);
    const data = pack(ordered, bits),
        s7 = section(5 + data.length, 7);
    s7.set(data, 5);
    const total = 16 + s1.length + s3.length + s4.length + s5.length + s6.length + s7.length + 4,
        head = new Uint8Array(16),
        hv = new DataView(head.buffer);
    head.set([71, 82, 73, 66]);
    head[7] = 2;
    hv.setUint32(12, total);
    return new Uint8Array(concatenate(head, s1, s3, s4, s5, s6, s7, new Uint8Array([55, 55, 55, 55])));
}
export const grib2Pair = (options: Grib2FixtureOptions = {}) =>
    concatenate(grib2Message(options), grib2Message({ ...options, component: 'v' }));
export function alterSection(input: Uint8Array, number: number, change: (section: DataView) => void): Uint8Array {
    const copy = input.slice(),
        view = new DataView(copy.buffer);
    let at = 16;
    while (at < copy.length - 4) {
        if (view.getUint8(at + 4) === number) {
            change(new DataView(copy.buffer, at, view.getUint32(at)));
            return copy;
        }
        at += view.getUint32(at);
    }
    throw new Error('Fixture section missing');
}
