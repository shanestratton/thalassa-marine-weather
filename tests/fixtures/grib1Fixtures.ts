/** Fictional regular-grid data only. This encoder is test scaffolding, never a provider adapter. */
export interface FixtureOptions {
    parameter?: number;
    level?: number;
    height?: number;
    table?: number;
    centre?: number;
    process?: number;
    year?: number;
    month?: number;
    day?: number;
    hour?: number;
    minute?: number;
    unit?: number;
    p1?: number;
    p2?: number;
    timeRange?: number;
    width?: number;
    rows?: number;
    west?: number;
    south?: number;
    dx?: number;
    dy?: number;
    scan?: number;
    values?: number[];
    bitmap?: boolean[];
    reference?: number;
    binaryScale?: number;
    decimalScale?: number;
    bits?: number;
}
const put24 = (out: Uint8Array, at: number, n: number) => {
    out[at] = n >>> 16;
    out[at + 1] = n >>> 8;
    out[at + 2] = n;
};
const sm = (n: number, sign: number) => (n < 0 ? sign | -n : n);
function ibm(value: number): number[] {
    if (!value) return [0, 0, 0, 0];
    let fraction = Math.abs(value),
        exponent = 64;
    while (fraction >= 1) {
        fraction /= 16;
        exponent++;
    }
    while (fraction < 1 / 16) {
        fraction *= 16;
        exponent--;
    }
    const mantissa = Math.round(fraction * 0x1000000);
    return [(value < 0 ? 0x80 : 0) | exponent, mantissa >>> 16, (mantissa >>> 8) & 255, mantissa & 255];
}
function packed(values: number[], bits: number): { bytes: Uint8Array; unused: number } {
    const length = Math.ceil((values.length * bits) / 8),
        bytes = new Uint8Array(length);
    let at = 0;
    for (const value of values)
        for (let b = bits - 1; b >= 0; b--, at++)
            if (Math.floor(value / 2 ** b) % 2) bytes[Math.floor(at / 8)] |= 1 << (7 - (at % 8));
    return { bytes, unused: length * 8 - values.length * bits };
}
export function message(options: FixtureOptions = {}): Uint8Array {
    const width = options.width ?? 3,
        rows = options.rows ?? 2,
        scan = options.scan ?? 0;
    const west = options.west ?? -30,
        south = options.south ?? -2,
        dx = options.dx ?? 1,
        dy = options.dy ?? 1;
    const east = west + dx * (width - 1),
        north = south + dy * (rows - 1);
    const firstLat = scan & 0x40 ? south : north,
        firstLon = scan & 0x80 ? east : west;
    const lastLat = scan & 0x40 ? north : south,
        lastLon = scan & 0x80 ? west : east;
    const pds = new Uint8Array(28),
        p = new DataView(pds.buffer);
    put24(pds, 0, 28);
    pds[3] = options.table ?? 2;
    pds[4] = options.centre ?? 7;
    pds[5] = options.process ?? 81;
    pds[6] = 255;
    pds[7] = options.bitmap ? 0xc0 : 0x80;
    pds[8] = options.parameter ?? 33;
    pds[9] = options.level ?? 105;
    p.setUint16(10, options.height ?? 10);
    const year = options.year ?? 2026;
    pds[12] = ((year - 1) % 100) + 1;
    pds[24] = Math.floor((year - 1) / 100) + 1;
    pds[13] = options.month ?? 1;
    pds[14] = options.day ?? 1;
    pds[15] = options.hour ?? 0;
    pds[16] = options.minute ?? 0;
    pds[17] = options.unit ?? 1;
    pds[18] = options.p1 ?? 0;
    pds[19] = options.p2 ?? 0;
    pds[20] = options.timeRange ?? 0;
    p.setUint16(26, sm(options.decimalScale ?? 0, 0x8000));
    const gds = new Uint8Array(32),
        g = new DataView(gds.buffer);
    put24(gds, 0, 32);
    gds[4] = 255;
    g.setUint16(6, width);
    g.setUint16(8, rows);
    const longitude = (value: number) => (value > 360 ? value - 360 : value < -360 ? value + 360 : value);
    put24(gds, 10, sm(Math.round(firstLat * 1000), 0x800000));
    put24(gds, 13, sm(Math.round(longitude(firstLon) * 1000), 0x800000));
    gds[16] = 0x80;
    put24(gds, 17, sm(Math.round(lastLat * 1000), 0x800000));
    put24(gds, 20, sm(Math.round(longitude(lastLon) * 1000), 0x800000));
    g.setUint16(23, dx * 1000);
    g.setUint16(25, dy * 1000);
    gds[27] = scan;
    const natural = options.values ?? Array.from({ length: width * rows }, (_, i) => i + 1);
    const ordered: number[] = [],
        mask: number[] = [];
    for (let index = 0; index < natural.length; index++) {
        const i = scan & 0x20 ? Math.floor(index / rows) : index % width;
        const j = scan & 0x20 ? index % rows : Math.floor(index / width);
        const x = scan & 0x80 ? width - 1 - i : i,
            y = scan & 0x40 ? j : rows - 1 - j;
        const source = y * width + x,
            exists = options.bitmap?.[source] ?? true;
        mask.push(exists ? 1 : 0);
        if (exists) ordered.push(natural[source]);
    }
    const bits = options.bits ?? 8,
        data = packed(ordered, bits);
    if ((11 + data.bytes.length) % 2) {
        const padded = new Uint8Array(data.bytes.length + 1);
        padded.set(data.bytes);
        data.bytes = padded;
        data.unused += 8;
    }
    const bds = new Uint8Array(11 + data.bytes.length),
        b = new DataView(bds.buffer);
    put24(bds, 0, bds.length);
    bds[3] = data.unused;
    b.setUint16(4, sm(options.binaryScale ?? 0, 0x8000));
    bds.set(ibm(options.reference ?? 0), 6);
    bds[10] = bits;
    bds.set(data.bytes, 11);
    let bms = new Uint8Array();
    if (options.bitmap) {
        const data = packed(mask, 1);
        if ((6 + data.bytes.length) % 2) {
            const padded = new Uint8Array(data.bytes.length + 1);
            padded.set(data.bytes);
            data.bytes = padded;
            data.unused += 8;
        }
        bms = new Uint8Array(6 + data.bytes.length);
        put24(bms, 0, bms.length);
        bms[3] = data.unused;
        bms.set(data.bytes, 6);
    }
    const result = new Uint8Array(8 + pds.length + gds.length + bms.length + bds.length + 4);
    result.set([71, 82, 73, 66]);
    put24(result, 4, result.length);
    result[7] = 1;
    result.set(pds, 8);
    result.set(gds, 36);
    result.set(bms, 68);
    result.set(bds, 68 + bms.length);
    result.fill(55, result.length - 4);
    return result;
}
export function concatenate(...messages: Uint8Array[]): ArrayBuffer {
    const joined = new Uint8Array(messages.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const message of messages) {
        joined.set(message, at);
        at += message.length;
    }
    return joined.buffer;
}
export function pair(options: FixtureOptions = {}): ArrayBuffer {
    return concatenate(message(options), message({ ...options, parameter: 34 }));
}
